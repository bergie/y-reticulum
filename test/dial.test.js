/**
 * @file dial.test.js
 * @description Smoketests for direct peer dialing (work document #34):
 * `dialPeer` from a known identity and `dialHash` from a destination hash —
 * plus the failure path, where dialing an unreachable peer must report
 * false without wedging the room's initiate de-bounce.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  Destination,
  DestType,
  fromHex,
  Identity,
  toHex,
} from "@reticulum/core";
import * as Y from "yjs";
import {
  roomDestinationHash,
  roomDestinationName,
} from "../src/destination.js";
import { ReticulumProvider } from "../src/index.js";
import { makeLoopback, nudgeAnnounce, waitFor } from "./loopback.js";

const ROOM = "y-reticulum-dial-smoke";

test("dialPeer establishes a link from a known identity and syncs docs", {
  timeout: 15_000,
}, async () => {
  const { rnsA, rnsB, close } = await makeLoopback();
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const idA = await Identity.generate();
  const providerA = new ReticulumProvider(ROOM, docA, {
    reticulum: rnsA,
    identity: idA,
  });
  const providerB = new ReticulumProvider(ROOM, docB, {
    reticulum: rnsB,
    identity: await Identity.generate(),
  });
  /** @type {number} */ let peersA = 0;
  /** @type {number} */ let peersB = 0;
  providerA.on("peers", (/** @type {any} */ e) => {
    peersA += e.added.length;
  });
  providerB.on("peers", (/** @type {any} */ e) => {
    peersB += e.added.length;
  });

  await providerA.connect();
  await providerB.connect();

  // No announces needed: B knows A's identity through its own channels.
  const dialed = await providerB.dialPeer(idA);
  assert.equal(dialed, true, "dialPeer establishes the link");

  await waitFor(() => peersA > 0 && peersB > 0, 5_000);
  docB.getMap("m").set("from", "B");
  await waitFor(() => docA.getMap("m").get("from") === "B", 5_000);

  await providerA.destroy().catch(() => {});
  await providerB.destroy().catch(() => {});
  await close();
});

test("dialHash establishes a link from a discovered destination hash", {
  timeout: 20_000,
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
  /** @type {number} */ let peersA = 0;
  /** @type {number} */ let peersB = 0;
  providerA.on("peers", (/** @type {any} */ e) => {
    peersA += e.added.length;
  });
  providerB.on("peers", (/** @type {any} */ e) => {
    peersB += e.added.length;
  });
  /** @type {string[]} */
  const discoveredB = [];
  providerB.on("discovered", (/** @type {any} */ e) => {
    discoveredB.push(e.remoteHex);
  });

  await providerA.connect();
  await providerB.connect();
  await nudgeAnnounce(providerA, providerB);
  await waitFor(() => discoveredB.length > 0, 5_000);

  const dialed = await providerB.dialHash(discoveredB[0]);
  assert.equal(dialed, true, "dialHash establishes the link");
  await waitFor(() => peersA > 0 && peersB > 0, 5_000);

  await providerA.destroy().catch(() => {});
  await providerB.destroy().catch(() => {});
  await close();
});

test("dialHash to an unreachable peer reports false without wedging", {
  timeout: 35_000,
}, async () => {
  const { rnsA, close } = await makeLoopback();
  const provider = new ReticulumProvider(ROOM, new Y.Doc(), {
    reticulum: rnsA,
    identity: await Identity.generate(),
  });
  await provider.connect();

  // Nobody announces for this hash: identity solicitation and the path
  // request both run out (~20 s), and the dial must give up cleanly.
  const dialed = await provider.dialHash("f".repeat(32));
  assert.equal(dialed, false);

  // @ts-expect-error -- white-box: the failed attempt must not wedge the
  // initiate de-bounce (which would also block announce-driven connects)
  assert.equal(provider.room.pendingInitiates.size, 0);

  await provider.destroy().catch(() => {});
  await close();
});

