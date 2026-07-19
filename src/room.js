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
import * as encoding from "lib0/encoding";
import { Destination, DestType, toHex } from "reticulum-js";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { messageAwareness, messageSync, readMessage } from "./messages.js";
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
 * @property {(synced: boolean) => void} onSynced
 *   Fired when the room's overall sync state changes.
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
   * @param {import("reticulum-js").Reticulum} options.reticulum
   * @param {import("reticulum-js").Identity} options.identity
   * @param {string} options.appName - Deterministic destination app-name for the room.
   * @param {number} options.maxConns
   * @param {number} options.announceIntervalMs
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
    callbacks,
  }) {
    this.doc = doc;
    this.awareness = awareness;
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
    /** Whether the Doc is synced with the current peer mesh. */
    this.synced = false;

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
    this._docUpdateHandler = this._docUpdateHandler.bind(this);
    this._awarenessUpdateHandler = this._awarenessUpdateHandler.bind(this);
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
    this.doc.on("update", this._docUpdateHandler);
    this.awareness.on("update", this._awarenessUpdateHandler);

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
   * Registers a newly active peer and kicks off the Yjs sync handshake
   * (syncStep1 + local awareness), mirroring y-webrtc's peer-on-connect path.
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
    this._sendInitialSync(peer);
  }

  /** @param {PeerConn} peer */
  _onPeerClose(peer) {
    if (!this.peerConns.delete(peer.peerId)) return;
    if (peer.remoteDestHash)
      this.linkedDestHexes.delete(toHex(peer.remoteDestHash));
    this.callbacks.onPeers([], [peer.peerId]);
    this._checkSynced();
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

  /** Recomputes room-level sync state and emits on change. */
  _checkSynced() {
    let synced = true;
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
