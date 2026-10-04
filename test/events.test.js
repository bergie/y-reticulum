/**
 * @file events.test.js
 * @description Smoketests for the provider's discovery-lifecycle events:
 * `announced` (this room's destination going on air) and `discovered` (a
 * matching announce arriving from the mesh). Also locks in the early
 * announce burst that covers a first announce dropped while the relay
 * interface is still coming up.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Identity, toHex } from "@reticulum/core";
import * as Y from "yjs";
import { ReticulumProvider } from "../src/index.js";
import { makeLoopback, nudgeAnnounce, waitFor } from "./loopback.js";

const ROOM = "y-reticulum-events-smoke";

test("announced fires at connect and on the early burst", {
  timeout: 15_000,
}, async () => {
  const { rnsA, close } = await makeLoopback();
  const provider = new ReticulumProvider(ROOM, new Y.Doc(), {
    reticulum: rnsA,
    identity: await Identity.generate(),
  });
  let announced = 0;
  provider.on("announced", () => {
    announced += 1;
  });

  await provider.connect();
  // The event reflects actual broadcasts, so it lands asynchronously after
  // connect() resolves.
  await waitFor(() => announced >= 1, 4_000);

  // The burst repeats the announce 1 s after connect; the remaining
  // repeats land at +4 s and +10 s, well after this test has moved on.
  await waitFor(() => announced >= 2, 4_000);

  await provider.destroy();
  await close();
});

test("announced does not fire after disconnect", {
  timeout: 15_000,
}, async () => {
  const { rnsA, close } = await makeLoopback();
  const provider = new ReticulumProvider(ROOM, new Y.Doc(), {
    reticulum: rnsA,
    identity: await Identity.generate(),
  });
  let announced = 0;
  provider.on("announced", () => {
    announced += 1;
  });

  await provider.connect();
  await waitFor(() => announced >= 1, 4_000);
  await provider.disconnect();
  const atDisconnect = announced;

  // The pending burst timers were cleared: no further announces within
  // the +1 s repeat window.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(announced, atDisconnect, "burst timers are cleared");

  await provider.destroy();
  await close();
});

test("discovered fires for a matching announce with the peer's destination hash", {
  timeout: 15_000,
}, async () => {
  const { rnsA, rnsB, close } = await makeLoopback();
  const providerA = new ReticulumProvider(ROOM, new Y.Doc(), {
    reticulum: rnsA,
    identity: await Identity.generate(),
  });
  const providerB = new ReticulumProvider(ROOM, new Y.Doc(), {
    reticulum: rnsB,
    identity: await Identity.generate(),
  });
  /** @type {string[]} */
  const discoveredA = [];
  /** @type {string[]} */
  const publicKeysA = [];
  providerA.on("discovered", (/** @type {any} */ e) => {
    discoveredA.push(e.remoteHex);
    publicKeysA.push(e.publicKeyHex);
  });

  await providerA.connect();
  await providerB.connect();
  await nudgeAnnounce(providerA, providerB);
  await waitFor(() => discoveredA.length > 0, 5_000);

  assert.equal(
    discoveredA[0],
    // @ts-expect-error -- reaching into the room for the expected hash
    providerB.room.myHex,
    "discovered carries the peer's room destination hash",
  );
  assert.equal(
    publicKeysA[0],
    // @ts-expect-error -- reaching into the room for the peer identity
    toHex(providerB.room.identity.publicKey),
    "discovered carries the peer's public key for the app's peer cache",
  );

  await providerA.destroy().catch(() => {});
  await providerB.destroy().catch(() => {});
  await close();
});

test("discovered fires even when the link is refused", {
  timeout: 15_000,
}, async () => {
  const { rnsA, rnsB, close } = await makeLoopback();
  const providerA = new ReticulumProvider(ROOM, new Y.Doc(), {
    reticulum: rnsA,
    identity: await Identity.generate(),
    linkPolicy: () => false,
  });
  const providerB = new ReticulumProvider(ROOM, new Y.Doc(), {
    reticulum: rnsB,
    identity: await Identity.generate(),
  });
  /** @type {string[]} */
  const discoveredA = [];
  let peersA = 0;
  providerA.on("discovered", (/** @type {any} */ e) => {
    discoveredA.push(e.remoteHex);
  });
  providerA.on("peers", () => {
    peersA += 1;
  });

  await providerA.connect();
  await providerB.connect();
  await nudgeAnnounce(providerA, providerB);
  await waitFor(() => discoveredA.length > 0, 5_000);

  assert.ok(
    discoveredA.length > 0,
    "the announce fact is narrable despite the refusal",
  );
  assert.equal(peersA, 0, "no peer is ever added");
  assert.equal(providerA.room?.peerConns.size, 0, "no link was kept");

  await providerA.destroy().catch(() => {});
  await providerB.destroy().catch(() => {});
  await close();
});

test("announce-failed surfaces early-burst announce errors", {
  timeout: 15_000,
}, async () => {
  const { rnsA, close } = await makeLoopback();
  const provider = new ReticulumProvider(ROOM, new Y.Doc(), {
    reticulum: rnsA,
    identity: await Identity.generate(),
  });
  /** @type {string[]} */
  const failures = [];
  provider.on("announce-failed", (/** @type {any} */ e) => {
    failures.push(e.error);
  });

  await provider.connect();
  // Sabotage announces before the +1 s burst tick fires, so its failure —
  // rather than a swallowed rejection — is reported.
  // @ts-expect-error -- white-box: force announce() to fail
  provider.room.dest.announce = () => Promise.reject(new Error("relay down"));

  await waitFor(() => failures.length > 0, 4_000);
  assert.equal(failures[0], "relay down", "the failure reason is surfaced");

  await provider.destroy().catch(() => {});
  await close();
});
