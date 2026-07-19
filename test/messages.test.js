/**
 * @file messages.test.js
 * @description Unit tests for the Yjs sync wire codec ({@link readMessage}).
 *
 * These exercise the protocol logic directly — no networking — so they're fast
 * and pin the request/reply behaviour (syncStep1→step2, updates, awareness,
 * queryAwareness) that the integration smoketests only cover end-to-end.
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import {
  messageAwareness,
  messageQueryAwareness,
  messageSync,
  readMessage,
} from "../src/messages.js";

/** Wraps `body` (written by `write`) in a tagged message frame. */
function frame(tag, write) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, tag);
  write?.(enc);
  return encoding.toUint8Array(enc);
}

test("message tags match the y-webrtc wire format", () => {
  assert.equal(messageSync, 0);
  assert.equal(messageAwareness, 1);
  assert.equal(messageQueryAwareness, 3);
});

test("syncStep1 is answered with a syncStep2 carrying our state", () => {
  // `doc` holds the state; an empty peer requests it via syncStep1.
  const doc = new Y.Doc();
  doc.getMap("m").set("k", "v");
  const peer = new Y.Doc();

  const step1 = frame(messageSync, (enc) =>
    syncProtocol.writeSyncStep1(enc, peer),
  );

  let syncedCalls = 0;
  const reply = readMessage(
    doc,
    new awarenessProtocol.Awareness(doc),
    step1,
    "origin",
    false,
    () => {
      syncedCalls++;
    },
  );

  // syncStep1 always produces a reply; it does not itself mark the room synced.
  assert.ok(reply instanceof Uint8Array);
  assert.equal(syncedCalls, 0);

  // Applying the reply (a syncStep2) to the peer delivers the state and fires
  // the one-shot synced callback.
  const reply2 = readMessage(
    peer,
    new awarenessProtocol.Awareness(peer),
    reply,
    "origin",
    false,
    () => {
      syncedCalls++;
    },
  );
  assert.equal(reply2, null); // syncStep2 needs no reply
  assert.equal(syncedCalls, 1);
  assert.equal(peer.getMap("m").get("k"), "v");
});

test("the synced callback is suppressed once the room is synced", () => {
  const doc = new Y.Doc();
  doc.getMap("m").set("k", "v");
  const sv = Y.encodeStateVector(new Y.Doc());
  const step2 = frame(messageSync, (enc) =>
    syncProtocol.writeSyncStep2(enc, doc, sv),
  );

  let syncedCalls = 0;
  const receiver = new Y.Doc();
  readMessage(
    receiver,
    new awarenessProtocol.Awareness(receiver),
    step2,
    "origin",
    true, // room already synced
    () => {
      syncedCalls++;
    },
  );
  assert.equal(syncedCalls, 0);
});

test("a sync update message applies to the doc and needs no reply", () => {
  // Capture a real update from a doc.
  const source = new Y.Doc();
  /** @type {Uint8Array|undefined} */ let update;
  source.on("update", (/** @type {Uint8Array} */ u) => {
    update = u;
  });
  source.getMap("m").set("k", "v");
  assert.ok(update);

  const updateMsg = frame(messageSync, (enc) =>
    syncProtocol.writeUpdate(enc, /** @type {Uint8Array} */ (update)),
  );

  const receiver = new Y.Doc();
  const reply = readMessage(
    receiver,
    new awarenessProtocol.Awareness(receiver),
    updateMsg,
    "origin",
    false,
    () => {},
  );
  assert.equal(reply, null);
  assert.equal(receiver.getMap("m").get("k"), "v");
});

test("queryAwareness is answered with an awareness update", () => {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState({ user: "alice" });

  const query = frame(messageQueryAwareness);
  const reply = readMessage(doc, awareness, query, "origin", false, () => {});
  assert.ok(reply instanceof Uint8Array);

  // Applying the reply to a fresh awareness delivers the state.
  const peerDoc = new Y.Doc();
  const peerAwareness = new awarenessProtocol.Awareness(peerDoc);
  const reply2 = readMessage(
    peerDoc,
    peerAwareness,
    reply,
    "origin",
    false,
    () => {},
  );
  assert.equal(reply2, null);
  assert.deepEqual(peerAwareness.getStates().get(doc.clientID), {
    user: "alice",
  });
});

test("an unknown message tag yields no reply", () => {
  const doc = new Y.Doc();
  const reply = readMessage(
    doc,
    new awarenessProtocol.Awareness(doc),
    frame(99),
    "origin",
    false,
    () => {},
  );
  assert.equal(reply, null);
});
