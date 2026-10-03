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

import { Destination, DestType, Identity, toHex } from "@reticulum/core";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { getCompressionProvider } from "./compression.js";
import { messageAwareness, messageSync, readMessage } from "./messages.js";
import { PeerConn } from "./peer-conn.js";

/**
 * Delay after a peer Link drops before the initiator re-requests the peer's
 * path, accelerating re-discovery beyond the periodic announce cadence. Small
 * enough to beat the default announce interval, large enough to skip transient
 * blips and to no-op if the peer comes back via the next announce first.
 */
const RECONNECT_PATH_REQUEST_DELAY_MS = 1500;

/** Constant-time-ish equality for two equal-length byte arrays. */
function bytesEqual(/** @type {Uint8Array} */ a, /** @type {Uint8Array} */ b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
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
 * @typedef {Object} RoomCallbacks
 * @property {(added: string[], removed: string[]) => void} onPeers
 *   Fired whenever peers are discovered or drop off. Ids are hex link_ids.
 * @property {(synced: boolean) => void} onSynced
 *   Fired when the room's overall sync state changes.
 * @property {(refusals: Array<{ destinationHash: string | null, identityHash: string | null, initiator: boolean }>) => void} [onRefused]
 *   Fired when a peer link was refused by the link policy. Apps can use this
 *   to surface access requests (e.g. "peer X wants to join").
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
    this.callbacks = callbacks;

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

    this.connected = true;
  }

  /** Stops announcing, tears down all peer links, and unbinds the destination. */
  async disconnect() {
    if (!this.connected) return;
    this.connected = false;

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
    if (removed.length) this.callbacks.onPeers([], removed);

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
    if (this.peerConns.size >= this.maxConns) return;
    if (
      this.linkedDestHexes.has(remoteHex) ||
      this.pendingInitiates.has(remoteHex)
    ) {
      return;
    }
    // Glare avoidance: only the lexicographically smaller destination initiates.
    if (this.myHex > remoteHex) return;

    // De-bounce before the policy runs: announces repeat, and a slow (e.g.
    // interactive) policy must not let concurrent announces each open a Link.
    this.pendingInitiates.add(remoteHex);

    // Link policy (initiator side): the announce cryptographically binds the
    // remote identity, so the policy can run before any link is opened.
    if (this.linkPolicy) {
      const initiatorIdentityHash = toHex(
        await Identity.truncatedHash(detail.identity.publicKey),
      );
      const allowed = await this.linkPolicy({
        remoteIdentityHash: initiatorIdentityHash,
        remoteDestinationHash: remoteHex,
        initiator: true,
      });
      if (!allowed) {
        this.pendingInitiates.delete(remoteHex);
        this.callbacks.onRefused?.([
          {
            destinationHash: remoteHex,
            identityHash: initiatorIdentityHash,
            initiator: true,
          },
        ]);
        return;
      }
    }

    try {
      const out = await Destination.OUT(
        this.appName,
        DestType.SINGLE,
        detail.identity,
        this.rns,
      );
      const link = await out.createLink();
      if (!this.connected) {
        await link.teardown();
        return;
      }
      // With a policy, prove our identity to the responder before any room
      // traffic: their policy cannot evaluate us until we do
      if (this.linkPolicy) {
        await link.identify(this.identity);
      }
      this.linkedDestHexes.add(remoteHex);
      this._registerPeer(link, detail.destinationHash);
    } catch {
      // Peer vanished mid-handshake, transport error, etc. — the announce loop
      // will retry on the next announce if the peer is still around.
    } finally {
      this.pendingInitiates.delete(remoteHex);
    }
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
    const packet = /** @type {any} */ (event).detail.packet;
    try {
      const link = await this.dest.acceptLink(packet);
      if (!this.connected) {
        await link.teardown();
        return;
      }
      if (this.linkPolicy) {
        const identityHash = await this._awaitIdentify(link);
        if (!identityHash) {
          // The peer never proved who they are: refuse without ceremony
          await link.teardown();
          this.callbacks.onRefused?.([
            { destinationHash: null, identityHash: null, initiator: false },
          ]);
          return;
        }
        const allowed = await this.linkPolicy({
          remoteIdentityHash: identityHash,
          remoteDestinationHash: null,
          initiator: false,
        });
        if (!allowed) {
          await link.teardown();
          this.callbacks.onRefused?.([
            { destinationHash: null, identityHash, initiator: false },
          ]);
          return;
        }
      }
      this._registerPeer(link, null);
    } catch {
      // Handshake failed; nothing to clean up.
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
   * Registers a newly active peer and kicks off the Yjs sync handshake
   * (syncStep1 + local awareness), mirroring y-webrtc's peer-on-connect path.
   * @param {import("@reticulum/core").Link} link
   * @param {Uint8Array|null} remoteDestHash
   */
  _registerPeer(link, remoteDestHash) {
    const peer = new PeerConn({
      link,
      remoteDestHash,
      bz2: this.bz2,
      onData: (payload, p) => this._onPeerData(payload, p),
      onClose: (p) => this._onPeerClose(p),
    });
    this.peerConns.set(peer.peerId, peer);
    this.callbacks.onPeers([peer.peerId], []);
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
