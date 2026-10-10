/**
 * @file revoke.test.js
 * @description Smoketests for live-link teardown (work document #3): when the
 * application's authorization for a peer changes after a link was
 * established, `revokePeer(remoteIdentityHash)` and `dropPeer(peerId)` tear
 * the link down immediately instead of letting it sync until it happens to
 * drop.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Identity, toHex } from "@reticulum/core";
import * as Y from "yjs";
import { ReticulumProvider } from "../src/index.js";
import { nudgeAnnounce, waitFor } from "./loopback.js";

const ROOM = "y-reticulum-revoke-smoke";

/** Builds two providers whose link policies read a mutable granted set. */
async function makeGatedPair(rnsA, rnsB) {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const idA = await Identity.generate();
  const idB = await Identity.generate();
  const hashA = toHex(await Identity.truncatedHash(await idA.getPublicKey()));
  const hashB = toHex(await Identity.truncatedHash(await idB.getPublicKey()));
  // Both sides gate on the same grants so identity is proven on both ends
  // (revokePeer matches the proven hash) and a revoked peer cannot relink.
  const grantedA = new Set([hashA, hashB]);
  const grantedB = new Set([hashA, hashB]);
  const providerA = new ReticulumProvider(ROOM, docA, {
    reticulum: rnsA,
    identity: idA,
    linkPolicy: ({ remoteIdentityHash }) => grantedA.has(remoteIdentityHash),
  });
  const providerB = new ReticulumProvider(ROOM, docB, {
    reticulum: rnsB,
    identity: idB,
    linkPolicy: ({ remoteIdentityHash }) => grantedB.has(remoteIdentityHash),
  });
  return { docA, docB, hashA, hashB, grantedA, providerA, providerB };
}

test("revokePeer tears down a live link and keeps it down", {
  timeout: 45000,
}, async () => {
  const { makeLoopback } = await import("./loopback.js");
  const { rnsA, rnsB, close } = await makeLoopback();
  const { docA, docB, hashB, grantedA, providerA, providerB } =
    await makeGatedPair(rnsA, rnsB);

  await providerA.connect();
  await providerB.connect();
  await nudgeAnnounce(providerA, providerB);
  await waitFor(() => providerA.room?.peerConns.size === 1, 15000);

  docA.getMap("doc").set("before", "yes");
  await waitFor(() => docB.getMap("doc").get("before") === "yes", 15000);

  // Revoke: drop every live link to B, then refuse future relinks
  grantedA.delete(hashB);
  const dropped = providerA.revokePeer(hashB);
  assert.equal(dropped, 1, "the live link to B was dropped");
  await waitFor(() => (providerA.room?.peerConns.size ?? 0) === 0, 10000);
  await waitFor(() => (providerB.room?.peerConns.size ?? 0) === 0, 10000);

  // Post-revocation writes must not reach the revoked peer
  docA.getMap("doc").set("after", "secret");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(
    docB.getMap("doc").get("after"),
    undefined,
    "a revoked peer stops receiving updates",
  );

  // And the next announce cycle must not re-establish the link
  await nudgeAnnounce(providerA, providerB);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(
    providerA.room?.peerConns.size,
    0,
    "a revoked peer is refused on re-initiate",
  );

  await providerA.destroy().catch(() => {});
  await providerB.destroy().catch(() => {});
  await close();
});

test("dropPeer tears down by peer id; the peer may reconnect", {
  timeout: 45000,
}, async () => {
  const { makeLoopback } = await import("./loopback.js");
  const { rnsA, rnsB, close } = await makeLoopback();
  const { docA, docB, providerA, providerB } = await makeGatedPair(rnsA, rnsB);

  /** @type {string[]} */
  const addedA = [];
  providerA.on("peers", (/** @type {any} */ e) => {
    addedA.push(...(e.added ?? []));
  });

  await providerA.connect();
  await providerB.connect();
  await nudgeAnnounce(providerA, providerB);
  await waitFor(() => addedA.length > 0, 15000);
  const peerId = addedA[0];

  assert.equal(providerA.dropPeer(peerId), true, "the peer was dropped");
  assert.equal(providerA.dropPeer(peerId), false, "drop is idempotent");
  await waitFor(() => (providerA.room?.peerConns.size ?? 0) === 0, 10000);
  await waitFor(() => (providerB.room?.peerConns.size ?? 0) === 0, 10000);

  // dropPeer is an eviction, not a revocation: the still-granted peer
  // reconnects on the next announce cycle
  await nudgeAnnounce(providerA, providerB);
  await waitFor(() => (providerA.room?.peerConns.size ?? 0) === 1, 15000);
  docA.getMap("doc").set("again", "yes");
  await waitFor(() => docB.getMap("doc").get("again") === "yes", 15000);

  await providerA.destroy().catch(() => {});
  await providerB.destroy().catch(() => {});
  await close();
});
