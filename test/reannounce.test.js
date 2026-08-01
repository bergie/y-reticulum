/**
 * @file reannounce.smoke.js
 * @description Smoketest for delegating the periodic re-announce loop to
 * @reticulum/core's `Destination.startAnnouncing` / `stopAnnouncing`.
 *
 * The cadence (and its §9.7 60 s floor) is the library's responsibility now;
 * this test just locks in that y-reticulum wires it up correctly: the loop is
 * running while a room is connected, the requested interval is forwarded (and
 * clamped to the floor), and the loop is stopped again on disconnect.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Identity } from "@reticulum/core";
import * as Y from "yjs";
import { ReticulumProvider } from "../src/index.js";
import { makeLoopback } from "./loopback.js";

const ROOM = "y-reticulum-reannounce-smoke";

test("connect starts the periodic re-announce loop; disconnect stops it", async () => {
  const { rnsA, close } = await makeLoopback();
  const provider = new ReticulumProvider(ROOM, new Y.Doc(), {
    reticulum: rnsA,
    identity: await Identity.generate(),
  });

  await provider.connect();
  // @ts-expect-error -- reaching into the room for a white-box check
  const dest = provider.room.dest;
  assert.equal(dest.isAnnouncing(), true, "loop should run while connected");

  // disconnect() nulls Room.dest, so capture the reference first; the object
  // outlives teardown and its timer must have been cleared.
  await provider.disconnect();
  assert.equal(dest.isAnnouncing(), false, "loop should stop on disconnect");

  await provider.destroy();
  await close();
});

test("announceIntervalMs is forwarded and clamped to the 60s floor", async () => {
  const { rnsA, close } = await makeLoopback();
  const provider = new ReticulumProvider(ROOM, new Y.Doc(), {
    reticulum: rnsA,
    identity: await Identity.generate(),
    announceIntervalMs: 5_000, // below the §9.7 floor
  });

  await provider.connect();
  // @ts-expect-error -- reaching into the room for a white-box check
  const { dest } = provider.room;
  assert.equal(dest.isAnnouncing(), true);
  assert.equal(
    dest.announceIntervalMs,
    60_000,
    "sub-floor interval must be clamped to 60s",
  );

  await provider.destroy();
  await close();
});
