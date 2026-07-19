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

/**
 * App-name prefix shared by every y-reticulum sync destination. The trailing
 * segment is a hex digest of the room name (see {@link roomDestinationName}).
 */
export const DESTINATION_APP_PREFIX = "y-reticulum.sync";

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
