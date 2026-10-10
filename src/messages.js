/**
 * @file messages.js
 * @description The Yjs sync wire protocol used over a peer Link.
 *
 * This is y-webrtc's framing, minus its BroadcastChannel peer-id message
 * (tag 4) which has no Reticulum equivalent. Each message is a 1-byte tag
 * followed by a lib0-encoded body:
 *
 *   0  sync        — carries syncStep1 / syncStep2 / update (y-protocols/sync)
 *   1  awareness   — an awareness update (y-protocols/awareness)
 *   3  queryAwareness — request the peer's full awareness state
 *
 * Bytes flow through {@link PeerConn}; this module only knows how to decode
 * them and apply them to a Doc / Awareness.
 */
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";

/** @type {0} */
export const messageSync = 0;
/** @type {1} */
export const messageAwareness = 1;
/** @type {3} */
export const messageQueryAwareness = 3;

/**
 * Decodes one inbound framed message, applying it to the doc / awareness, and
 * returns the bytes of a reply to send back to the same peer (or `null`).
 *
 * Mirrors y-webrtc's `readMessage`: a `syncStep1` requests our state and so
 * produces a `syncStep2` reply; a `syncStep2` delivers the peer's state and
 * marks the room synced (once, via `onSynced`); `queryAwareness` produces an
 * awareness reply.
 *
 * @param {import("yjs").Doc} doc
 * @param {awarenessProtocol.Awareness} awareness
 * @param {Uint8Array} buf
 * @param {any} origin - transactionOrigin for any updates this applies.
 * @param {boolean} roomSynced - whether the room is already synced (gates the
 *   one-shot `onSynced` callback, matching y-webrtc).
 * @param {() => void} onSynced - invoked once when a syncStep2 first arrives.
 * @param {boolean} [canWrite=true] - whether the sending peer may modify the
 *   local Doc. `false` gates the write direction only: the peer's syncStep2 /
 *   update payloads are dropped unread (their state never reaches this Doc),
 *   while a syncStep1 still earns a syncStep2 reply (a read-only peer may
 *   read our state) and awareness still flows both ways.
 * @returns {Uint8Array | null} reply bytes, or `null` when no reply is needed.
 */
export function readMessage(
  doc,
  awareness,
  buf,
  origin,
  roomSynced,
  onSynced,
  canWrite = true,
) {
  const decoder = decoding.createDecoder(buf);
  const encoder = encoding.createEncoder();
  const messageType = decoding.readVarUint(decoder);
  let sendReply = false;
  switch (messageType) {
    case messageSync: {
      encoding.writeVarUint(encoder, messageSync);
      if (!canWrite) {
        // Write-gated peer: replicate only the read half of the sync protocol
        // by hand. A syncStep1 requests our state and earns a (state-vector-
        // scoped) syncStep2 reply; a syncStep2/update carries THEIR state,
        // which must never reach this Doc, so it is dropped. The handshake
        // still counts as synced: the peer did deliver its state, we chose
        // not to adopt it.
        const syncMessageType = decoding.readVarUint(decoder);
        if (syncMessageType === syncProtocol.messageYjsSyncStep1) {
          const stateVector = decoding.readVarUint8Array(decoder);
          syncProtocol.writeSyncStep2(encoder, doc, stateVector);
          sendReply = true;
        } else if (
          syncMessageType === syncProtocol.messageYjsSyncStep2 &&
          !roomSynced
        ) {
          onSynced();
        }
        break;
      }
      const syncMessageType = syncProtocol.readSyncMessage(
        decoder,
        encoder,
        doc,
        origin,
      );
      if (syncMessageType === syncProtocol.messageYjsSyncStep2 && !roomSynced) {
        onSynced();
      }
      if (syncMessageType === syncProtocol.messageYjsSyncStep1) {
        sendReply = true;
      }
      break;
    }
    case messageQueryAwareness:
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(
          awareness,
          Array.from(awareness.getStates().keys()),
        ),
      );
      sendReply = true;
      break;
    case messageAwareness:
      awarenessProtocol.applyAwarenessUpdate(
        awareness,
        decoding.readVarUint8Array(decoder),
        origin,
      );
      break;
    default:
      return null;
  }
  return sendReply ? encoding.toUint8Array(encoder) : null;
}
