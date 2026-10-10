/**
 * @file capability.test.js
 * @description Smoketests for the authorization phase's capability verdicts
 * (work document #3): an `authorizeLink` that resolves `{ sync: true }` makes
 * the peer read-only — its Doc updates are dropped while awareness still
 * flows and it still receives our updates — and an authorizer that resolves
 * `undefined` must refuse the link (fail-closed).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Identity, toHex } from "@reticulum/core";
import * as Y from "yjs";
import { ReticulumProvider } from "../src/index.js";
import { nudgeAnnounce, waitFor } from "./loopback.js";

const ROOM = "y-reticulum-capability-smoke";

test("a { sync: true } capability verdict makes the peer read-only", {
  timeout: 40000,
}, async () => {
  const { makeLoopback } = await import("./loopback.js");
  const { rnsA, rnsB, close } = await makeLoopback();
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const idA = await Identity.generate();
  const idB = await Identity.generate();
  const hashB = toHex(await Identity.truncatedHash(await idB.getPublicKey()));

  // A gates B down to sync-only: B may read and share awareness, but its
  // Doc updates must never reach A's Doc.
  const providerA = new ReticulumProvider(ROOM, docA, {
    reticulum: rnsA,
    identity: idA,
    authorizeLink: ({ remoteIdentityHash }) =>
      remoteIdentityHash === hashB ? { sync: true } : false,
  });
  const providerB = new ReticulumProvider(ROOM, docB, {
    reticulum: rnsB,
    identity: idB,
    authorizeLink: () => true,
  });

  await providerA.connect();
  await providerB.connect();
  await nudgeAnnounce(providerA, providerB);
  await waitFor(() => providerA.room?.peerConns.size === 1, 15000);

  // B's Doc write must not reach A (dropped by the write gate)
  docB.getMap("doc").set("intruder", "yes");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(
    docA.getMap("doc").get("intruder"),
    undefined,
    "a sync-only peer's Doc updates are dropped",
  );

  // Awareness still flows to the read-only peer
  providerB.awareness.setLocalStateField("user", "B");
  await waitFor(
    () => providerA.awareness.getStates().has(docB.clientID),
    10000,
  );

  // A's writes still reach the read-only peer (the read direction works)
  docA.getMap("doc").set("owner", "content");
  await waitFor(() => docB.getMap("doc").get("owner") === "content", 15000);

  await providerA.destroy().catch(() => {});
  await providerB.destroy().catch(() => {});
  await close();
});

test("a full capability object behaves like a true verdict", {
  timeout: 40000,
}, async () => {
  const { makeLoopback } = await import("./loopback.js");
  const { rnsA, rnsB, close } = await makeLoopback();
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const idA = await Identity.generate();
  const idB = await Identity.generate();
  const hashB = toHex(await Identity.truncatedHash(await idB.getPublicKey()));

  const providerA = new ReticulumProvider(ROOM, docA, {
    reticulum: rnsA,
    identity: idA,
    authorizeLink: ({ remoteIdentityHash }) =>
      remoteIdentityHash === hashB ? { sync: true, write: true } : false,
  });
  const providerB = new ReticulumProvider(ROOM, docB, {
    reticulum: rnsB,
    identity: idB,
    authorizeLink: () => true,
  });

  await providerA.connect();
  await providerB.connect();
  await nudgeAnnounce(providerA, providerB);
  await waitFor(() => providerA.room?.peerConns.size === 1, 15000);

  docB.getMap("doc").set("granted", "yes");
  await waitFor(() => docA.getMap("doc").get("granted") === "yes", 15000);

  await providerA.destroy().catch(() => {});
  await providerB.destroy().catch(() => {});
  await close();
});

test("an authorizer that resolves undefined refuses the link", {
  timeout: 40000,
}, async () => {
  const { makeLoopback } = await import("./loopback.js");
  const { rnsA, rnsB, close } = await makeLoopback();
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const idA = await Identity.generate();
  const idB = await Identity.generate();

  // A's authorizer falls off the end of its async body: implicit undefined.
  // That must refuse, not grant (the old `verdict !== false` behavior).
  const refusals = [];
  const providerA = new ReticulumProvider(ROOM, docA, {
    reticulum: rnsA,
    identity: idA,
    authorizeLink: async () => {},
  });
  providerA.on("refused", (/** @type {any} */ e) => {
    refusals.push(...e.refusals);
  });
  const providerB = new ReticulumProvider(ROOM, docB, {
    reticulum: rnsB,
    identity: idB,
    authorizeLink: () => true,
  });

  await providerA.connect();
  await providerB.connect();
  await nudgeAnnounce(providerA, providerB);
  await waitFor(() => refusals.length > 0, 15000);
  assert.equal(
    refusals[0].reason,
    "authorization",
    "an undefined verdict is a refusal",
  );

  docB.getMap("doc").set("intruder", "yes");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(
    docA.getMap("doc").get("intruder"),
    undefined,
    "no sync flows through a refused link",
  );

  await providerA.destroy().catch(() => {});
  await providerB.destroy().catch(() => {});
  await close();
});
