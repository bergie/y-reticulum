/**
 * @file peer-conn.js
 * @description Wrapper around a Reticulum {@link Link} to a single Yjs peer.
 *
 * Owns link lifecycle and the low-level send/receive of raw framed bytes. It
 * carries no Yjs semantics of its own: the Room plugs the sync/awareness
 * protocol into the bytes that flow through here.
 *
 * Payloads up to the link MDU go as a single ContextType.NONE DATA packet;
 * anything larger is transported as a chunked, integrity-checked Reticulum
 * {@link Resource} (Phase 4) and reassembled before delivery, so an initial
 * doc state or a large update that would overflow a single packet still syncs.
 */
import {
  ContextType,
  DestType,
  Packet,
  PacketType,
  Resource,
  toHex,
} from "reticulum-js";

/**
 * A peer-to-peer connection over a Reticulum Link.
 *
 * Exactly one PeerConn exists per established Link. `send` writes a raw byte
 * payload — as a single DATA packet when it fits the link MDU, else as a
 * Resource. Inbound payloads arrive via the link's `data` event (small) or
 * `resource` event (large) and are forwarded to the room. The peer id is the
 * hex link_id — identical on both ends of a link, so both peers agree on the id.
 */
export class PeerConn {
  /**
   * @param {object} options
   * @param {import("reticulum-js").Link} options.link
   * @param {Uint8Array|null} options.remoteDestHash
   *   The peer's destination hash. Known on the initiator side (from the
   *   announce that triggered the link); `null` on the responder side.
   * @param {import("@digitaldefiance/bzip2-wasm").default | null} [options.bz2]
   *   Shared bzip2 provider; set on the link so inbound Resources can be
   *   decompressed, and used to compress outbound ones. `null` disables it.
   * @param {(payload: Uint8Array, peer: PeerConn) => void} options.onData
   * @param {(peer: PeerConn) => void} options.onClose
   */
  constructor({ link, remoteDestHash, bz2, onData, onClose }) {
    this.link = link;
    // The receiver decompresses via the link's bz2 (Resource.accept reads it).
    this.link.bz2 = bz2 ?? undefined;
    this.remoteDestHash = remoteDestHash;
    /** @type {import("@digitaldefiance/bzip2-wasm").default | undefined} */
    this.bz2 = bz2 ?? undefined;
    /** Hex link_id; used as the peer id (symmetric across both ends). */
    this.peerId = toHex(link.linkId);
    /** Whether the Yjs doc is synced with this peer. */
    this.synced = false;
    this.closed = false;
    this._onData = onData;
    this._onClose = onClose;

    // Small, single-packet payloads.
    link.addEventListener("data", (/** @type {any} */ event) => {
      this._onData(event.detail.packet.payload, this);
    });
    // Large, chunked payloads: reassemble, then feed the same path.
    link.addEventListener("resource", (/** @type {any} */ event) => {
      const resource = event.detail.resource;
      resource
        .whenComplete()
        .then(() => {
          if (resource.data) this._onData(resource.data, this);
        })
        .catch(() => {
          // Transfer failed (peer dropped, corrupt, rejected) — nothing to
          // deliver; the room's sync will converge on the next exchange.
        });
    });
    link.addEventListener("close", () => this._handleClose());
  }

  /**
   * Sends a raw byte payload to the peer. Small payloads go as a single DATA
   * packet; payloads larger than the link MDU travel as a chunked Resource.
   * @param {Uint8Array} payload
   */
  async send(payload) {
    if (this.closed) return;
    if (payload.length > this.link.mdu) {
      await this._sendResource(payload);
      return;
    }
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
   * Transfers `payload` as an uncompressed Reticulum Resource. Only the
   * advertisement is awaited; the chunked transfer then proceeds on the link
   * and the receiver reassembles it.
   * @param {Uint8Array} payload
   */
  async _sendResource(payload) {
    const resource = new Resource({
      data: payload,
      link: this.link,
      bz2: this.bz2,
      autoCompress: true,
    });
    await resource.advertise();
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
