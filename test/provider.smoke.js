/**
 * @file provider.smoke.js
 * @description Phase 2 smoketest — the {@link ReticulumProvider} connection
 * lifecycle and peer mesh, without any Yjs sync yet.
 *
 * Two providers, each on its own in-process Reticulum instance wired over a TCP
 * loopback, connect to the same room. Both should announce, discover each
 * other, establish exactly one Link between them (via the glare-avoidance
 * rule), and each emit a `peers` event with the other added.
 */

import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { Identity, Reticulum } from "@reticulum/core";
import { TCPClientInterface, TCPServerInterface } from "@reticulum/node";
import * as Y from "yjs";
import { ReticulumProvider } from "../src/index.js";

const ROOM = "y-reticulum-provider-smoke";
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

/**
 * Wires two in-process Reticulum instances over a TCP loopback (A listens, B
 * dials) and returns them plus a `close()` that tears the link down.
 */
async function makeLoopback() {
  const port = await getFreePort();
  const rnsA = new Reticulum();
  const rnsB = new Reticulum();

  // A listens. The TCPServerInterface has no writable stream itself, so do not
  // addInterface() it — only its spawned children get wired in, marked default
  // so the leaf can emit handshake packets via the default-interface fallback.
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

test("two providers discover each other and form a single Link", {
  timeout: 15000,
}, async () => {
  const { rnsA, rnsB, close } = await makeLoopback();
  const idA = await Identity.generate();
  const idB = await Identity.generate();

  const providerA = new ReticulumProvider(ROOM, new Y.Doc(), {
    reticulum: rnsA,
    identity: idA,
    announceIntervalMs: 500,
  });
  const providerB = new ReticulumProvider(ROOM, new Y.Doc(), {
    reticulum: rnsB,
    identity: idB,
    announceIntervalMs: 500,
  });

  /** @type {string[]} */
  const aPeers = [];
  /** @type {string[]} */
  const bPeers = [];
  let aConnected = false;
  let bConnected = false;
  providerA.on("status", (/** @type {any} */ e) => {
    aConnected = aConnected || e.connected;
  });
  providerB.on("status", (/** @type {any} */ e) => {
    bConnected = bConnected || e.connected;
  });
  providerA.on("peers", (/** @type {any} */ e) => aPeers.push(...e.added));
  providerB.on("peers", (/** @type {any} */ e) => bPeers.push(...e.added));

  await providerA.connect();
  await providerB.connect();

  // Both should connect, discover exactly one peer, and hold one Link.
  await waitFor(() => aPeers.length >= 1 && bPeers.length >= 1, 10000);
  assert.ok(aConnected, "provider A never reported connected");
  assert.ok(bConnected, "provider B never reported connected");
  assert.equal(
    /** @type {any} */ (providerA).room.peerConns.size,
    1,
    "provider A should hold exactly one peer Link",
  );
  assert.equal(
    /** @type {any} */ (providerB).room.peerConns.size,
    1,
    "provider B should hold exactly one peer Link",
  );

  await providerA.destroy();
  await providerB.destroy();
  await close();
});
