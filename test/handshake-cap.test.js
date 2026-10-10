/**
 * @file handshake-cap.test.js
 * @description Smoketests for the in-flight inbound handshake cap (work
 * document #3): links held in the identify / policy / authorization phases
 * are not yet registered peers, so `maxConns` alone does not bound how many
 * ungranted peers can hold simultaneous handshakes. The room caps in-flight
 * handshakes separately, and the counter must return to zero on every path.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Identity, toHex } from "@reticulum/core";
import * as Y from "yjs";
import { ReticulumProvider, roomDestinationHash } from "../src/index.js";
import { nudgeAnnounce, waitFor } from "./loopback.js";

const ROOM = "y-reticulum-handshake-cap-smoke";

/**
 * Builds a provider pair whose room destination hashes force B (the smaller
 * destination hash) to initiate, so A is the responder whose handshake cap is
 * under test. The glare rule compares DESTINATION hashes (a hash of the room
 * name plus the identity hash), so the loop must run on those — identity-hash
 * ordering does not determine who initiates.
 */
async function makeResponderPair(rnsA, rnsB) {
  let idA = await Identity.generate();
  let idB = await Identity.generate();
  let hashA = toHex(await Identity.truncatedHash(await idA.getPublicKey()));
  let hashB = toHex(await Identity.truncatedHash(await idB.getPublicKey()));
  let destA = await roomDestinationHash(ROOM, hashA);
  let destB = await roomDestinationHash(ROOM, hashB);
  while (destA <= destB) {
    idA = await Identity.generate();
    idB = await Identity.generate();
    hashA = toHex(await Identity.truncatedHash(await idA.getPublicKey()));
    hashB = toHex(await Identity.truncatedHash(await idB.getPublicKey()));
    destA = await roomDestinationHash(ROOM, hashA);
    destB = await roomDestinationHash(ROOM, hashB);
  }
  const providerA = new ReticulumProvider(ROOM, new Y.Doc(), {
    reticulum: rnsA,
    identity: idA,
    linkPolicy: () => true,
  });
  const providerB = new ReticulumProvider(ROOM, new Y.Doc(), {
    reticulum: rnsB,
    identity: idB,
    linkPolicy: () => true,
  });
  return { hashA, hashB, providerA, providerB };
}

test("a zero in-flight handshake cap refuses inbound links", {
  timeout: 45000,
}, async () => {
  const { makeLoopback } = await import("./loopback.js");
  const { rnsA, rnsB, close } = await makeLoopback();
  const { providerA, providerB } = await makeResponderPair(rnsA, rnsB);

  await providerA.connect();
  // White-box: lower the cap to zero after A's room destination is live, so
  // every inbound link request is ignored before acceptLink.
  providerA.room.maxInFlightHandshakes = 0;
  await providerB.connect();
  await nudgeAnnounce(providerA, providerB);

  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.equal(
    providerA.room?.peerConns.size,
    0,
    "a capped responder registers no peers",
  );
  assert.equal(
    providerB.room?.peerConns.size,
    0,
    "the capped responder never completes the initiator's link",
  );
  assert.equal(
    providerA.room?.inFlightHandshakes,
    0,
    "ignored requests do not leak in-flight handshake slots",
  );

  await providerA.destroy().catch(() => {});
  await providerB.destroy().catch(() => {});
  await close();
});

test("the handshake counter returns to zero after a successful link", {
  timeout: 45000,
}, async () => {
  const { makeLoopback } = await import("./loopback.js");
  const { rnsA, rnsB, close } = await makeLoopback();
  const { providerA, providerB } = await makeResponderPair(rnsA, rnsB);

  await providerA.connect();
  await providerB.connect();
  await nudgeAnnounce(providerA, providerB);
  await waitFor(() => providerA.room?.peerConns.size === 1, 15000);
  assert.equal(
    providerA.room?.inFlightHandshakes,
    0,
    "completed handshakes release their slot",
  );

  await providerA.destroy().catch(() => {});
  await providerB.destroy().catch(() => {});
  await close();
});
