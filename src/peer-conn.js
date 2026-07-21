/**
 * @file peer-conn.js
 * @description Wrapper around a Reticulum {@link Link} to a single Yjs peer.
 *
 * Owns link lifecycle and the low-level send/receive of raw framed bytes. It
 * carries no Yjs semantics of its own: the Room plugs the sync/awareness
 * protocol into the bytes that flow through here.
 *
 * Small payloads travel as reliable {@link Channel} messages: the channel adds
 * automatic retries, send-window flow control, and in-order / dedup'd delivery
 * over the link, so a sync update or awareness change dropped on a lossy hop is
 * retransmitted rather than lost. Payloads larger than the channel MDU (an
 * initial doc state or a large update) cannot fit in a single channel message
 * and are instead transported as a chunked, integrity-checked, bz2-compressed
 * Reticulum {@link Resource}, reassembled before delivery.
 */
import {
  CEType,
  ChannelException,
  MessageBase,
  Resource,
  toHex,
} from "reticulum-js";

/**
 * Application message type used on every y-reticulum {@link Channel}. Its body
 * is a single raw Yjs wire frame (the y-webrtc tag + lib0 payload), carried
 * verbatim — the channel envelope adds the framing Reticulum needs for
 * reliability, ordering, and flow control, so nothing here touches the Yjs
 * bytes.
 *
 * @extends {MessageBase}
 */
class YjsSyncMessage extends MessageBase {
  /** Unique y-reticulum message type on the channel (< 0xf000). */
  static MSGTYPE = 0x0001;

  constructor() {
    super();
    /** @type {Uint8Array} */
    this.data = new Uint8Array(0);
  }

  /** @returns {Uint8Array} */
  pack() {
    return this.data;
  }

  /** @param {Uint8Array} raw */
  unpack(raw) {
    this.data = raw;
  }
}

/**
 * A peer-to-peer connection over a Reticulum Link.
 *
 * Exactly one PeerConn exists per established Link. `send` writes a raw byte
 * payload — as a reliable Channel message when it fits the channel MDU, else as
 * a compressed Resource. Inbound payloads arrive via the channel's message
 * handler (small) or the link's `resource` event (large) and are forwarded to
 * the room. The peer id is the hex link_id — identical on both ends of a link,
 * so both peers agree on the id.
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
    /** Reliable typed-message channel over the link (retries + flow control). */
    this.channel = link.getChannel();
    this.channel.registerMessageType(YjsSyncMessage);
    this._onChannelMessage = this._onChannelMessage.bind(this);
    this.channel.addMessageHandler(this._onChannelMessage);
    /** Hex link_id; used as the peer id (symmetric across both ends). */
    this.peerId = toHex(link.linkId);
    /** Whether the Yjs doc is synced with this peer. */
    this.synced = false;
    this.closed = false;
    this._onData = onData;
    this._onClose = onClose;

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
   * Inbound Yjs channel message: forward the raw body to the room. Returns
   * `true` to claim the message (no other handlers are registered).
   * @param {import("reticulum-js").MessageBase} msg
   * @returns {boolean}
   */
  _onChannelMessage(msg) {
    if (!(msg instanceof YjsSyncMessage)) return false;
    this._onData(msg.data, this);
    return true;
  }

  /**
   * Sends a raw byte payload to the peer. Small payloads go as a reliable
   * Channel message (waiting for the send window if it is momentarily full);
   * payloads larger than the channel MDU travel as a compressed Resource.
   * @param {Uint8Array} payload
   */
  async send(payload) {
    if (this.closed) return;
    if (payload.length > this.channel.mdu) {
      await this._sendResource(payload);
      return;
    }
    await this._sendChannel(payload);
  }

  /**
   * Sends `payload` as a reliable Channel message. Waits while the send window
   * is full (backpressure) and re-arms if the window fills between the readiness
   * check and the serialized send — matching the library's buffer-layer loop.
   * @param {Uint8Array} payload
   */
  async _sendChannel(payload) {
    const message = new YjsSyncMessage();
    message.data = payload;
    for (;;) {
      if (this.closed || this.channel._shutDown) return;
      while (!this.channel.isReadyToSend()) {
        if (this.closed || this.channel._shutDown) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      try {
        await this.channel.send(message);
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
  }

  /**
   * Transfers `payload` as a chunked Reticulum Resource, bz2-compressed when
   * that shrinks it. Only the advertisement is awaited; the chunked transfer
   * then proceeds on the link and the receiver reassembles (and decompresses)
   * it before delivery.
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
