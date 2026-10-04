/**
 * @file stale-link.test.js
 * @description Smoketest — a stale link is dropped and re-initiated on announce.
 *
 * Two providers sync over a TCP loopback. One of them is the initiator (the
 * peer with the lexicographically smaller destination hash, per the
 * glare-avoidance rule). We then simulate the peer having died without
 * tearing its link down — a crash, a reload, a killed worker: from the
 * initiator's room's point of view the link is no longer ACTIVE, but no
 * `close` event ever arrived, so the room still holds it as linked. When the
 * (still very much alive) peer announces, the room must recognize the stale
 * link, drop the dead connection — firing `peers removed` and shrinking
 * `peerConns`, not leaking a slot — and re-initiate, ending synced with a
 * live link across which edits flow.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Identity, LinkStatus } from "@reticulum/core";
import * as Y from "yjs";
import { ReticulumProvider } from "../src/index.js";
import { makeLoopback, nudgeAnnounce, waitFor } from "./loopback.js";

const ROOM = "y-reticulum-stale-link-smoke";

/**
 * @param {ReticulumProvider} p
 * @returns {Map<string, unknown>}
 */
function peerConns(p) {
  return /** @type {any} */ (p).room.peerConns;
}

test("a stale link is dropped and re-initiated when the peer announces", {
  timeout: 20000,
}, async () => {
  const { rnsA, rnsB, close } = await makeLoopback();
  const docA = new Y.Doc();
  const docB = new Y.Doc();

  const providerA = new ReticulumProvider(ROOM, docA, {
    reticulum: rnsA,
    identity: await Identity.generate(),
  });
  const providerB = new ReticulumProvider(ROOM, docB, {
    reticulum: rnsB,
    identity: await Identity.generate(),
  });

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
  await nudgeAnnounce(providerA, providerB);

  // --- Initial mesh: each discovers exactly one peer and syncs -----------
  await waitFor(() => peerConns(providerA).size === 1, 10000);
  await waitFor(() => peerConns(providerB).size === 1, 10000);
  await waitFor(
    () =>
      [
        ...peerConns(providerA).values(),
        ...peerConns(providerB).values(),
      ].every((conn) => /** @type {any} */ (conn).synced),
    10000,
  );

  // Exactly one side is the initiator (glare rule): its conn carries the
  // remote destination hash.
  const connA = /** @type {any} */ ([...peerConns(providerA).values()][0]);
  const connB = /** @type {any} */ ([...peerConns(providerB).values()][0]);
  const initiator = connA.remoteDestHash ? providerA : providerB;
  const responder = initiator === providerA ? providerB : providerA;
  const initConn = connA.remoteDestHash ? connA : connB;
  const removed = initiator === providerA ? aRemoved : bRemoved;

  // --- A re-announce while the link is live must be a no-op -------------
  await nudgeAnnounce(providerA, providerB);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(removed.length, 0, "live link must survive a re-announce");
  assert.equal(peerConns(initiator).size, 1);
  assert.equal(peerConns(responder).size, 1);

  // --- Simulate the peer dying without tearing its link down ------------
  // The link is physically fine here; we only fake the initiator's room's
  // view of it (no longer ACTIVE, no `close` event delivered), which is the
  // state a crashed/reloaded peer leaves behind.
  initConn.link.status = LinkStatus.PENDING;

  // The peer announces — evidence it is alive. The room must drop the stale
  // connection (with full bookkeeping) and re-initiate.
  await /** @type {any} */ (responder).room.dest.announce();

  // The stale connection must be torn down AND removed: `peers removed`
  // fires and the conn is destroyed instead of leaking in peerConns. (The
  // transient zero-conn state can be over before we ever poll, so we assert
  // on the event and the conn itself.)
  await waitFor(() => removed.length >= 1, 10000);
  assert.deepEqual(removed, [initConn.peerId]);
  assert.equal(initConn.closed, true, "stale conn must be destroyed");

  // The initiator re-establishes the Link with a fresh connection.
  await waitFor(
    () =>
      peerConns(initiator).size === 1 &&
      ![...peerConns(initiator).values()].includes(initConn),
    10000,
  );
  await waitFor(() => peerConns(responder).size === 1, 10000);
  const newConn = /** @type {any} */ ([...peerConns(initiator).values()][0]);
  assert.notEqual(newConn, initConn, "must be a fresh Link, not the stale one");
  await waitFor(() => newConn.link.status === LinkStatus.ACTIVE, 10000);

  // Re-sync completes and an edit made after recovery flows — live sync, not
  // a stale link.
  await waitFor(
    () =>
      [...peerConns(initiator).values()].every(
        (conn) => /** @type {any} */ (conn).synced,
      ),
    10000,
  );
  /** @type {Y.Doc} */ const initiatorDoc =
    initiator === providerA ? docA : docB;
  /** @type {Y.Doc} */ const responderDoc =
    responder === providerA ? docA : docB;
  initiatorDoc.getMap("m").set("after", "stale-recovery");
  await waitFor(
    () => responderDoc.getMap("m").get("after") === "stale-recovery",
    5000,
  );
  assert.equal(responderDoc.getMap("m").get("after"), "stale-recovery");

  await providerA.destroy();
  await providerB.destroy();
  await close();
});
