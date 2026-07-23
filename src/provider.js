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
 * @property {(event: { added: Array<string>, removed: Array<string> }) => void} peers
 *   Fired when peers are discovered or drop off.
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
    this.announceIntervalMs = opts.announceIntervalMs ?? 30_000;

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
      callbacks: {
        onPeers: (
          /** @type {string[]} */ added,
          /** @type {string[]} */ removed,
        ) => this.emit("peers", [{ added, removed }]),
        onSynced: (/** @type {boolean} */ synced) =>
          this.emit("synced", [{ synced }]),
      },
    });
    await this.room.connect();
    this.emit("status", [{ connected: true }]);
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
