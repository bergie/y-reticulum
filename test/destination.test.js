/**
 * @file destination.test.js
 * @description Unit tests for the room-name → destination aspect derivation.
 *
 * Locks the exact mapping so a refactor can't silently change room membership
 * (two peers must derive the same aspect to find each other).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { roomDestinationName } from "../src/destination.js";

test("roomDestinationName is deterministic for the same input", async () => {
  const a = await roomDestinationName("my-room");
  const b = await roomDestinationName("my-room");
  assert.equal(a, b);
});

test("roomDestinationName differs for different inputs", async () => {
  const a = await roomDestinationName("room-one");
  const b = await roomDestinationName("room-two");
  assert.notEqual(a, b);
});

test("roomDestinationName has the expected shape", async () => {
  const name = await roomDestinationName("anything");
  assert.match(
    name,
    /^y-reticulum\.sync\.[0-9a-f]{16}$/,
    "aspect must be y-reticulum.sync.<16 hex chars>",
  );
});

test("roomDestinationName maps known inputs to a locked hash", async () => {
  // First 8 bytes of SHA-256("hello") = 2cf24dba5fb0a30e. Pinning this catches
  // accidental changes to the derivation that would fragment a room's peers.
  assert.equal(
    await roomDestinationName("hello"),
    "y-reticulum.sync.2cf24dba5fb0a30e",
  );
  // SHA-256("y-reticulum") prefix = 2b3a1eacdb01545a
  assert.equal(
    await roomDestinationName("y-reticulum"),
    "y-reticulum.sync.2b3a1eacdb01545a",
  );
});
