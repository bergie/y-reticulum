/**
 * @file compression.js
 * @description Shared bzip2 provider for compressing Reticulum Resources.
 *
 * `@digitaldefiance/bzip2-wasm` is a hard dependency of y-reticulum, so both
 * peers can always compress/decompress large sync payloads (an initial doc
 * state or a big update). The WASM module needs a one-time async `init()`; this
 * module exposes a shared, lazily-initialized instance. If init ever fails we
 * resolve to `null` and sync transparently falls back to uncompressed Resources.
 */
import BZip2 from "@digitaldefiance/bzip2-wasm";

/** @type {Promise<import("@digitaldefiance/bzip2-wasm").default | null> | null} */
let initPromise = null;

/**
 * Returns a shared, initialized BZip2 instance, or `null` if the WASM module
 * failed to load. Safe to call repeatedly — initialization runs only once.
 *
 * @returns {Promise<import("@digitaldefiance/bzip2-wasm").default | null>}
 */
export function getCompressionProvider() {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const bz2 = new BZip2();
        await bz2.init();
        return bz2;
      } catch {
        // WASM unavailable / failed to load — Resources will go uncompressed.
        return null;
      }
    })();
  }
  return initPromise;
}
