/**
 * @file reconnect.smoke.js
 * @description Phase 5 smoketest — a dropped peer Link is re-established.
 *
 * Two providers sync over a TCP loopback. We then tear down the underlying
 * Link from one side (simulating a peer/link drop): each provider should emit
 * `peers removed` and flip `synced` to false (it lost its last peer). The
 * initiator — the peer with the lexicographically smaller destination hash, per
 * the glare-avoidance rule — then re-discovers the responder (its scheduled
 * path request beats the periodic announce) and opens a fresh Link, so both
 * emit `peers added` again, re-run the sync handshake, and end up synced. An
 * edit made after reconnect must still flow across — proving a live Link, not a
 * stale one.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Identity } from "@reticulum/core";
import * as Y from "yjs";
import { ReticulumProvider } from "../src/index.js";
import { makeLoopback, waitFor } from "./loopback.js";

const ROOM = "y-reticulum-reconnect-smoke";

/**
 * @param {ReticulumProvider} p
 * @returns {Map<string, unknown>}
 */
function peerConns(p) {
  return /** @type {any} */ (p).room.peerConns;
}

test("a dropped Link is re-established and re-synced", {
  timeout: 20000,
}, async () => {
  const { rnsA, rnsB, close } = await makeLoopback();
  const docA = new Y.Doc();
  const docB = new Y.Doc();

  const providerA = new ReticulumProvider(ROOM, docA, {
    reticulum: rnsA,
    identity: await Identity.generate(),
    // Re-announce slowly so the reconnect is driven by the path request, not
    // the announce cadence — exercising that path. Initial discovery is still
    // immediate (connect() announces once up front).
    announceIntervalMs: 5000,
  });
  const providerB = new ReticulumProvider(ROOM, docB, {
    reticulum: rnsB,
    identity: await Identity.generate(),
    announceIntervalMs: 5000,
  });

  /** @type {boolean[]} */ const syncedA = [];
  /** @type {boolean[]} */ const syncedB = [];
  providerA.on("synced", (/** @type {any} */ e) => syncedA.push(e.synced));
  providerB.on("synced", (/** @type {any} */ e) => syncedB.push(e.synced));

  /** @type {string[]} */ const aAdded = [];
  /** @type {string[]} */ const aRemoved = [];
  /** @type {string[]} */ const bAdded = [];
  /** @type {string[]} */ const bRemoved = [];
  providerA.on("peers", (/** @type {any} */ e) => {
    aAdded.push(...e.added);
    aRemoved.push(...e.removed);
  });
  providerB.on("peers", (/** @type {any} */ e) => {
    bAdded.push(...e.added);
    bRemoved.push(...e.removed);
  });

  await providerA.connect();
  await providerB.connect();

  // --- Initial mesh: each discovers exactly one peer and syncs -----------
  await waitFor(() => aAdded.length >= 1 && bAdded.length >= 1, 10000);
  await waitFor(() => peerConns(providerA).size === 1, 10000);
  await waitFor(() => peerConns(providerB).size === 1, 10000);
  await waitFor(() => syncedA.includes(true) && syncedB.includes(true), 10000);

  // Sanity: an edit flows A → B before we break anything.
  docA.getMap("m").set("first", "yes");
  await waitFor(() => docB.getMap("m").get("first") === "yes", 5000);

  // --- Drop the Link from A's side; both ends get `close` ---------------
  const connA = [...peerConns(providerA).values()][0];
  await /** @type {any} */ (connA).link.teardown();

  // Both observe the peer leaving and drop to zero peers.
  await waitFor(() => aRemoved.length >= 1 && bRemoved.length >= 1, 10000);
  await waitFor(() => peerConns(providerA).size === 0, 10000);
  await waitFor(() => peerConns(providerB).size === 0, 10000);

  // Losing the last peer must flip synced to false (the zero-peer rule).
  await waitFor(() => syncedA.includes(false) && syncedB.includes(false), 5000);

  // --- The initiator re-establishes the Link ----------------------------
  await waitFor(() => aAdded.length >= 2 && bAdded.length >= 2, 10000);
  await waitFor(() => peerConns(providerA).size === 1, 10000);
  await waitFor(() => peerConns(providerB).size === 1, 10000);

  // Re-sync handshake completes; final synced state is true on both.
  await waitFor(() => syncedA[syncedA.length - 1] === true, 10000);
  await waitFor(() => syncedB[syncedB.length - 1] === true, 10000);

  // An edit made *after* reconnect flows A → B — live sync, not a stale link.
  docA.getMap("m").set("after", "reconnect");
  await waitFor(() => docB.getMap("m").get("after") === "reconnect", 5000);
  assert.equal(docB.getMap("m").get("after"), "reconnect");

  await providerA.destroy();
  await providerB.destroy();
  await close();
});
