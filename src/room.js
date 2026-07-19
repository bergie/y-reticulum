/**
 * @file room.js
 * @description The per-room mesh for a {@link ReticulumProvider}.
 *
 * A Room owns the local Reticulum destination for a Yjs room, announces it for
 * discovery, learns peers from their announces, and maintains a pairwise
 * {@link PeerConn} (Link) to each one. It is transport-only: it establishes
 * the peer mesh and emits peer add/remove, but does not yet exchange Yjs sync
 * messages (that lands in Phase 3).
 *
 * To avoid the two peers both trying to open a Link to each other (WebRTC
 * "glare"), exactly one side initiates: the peer whose destination hash is
 * lexicographically smaller. The other simply accepts.
 */
import { Destination, DestType, toHex } from "reticulum-js";
import { PeerConn } from "./peer-conn.js";

/** Constant-time-ish equality for two equal-length byte arrays. */
function bytesEqual(/** @type {Uint8Array} */ a, /** @type {Uint8Array} */ b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * @typedef {Object} RoomCallbacks
 * @property {(added: string[], removed: string[]) => void} onPeers
 *   Fired whenever peers are discovered or drop off. Ids are hex link_ids.
 */

/**
 * One Yjs room: a local destination that announces for discovery, plus the
 * set of pairwise {@link PeerConn} links to discovered peers. Transport-only —
 * no Yjs sync happens here yet.
 */
export class Room {
  /**
   * @param {object} options
   * @param {import("reticulum-js").Reticulum} options.reticulum
   * @param {import("reticulum-js").Identity} options.identity
   * @param {string} options.appName - Deterministic destination app-name for the room.
   * @param {number} options.maxConns
   * @param {number} options.announceIntervalMs
   * @param {RoomCallbacks} options.callbacks
   */
  constructor({
    reticulum,
    identity,
    appName,
    maxConns,
    announceIntervalMs,
    callbacks,
  }) {
    this.rns = reticulum;
    this.identity = identity;
    this.appName = appName;
    this.maxConns = maxConns;
    this.announceIntervalMs = announceIntervalMs;
    this.callbacks = callbacks;

    /** @type {import("reticulum-js").Destination|null} */
    this.dest = null;
    /** Hex of this room destination's hash; set once connected. */
    this.myHex = "";
    this.connected = false;

    /** @type {Map<string, PeerConn>} hex link_id → conn */
    this.peerConns = new Map();
    /** Destination hashes we currently have an outgoing link to (initiator side). */
    this.linkedDestHexes = new Set();
    /** Destination hashes with an in-flight createLink() (de-bounces announces). */
    this.pendingInitiates = new Set();

    /** @type {ReturnType<typeof setInterval>|null} */
    this.announceTimer = null;

    this._onAnnounce = this._onAnnounce.bind(this);
    this._onLinkRequest = this._onLinkRequest.bind(this);
  }

  /** Creates + binds the room destination, announces, and starts discovery. */
  async connect() {
    if (this.connected) return;
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

    await this.dest.announce();
    this.announceTimer = setInterval(() => {
      this.dest?.announce().catch(() => {});
    }, this.announceIntervalMs);

    this.connected = true;
  }

  /** Stops announcing, tears down all peer links, and unbinds the destination. */
  async disconnect() {
    if (!this.connected) return;
    this.connected = false;

    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }
    this.rns.transport.removeEventListener("announce", this._onAnnounce);
    this.dest?.removeEventListener("link_request", this._onLinkRequest);

    const removed = [...this.peerConns.keys()];
    for (const conn of this.peerConns.values()) conn.destroy();
    this.peerConns.clear();
    this.linkedDestHexes.clear();
    this.pendingInitiates.clear();
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

    this.pendingInitiates.add(remoteHex);
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
   * Responder path: a peer is opening a Link to us. Accept it.
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
      this._registerPeer(link, null);
    } catch {
      // Handshake failed; nothing to clean up.
    }
  }

  /**
   * @param {import("reticulum-js").Link} link
   * @param {Uint8Array|null} remoteDestHash
   */
  _registerPeer(link, remoteDestHash) {
    const peer = new PeerConn({
      link,
      remoteDestHash,
      onData: (payload, p) => this._onPeerData(payload, p),
      onClose: (p) => this._onPeerClose(p),
    });
    this.peerConns.set(peer.peerId, peer);
    this.callbacks.onPeers([peer.peerId], []);
  }

  /** @param {PeerConn} peer */
  _onPeerClose(peer) {
    if (!this.peerConns.delete(peer.peerId)) return;
    if (peer.remoteDestHash)
      this.linkedDestHexes.delete(toHex(peer.remoteDestHash));
    this.callbacks.onPeers([], [peer.peerId]);
  }

  /**
   * Inbound raw bytes from a peer. Phase 2 has no sync protocol yet, so this is
   * a no-op; Phase 3 decodes the Yjs message tag here.
   * @param {Uint8Array} _payload
   * @param {PeerConn} _peer
   */
  _onPeerData(_payload, _peer) {}
}
