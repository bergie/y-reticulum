/**
 * @file room.js
 * @description The per-room mesh for a {@link ReticulumProvider}.
 *
 * A Room owns the local Reticulum destination for a Yjs room, announces it for
 * discovery, learns peers from their announces, and maintains a pairwise
 * {@link PeerConn} (Link) to each one. Over each link it runs the Yjs sync
 * protocol (y-protocols/sync) and awareness protocol, broadcasting local Doc
 * and Awareness updates and applying inbound ones.
 *
 * To avoid the two peers both trying to open a Link to each other (WebRTC
 * "glare"), exactly one side initiates: the peer whose destination hash is
 * lexicographically smaller. The other simply accepts.
 */

import {
  CEType,
  ChannelException,
  Destination,
  DestType,
  fromHex,
  Identity,
  LinkStatus,
  toHex,
} from "@reticulum/core";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { getCompressionProvider } from "./compression.js";
import { messageAwareness, messageSync, readMessage } from "./messages.js";
import { LinkAuthMessage, PeerConn, YjsSyncMessage } from "./peer-conn.js";

/**
 * Delay after a peer Link drops before the initiator re-requests the peer's
 * path, accelerating re-discovery beyond the periodic announce cadence. Small
 * enough to beat the default announce interval, large enough to skip transient
 * blips and to no-op if the peer comes back via the next announce first.
 */
const RECONNECT_PATH_REQUEST_DELAY_MS = 1500;

/**
 * Delays between connect() and the early announce burst that covers a
 * dropped first announce (which races interface readiness at the relay).
 * Each fires once; large enough for the interface to be established end to
 * end, small enough that discovery does not wait for the periodic announce
 * cadence.
 */
const EARLY_ANNOUNCE_DELAYS_MS = [1_000, 4_000, 10_000];

