/**
 * @file destination.js
 * @description Helpers mapping a Yjs room name to a Reticulum destination.
 *
 * Two peers that pass the same room name must arrive at the same Reticulum
 * "aspect" so they can discover each other via the Announce mechanism. We hash
 * the room name into the aspect so the cleartext name is not leaked on the wire,
 * and so the resulting 10-byte `nameHash` doubles as the room-membership filter
 * when comparing inbound announces (see SPEC.md → Discovery model).
 */
import { fromHex, Identity, toHex } from "@reticulum/core";

/**
 * App-name prefix shared by every y-reticulum sync destination. The trailing
 * segment is a hex digest of the room name (see {@link roomDestinationName}).
 */
export const DESTINATION_APP_PREFIX = "y-reticulum.sync";

/**
 * Computes the room destination hash for a peer whose identity hash the
 * application knows from its own state (work document #34): a room
 * destination is derived from the app name's hash combined with the peer's
 * identity hash — the same derivation `@reticulum/core` performs when
 * validating an announce. Knowing the destination hash lets the application
 * dial the peer directly, without waiting for announce-driven discovery.
 *
 * @param {string} roomName The Yjs room name (e.g. `noflo-ui:<uuid>`).
 * @param {string} peerIdentityHashHex Hex of the peer's 16-byte identity
 *   hash, as the application tracks it.
 * @returns {Promise<string>} Hex of the peer's 16-byte room destination
 *   hash.
 */
export async function roomDestinationHash(roomName, peerIdentityHashHex) {
  const appName = await roomDestinationName(roomName);
  const nameHashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(appName),
  );
  const nameHash = new Uint8Array(nameHashBuffer.slice(0, 10));
  const identityHash = fromHex(peerIdentityHashHex);
  const combined = new Uint8Array(nameHash.length + identityHash.length);
  combined.set(nameHash, 0);
  combined.set(identityHash, nameHash.length);
  const destinationHash = await Identity.truncatedHash(combined);
  return toHex(destinationHash);
}

/**
 * Derives the deterministic Reticulum destination app-name for a Yjs room.
 *
 * The room name is hashed (first 8 bytes of its SHA-256, rendered as 16 hex
 * chars) so the on-wire aspect does not leak the cleartext room name. Two peers
 * that pass the same `roomName` arrive at the same app-name — and therefore the
 * same 10-byte `nameHash` — which is exactly what room peer-discovery filters on
 * when comparing inbound announces.
 *
 * @param {string} roomName
 * @returns {Promise<string>} app-name like `y-reticulum.sync.<16 hex chars>`
 */
export async function roomDestinationName(roomName) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(roomName),
  );
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < 8; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return `${DESTINATION_APP_PREFIX}.${hex}`;
}