test("dialHash falls back to Destination.recalled when stage 1 misses", {
  timeout: 15_000,
}, async () => {
  // Covers the hash-recalled branch: the stage-1 identity recall misses
  // (stubbed), but the peer has announced, so `recalled` rehydrates the
  // identity from the transport cache and verifies it hashes to the dialed
  // hash under our app name before linking.
  const { rnsA, rnsB, close } = await makeLoopback();
  const idA = await Identity.generate();
  const providerA = new ReticulumProvider(ROOM, new Y.Doc(), {
    reticulum: rnsA,
    identity: idA,
  });
  const providerB = new ReticulumProvider(ROOM, new Y.Doc(), {
    reticulum: rnsB,
    identity: await Identity.generate(),
  });
  /** @type {number} */ let peersA = 0;
  /** @type {number} */ let peersB = 0;
  providerA.on("peers", (/** @type {any} */ e) => {
    peersA += e.added.length;
  });
  providerB.on("peers", (/** @type {any} */ e) => {
    peersB += e.added.length;
  });
  /** @type {string[]} */
  const discoveredB = [];
  providerB.on("discovered", (/** @type {any} */ e) => {
    discoveredB.push(e.remoteHex);
  });

  await providerA.connect();
  await providerB.connect();
  await nudgeAnnounce(providerA, providerB);
  await waitFor(() => discoveredB.length > 0, 5_000);

  // Force the stage-1 miss: only the first recall fails, so the recall
  // `recalled` performs internally succeeds from the same cache.
  const transport = /** @type {any} */ (providerB.room?.rns.transport);
  const realRecall = transport.recallOrSolicitIdentity.bind(transport);
  let missed = false;
  transport.recallOrSolicitIdentity = (
    /** @type {Uint8Array} */ hash,
    /** @type {number} */ timeoutMs,
  ) => {
    if (!missed) {
      missed = true;
      return Promise.reject(new Error("forced stage-1 miss"));
    }
    return realRecall(hash, timeoutMs);
  };

  const dialed = await providerB.dialHash(discoveredB[0]);
  assert.equal(dialed, true, "the recalled destination dials the peer");
  await waitFor(() => peersA > 0 && peersB > 0, 5_000);

  await providerA.destroy().catch(() => {});
  await providerB.destroy().catch(() => {});
  await close();
});

test("Destination.recalled yields the hash roomDestinationHash computes", {
  timeout: 15_000,
}, async () => {
  // The compat surface dial-by-hash relies on: recalling by the hash
  // computed from the room name + peer identity hash produces a
  // destination with exactly that hash — i.e. one the peer will accept.
  const { rnsA, rnsB, close } = await makeLoopback();
  const identity = await Identity.generate();
  const appName = await roomDestinationName(ROOM);
  const dest = await Destination.IN(appName, DestType.SINGLE, identity, rnsA);
  await dest.announce();

  const identityHashHex = toHex(
    await Identity.truncatedHash(identity.publicKey),
  );
  const hashHex = await roomDestinationHash(ROOM, identityHashHex);
  const recalled = await Destination.recalled(appName, fromHex(hashHex), rnsB);
  assert.equal(
    toHex(/** @type {Uint8Array} */ (recalled.destinationHash)),
    hashHex,
  );

  await close();
});

test("Destination.recalled rejects a wrong name and a malformed hash", {
  timeout: 15_000,
}, async () => {
  const { rnsA, rnsB, close } = await makeLoopback();
  const identity = await Identity.generate();
  const appName = await roomDestinationName(ROOM);
  const dest = await Destination.IN(appName, DestType.SINGLE, identity, rnsA);
  await dest.announce();

  const hashBytes = /** @type {Uint8Array} */ (dest.destinationHash);
  // A different app name must not silently produce a different destination.
  await assert.rejects(
    Destination.recalled(
      "y-reticulum.sync.someothername",
      hashBytes,
      rnsB,
      500,
    ),
    /does not hash to/,
  );
  // Malformed hashes fail fast with a TypeError, without any network wait.
  await assert.rejects(
    Destination.recalled(appName, hashBytes.slice(4), rnsB),
    TypeError,
  );
  await assert.rejects(
    Destination.recalled(appName, "zz-not-hex", rnsB),
    TypeError,
  );

  await close();
});