/** Constant-time-ish equality for two equal-length byte arrays. */
function bytesEqual(/** @type {Uint8Array} */ a, /** @type {Uint8Array} */ b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** The full capability an authorization phase grants when it resolves `true`. */
const FULL_CAPABILITY = /** @type {{ sync: boolean, write: boolean }} */ (
  Object.freeze({ sync: true, write: true })
);

/**
 * Normalizes a {@link LinkAuthorizer} verdict into a per-peer capability
 * record (work document #3). `true` grants full sync+write; a verdict object
 * grants exactly the flags it sets (`{ sync: true }` makes the peer
 * read-only: awareness and reads flow, but its Doc updates are dropped);
 * anything else — `false`, `undefined`, `null`, or a truthy non-boolean — is
 * a refusal. The non-boolean cases are fail-closed on purpose: an async
 * authorizer that falls off the end of its function body (implicit
 * `undefined`) must not grant access, and only a deliberate `true` or an
 * explicit capability object may.
 *
 * @param {any} verdict
 * @returns {{ sync: boolean, write: boolean } | null} The capability, or
 *   `null` when the verdict refuses the link.
 */
function normalizeCapability(verdict) {
  if (verdict === true) return FULL_CAPABILITY;
  if (verdict !== null && typeof verdict === "object") {
    const capability = {
      sync: verdict.sync === true,
      write: verdict.write === true,
    };
    if (capability.sync || capability.write) return capability;
  }
  return null;
}

/**
 * Context handed to a room's {@link LinkPolicy} for every inbound and
 * outbound peer link.
 *
 * @typedef {Object} LinkPolicyContext
 * @property {string} remoteIdentityHash Hex truncated hash of the remote
 *   peer's long-term identity. Cryptographically bound: on the initiator
 *   side it comes from the peer's announce, on the responder side from the
 *   signed identify handshake over the link.
 * @property {string|null} remoteDestinationHash Hex destination hash of the
 *   remote room destination, when known (initiator side).
 * @property {boolean} initiator Whether this side initiated the link.
 */

/**
 * Decides whether a peer link may carry room traffic. Called on both the
 * initiator and responder sides once the remote identity is proven.
 *
 * @typedef {(context: LinkPolicyContext) => boolean | Promise<boolean>} LinkPolicy
 */

/**
 * Exchange API handed to a room's {@link LinkAuthorizer} for the
 * application-defined authorization phase on a newly established link. `send`
 * delivers an application payload to the peer; `receive` resolves with the
 * next application payload from the peer (payloads arriving before the call
 * are queued). Both are scoped to this link and stop working once the
 * authorization phase ends.
 *
 * @typedef {Object} LinkAuthorizationExchange
 * @property {(payload: Uint8Array) => Promise<void>} send
 * @property {() => Promise<Uint8Array>} receive
 */

/**
 * Context handed to a room's {@link LinkAuthorizer}. Carries the same identity
 * proof as {@link LinkPolicyContext}, plus the live link and a
 * {@link LinkAuthorizationExchange} so the application can run its own
 * protocol (e.g. a Dacar assertion exchange) before any room traffic flows.
 *
 * @typedef {Object} LinkAuthorizationContext
 * @property {import("@reticulum/core").Link} link The established link.
 * @property {string} remoteIdentityHash Hex truncated hash of the remote
 *   peer's long-term identity, proven over the link.
 * @property {string|null} remoteDestinationHash Hex destination hash of the
 *   remote room destination, when known (initiator side).
 * @property {boolean} initiator Whether this side initiated the link.
 * @property {LinkAuthorizationExchange} exchange
 */

/**
 * Application-defined authorization for a peer link, run after the identity
 * is proven and before any room traffic flows. May exchange messages with the
 * peer via `context.exchange`. The verdict resolves the peer's capability:
 * `true` grants full sync+write; a `{ sync, write }` object grants exactly
 * the flags it sets (`{ sync: true }` makes the peer read-only — awareness
 * and reads flow, but its Doc updates are dropped); `false`, `undefined`, a
 * throw, or exceeding `authorizeTimeoutMs` refuses the link.
 *
 * @typedef {(context: LinkAuthorizationContext) => boolean | { sync?: boolean, write?: boolean } | Promise<boolean | { sync?: boolean, write?: boolean }>} LinkAuthorizer
 */

/**
 * @typedef {Object} RoomCallbacks
 * @property {(added: string[], removed: string[], identities?: Record<string, string | null>) => void} onPeers
 *   The third argument maps peer ids to the remote's truncated identity
 *   hash, when the peer proved its identity during establishment. Peer ids
 *   are hex link ids (symmetric across both ends); identity hashes are
 *   stable across reconnects and are what applications display.
 *   Fired whenever peers are discovered or drop off. Ids are hex link_ids.
 * @property {(remoteHex: string, publicKeyHex: string) => void} [onDiscovered]
 *   Fired when an announce matching this room arrives, before any glare
 *   or policy decision — the room-propagation fact, narrable even when a
 *   subsequent link does not form. The peer's full public key (hex) rides
 *   along for the app's peer cache.
 * @property {() => void} [onAnnounced]
 *   Fired each time this room's destination actually broadcasts an announce
 *   (core 0.9.5's "announced" destination event covers the immediate,
 *   early-burst, and periodic cadences uniformly).
 * @property {(error: string) => void} [onAnnounceFailed]
 *   Fired when an announce attempt threw before broadcast.
 * @property {(synced: boolean) => void} onSynced
 *   Fired when the room's overall sync state changes.
 * @property {(refusals: Array<{ destinationHash: string | null, identityHash: string | null, initiator: boolean, reason?: string }>) => void} [onRefused]
 *   Fired when a peer link was refused by the link policy or the
 *   authorization phase. `reason` is `"identify-timeout"` (the peer never
 *   proved its identity), `"link-policy"` (policy declined),
 *   `"authorization"` (the authorizer declined or threw) or
 *   `"authorization-timeout"` (the authorization phase exceeded
 *   `authorizeTimeoutMs`). Apps can use this to surface access requests
 *   (e.g. "peer X wants to join").
 */

/**
 * One Yjs room: a local destination that announces for discovery, plus the set
 * of pairwise {@link PeerConn} links to discovered peers, with the Yjs sync
 * and awareness protocols running over each link.
 */
export class Room {
  /**
   * @param {object} options
   * @param {Y.Doc} options.doc
   * @param {awarenessProtocol.Awareness} options.awareness
   * @param {import("@reticulum/core").Reticulum} options.reticulum
   * @param {import("@reticulum/core").Identity} options.identity
   * @param {string} options.appName - Deterministic destination app-name for the room.
   * @param {number} options.maxConns
   * @param {number} options.announceIntervalMs
   * @param {LinkPolicy | null} [options.linkPolicy] When set, peer links must prove
   *   their identity (initiator runs the identify handshake) and pass the
   *   policy before any room traffic flows; refused links are torn down.
   * @param {number} [options.identifyTimeoutMs] How long the responder waits
   *   for the initiator's identify handshake before refusing.
   * @param {LinkAuthorizer | null} [options.authorizeLink] When set, runs the
   *   application-defined authorization phase on every peer link after the
   *   identity is proven and before any room traffic flows. The authorizer
   *   may exchange messages with the peer over the link; a `false` verdict,
   *   a throw, or exceeding `authorizeTimeoutMs` refuses and tears down the
   *   link (reported via `onRefused`). Composes with `linkPolicy`, which is
   *   evaluated first.
   * @param {number} [options.authorizeTimeoutMs] How long the authorization
   *   phase may run before the link is refused.
   * @param {number} [options.maxResourceSize] Cap (bytes) on the uncompressed
   *   size of inbound Resource transfers accepted on peer links. Applied from
   *   link establishment — including the pre-authorization window — so peers
   *   held in the gate window cannot make us buffer advertisements we would
   *   never deliver. Defaults to the `@reticulum/core` cap (32 MiB).
   * @param {RoomCallbacks} options.callbacks
   */
  constructor({
    doc,
    awareness,
    reticulum,
    identity,
    appName,
    maxConns,
    announceIntervalMs,
    linkPolicy,
    identifyTimeoutMs = 10_000,
    authorizeLink,
    authorizeTimeoutMs = 10_000,
    maxResourceSize,
    callbacks,
  }) {
    this.doc = doc;
    this.awareness = awareness;
    this.rns = reticulum;
    this.identity = identity;
    this.appName = appName;
    this.maxConns = maxConns;
    this.announceIntervalMs = announceIntervalMs;
    this.linkPolicy = linkPolicy ?? null;
    this.identifyTimeoutMs = identifyTimeoutMs;
    this.authorizeLink = authorizeLink ?? null;
    this.authorizeTimeoutMs = authorizeTimeoutMs;
    this.maxResourceSize = maxResourceSize;
    this.callbacks = callbacks;

    /** In-flight inbound link handshakes (see {@link Room._onLinkRequest}). */
    this.inFlightHandshakes = 0;
    /** Flood cap on concurrent handshakes: a link held in the identify /
     * policy / authorization phases is not yet in peerConns, so maxConns
     * does not bound how many ungranted peers can hold us at once. Derived
     * from maxConns; not an option, so flood behavior stays uniform. */
    this.maxInFlightHandshakes = maxConns * 2;

    /** @type {import("@reticulum/core").Destination|null} */
    this.dest = null;
    /** Hex of this room destination's hash; set once connected. */
    this.myHex = "";
    this.connected = false;
    /** Whether the Doc is synced with the current peer mesh. */
    this.synced = false;
    /** Shared bzip2 provider for Resource compression; set on connect(). */
    this.bz2 = null;

    /** @type {Map<string, PeerConn>} hex link_id → conn */
    this.peerConns = new Map();
    /** Destination hashes we currently have an outgoing link to (initiator side). */
    this.linkedDestHexes = new Set();
    /** Destination hashes with an in-flight createLink() (de-bounces announces). */
    this.pendingInitiates = new Set();
    /** Destination hex → scheduled reconnect path-request timer (initiator side). */
    this.pendingPathRequests = new Map();
    /** Timers for the early announce burst after connect (see connect()). */
    this.earlyAnnounceTimers = new Set();
    /** Link → payloads stashed before the peer's PeerConn existed (see
     * {@link Room._primeChannel}). */
    this._primedChannels = new Map();

    this._onAnnounce = this._onAnnounce.bind(this);
    this._onLinkRequest = this._onLinkRequest.bind(this);
    this._docUpdateHandler = this._docUpdateHandler.bind(this);
    this._awarenessUpdateHandler = this._awarenessUpdateHandler.bind(this);
  }

  /** Creates + binds the room destination, announces, and starts discovery. */
  async connect() {
    if (this.connected) return;
    this.bz2 = await getCompressionProvider();
    this.dest = await Destination.IN(
      this.appName,
      DestType.SINGLE,
      this.identity,
      this.rns,
    );
    this.myHex = toHex(/** @type {Uint8Array} */ (this.dest.destinationHash));
    // registerDestination() has bindLocalDestination commented out upstream, so
    // bind explicitly — otherwise inbound LINKREQUEST/DATA for this destination
    // is dropped by the transport.
    this.rns.transport.bindLocalDestination(this.dest);

    this.rns.transport.addEventListener("announce", this._onAnnounce);
    this.dest.addEventListener("link_request", this._onLinkRequest);
    this.doc.on("update", this._docUpdateHandler);
    this.awareness.on("update", this._awarenessUpdateHandler);

    // Delegate the periodic re-announce loop — and its §9.7 60 s floor — to
    // @reticulum/core. startAnnouncing() fires the first announce immediately
    // (so the destination is reachable as soon as connect() returns), then
    // repeats at the interval to keep cached mesh paths fresh against
    // transit-relay TTLs.
    this.dest.startAnnouncing({ intervalMs: this.announceIntervalMs });

    // Truthful announce reporting (work document #34): core 0.9.5 emits
    // "announced" on the destination only after the packet is broadcast, so
    // the narration reflects actual broadcasts — and the early burst's
    // failures surface through onAnnounceFailed with their reason instead
    // of being swallowed.
    this.dest.addEventListener("announced", () =>
      this.callbacks.onAnnounced?.(),
    );

    // The immediate first announce races interface readiness at the relay
    // (a just-connected WebSocket client may not yet be a viable repeater
    // path): when it is dropped, discovery stalls for a full announce
    // interval — compounded by the glare rule, where only the larger
    // destination hash initiates and thus needs to receive the peer's
    // announce. Burst a few early repeats so a dropped packet costs
    // seconds, not a minute; the periodic cadence takes over after.
    for (const delay of EARLY_ANNOUNCE_DELAYS_MS) {
      const timer = setTimeout(() => {
        this.earlyAnnounceTimers.delete(timer);
        if (this.connected && this.dest) {
          this.dest
            .announce()
            .catch((/** @type {any} */ err) =>
              this.callbacks.onAnnounceFailed?.(
                /** @type {any} */ (err)?.message ?? String(err),
              ),
            );
        }
      }, delay);
      this.earlyAnnounceTimers.add(timer);
    }

    this.connected = true;
  }

  /** Stops announcing, tears down all peer links, and unbinds the destination. */
  async disconnect() {
    if (!this.connected) return;
    this.connected = false;

    for (const timer of this.earlyAnnounceTimers) clearTimeout(timer);
    this.earlyAnnounceTimers.clear();
    this.dest?.stopAnnouncing();
    for (const timer of this.pendingPathRequests.values()) clearTimeout(timer);
    this.pendingPathRequests.clear();
    this.rns.transport.removeEventListener("announce", this._onAnnounce);
    this.dest?.removeEventListener("link_request", this._onLinkRequest);
    this.doc.off("update", this._docUpdateHandler);
    this.awareness.off("update", this._awarenessUpdateHandler);

    // Tell peers to drop our awareness state before the links come down.
    awarenessProtocol.removeAwarenessStates(
      this.awareness,
      [this.doc.clientID],
      "disconnect",
    );

    const removed = [...this.peerConns.keys()];
    for (const conn of this.peerConns.values()) conn.destroy();
    this.peerConns.clear();
    this.linkedDestHexes.clear();
    this.pendingInitiates.clear();
    this.synced = false;
    if (removed.length) this.callbacks.onPeers([], removed, {});

    if (this.dest) {
      this.rns.transport.unbindLocalDestination(this.dest);
      this.dest = null;
    }
    this.myHex = "";
  }

  /**
   * Initiator path: a peer in our room announced. Open a Link to it unless we
   * already have one, we're at capacity, or the glare rule says the peer should
   * initiate instead.
   * @param {Event} event
   */
  async _onAnnounce(event) {
    if (!this.connected || !this.dest) return;
    const detail = /** @type {any} */ (event).detail;
    if (
      !bytesEqual(
        /** @type {Uint8Array} */ (detail.nameHash),
        /** @type {Uint8Array} */ (this.dest.nameHash),
      )
    ) {
      return; // different room
    }
    const remoteHex = toHex(/** @type {Uint8Array} */ (detail.destinationHash));
    if (remoteHex === this.myHex) return; // self (transport filters this, but be safe)
    // A matching announce is a discovery fact in its own right: narrate it
    // before any glare or policy decision, so apps can see that room
    // announcements propagate even when a subsequent link does not form.
    // The full public key rides along: the app can persist it as a peer
    // cache and dial directly on reconnect (work document #34)
    this.callbacks.onDiscovered?.(
      remoteHex,
      toHex(detail.identity?.publicKey ?? []),
    );
    if (this.peerConns.size >= this.maxConns) return;
    if (this.linkedDestHexes.has(remoteHex)) {
      // The peer is announcing, which is evidence it is alive — but our
      // link to it may be a stale remnant of its previous session (it died
      // without tearing the link down: a crash, a reload, a killed
      // worker). Such a link only goes away via the Reticulum link
      // timeout, which would leave both sides unsynced for minutes. If no
      // live link exists for this destination, drop the stale connection
      // and fall through to re-initiate.
      const conns = [...this.peerConns.values()].filter(
        (conn) =>
          conn.remoteDestHash && toHex(conn.remoteDestHash) === remoteHex,
      );
      if (conns.some((conn) => conn.link.status === LinkStatus.ACTIVE)) return;
      for (const conn of conns) {
        conn.destroy();
        // destroy() does not fire onClose — do the removal bookkeeping here.
        // (The reconnect path request this schedules is redundant — the peer
        // is announcing — but harmless and coalesced.)
        this._onPeerClose(conn);
      }
    }
    if (this.pendingInitiates.has(remoteHex)) {
      return;
    }
    // Glare avoidance: only the lexicographically smaller destination initiates.
    if (this.myHex > remoteHex) return;

    // De-bounce before the policy runs: announces repeat, and a slow (e.g.
    // interactive) policy must not let concurrent announces each open a Link.
    this.pendingInitiates.add(remoteHex);

    // The announce cryptographically binds the remote identity, so the
    // initiator always knows the peer's identity hash: it feeds the link
    // policy / authorization context when configured, and peer registration
    // (the `peers` event's identities map) otherwise.
    const initiatorIdentityHash = toHex(
      await Identity.truncatedHash(detail.identity.publicKey),
    );
    const out = await Destination.OUT(
      this.appName,
      DestType.SINGLE,
      detail.identity,
      this.rns,
    );
    await this._establishOutgoingLink(remoteHex, out, initiatorIdentityHash);
  }

  /**
   * Establishes an outgoing peer link to a room peer: the link policy,
   * signed identify, and application authorization phases all run before
   * any room traffic. Shared by the announce-driven initiate and the
   * direct dial (work document #34).
   *
   * @param {string} remoteHex Hex of the peer's room destination hash.
   * @param {InstanceType<typeof Destination>} out The OUT destination
   *   targeting the peer — from its announce identity, or recalled by hash
   *   when the peer's identity hash is known from project state.
   * @param {string} initiatorIdentityHash Hex of the remote peer's truncated
   *   identity hash, proven by its announce (initiate path) or the transport's
   *   identity recall (dial path); feeds the link-policy context.
   * @returns {Promise<boolean>} Whether a link was established.
   */
  async _establishOutgoingLink(remoteHex, out, initiatorIdentityHash) {
    let link = /** @type {import("@reticulum/core").Link|null} */ (null);
    try {
      // Link policy (initiator side): the announce (or transport identity
      // recall) cryptographically binds the remote identity, so the policy
      // can run before any link is opened. A refusal must still fall
      // through the finally below — a wedged pendingInitiates entry would
      // block every future announce-driven retry, including after the app
      // changes its verdict.
      if (this.linkPolicy) {
        const allowed = await this.linkPolicy({
          remoteIdentityHash: initiatorIdentityHash,
          remoteDestinationHash: remoteHex,
          initiator: true,
        });
        if (!allowed) {
          this.callbacks.onRefused?.([
            {
              destinationHash: remoteHex,
              identityHash: initiatorIdentityHash,
              initiator: true,
              reason: "link-policy",
            },
          ]);
          return false;
        }
      }

      link = await out.createLink();
      if (!this.connected) {
        await link.teardown();
        return false;
      }
      // Register the Yjs message type (and stash early inbound traffic)
      // before any await: the responder may start its Yjs sync handshake
      // while we are still identifying.
      this._primeChannel(link);
      // With a policy or authorization phase, prove our identity to the
      // responder before any room traffic: they cannot evaluate us until we
      // do.
      if (this.linkPolicy || this.authorizeLink) {
        await link.identify(this.identity);
      }
      // Application-defined authorization phase: runs after the identity is
      // proven and before any room traffic flows. The verdict resolves the
      // peer's capability ({ sync, write }); a null capability refuses.
      /** @type {{ sync: boolean, write: boolean } | undefined} */
      let capability;
      if (this.authorizeLink) {
        const verdict = await this._authorizeLink(link, {
          remoteIdentityHash: initiatorIdentityHash,
          remoteDestinationHash: remoteHex,
          initiator: true,
        });
        if (!verdict.capability) {
          this._unprimeChannel(link);
          await link.teardown();
          this.callbacks.onRefused?.([
            {
              destinationHash: remoteHex,
              identityHash: initiatorIdentityHash,
              initiator: true,
              reason: verdict.timedOut
                ? "authorization-timeout"
                : "authorization",
            },
          ]);
          return false;
        }
        capability = verdict.capability;
      }
      this.linkedDestHexes.add(remoteHex);
      this._registerPeer(
        link,
        out.destinationHash,
        initiatorIdentityHash || null,
        capability,
      );
      return true;
    } catch {
      // Peer vanished mid-handshake, transport error, etc. — the announce
      // loop will retry on the next announce if the peer is still around.
      if (link) this._unprimeChannel(link);
      return false;
    } finally {
      this.pendingInitiates.delete(remoteHex);
    }
  }

  /**
   * Dials a peer's room destination directly from its destination hash,
   * without waiting for announce-driven discovery (work document #34): for
   * peers whose room destination hash the application knows through its own
   * channels. The peer proves its identity during the identify phase; the
   *   same identify/authorization sequence as the announce-driven initiate
   *   applies. The initiator-side link policy runs once the transport
   *   recalls (or solicits) the peer's proven identity; when the peer stays
   *   unknown the link is not attempted, so the responder-side policy
   *   (evaluated after identify) remains the gate.
   *
   * @param {string} remoteHex Hex of the peer's room destination hash.
   * @param {string} [remoteIdentityHashHex] Hex of the peer's identity
   *   hash, when the application knows it — reported in refusal payloads
   *   and used as the policy context fallback.
   * @returns {Promise<boolean>} Whether a link was established (true also
   *   when an active link to this peer already existed, or a link attempt
   *   is in flight).
   */
  async dialHash(remoteHex, remoteIdentityHashHex = "") {
    if (!this.connected || !this.dest) return false;
    const remoteHashBytes = fromHex(remoteHex);
    const existing = [...this.peerConns.values()].some(
      (conn) =>
        conn.remoteDestHash &&
        toHex(conn.remoteDestHash) === remoteHex &&
        conn.link.status === LinkStatus.ACTIVE,
    );
    if (existing) return true;
    if (this.pendingInitiates.has(remoteHex)) return true;
    this.pendingInitiates.add(remoteHex);
    try {
      // Stage 1 — identity: recall from the transport's cache (populated
      // from processed announces, persisted) or solicit by waiting for the
      // peer's next announce (work document #34). The identity lets the
      // link policy evaluate the TRUE remote hash before any link is
      // opened; the announce reception itself also refreshes the path.
      const remoteIdentity =
        (await this.rns.transport
          .recallOrSolicitIdentity?.(remoteHashBytes, 10_000)
          .catch(() => null)) ?? null;
      const initiatorIdentityHash = remoteIdentity
        ? toHex(await Identity.truncatedHash(remoteIdentity.publicKey))
        : remoteIdentityHashHex;
      if (this.linkPolicy && remoteIdentity) {
        const allowed = await this.linkPolicy({
          remoteIdentityHash: initiatorIdentityHash,
          remoteDestinationHash: remoteHex,
          initiator: true,
        });
        if (!allowed) {
          this.callbacks.onRefused?.([
            {
              destinationHash: remoteHex,
              identityHash: initiatorIdentityHash,
              initiator: true,
              reason: "link-policy",
            },
          ]);
          return false;
        }
      }
      // Stage 2 — path: a LINKREQUEST needs a path to route. Request one
      // from the network and wait briefly; the relay answers from its path
      // table when the peer has announced recently.
      if (!this.rns.transport.hasPath?.(remoteHashBytes)) {
        await this.rns.transport.requestPath?.(remoteHashBytes).catch(() => {});
        const pathDeadline = Date.now() + 10_000;
        while (
          !this.rns.transport.hasPath?.(remoteHashBytes) &&
          Date.now() < pathDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!this.rns.transport.hasPath?.(remoteHashBytes)) return false;
      }
      // Stage 3 — link: with a real identity, a fully formed OUT
      // destination; without one, `Destination.recalled` hydrates the
      // identity from the transport's cache (or solicits it, with the same
      // patience as the other stages) and verifies it hashes to the dialed
      // hash under our app name. The peer proves its identity during
      // identify either way.
      const out = remoteIdentity
        ? await Destination.OUT(
            this.appName,
            DestType.SINGLE,
            remoteIdentity,
            this.rns,
          )
        : await Destination.recalled(
            this.appName,
            remoteHashBytes,
            this.rns,
            10_000,
          );
      return await this._establishOutgoingLink(
        remoteHex,
        out,
        initiatorIdentityHash,
      );
    } catch {
      return false;
    } finally {
      this.pendingInitiates.delete(remoteHex);
    }
  }

  /**
   * Dials a peer's room destination directly from a known identity (work
   * document #34): for peers whose identity the application learned
   * through its own channels.
   *
   * @param {InstanceType<typeof Identity>} remoteIdentity
   * @returns {Promise<boolean>} Whether a link was established.
   */
  async dial(remoteIdentity) {
    if (!this.connected || !this.dest) return false;
    const out = await Destination.OUT(
      this.appName,
      DestType.SINGLE,
      remoteIdentity,
      this.rns,
    );
    const remoteHex = toHex(/** @type {Uint8Array} */ (out.destinationHash));
    if (remoteHex === this.myHex) return false;
    const existing = [...this.peerConns.values()].some(
      (conn) =>
        conn.remoteDestHash &&
        toHex(conn.remoteDestHash) === remoteHex &&
        conn.link.status === LinkStatus.ACTIVE,
    );
    if (existing || this.pendingInitiates.has(remoteHex)) return true;
    this.pendingInitiates.add(remoteHex);
    const initiatorIdentityHash = toHex(
      await Identity.truncatedHash(remoteIdentity.publicKey),
    );
    return await this._establishOutgoingLink(
      remoteHex,
      out,
      initiatorIdentityHash,
    );
  }

  /**
   * Responder path: a peer is opening a Link to us. Accept it. With a link
   * policy, the peer must prove its identity over the link (signed identify
   * handshake) before the policy decides and any room traffic flows.
   * @param {Event} event
   */
  async _onLinkRequest(event) {
    if (!this.connected || !this.dest) return;
    if (this.peerConns.size >= this.maxConns) return;
    if (this.inFlightHandshakes >= this.maxInFlightHandshakes) return;
    this.inFlightHandshakes += 1;
    const packet = /** @type {any} */ (event).detail.packet;
    let link = /** @type {import("@reticulum/core").Link|null} */ (null);
    try {
      link = await this.dest.acceptLink(packet);
      if (!this.connected) {
        await link.teardown();
        return;
      }
      // Register the Yjs message type (and stash early inbound traffic)
      // before any await: the initiator may already be sending its Yjs sync
      // handshake while we identify / run the link policy.
      this._primeChannel(link);
      // Hoisted: the identity and capability ride into peer registration
      // even when no policy / authorization is configured (then both stay
      // null / undefined)
      let identityHash = null;
      /** @type {{ sync: boolean, write: boolean } | undefined} */
      let capability;
      if (this.linkPolicy || this.authorizeLink) {
        identityHash = await this._awaitIdentify(link);
        if (!identityHash) {
          // The peer never proved who they are: refuse without ceremony
          this._unprimeChannel(link);
          await link.teardown();
          this.callbacks.onRefused?.([
            {
              destinationHash: null,
              identityHash: null,
              initiator: false,
              reason: "identify-timeout",
            },
          ]);
          return;
        }
        if (this.linkPolicy) {
          const allowed = await this.linkPolicy({
            remoteIdentityHash: identityHash,
            remoteDestinationHash: null,
            initiator: false,
          });
          if (!allowed) {
            this._unprimeChannel(link);
            await link.teardown();
            this.callbacks.onRefused?.([
              {
                destinationHash: null,
                identityHash,
                initiator: false,
                reason: "link-policy",
              },
            ]);
            return;
          }
        }
        // Application-defined authorization phase: runs after the identity
        // is proven (and the policy passed) and before any room traffic.
        // The verdict resolves the peer's capability; a null capability
        // refuses the link.
        if (this.authorizeLink) {
          const verdict = await this._authorizeLink(link, {
            remoteIdentityHash: identityHash,
            remoteDestinationHash: null,
            initiator: false,
          });
          if (!verdict.capability) {
            this._unprimeChannel(link);
            await link.teardown();
            this.callbacks.onRefused?.([
              {
                destinationHash: null,
                identityHash,
                initiator: false,
                reason: verdict.timedOut
                  ? "authorization-timeout"
                  : "authorization",
              },
            ]);
            return;
          }
          capability = verdict.capability;
        }
      }
      this._registerPeer(link, null, identityHash, capability);
    } catch {
      // Handshake failed; nothing to clean up.
      if (link) this._unprimeChannel(link);
    } finally {
      this.inFlightHandshakes -= 1;
    }
  }

  /**
   * Waits for the initiator's signed identify handshake on this link.
   *
   * @param {import("@reticulum/core").Link} link
   * @returns {Promise<string|null>} Hex remote identity hash, or null when
   *   the peer did not identify within the timeout.
   */
  _awaitIdentify(link) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        link.removeEventListener("identify", onIdentify);
        resolve(null);
      }, this.identifyTimeoutMs);
      const onIdentify = (/** @type {Event} */ event) => {
        clearTimeout(timer);
        const detail = /** @type {any} */ (event).detail;
        const identity = detail?.identity;
        resolve(identity ? toHex(identity.getSalt()) : null);
      };
      link.addEventListener("identify", onIdentify, { once: true });
    });
  }

  /**
   * Registers the Yjs and link-authorization message types on the link's
   * channel and stashes any inbound payloads that arrive before the
   * {@link PeerConn} exists (Yjs) or before the application consumes them
   * (authorization). Without the Yjs stash, a payload arriving during the
   * identify / link-policy / authorization awaits is dropped by the channel
   * with `Unable to find constructor for Channel MSGTYPE 0x1`.
   * @param {import("@reticulum/core").Link} link
   */
  _primeChannel(link) {
    // Bound inbound Resource transfers (the @reticulum/core default cap is
    // 32 MiB per resource): a peer held in the pre-authorization window can
    // otherwise make the link accept large advertisements it will never
    // deliver. Applied here, right after link establishment, so the cap
    // covers the gate window too.
    link.maxResourceSize = this.maxResourceSize;
    const channel = link.getChannel();
    channel.registerMessageType(YjsSyncMessage);
    channel.registerMessageType(LinkAuthMessage);
    const payloads = /** @type {Uint8Array[]} */ ([]);
    const stash = (/** @type {any} */ msg) => {
      if (!(msg instanceof YjsSyncMessage)) return false;
      payloads.push(msg.data);
      return true;
    };
    channel.addMessageHandler(stash);
    const authPayloads = /** @type {Uint8Array[]} */ ([]);
    /** @type {Array<{ resolve: (payload: Uint8Array) => void, reject: (err: Error) => void }>} */
    const authWaiters = [];
    const authStash = (/** @type {any} */ msg) => {
      if (!(msg instanceof LinkAuthMessage)) return false;
      const waiter = authWaiters.shift();
      if (waiter) waiter.resolve(msg.data);
      else authPayloads.push(msg.data);
      return true;
    };
    channel.addMessageHandler(authStash);
    this._primedChannels.set(link, {
      payloads,
      stash,
      authPayloads,
      authStash,
      authWaiters,
    });
  }

  /**
   * Removes the stash handlers installed by {@link Room._primeChannel} and
   * returns the Yjs payloads received before the PeerConn took over the
   * channel. Pending authorization `receive()` calls are rejected.
   * @param {import("@reticulum/core").Link} link
   * @returns {Uint8Array[]}
   */
  _unprimeChannel(link) {
    const primed = this._primedChannels.get(link);
    if (!primed) return [];
    this._primedChannels.delete(link);
    const channel = link.getChannel();
    channel.removeMessageHandler(primed.stash);
    channel.removeMessageHandler(primed.authStash);
    for (const waiter of primed.authWaiters.splice(0)) {
      waiter.reject(new Error("authorization channel closed"));
    }
    return primed.payloads;
  }

  /**
   * Runs the application-defined authorization phase on an established link:
   * hands the authorizer the link plus a send/receive exchange bound to this
   * link's channel, and races it against `authorizeTimeoutMs`. Any `false`
   * verdict, throw, or timeout refuses the link. Inbound Yjs traffic is
   * stashed by `_primeChannel` meanwhile and only delivered once the phase
   * passes, so no sync flows before the verdict.
   *
   * @param {import("@reticulum/core").Link} link
   * @param {{ remoteIdentityHash: string, remoteDestinationHash: string | null, initiator: boolean }} proven
   * @returns {Promise<{ capability: { sync: boolean, write: boolean } | null, timedOut: boolean }>}
   *   `capability: null` refuses the link (fail-closed: an authorizer that
   *   resolves `undefined` does not grant access).
   */
  async _authorizeLink(
    link,
    { remoteIdentityHash, remoteDestinationHash, initiator },
  ) {
    if (!this.authorizeLink) return { capability: null, timedOut: false };
    const primed = this._primedChannels.get(link);
    if (!primed) return { capability: null, timedOut: false };
    const channel = link.getChannel();

    /** Mirrors PeerConn._sendChannel's readiness/retry loop, for auth bytes. */
    const send = async (/** @type {Uint8Array} */ payload) => {
      const message = new LinkAuthMessage();
      message.data = payload;
      for (;;) {
        if (!this._primedChannels.has(link) || channel._shutDown) {
          throw new Error("authorization channel closed");
        }
        while (!channel.isReadyToSend()) {
          if (!this._primedChannels.has(link) || channel._shutDown) {
            throw new Error("authorization channel closed");
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        try {
          await channel.send(message);
          return;
        } catch (err) {
          if (
            err instanceof ChannelException &&
            err.type === CEType.ME_LINK_NOT_READY
          ) {
            continue; // window filled between the check and the serialized send
          }
          throw err;
        }
      }
    };

    const receive = () => {
      const queued = primed.authPayloads.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        primed.authWaiters.push({ resolve, reject });
      });
    };

    let timer = null;
    try {
      const verdict = await Promise.race([
        Promise.resolve(
          this.authorizeLink({
            link,
            remoteIdentityHash,
            remoteDestinationHash,
            initiator,
            exchange: { send, receive },
          }),
        ),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("authorization timed out")),
            this.authorizeTimeoutMs,
          );
        }),
      ]);
      return { capability: normalizeCapability(verdict), timedOut: false };
    } catch {
      return { capability: null, timedOut: true };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /**
   * Registers a newly active peer and kicks off the Yjs sync handshake
   * (syncStep1 + local awareness), mirroring y-webrtc's peer-on-connect path.
   * @param {import("@reticulum/core").Link} link
   * @param {Uint8Array|null} remoteDestHash
   * @param {string|null} remoteIdentityHash Hex truncated identity hash of
   *   the remote peer, when proven during establishment.
   * @param {{ sync: boolean, write: boolean } | null} [capability] Capability
   *   the authorization phase resolved for this peer; `null`/undefined when
   *   no authorization phase ran (full sync+write, as before).
   */
  _registerPeer(
    link,
    remoteDestHash,
    remoteIdentityHash = null,
    capability = null,
  ) {
    const stashed = this._unprimeChannel(link);
    const peer = new PeerConn({
      link,
      remoteDestHash,
      remoteIdentityHash,
      capability,
      bz2: this.bz2,
      onData: (payload, p) => this._onPeerData(payload, p),
      onClose: (p) => this._onPeerClose(p),
    });
    this.peerConns.set(peer.peerId, peer);
    this.callbacks.onPeers([peer.peerId], [], {
      [peer.peerId]: peer.remoteIdentityHash,
    });
    if (remoteIdentityHash == null) {
      // No gates configured, so identify never ran on our side — but the
      // initiator may still identify voluntarily (it does whenever it runs
      // its own policy). Record the proven hash and refresh the peers
      // event's identities map so apps see who connected.
      link.addEventListener(
        "identify",
        (/** @type {Event} */ event) => {
          const identity = /** @type {any} */ (event).detail?.identity;
          if (!identity || peer.closed) return;
          peer.remoteIdentityHash = toHex(identity.getSalt());
          this.callbacks.onPeers([], [], {
            [peer.peerId]: peer.remoteIdentityHash,
          });
        },
        { once: true },
      );
    }
    // Deliver anything the peer sent before our PeerConn existed (typically
    // its syncStep1) ahead of our own handshake so replies keep protocol order.
    for (const payload of stashed) this._onPeerData(payload, peer);
    this._sendInitialSync(peer);
  }

  /** @param {PeerConn} peer */
  _onPeerClose(peer) {
    if (!this.peerConns.delete(peer.peerId)) return;
    if (peer.remoteDestHash) {
      const remoteHex = toHex(peer.remoteDestHash);
      this.linkedDestHexes.delete(remoteHex);
      // Initiator side only: the responder (remoteDestHash === null) must not
      // re-initiate per the glare rule, so it has nothing to path-request.
      this._scheduleReconnectPathRequest(remoteHex, peer.remoteDestHash);
    }
    this.callbacks.onPeers([], [peer.peerId]);
    this._checkSynced();
  }

  /**
   * Tears down a live peer link by peer id (hex link id, as reported on the
   * `peers` event). Sync with that peer stops immediately and it is reported
   * as removed. Used when the application's authorization for a peer changes
   * after the link was established (e.g. a grant revocation).
   *
   * @param {string} peerId
   * @returns {boolean} Whether a live peer was dropped.
   */
  dropPeer(peerId) {
    const peer = this.peerConns.get(peerId);
    if (!peer) return false;
    peer.destroy();
    this._onPeerClose(peer);
    return true;
  }

  /**
   * Tears down every live peer link whose remote proved the given truncated
   * identity hash (hex). Identity-proofed peers register their hash on both
   * link sides — announce/identify on the initiator side, the signed
   * identify handshake on the responder side — so this covers peers we
   * initiated to and peers that dialed us. Peers registered without an
   * identity proof (no link policy / authorization configured) cannot be
   * matched by hash; drop those by peer id with {@link Room.dropPeer}.
   *
   * @param {string} remoteIdentityHash Hex truncated identity hash.
   * @returns {number} How many live peers were dropped.
   */
  revokePeer(remoteIdentityHash) {
    let dropped = 0;
    for (const peer of [...this.peerConns.values()]) {
      if (peer.remoteIdentityHash !== remoteIdentityHash) continue;
      peer.destroy();
      this._onPeerClose(peer);
      dropped += 1;
    }
    return dropped;
  }

  /**
   * Schedules a one-shot path request for a dropped peer so the mesh answers
   * with a fresh path-response announce, beating the periodic announce
   * cadence. Coalesces flaps to one in-flight request per peer and is a no-op
   * if the peer already came back (via a normal announce) by the time it fires.
   *
   * @param {string} remoteHex
   * @param {Uint8Array} remoteDestHash
   */
  _scheduleReconnectPathRequest(remoteHex, remoteDestHash) {
    if (!this.connected || this.pendingPathRequests.has(remoteHex)) return;
    const timer = setTimeout(() => {
      this.pendingPathRequests.delete(remoteHex);
      if (!this.connected || !this.dest) return;
      if (this.linkedDestHexes.has(remoteHex)) return; // already re-linked
      this.rns.transport.requestPath(remoteDestHash).catch(() => {});
    }, RECONNECT_PATH_REQUEST_DELAY_MS);
    this.pendingPathRequests.set(remoteHex, timer);
  }

  /**
   * Inbound raw bytes from a peer: decode and apply, send back any reply, and
   * mark the peer (and possibly the room) synced.
   * @param {Uint8Array} payload
   * @param {PeerConn} peer
   */
  _onPeerData(payload, peer) {
    const reply = readMessage(
      this.doc,
      this.awareness,
      payload,
      peer,
      this.synced,
      () => {
        peer.synced = true;
        this._checkSynced();
      },
      peer.canWrite,
    );
    if (reply) this._send(peer, reply);
  }

  /**
   * Local Doc update → broadcast a sync `update` to every peer.
   * @param {Uint8Array} update
   * @param {any} _origin
   */
  _docUpdateHandler(update, _origin) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeUpdate(encoder, update);
    this._broadcast(encoding.toUint8Array(encoder));
  }

  /**
   * Local Awareness update → broadcast an awareness update to every peer.
   * @param {{added: number[], updated: number[], removed: number[]}} changes
   * @param {any} _origin
   */
  _awarenessUpdateHandler({ added, updated, removed }, _origin) {
    const changedClients = added.concat(updated, removed);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageAwareness);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients),
    );
    this._broadcast(encoding.toUint8Array(encoder));
  }

  /**
   * Sends the initial sync handshake to a freshly connected peer: a syncStep1
   * (requesting their state) and, if we have any, our awareness state. Both
   * sides do this, so state flows both ways.
   * @param {PeerConn} peer
   */
  _sendInitialSync(peer) {
    const step1 = encoding.createEncoder();
    encoding.writeVarUint(step1, messageSync);
    syncProtocol.writeSyncStep1(step1, this.doc);
    this._send(peer, encoding.toUint8Array(step1));

    const clients = Array.from(this.awareness.getStates().keys());
    if (clients.length > 0) {
      const aw = encoding.createEncoder();
      encoding.writeVarUint(aw, messageAwareness);
      encoding.writeVarUint8Array(
        aw,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients),
      );
      this._send(peer, encoding.toUint8Array(aw));
    }
  }

  /** @param {Uint8Array} bytes */
  _broadcast(bytes) {
    for (const peer of this.peerConns.values()) this._send(peer, bytes);
  }

  /** @param {PeerConn} peer @param {Uint8Array} bytes */
  _send(peer, bytes) {
    peer.send(bytes).catch(() => {});
  }

  /**
   * Recomputes room-level sync state and emits on change. A room with no peers
   * is *not* synced — an empty mesh carries no sync guarantee — so this flips
   * back to `synced: false` when the last peer drops, rather than vacuously
   * `true`.
   */
  _checkSynced() {
    let synced = this.peerConns.size > 0;
    for (const peer of this.peerConns.values()) {
      if (!peer.synced) {
        synced = false;
        break;
      }
    }
    if (synced !== this.synced) {
      this.synced = synced;
      this.callbacks.onSynced(synced);
    }
  }
}
