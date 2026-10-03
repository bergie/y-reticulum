/**
 * @file early-message.test.js
 * @description Regression test for the link-setup race: the initiator may
 * start the Yjs sync handshake (syncStep1 + awareness) while the responder is
 * still awaiting its identify / link-policy decision, i.e. before a PeerConn
 * exists and `YjsSyncMessage` is registered on the channel. Without channel
 * priming the channel drops such messages with
 * `Unable to find constructor for Channel MSGTYPE 0x1` — the initiator's
 * initial awareness state is then permanently lost.
 *
 * The responder's link policy resolves only after a delay long enough for the
 * initiator's initial sync traffic to arrive, so the test exercises the
 * stash-and-flush path in `Room._primeChannel` / `Room._registerPeer`.
 */

import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { Identity, Reticulum } from "@reticulum/core";
import { TCPClientInterface, TCPServerInterface } from "@reticulum/node";
import * as Y from "yjs";
import { ReticulumProvider } from "../src/index.js";
import { nudgeAnnounce } from "./loopback.js";

const ROOM = "y-reticulum-early-message-smoke";
const HOST = "127.0.0.1";
const POLICY_DELAY_MS = 500;

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

test("early inbound messages survive the link-policy window", {
  timeout: 20000,
}, async () => {
  const { rnsA, rnsB, close } = await makeLoopback();
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const idA = await Identity.generate();
  const idB = await Identity.generate();

  // A delay in the policy (which runs on both sides, responder-side after
  // identify) opens the race window: the initiator registers its PeerConn and
  // sends syncStep1 + awareness while the responder has not yet registered.
  const delayPolicy = async () => {
    await new Promise((resolve) => setTimeout(resolve, POLICY_DELAY_MS));
    return true;
  };

  const providerA = new ReticulumProvider(ROOM, docA, {
    reticulum: rnsA,
    identity: idA,
    linkPolicy: delayPolicy,
  });
  const providerB = new ReticulumProvider(ROOM, docB, {
    reticulum: rnsB,
    identity: idB,
    linkPolicy: delayPolicy,
  });

  /** @type {boolean} */ let aSynced = false;
  /** @type {boolean} */ let bSynced = false;
  providerA.on("synced", (/** @type {any} */ e) => {
    if (e.synced) aSynced = true;
  });
  providerB.on("synced", (/** @type {any} */ e) => {
    if (e.synced) bSynced = true;
  });

  // Awareness state present before the link exists, so it travels in the
  // initiator's initial sync — the traffic most exposed to the race.
  providerA.awareness.setLocalState({ user: "alice" });

  await providerA.connect();
  await providerB.connect();
  await nudgeAnnounce(providerA, providerB);

  await waitFor(() => aSynced && bSynced, 15000);
  assert.ok(aSynced && bSynced, "both sides complete the sync handshake");

  // The initiator's pre-registration awareness state must have been applied,
  // not dropped by the channel's "unknown MSGTYPE" path.
  await waitFor(() => {
    const s = providerB.awareness.getStates().get(docA.clientID);
    return s != null && s.user === "alice";
  }, 5000);
  assert.deepEqual(providerB.awareness.getStates().get(docA.clientID), {
    user: "alice",
  });

  // Doc sync still works end to end.
  docA.getMap("doc").set("hello", "world");
  await waitFor(() => docB.getMap("doc").get("hello") === "world", 5000);
  assert.equal(docB.getMap("doc").get("hello"), "world");

  await providerA.destroy();
  await providerB.destroy();
  await close();
});
