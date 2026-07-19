/**
 * @file sync.smoke.js
 * @description Phase 3 smoketest — Yjs doc and awareness actually sync between
 * two providers over the Reticulum mesh.
 *
 * Two providers connect to the same room, each waits to be marked `synced`,
 * then: an edit made on provider A's Doc appears on provider B's Doc, and a
 * local awareness state set on A appears in B's awareness map. This exercises
 * the full sync handshake (syncStep1/2) plus the doc-update and awareness
 * broadcast paths.
 */

import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import {
  Identity,
  Reticulum,
} from "reticulum-js";
import {
  TCPClientInterface,
  TCPServerInterface,
} from "reticulum-js/src/interfaces/tcp.js";
import * as Y from "yjs";
import { ReticulumProvider } from "../src/index.js";

const ROOM = "y-reticulum-sync-smoke";
const HOST = "127.0.0.1";

/** Resolves with a free localhost TCP port (ephemeral, immediately released). */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen({ host: HOST, port: 0 }, () => {
      const { port } = /** @type {net.AddressInfo} */ (probe.address());
      probe.close(() => resolve(port));
    });
  });
}

/** Two in-process Reticulum instances wired over a TCP loopback (A listens, B dials). */
async function makeLoopback() {
  const port = await getFreePort();
  const rnsA = new Reticulum();
  const rnsB = new Reticulum();
  const server = new TCPServerInterface({ port });
  await server.connect();
  const spawned = new Promise((resolve) => {
    server.addEventListener(
      "connection",
      (/** @type {any} */ event) => {
        rnsA.addInterface(event.detail, true);
        resolve();
      },
      { once: true },
    );
  });
  const client = new TCPClientInterface({ host: HOST, port });
  await client.connect();
  rnsB.addInterface(client, true);
  await spawned;
  return {
    rnsA,
    rnsB,
    async close() {
      await client.disconnect().catch(() => {});
      await server.disconnect().catch(() => {});
    },
  };
}

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

test("Doc and awareness sync between two providers", {
  timeout: 15000,
}, async () => {
  const { rnsA, rnsB, close } = await makeLoopback();
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const idA = await Identity.generate();
  const idB = await Identity.generate();

  const providerA = new ReticulumProvider(ROOM, docA, {
    reticulum: rnsA,
    identity: idA,
    announceIntervalMs: 500,
  });
  const providerB = new ReticulumProvider(ROOM, docB, {
    reticulum: rnsB,
    identity: idB,
    announceIntervalMs: 500,
  });

  /** @type {boolean} */ let aSynced = false;
  /** @type {boolean} */ let bSynced = false;
  providerA.on("synced", (/** @type {any} */ e) => {
    if (e.synced) aSynced = true;
  });
  providerB.on("synced", (/** @type {any} */ e) => {
    if (e.synced) bSynced = true;
  });

  await providerA.connect();
  await providerB.connect();

  // Both sides complete the syncStep1/2 handshake.
  await waitFor(() => aSynced && bSynced, 10000);

  // --- Doc sync: an edit on A appears on B ----------------------------
  docA.getMap("doc").set("hello", "world");
  await waitFor(() => docB.getMap("doc").get("hello") === "world", 5000);
  assert.equal(docB.getMap("doc").get("hello"), "world");

  // --- Awareness sync: a local state set on A appears on B ------------
  providerA.awareness.setLocalState({ user: "alice" });
  await waitFor(() => {
    const s = providerB.awareness.getStates().get(docA.clientID);
    return s != null && s.user === "alice";
  }, 5000);
  assert.deepEqual(providerB.awareness.getStates().get(docA.clientID), {
    user: "alice",
  });

  await providerA.destroy();
  await providerB.destroy();
  await close();
});
