/**
 * @file large-sync.smoke.js
 * @description Phase 4 smoketest — an initial Doc state larger than the link
 * MDU syncs via a chunked, compressed Reticulum Resource.
 *
 * Provider A starts with a large payload already in its Doc, so the very first
 * syncStep2 it sends (its full state) cannot fit in a single DATA packet and
 * must travel as a Resource. Provider B receives, reassembles (decompressing if
 * bz2 shrunk it) and ends up with identical state — exercising the oversized
 * path end to end.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Identity } from "@reticulum/core";
import * as Y from "yjs";
import { ReticulumProvider } from "../src/index.js";
import { makeLoopback, waitFor } from "./loopback.js";

const ROOM = "y-reticulum-large-sync-smoke";
// Comfortably larger than the default link MDU (~431 B).
const LARGE = "x".repeat(3000);

test("an initial state larger than the link MDU syncs via a Resource", {
  timeout: 15000,
}, async () => {
  const { rnsA, rnsB, close } = await makeLoopback();
  const docA = new Y.Doc();
  const docB = new Y.Doc();

  // Put the large payload in A *before* connecting, so the initial syncStep2
  // (A's full state) must be chunked into a Resource.
  docA.getText("t").insert(0, LARGE);
  assert.ok(
    Y.encodeStateAsUpdate(docA).length > 500,
    "sanity: payload must exceed the link MDU",
  );

  const providerA = new ReticulumProvider(ROOM, docA, {
    reticulum: rnsA,
    identity: await Identity.generate(),
    announceIntervalMs: 500,
  });
  const providerB = new ReticulumProvider(ROOM, docB, {
    reticulum: rnsB,
    identity: await Identity.generate(),
    announceIntervalMs: 500,
  });

  /** @type {boolean} */ let bSynced = false;
  providerB.on("synced", (/** @type {any} */ e) => {
    if (e.synced) bSynced = true;
  });

  await providerA.connect();
  await providerB.connect();

  // B becomes synced exactly when it receives + applies A's large step2.
  await waitFor(() => bSynced, 10000);
  await waitFor(() => docB.getText("t").toString() === LARGE, 5000);
  assert.equal(docB.getText("t").toString(), LARGE);

  await providerA.destroy();
  await providerB.destroy();
  await close();
});
