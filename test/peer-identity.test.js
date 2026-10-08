/**
 * @file peer-identity.test.js
 * @description Smoketests for peer identity propagation: the truncated
 *   identity hash a peer proved during establishment rides into peer
 *   registration (`PeerConn.remoteIdentityHash`) and out on the `peers`
 *   event as an `identities` map (peer id → hash or `null`).
 *
 *   Two scenarios:
 *   - with a link policy, both sides prove the remote identity (announce /
 *     signed identify), so both peers' entries are the peer's identity hash;
 *   - without a policy or authorization phase the responder never learns the
 *     initiator's identity, so its entry is `null` while the initiator's is
 *     announce-proven.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { Identity, toHex } from "@reticulum/core";
import * as Y from "yjs";
import { ReticulumProvider, roomDestinationHash } from "../src/index.js";
import { makeLoopback, nudgeAnnounce, waitFor } from "./loopback.js";

const ROOM = "y-reticulum-peer-identity-smoke";

/**
 * Generates an identity pair ordered so A initiates the link: the glare rule
 * lets only the peer with the lexicographically smaller room destination hash
 * initiate, and that hash is derived from (room name hash + identity hash),
 * so the ordering key is the destination hash, not the identity hash itself.
 */
async function orderedIdentities() {
  let idA = await Identity.generate();
  let idB = await Identity.generate();
  let hashA = toHex(await Identity.truncatedHash(await idA.getPublicKey()));
  let hashB = toHex(await Identity.truncatedHash(await idB.getPublicKey()));
  while (
    (await roomDestinationHash(ROOM, hashA)) >=
    (await roomDestinationHash(ROOM, hashB))
  ) {
    idA = await Identity.generate();
    idB = await Identity.generate();
    hashA = toHex(await Identity.truncatedHash(await idA.getPublicKey()));
    hashB = toHex(await Identity.truncatedHash(await idB.getPublicKey()));
  }
  return { idA, idB, hashA, hashB };
}

/** Collects `peers` events into an array. @param {any} provider */
function trackPeers(provider) {
  /** @type {any[]} */
  const events = [];
  provider.on("peers", (/** @type {any} */ e) => events.push(e));
  return events;
}

test("with a link policy, both peers carry the remote's proven identity hash", {
  timeout: 30000,
}, async () => {
  const { idA, idB, hashA, hashB } = await orderedIdentities();
  const { rnsA, rnsB, close } = await makeLoopback();
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
  const peersA = trackPeers(providerA);
  const peersB = trackPeers(providerB);

  await providerA.connect();
  await providerB.connect();
  await nudgeAnnounce(providerA, providerB);
  await waitFor(() => providerA.room?.peerConns.size === 1, 10000);
  await waitFor(() => providerB.room?.peerConns.size === 1, 10000);

  // Both ends registered the same link id, each knowing the remote's identity
  const [connA] = [...(providerA.room?.peerConns.values() ?? [])];
  const [connB] = [...(providerB.room?.peerConns.values() ?? [])];
  assert.equal(connA.peerId, connB.peerId, "peer ids are symmetric");
  assert.equal(connA.remoteIdentityHash, hashB, "initiator knows B's identity");
  assert.equal(
    connB.remoteIdentityHash,
    hashA,
    "responder knows A's identity from the signed identify",
  );

  // The peers event carries the identity map for the added peer
  await waitFor(() => peersA.length > 0 && peersB.length > 0, 5000);
  assert.deepEqual(peersA[0].identities, { [connA.peerId]: hashB });
  assert.deepEqual(peersB[0].identities, { [connB.peerId]: hashA });
  assert.deepEqual(peersA[0].added, [connA.peerId]);
  assert.deepEqual(peersA[0].removed, []);

  await providerA.destroy().catch(() => {});
  await providerB.destroy().catch(() => {});
  await close();
});

test("without a policy, the responder's identity entry is null", {
  timeout: 30000,
}, async () => {
  // A initiates (smaller room destination hash): it proved B's identity from
  // the announce, but B never proves A's — no identify handshake runs
  // without a policy.
  const { idA, idB, hashB } = await orderedIdentities();
  const { rnsA, rnsB, close } = await makeLoopback();
  const providerA = new ReticulumProvider(ROOM, new Y.Doc(), {
    reticulum: rnsA,
    identity: idA,
  });
  const providerB = new ReticulumProvider(ROOM, new Y.Doc(), {
    reticulum: rnsB,
    identity: idB,
  });
  const peersA = trackPeers(providerA);
  const peersB = trackPeers(providerB);

  await providerA.connect();
  await providerB.connect();
  await nudgeAnnounce(providerA, providerB);
  await waitFor(() => providerA.room?.peerConns.size === 1, 10000);
  await waitFor(() => providerB.room?.peerConns.size === 1, 10000);

  const [connA] = [...(providerA.room?.peerConns.values() ?? [])];
  const [connB] = [...(providerB.room?.peerConns.values() ?? [])];
  assert.equal(connA.peerId, connB.peerId, "peer ids are symmetric");
  assert.equal(connA.remoteIdentityHash, hashB, "initiator knows B's identity");
  assert.equal(
    connB.remoteIdentityHash,
    null,
    "responder never proved A's identity",
  );

  await waitFor(() => peersA.length > 0 && peersB.length > 0, 5000);
  assert.deepEqual(peersA[0].identities, { [connA.peerId]: hashB });
  assert.deepEqual(peersB[0].identities, { [connB.peerId]: null });

  await providerA.destroy().catch(() => {});
  await providerB.destroy().catch(() => {});
  await close();
});
