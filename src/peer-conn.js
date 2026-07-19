/**
 * @file peer-conn.js
 * @description Wrapper around a Reticulum {@link Link} to a single Yjs peer.
 *
 * Owns link lifecycle and the low-level send/receive of raw framed bytes. It
 * carries no Yjs semantics of its own: Phase 3 plugs the sync/awareness
 * protocol into the bytes that flow through here.
 */
import { ContextType, DestType, Packet, PacketType, toHex } from "reticulum-js";

/**
 * A peer-to-peer connection over a Reticulum Link.
 *
 * Exactly one PeerConn exists per established Link. `send` writes a raw byte
 * payload as a ContextType.NONE DATA packet; inbound payloads arrive via the
 * link's `data` event and are forwarded to the room. The peer id is the hex
 * link_id — identical on both ends of a link, so both peers agree on the id.
 */
export class PeerConn {
  /**
   * @param {object} options
   * @param {import("reticulum-js").Link} options.link
   * @param {Uint8Array|null} options.remoteDestHash
   *   The peer's destination hash. Known on the initiator side (from the
   *   announce that triggered the link); `null` on the responder side.
   * @param {(payload: Uint8Array, peer: PeerConn) => void} options.onData
   * @param {(peer: PeerConn) => void} options.onClose
   */
  constructor({ link, remoteDestHash, onData, onClose }) {
    this.link = link;
    this.remoteDestHash = remoteDestHash;
    /** Hex link_id; used as the peer id (symmetric across both ends). */
    this.peerId = toHex(link.linkId);
    /** Whether the Yjs doc is synced with this peer (set in Phase 3). */
    this.synced = false;
    this.closed = false;
    this._onData = onData;
    this._onClose = onClose;

    link.addEventListener("data", (/** @type {any} */ event) => {
      this._onData(event.detail.packet.payload, this);
    });
    link.addEventListener("close", () => this._handleClose());
  }

  /**
   * Sends a raw byte payload to the peer.
   * @param {Uint8Array} payload
   */
  async send(payload) {
    if (this.closed) return;
    await this.link.send(
      new Packet({
        packetType: PacketType.DATA,
        destinationType: DestType.LINK,
        destinationHash: this.link.linkId,
        contextByte: ContextType.NONE,
        payload,
      }),
    );
  }

  /**
   * Silently tears down the link (does not invoke `onClose` — the caller is
   * responsible for bookkeeping, e.g. a bulk disconnect).
   */
  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.link.teardown().catch(() => {});
  }

  /** Internal: a `close` event arrived from the link (peer dropped / timeout). */
  _handleClose() {
    if (this.closed) return;
    this.closed = true;
    this._onClose(this);
  }
}
