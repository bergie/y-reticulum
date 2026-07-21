/**
 * @file peer-conn.smoke.js
 * @description Channel transport smoketest for {@link PeerConn}.
 *
 * Establishes a single Link between two in-process Reticulum instances (over a
 * TCP loopback), wraps each end in a PeerConn, and verifies the two send paths:
 *
 *   - small payloads (≤ the channel MDU) round-trip as reliable Channel
 *     messages, in both directions;
 *   - a payload larger than the channel MDU is delivered via a chunked,
 *     compressed Reticulum Resource.
 *
 * No Yjs machinery — this pins the PeerConn transport layer directly.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Destination, DestType, Identity } from "reticulum-js";
import {
  getCompressionProvider,
  PeerConn,
  roomDestinationName,
} from "../src/index.js";
import { makeLoopback, waitFor } from "./loopback.js";

const ROOM = "y-reticulum-peer-conn-smoke";

/** Constant-time-ish equality for two Uint8Arrays of equal length. */
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Resolves with the first validated announce on `rns` whose `nameHash` matches
 * `roomNameHash` (a peer in the same room).
 * @param {import("reticulum-js").Reticulum} rns
 * @param {Uint8Array} roomNameHash
 * @returns {Promise<{ destinationHash: Uint8Array, identity: Identity }>}
 */
function waitForPeer(rns, roomNameHash) {
  return new Promise((resolve) => {
    const listener = (/** @type {any} */ event) => {
      const detail = event.detail;
      if (
        bytesEqual(/** @type {Uint8Array} */ (detail.nameHash), roomNameHash)
      ) {
        rns.transport.removeEventListener("announce", listener);
        resolve({
          destinationHash: detail.destinationHash,
          identity: detail.identity,
        });
      }
    };
    rns.transport.addEventListener("announce", listener);
  });
}

test("PeerConn exchanges small payloads over the Channel and large over a Resource", {
  timeout: 15000,
}, async () => {
  const { rnsA, rnsB, close } = await makeLoopback();
  const bz2 = await getCompressionProvider();
  const appName = await roomDestinationName(ROOM);

  const idA = await Identity.generate();
  const idB = await Identity.generate();
  const destA = await Destination.IN(appName, DestType.SINGLE, idA, rnsA);
  rnsA.transport.bindLocalDestination(destA);
  const destB = await Destination.IN(appName, DestType.SINGLE, idB, rnsB);
  rnsB.transport.bindLocalDestination(destB);

  // Discover each other before opening a link.
  const aSeesB = waitForPeer(rnsA, destB.nameHash);
  const bSeesA = waitForPeer(rnsB, destA.nameHash);
  await destA.announce();
  await destB.announce();
  const peerBOnA = await aSeesB;
  const peerAOnB = await bSeesA;

  /** @type {PeerConn | null} */ let connA = null;
  /** @type {Uint8Array[]} */ const aReceived = [];

  // A is the responder: accept the link and wrap it.
  destA.addEventListener("link_request", async (/** @type {any} */ event) => {
    const link = await destA.acceptLink(event.detail.packet);
    connA = new PeerConn({
      link,
      remoteDestHash: null,
      bz2,
      onData: (payload) => {
        aReceived.push(payload);
      },
      onClose: () => {},
    });
  });

  // B is the initiator: open the link and wrap it.
  const outDest = await Destination.OUT(
    appName,
    DestType.SINGLE,
    peerAOnB.identity,
    rnsB,
  );
  const linkB = await outDest.createLink();
  /** @type {Uint8Array[]} */ const bReceived = [];
  const connB = new PeerConn({
    link: linkB,
    remoteDestHash: peerBOnA.destinationHash,
    bz2,
    onData: (payload) => {
      bReceived.push(payload);
    },
    onClose: () => {},
  });

  await waitFor(() => connA != null, 5000);
  const connALocal = /** @type {PeerConn} */ (connA);

  // Sanity: the channel is wired up and its MDU is below the link MDU.
  assert.ok(connB.channel.mdu > 0);
  assert.ok(connB.channel.mdu < linkB.mdu);

  // --- Small payloads round-trip over the Channel (both directions) -----
  const small = new Uint8Array([1, 2, 3, 4, 5]);
  await connB.send(small); // B → A
  await waitFor(() => aReceived.length >= 1, 5000);
  assert.deepEqual(aReceived[0], small);

  await connALocal.send(small); // A → B
  await waitFor(() => bReceived.length >= 1, 5000);
  assert.deepEqual(bReceived[0], small);

  // --- A payload larger than the channel MDU travels as a Resource ------
  const large = new Uint8Array(2000);
  for (let i = 0; i < large.length; i++) large[i] = i & 0xff;
  assert.ok(
    large.length > connB.channel.mdu,
    "fixture must exceed channel MDU",
  );
  await connB.send(large); // B → A
  await waitFor(() => aReceived.some((p) => p.length === large.length), 8000);
  const gotLarge = aReceived.find((p) => p.length === large.length);
  assert.deepEqual(gotLarge, large);

  connALocal.destroy();
  connB.destroy();
  await close();
});
