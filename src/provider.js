/**
 * @file provider.js
 * @description Reticulum provider for Yjs.
 *
 * Wraps a {@link Y.Doc} and synchronizes it with peers discovered over the
 * Reticulum mesh. Each provider owns (or borrows) a {@link Reticulum} instance
 * and a {@link Room} that announces a destination derived from the room name
 * and maintains pairwise Links to peers.
 *
 * Phase 2 (this file) implements the connection lifecycle and peer mesh:
 * announcing, discovery and `peers` events. Yjs sync/awareness over those Links
 * lands in Phase 3.
 */

import { Identity } from "@reticulum/core";
import { ObservableV2 } from "lib0/observable";
import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";
import { roomDestinationName } from "./destination.js";
import { Room } from "./room.js";

/**
 * Options accepted by {@link ReticulumProvider}.
 *
 * @typedef {Object} ProviderOptions
 * @property {import("@reticulum/core").Reticulum} reticulum
 *   A configured Reticulum instance with at least one (default) interface
 *   attached. The provider does not open interfaces itself.
 * @property {import("@reticulum/core").Identity} [identity]
 *   Identity for this peer's room destination. Generated (non-persistent) if
 *   omitted; supply your own to keep a stable address across restarts.
 * @property {awarenessProtocol.Awareness} [awareness]
 *   Reuse an existing Awareness instance. A fresh one is created when omitted.
 * @property {number} [maxConns]
 *   Upper bound on simultaneous peer Links. Mirrors y-webrtc's `maxConns`.
 * @property {number} [announceIntervalMs]
 *   Cadence (ms) at which the room destination is re-announced for discovery.
 *   Forwarded to `Destination.startAnnouncing`, which clamps it to the
 *   §9.7 60 s floor (sub-minute intervals trigger ingress rate limiting).
 * @property {import("./room.js").LinkPolicy} [linkPolicy]
 *   When set, peer links must prove their identity (the initiator runs the
 *   signed identify handshake over the link) and pass the policy before any
 *   room traffic flows. Refused links are torn down and reported via the
 *   `refused` event, which apps can use to surface access requests.
 * @property {import("./room.js").LinkAuthorizer} [authorizeLink]
 *   When set, runs an application-defined authorization phase on every peer
 *   link after the identity is proven and before any room traffic flows. The
 *   authorizer receives the live link plus a `send`/`receive` exchange bound
 *   to the link's channel, so it can run its own protocol (e.g. a Dacar
 *   assertion exchange) before Yjs sync is allowed to start. A `false`
 *   verdict, a throw, or exceeding `authorizeTimeoutMs` tears the link down
 *   and reports it via the `refused` event. Composes with `linkPolicy`,
 *   which is evaluated first.
 * @property {number} [identifyTimeoutMs]
 *   How long the responder waits for the initiator's identify handshake
 *   before refusing the link.
 * @property {number} [authorizeTimeoutMs]
 *   How long the authorization phase may run before the link is refused.
 *   Only relevant with an `authorizeLink`.
 */

/**
 * Events emitted by {@link ReticulumProvider}. Mirrors the y-webrtc event
 * surface so consumers can switch providers with minimal changes.
 *
 * @typedef {Object} ReticulumProviderEvents
 * @property {(event: { connected: boolean }) => void} status
 *   Fired when the provider (dis)connects from the mesh.
 * @property {(event: { synced: boolean }) => void} synced
 *   Fired when sync state with the peer mesh changes. (Phase 3.)
 * @property {(event: { added: Array<string>, removed: Array<string>, identities: Record<string, string | null> }) => void} peers
 *   Fired when peers are discovered or drop off. `identities` maps each
 *   added peer id to the remote's truncated identity hash when the peer
 *   proved its identity during establishment (announce or signed identify
 *   handshake), `null` when it did not (no link policy / authorization
 *   configured on the responder side); empty when peers were removed.
 * @property {(event: { remoteHex: string, publicKeyHex: string }) => void} discovered
 *   Fired when an announce for this room arrives from the mesh, before any
 *   glare or policy decision — evidence the room propagates even when no
 *   link forms. The peer's full public key (hex) rides along so apps can
 *   persist a peer cache and dial directly (see `dialPeer`).
 * @property {(event: {}) => void} announced
 *   Fired each time this peer's room destination actually broadcasts an
 *   announce — the connect-time, early-burst and periodic cadences alike.
 * @property {(event: { error: string }) => void} announce-failed
 *   Fired when an early-burst announce attempt throws before broadcast,
 *   with the failure reason. Failures of the periodic re-announce cadence
 *   are logged by `@reticulum/core` and only skip that tick.
 * @property {(event: { refusals: Array<{ destinationHash: string | null, identityHash: string | null, initiator: boolean, reason?: string }> }) => void} refused
 *   Fired when a peer link was refused by the link policy or the
 *   authorization phase.
 */

