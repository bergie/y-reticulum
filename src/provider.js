/**
 * @file provider.js
 * @description Reticulum provider for Yjs (public API surface).
 *
 * Eventually this establishes a Reticulum destination per room, discovers peers
 * via the Announce mechanism, and synchronizes a {@link Y.Doc} and Awareness
 * over pairwise Links (see SPEC.md). This module currently holds the typed
 * public API; transport wiring lands in later phases.
 */

import { ObservableV2 } from "lib0/observable";
import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";

/**
 * Options accepted by {@link ReticulumProvider}.
 *
 * @typedef {Object} ProviderOptions
 * @property {awarenessProtocol.Awareness} [awareness]
 *   Reuse an existing Awareness instance. A fresh one is created when omitted.
 * @property {number} [maxConns]
 *   Upper bound on simultaneous peer Links. Mirrors y-webrtc's `maxConns`.
 * @property {number} [announceIntervalMs]
 *   Cadence (ms) at which the room destination is re-announced for discovery.
 */

/**
 * Events emitted by {@link ReticulumProvider}. Mirrors the y-webrtc event
 * surface so consumers can switch providers with minimal changes.
 *
 * @typedef {Object} ReticulumProviderEvents
 * @property {(event: { connected: boolean }) => void} status
 *   Fired when the provider (dis)connects from the mesh.
 * @property {(event: { synced: boolean }) => void} synced
 *   Fired when sync state with the peer mesh changes.
 * @property {(event: { added: Array<string>, removed: Array<string> }) => void} peers
 *   Fired when peers are discovered or drop off.
 */

/**
 * Reticulum provider for Yjs.
 *
 * @extends {ObservableV2<ReticulumProviderEvents>}
 */
export class ReticulumProvider extends ObservableV2 {
  /**
   * @param {string} roomName
   * @param {Y.Doc} doc
   * @param {ProviderOptions} [opts]
   */
  constructor(roomName, doc, opts = {}) {
    super();
    this.roomName = roomName;
    this.doc = doc;
    /** @type {awarenessProtocol.Awareness} */
    this.awareness = opts.awareness ?? new awarenessProtocol.Awareness(doc);
    this.maxConns = opts.maxConns ?? 20;
    this.announceIntervalMs = opts.announceIntervalMs ?? 30_000;
    this.shouldConnect = false;
  }

  /**
   * Whether the provider is attempting to connect to the mesh. Does not imply
   * that any peer is reachable; only that we are looking.
   *
   * @type {boolean}
   */
  get connected() {
    return this.shouldConnect;
  }

  /** Begin announcing and accepting peer Links. */
  connect() {
    this.shouldConnect = true;
  }

  /** Stop announcing and tear down peer Links. */
  disconnect() {
    this.shouldConnect = false;
  }

  /** Permanently release all resources. */
  destroy() {
    super.destroy();
  }
}
