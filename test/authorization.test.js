import assert from "node:assert/strict";
import test from "node:test";

import { Identity } from "@reticulum/core";
import * as Y from "yjs";
import { ReticulumProvider } from "../src/index.js";
import { nudgeAnnounce, waitFor } from "./loopback.js";

const ROOM = "y-reticulum-authz-smoke";

/**
 * A symmetric authorizer for the exchange test: the initiator sends its
 * nonce and awaits the responder's; the responder receives first and replies.
 * Records that no peer was registered while the phase was running.
 */
function nonceExchanger(state) {
  return async ({ exchange, initiator, link }) => {
    assert.ok(link, "authorizer receives the live link");
    assert.equal(
      state.provider.room.peerConns.size,
      0,
      "no peer is registered before the authorization verdict",
    );
    state.phases += 1;
    if (initiator) {
      await exchange.send(state.nonceA);
      const reply = await exchange.receive();
      assert.deepEqual(reply, state.nonceB);
    } else {
      const request = await exchange.receive();
      assert.deepEqual(request, state.nonceA);
      await exchange.send(state.nonceB);
    }
    state.completed += 1;
    return true;
  };
}

test("authorization hook exchanges messages over the link before sync", {
  timeout: 30000,
}, async () => {
  const { makeLoopback } = await import("./loopback.js");
  const { rnsA, rnsB, close } = await makeLoopback();
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const idA = await Identity.generate();
  const idB = await Identity.generate();

  const stateA = {
    provider: /** @type {any} */ (null),
    nonceA: new Uint8Array([1, 2, 3, 4]),
    nonceB: new Uint8Array([9, 8, 7, 6]),
    phases: 0,
    completed: 0,
  };
  const stateB = {
    provider: /** @type {any} */ (null),
    nonceA: stateA.nonceA,
    nonceB: stateA.nonceB,
    phases: 0,
    completed: 0,
  };
  const providerA = new ReticulumProvider(ROOM, docA, {
    reticulum: rnsA,
    identity: idA,
    authorizeLink: nonceExchanger(stateA),
  });
  stateA.provider = providerA;
  const providerB = new ReticulumProvider(ROOM, docB, {
    reticulum: rnsB,
    identity: idB,
    authorizeLink: nonceExchanger(stateB),
  });
  stateB.provider = providerB;

  await providerA.connect();
  await providerB.connect();
  await nudgeAnnounce(providerA, providerB);

  // Docs converge only after the exchange completed on both sides
  docB.getMap("doc").set("authorized", "yes");
  await waitFor(() => docA.getMap("doc").get("authorized") === "yes", 15000);
  assert.equal(
    docA.getMap("doc").get("authorized"),
    "yes",
    "approved peers sync after the authorization exchange",
  );
  assert.equal(stateA.completed, 1, "initiator-side authorizer completed");
  assert.equal(stateB.completed, 1, "responder-side authorizer completed");
  assert.equal(stateA.phases, 1, "authorization runs once per link");

  await providerA.destroy().catch(() => {});
  await providerB.destroy().catch(() => {});
  await close();
});

test("authorization refusal tears the link down and reports the reason", {
  timeout: 30000,
}, async () => {
  const { makeLoopback } = await import("./loopback.js");
  const { rnsA, rnsB, close } = await makeLoopback();
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const idA = await Identity.generate();
  const idB = await Identity.generate();

  /** @type {any[]} */
  const refusalsA = [];
  const providerA = new ReticulumProvider(ROOM, docA, {
    reticulum: rnsA,
    identity: idA,
    authorizeLink: () => false,
  });
  providerA.on("refused", (/** @type {any} */ e) => {
    refusalsA.push(...e.refusals);
  });
  const providerB = new ReticulumProvider(ROOM, docB, {
    reticulum: rnsB,
    identity: idB,
    // B approves, but A must refuse before any sync traffic flows
    authorizeLink: () => true,
  });

  await providerA.connect();
  await providerB.connect();
  await nudgeAnnounce(providerA, providerB);

  docB.getMap("doc").set("intruder", "yes");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(
    docA.getMap("doc").get("intruder"),
    undefined,
    "refused peer's data never arrives",
  );
  assert.equal(providerA.room?.peerConns.size, 0, "no peer registered on A");
  assert.equal(providerB.room?.peerConns.size, 0, "no peer registered on B");
  assert.equal(refusalsA.length, 1, "A reports exactly one refusal");
  assert.equal(
    refusalsA[0].reason,
    "authorization",
    "refusal carries the authorization reason",
  );

  await providerA.destroy().catch(() => {});
  await providerB.destroy().catch(() => {});
  await close();
});

test("authorization phase timeout refuses the link", {
  timeout: 30000,
}, async () => {
  const { makeLoopback } = await import("./loopback.js");
  const { rnsA, rnsB, close } = await makeLoopback();
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const idA = await Identity.generate();
  const idB = await Identity.generate();

  /** @type {any[]} */
  const refusalsA = [];
  const providerA = new ReticulumProvider(ROOM, docA, {
    reticulum: rnsA,
    identity: idA,
    // Waits for a message that never comes: must hit the timeout
    authorizeTimeoutMs: 600,
    authorizeLink: ({ exchange }) => exchange.receive(),
  });
  providerA.on("refused", (/** @type {any} */ e) => {
    refusalsA.push(...e.refusals);
  });
  const providerB = new ReticulumProvider(ROOM, docB, {
    reticulum: rnsB,
    identity: idB,
    authorizeTimeoutMs: 5000,
    authorizeLink: () => true,
  });

  await providerA.connect();
  await providerB.connect();
  await nudgeAnnounce(providerA, providerB);

  docB.getMap("doc").set("late", "no");
  await waitFor(() => refusalsA.length > 0, 15000);
  assert.equal(
    refusalsA[0].reason,
    "authorization-timeout",
    "stalled authorization is reported as a timeout refusal",
  );
  assert.equal(
    docA.getMap("doc").get("late"),
    undefined,
    "no sync before or after the stalled authorization",
  );

  await providerA.destroy().catch(() => {});
  await providerB.destroy().catch(() => {});
  await close();
});