/**
 * Reticulum provider for Yjs.
 *
 * @extends {ObservableV2<ReticulumProviderEvents>}
 */
export class ReticulumProvider extends ObservableV2 {
  /**
   * @param {string} roomName
   * @param {Y.Doc} doc
   * @param {ProviderOptions} opts
   */
  constructor(roomName, doc, opts) {
    super();
    if (!opts || !opts.reticulum) {
      throw new Error("ReticulumProvider requires a `reticulum` instance.");
    }
    this.roomName = roomName;
    this.doc = doc;
    this.reticulum = opts.reticulum;
    /** @type {awarenessProtocol.Awareness} */
    this.awareness = opts.awareness ?? new awarenessProtocol.Awareness(doc);
    this.maxConns = opts.maxConns ?? 20;
    this.announceIntervalMs = opts.announceIntervalMs ?? 60_000;
    this.linkPolicy = opts.linkPolicy ?? null;
    this.identifyTimeoutMs = opts.identifyTimeoutMs ?? 10_000;
    this.authorizeLink = opts.authorizeLink ?? null;
    this.authorizeTimeoutMs = opts.authorizeTimeoutMs ?? 10_000;

    /** Resolved with the room destination's identity on connect(). */
    this.identityPromise = opts.identity
      ? Promise.resolve(opts.identity)
      : Identity.generate();
    /** @type {Identity|null} */
    this.identity = opts.identity ?? null;

    /** @type {Room|null} */
    this.room = null;
    this.shouldConnect = false;
  }

  /**
   * Whether the provider is announcing and accepting peer Links. Does not imply
   * that any peer is reachable; only that we are looking.
   *
   * @type {boolean}
   */
  get connected() {
    return this.room !== null && this.shouldConnect;
  }

  /** Begin announcing and maintaining the peer mesh. */
  async connect() {
    if (this.shouldConnect) return;
    this.shouldConnect = true;
    this.identity ??= await this.identityPromise;

    const appName = await roomDestinationName(this.roomName);
    this.room = new Room({
      doc: this.doc,
      awareness: this.awareness,
      reticulum: this.reticulum,
      identity: /** @type {Identity} */ (this.identity),
      appName,
      maxConns: this.maxConns,
      announceIntervalMs: this.announceIntervalMs,
      linkPolicy: this.linkPolicy,
      identifyTimeoutMs: this.identifyTimeoutMs,
      authorizeLink: this.authorizeLink,
      authorizeTimeoutMs: this.authorizeTimeoutMs,
      callbacks: {
        onPeers: (
          /** @type {string[]} */ added,
          /** @type {string[]} */ removed,
          /** @type {Record<string, string | null> | undefined} */ identities,
        ) =>
          this.emit("peers", [
            { added, removed, identities: identities ?? {} },
          ]),
        onDiscovered: (
          /** @type {string} */ remoteHex,
          /** @type {string} */ publicKeyHex,
        ) => this.emit("discovered", [{ remoteHex, publicKeyHex }]),
        onAnnounced: () => this.emit("announced", [{}]),
        onAnnounceFailed: (/** @type {string} */ error) =>
          this.emit("announce-failed", [{ error }]),
        onSynced: (/** @type {boolean} */ synced) =>
          this.emit("synced", [{ synced }]),
        onRefused: (/** @type {any[]} */ refusals) =>
          this.emit("refused", [{ refusals }]),
      },
    });
    await this.room.connect();
    this.emit("status", [{ connected: true }]);
  }

  /**
   * Dials a peer's room destination directly from its destination hash (work
   * document #34): for peers whose room destination hash the application
   * knows through its own channels. See the Room's dialHash.
   *
   * @param {string} remoteHex Hex of the peer's room destination hash.
   * @param {string} [remoteIdentityHashHex] Hex of the peer's identity hash,
   *   when the application knows it.
   * @returns {Promise<boolean>} Whether a link was established.
   */
  async dialHash(remoteHex, remoteIdentityHashHex = "") {
    return (
      (await this.room?.dialHash(remoteHex, remoteIdentityHashHex)) ?? false
    );
  }

  /**
   * Dials a peer's room destination directly from a known identity (work
   * document #34): for peers whose identity the application learned
   * through its own channels.
   *
   * @param {InstanceType<typeof Identity>} remoteIdentity
   * @returns {Promise<boolean>} Whether a link was established.
   */
  async dialPeer(remoteIdentity) {
    return (await this.room?.dial(remoteIdentity)) ?? false;
  }

  /** Stop announcing, tear down all peer Links, and release the destination. */
  async disconnect() {
    if (!this.shouldConnect) return;
    this.shouldConnect = false;
    if (this.room) {
      await this.room.disconnect();
      this.room = null;
    }
    this.emit("status", [{ connected: false }]);
  }

  /** Permanently release all resources. */
  async destroy() {
    await this.disconnect();
    super.destroy();
  }
}
