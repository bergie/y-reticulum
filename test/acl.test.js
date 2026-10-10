import assert from "node:assert/strict";
import test from "node:test";

import { Identity, toHex } from "@reticulum/core";
import * as Y from "yjs";
import { ReticulumProvider, roomDestinationHash } from "../src/index.js";
import { nudgeAnnounce } from "./loopback.js";

const ROOM = "y-reticulum-acl-smoke";

/** Polls `cond()` every 50ms until true, rejecting after `timeoutMs`. */
function waitFor(cond, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (cond()) return resolve(undefined);
      if (Date.now() >= deadline) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

test("link policy gates sync: granted peers sync, refused peers do not", {
  timeout: 30000,
}, async () => {
  const { makeLoopback } = await import("./loopback.js");
  const { rnsA, rnsB, close } = await makeLoopback();
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const idA = await Identity.generate();
  const idB = await Identity.generate();
  const hashA = toHex(await Identity.truncatedHash(await idA.getPublicKey()));
  const hashB = toHex(await Identity.truncatedHash(await idB.getPublicKey()));

  // A grants itself (owner) and nobody else: B must be refused
  const granted = new Set([hashA]);
  /** @type {any[]} */
  const refusals = [];
  const providerA = new ReticulumProvider(ROOM, docA, {
    reticulum: rnsA,
    identity: idA,
    linkPolicy: ({ remoteIdentityHash }) => granted.has(remoteIdentityHash),
  });
  providerA.on("refused", (/** @type {any} */ e) => {
    refusals.push(...e.refusals);
  });
  const providerB = new ReticulumProvider(ROOM, docB, {
    reticulum: rnsB,
    identity: idB,
    linkPolicy: () => true,
  });

  await providerA.connect();
  await providerB.connect();
  await nudgeAnnounce(providerA, providerB);

  // B's edit must NOT reach A while B is ungranted (either direction of the
  // link was refused)
  docB.getMap("doc").set("intruder", "yes");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(
    docA.getMap("doc").get("intruder"),
    undefined,
    "ungranted peer's data never arrives",
  );

  // The owner sees the refusal with B's identity hash: a join request
  await waitFor(() => refusals.some((r) => r.identityHash === hashB), 10000);

  // Owner grants B; the next announce cycle connects them
  granted.add(hashB);
  await nudgeAnnounce(providerA, providerB);
  await waitFor(() => docA.getMap("doc").get("intruder") === "yes", 15000);
  assert.equal(
    docA.getMap("doc").get("intruder"),
    "yes",
    "granted peer's data now syncs",
  );

  await providerA.destroy().catch(() => {});
  await providerB.destroy().catch(() => {});
  await close();
});

test("an initiator-side policy refusal does not wedge later retries", {
  timeout: 30000,
}, async () => {
  // Regression: a refused initiator-side policy used to leave the peer's
  // hash stuck in the room's initiate de-bounce, so the announce loop never
  // re-attempted — a later grant could never connect. Force the glare order
  // so the owner (A) is the initiator and the refusal happens on its side.
  const { makeLoopback } = await import("./loopback.js");
  let idA = await Identity.generate();
  let idB = await Identity.generate();
  let hashA = toHex(await Identity.truncatedHash(await idA.getPublicKey()));
  let hashB = toHex(await Identity.truncatedHash(await idB.getPublicKey()));
  // Force the glare order so the owner (A) is the initiator and the refusal
  // happens on its side. The glare rule compares room DESTINATION hashes (a
  // hash of the room name plus the identity hash), so the loop runs on those
  // — identity-hash ordering does not determine who initiates.
  while (
    (await roomDestinationHash(ROOM, hashA)) >=
    (await roomDestinationHash(ROOM, hashB))
  ) {
    idA = await Identity.generate();
    idB = await Identity.generate();
    hashA = toHex(await Identity.truncatedHash(await idA.getPublicKey()));
    hashB = toHex(await Identity.truncatedHash(await idB.getPublicKey()));
  }

  const { rnsA, rnsB, close } = await makeLoopback();
  const granted = new Set();
  /** @type {any[]} */
  const refusals = [];
  const providerA = new ReticulumProvider(ROOM, new Y.Doc(), {
    reticulum: rnsA,
    identity: idA,
    linkPolicy: ({ remoteIdentityHash }) => granted.has(remoteIdentityHash),
  });
  providerA.on("refused", (/** @type {any} */ e) => {
    refusals.push(...e.refusals);
  });
  const providerB = new ReticulumProvider(ROOM, new Y.Doc(), {
    reticulum: rnsB,
    identity: idB,
    linkPolicy: () => true,
  });

  await providerA.connect();
  await providerB.connect();
  await nudgeAnnounce(providerA, providerB);
  await waitFor(() => refusals.length > 0, 10000);
  assert.equal(refusals[0].identityHash, hashB, "B was refused by A");

  // The refused attempt must not wedge the initiate de-bounce.
  // @ts-expect-error -- white-box: regression asserts internal bookkeeping
  assert.equal(providerA.room.pendingInitiates.size, 0);

  granted.add(hashB);
  await nudgeAnnounce(providerA, providerB);
  await waitFor(() => providerA.room?.peerConns.size === 1, 10000);
  assert.equal(
    providerA.room?.peerConns.size,
    1,
    "a granted peer connects after an earlier refusal",
  );

  await providerA.destroy().catch(() => {});
  await providerB.destroy().catch(() => {});
  await close();
});
