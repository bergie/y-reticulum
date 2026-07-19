/**
 * @file transport.smoke.js
 * @description Phase 1 smoketest — validates the Reticulum transport foundation
 * before any Yjs sync semantics land.
 *
 * Spins up two in-process Reticulum instances wired together over a TCP
 * loopback (instance A listens, instance B dials), derives the *same* room
 * destination name on each, has both announce, discovers the peer via the
 * transport `announce` event (filtered by room `nameHash`), establishes a
 * Link, and exchanges raw bytes both ways (ping → pong).
 *
 * If this passes, discovery + Link transport work; Phase 3 can build the Yjs
 * sync protocol on top with confidence.
 */

import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import {
  ContextType,
  Destination,
  DestType,
  Identity,
  Packet,
  PacketType,
  Reticulum,
  TCPClientInterface,
  TCPServerInterface,
} from "reticulum-js";
import { roomDestinationName } from "../src/destination.js";

const ROOM_NAME = "y-reticulum-transport-smoke";
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
 * Constant-time-ish equality for two Uint8Arrays of equal length.
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 */
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Resolves with the first validated announce seen on `rns.transport` whose
 * `nameHash` matches `roomNameHash` (i.e. a peer in the same room).
 *
 * @param {Reticulum} rns
 * @param {Uint8Array} roomNameHash
 * @returns {Promise<{ destinationHash: Uint8Array, identity: Identity }>}
 */
function waitForPeer(rns, roomNameHash) {
  return new Promise((resolve) => {
    const listener = (/** @type {any} */ event) => {
      const detail = event.detail;
      if (
        bytesEqual(/** @type {Uint8Array} */ (detail.nameHash), roomNameHash)
      ) {
        rns.transport.removeEventListener("announce", listener);
        resolve({
          destinationHash: detail.destinationHash,
          identity: detail.identity,
        });
      }
    };
    rns.transport.addEventListener("announce", listener);
  });
}

/** Builds a Link DATA packet carrying `payload` (ContextType.NONE). */
function linkDataPacket(linkId, payload) {
  return new Packet({
    packetType: PacketType.DATA,
    destinationType: DestType.LINK,
    destinationHash: linkId,
    contextByte: ContextType.NONE,
    payload,
  });
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test("two peers discover each other and exchange bytes over a Link", {
  timeout: 15000,
}, async () => {
  // --- 1. TCP loopback: A listens, B dials -----------------------------
  const port = await getFreePort();

  const rnsA = new Reticulum();
  const rnsB = new Reticulum();

  // A listens. The TCPServerInterface itself has no writable stream (it only
  // spawns a fresh TCPClientInterface per accepted connection), so it must NOT
  // be passed to addInterface — only its spawned children get wired into the
  // transport, which we do in the "connection" handler below.
  const server = new TCPServerInterface({ port });
  await server.connect();
  const spawned = new Promise((resolve) => {
    server.addEventListener(
      "connection",
      (/** @type {any} */ event) => {
        // Mark default so this leaf node can emit link/handshake packets
        // (e.g. the responder's LRPROOF) via the default-interface fallback.
        rnsA.addInterface(event.detail, true);
        resolve(event.detail);
      },
      { once: true },
    );
  });

  const client = new TCPClientInterface({ host: HOST, port });
  await client.connect();
  rnsB.addInterface(client, true);
  await spawned; // ensure the server-side interface is wired before traffic

  try {
    // --- 2. Room destinations (same aspect → same nameHash) ------------
    const appName = await roomDestinationName(ROOM_NAME);

    const idA = await Identity.generate();
    idA.setAppData("y-reticulum A");
    const destA = await Destination.IN(appName, DestType.SINGLE, idA, rnsA);
    rnsA.transport.bindLocalDestination(destA);

    const idB = await Identity.generate();
    idB.setAppData("y-reticulum B");
    const destB = await Destination.IN(appName, DestType.SINGLE, idB, rnsB);
    rnsB.transport.bindLocalDestination(destB);

    // --- 3. Discover each other before announcing ----------------------
    const aSeesB = waitForPeer(rnsA, destB.nameHash);
    const bSeesA = waitForPeer(rnsB, destA.nameHash);

    await destA.announce();
    await destB.announce();

    const peerAOnB = await bSeesA;
    const peerBOnA = await aSeesB;
    assert.deepEqual(peerAOnB.destinationHash, destA.destinationHash);
    assert.deepEqual(peerBOnA.destinationHash, destB.destinationHash);

    // --- 4. A accepts links and echoes inbound data --------------------
    destA.addEventListener("link_request", async (/** @type {any} */ event) => {
      const link = await destA.acceptLink(event.detail.packet);
      link.addEventListener("data", (/** @type {any} */ dataEvent) => {
        link.send(
          linkDataPacket(
            link.linkId,
            encoder.encode(
              `pong:${decoder.decode(dataEvent.detail.packet.payload)}`,
            ),
          ),
        );
      });
    });

    // --- 5. B opens a Link to A and ping/pongs -------------------------
    const outDest = await Destination.OUT(
      appName,
      DestType.SINGLE,
      peerAOnB.identity,
      rnsB,
    );
    const link = await outDest.createLink();

    const pong = new Promise((resolve) => {
      link.addEventListener(
        "data",
        (/** @type {any} */ event) =>
          resolve(decoder.decode(event.detail.packet.payload)),
        { once: true },
      );
    });
    await link.send(linkDataPacket(link.linkId, encoder.encode("ping")));

    assert.equal(await pong, "pong:ping");
  } finally {
    await client.disconnect().catch(() => {});
    await server.disconnect().catch(() => {});
  }
});
