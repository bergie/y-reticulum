/**
 * @file loopback.js
 * @description Shared TCP-loopback harness for smoketests: wires two
 *   in-process Reticulum instances together (one listens, one dials) so a test
 *   can build providers on them. Not a test file — just helpers.
 */
import net from "node:net";
import {
  Reticulum,
  TCPClientInterface,
  TCPServerInterface,
} from "reticulum-js";

export const HOST = "127.0.0.1";

/** Resolves with a free localhost TCP port (ephemeral, immediately released). */
export function getFreePort() {
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
 *
 * @returns {Promise<{
 *   rnsA: Reticulum,
 *   rnsB: Reticulum,
 *   close: () => Promise<void>,
 * }>}
 */
export async function makeLoopback() {
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
export function waitFor(cond, timeoutMs) {
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
