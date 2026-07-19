# y-reticulum — Reticulum provider for Yjs

A Yjs provider that synchronizes documents over the [Reticulum Network System
(RNS)](https://reticulum.network/) mesh. The goal is to reach feature parity
with the [y-webrtc](https://github.com/yjs/y-webrtc) provider, substituting
Reticulum's transport and discovery primitives for WebRTC + signaling servers.

## Goals

- Synchronize `Y.Doc` state and `Awareness` between peers over Reticulum.
- Work anywhere `reticulum-js` runs (Node.js, Deno, browsers).
- Provide an API and event surface familiar to anyone who has used
  `WebrtcProvider` (`status`, `synced`, `peers`).
- Be roughly on the same feature level as y-webrtc.

## Non-goals (for now)

- Acting as a Reticulum *transport* (routing) node. We are a leaf node, same as
  the rest of `reticulum-js`.
- E2E encryption of the room beyond what Reticulum's Links already provide.
  (y-webrtc's optional `password` key derivation is a future enhancement.)
- A `BroadcastChannel` same-origin/tab shortcut. Reticulum is the single
  transport.

## Architecture

### How y-webrtc works (reference)

- A `WebrtcProvider` wraps a `Y.Doc` and opens a `Room` (one per room name).
- Peer discovery happens through one or more **signaling servers** (WebSocket):
  clients `announce` their `peerId` and relay WebRTC `offer`/`answer`/`signal`
  messages through the server.
- Each pair of peers opens a **WebRTC data channel** (`simple-peer`).
- Doc/awareness updates are encoded with `lib0` and framed with a 1-byte
  message-type tag, then sent over every peer channel.
- An optional `BroadcastChannel` path shortcuts same-origin tabs.

The message wire protocol (reused verbatim here):

| Tag | Meaning |
|---|---|
| `0` | sync (carries `messageYjsSyncStep1` / `Step2` / `update`) |
| `1` | awareness update |
| `3` | query awareness |
| `4` | broadcastchannel peer-id add/remove — **not needed** (no BC) |

### Reticulum primitives we build on

- **`Destination`** (IN/OUT, SINGLE/GROUP/PLAIN) + **`Announce`** for
  authenticated, signed peer discovery. Each peer's announce carries its public
  identity, which others recall to open Links.
- **`Link`** — an ephemeral, encrypted, ordered, reliable channel between two
  destinations, established via a `LINKREQUEST`/`LRPROOF` handshake. Strictly
  stronger guarantees than a WebRTC data channel; ideal for Yjs sync.
- **`Resource`** — chunked, hash-verified large-payload transport over a Link,
  with automatic compression. Used for oversized sync payloads (initial state,
  big `syncStep2`).
- **`request()`/`response()`** RPC built on Links — *not* used directly; we run
  our own framing so the message-type tag matches y-webrtc's semantics.

### Concept mapping

| y-webrtc | y-reticulum |
|---|---|
| Signaling server `announce`/`publish` | Reticulum `Announce` to a deterministic destination |
| WebRTC data channel | `Link` |
| Raw peer `.send(bytes)` | `Link` `data` event (inbound) + `ContextType.NONE` DATA packet (outbound) |
| Large peer payloads (none) | `Resource` |
| BroadcastChannel (same-origin) | not applicable |
| `WebrtcProvider` (`ObservableV2`: `status`/`synced`/`peers`) | `ReticulumProvider` with the same events |
| Message tags 0/1/3 | reused verbatim |

### Discovery model (chosen: deterministic destination per room)

Each peer creates a **`SINGLE` IN destination** whose full app name is derived
from the room name, e.g.:

```
y-reticulum.sync.<hex(hash(roomName))>
```

The peer announces this destination. Other peers running the same room name
learn the announcer's identity from the announce and open a `Link` to it.
Because every peer both announces and listens, the topology is a full mesh of
pairwise Links (bounded by `maxConns`, same as y-webrtc).

> A pure group-destination broadcast (one destination, no Links) was considered
> and rejected: it loses Link-level reliability/encryption/ordering and makes
> `peers`/`maxConns` semantics awkward. We keep the "announce → connect to peers
> individually" model that mirrors y-webrtc.

### Room identity and the destination hash

- The room name is hashed to form the destination aspect so that two peers that
  type the same room name arrive at the same destination namespace without
  leaking the cleartext room name in announce app data.
- Each peer generates (and persists, when a storage adapter is available) its
  own `Identity`. The announce carries a small `app_data` blob identifying this
  peer (peer id + provider version) for diagnostics.

### Wire protocol on a Link

Identical framing to y-webrtc, minus tag `4`:

```
<1-byte tag><payload encoded with lib0>
```

- tag `0` sync → `syncProtocol.readSyncMessage` / `writeSyncStep1/2` / `writeUpdate`
- tag `1` awareness → `awarenessProtocol.encodeAwarenessUpdate` / `applyAwarenessUpdate`
- tag `3` query awareness → reply with tag `1`

Small messages go directly as a `ContextType.NONE` DATA packet on the Link.
Messages exceeding a threshold (configurable, default ~ the link/interface MDU)
are transported via a `Resource` and reassembled on the receiver before being
handed to the same `readMessage` path.

## Public API (target)

```js
import * as Y from "yjs";
import { ReticulumProvider } from "y-reticulum";

const doc = new Y.Doc();
const provider = new ReticulumProvider("my-room", doc, {
  identity,        // optional; generated/persisted if omitted
  reticulum,       // optional pre-configured Reticulum instance
  awareness,       // optional; created if omitted
  maxConns,        // optional; default 20-ish like y-webrtc
  announceInterval,// optional
});

provider.on("status", ({ connected }) => { /* ... */ });
provider.on("synced", ({ synced }) => { /* ... */ });
provider.on("peers",  ({ added, removed }) => { /* ... */ });
```

Methods mirror y-webrtc: `connect()`, `disconnect()`, `destroy()`.

## Project layout

```
src/
  index.js                 # public exports
  provider.js              # ReticulumProvider
  room.js                  # Room abstraction (announces, tracks peer Links)
  peer-conn.js             # one peer-to-peer Link wrapper
  messages.js              # message tags + readMessage/broadcast helpers
  destination.js           # room-name → deterministic destination name helpers
test/
  *.smoke.js               # smoketests per layer
examples/                  # demo clients (later)
```

## Type safety

All source is plain JavaScript (`.js`) with **JSDoc type annotations verified by
the TypeScript checker** — no hand-written `.ts` source files. This matches the
conventions of both `y-webrtc` and `reticulum-js`.

- `tsconfig.json` enables `allowJs: true` and `checkJs: true` (plus
  `declaration` / `emitDeclarationOnly: true` so a `.d.ts` bundle is produced).
- Every function, method, and constructor gets `@param {Type} name` /
  `@returns {Type}` annotations; module-level `@typedef`s describe option objects
  and event payloads; `@import` (or `import` in `@type`) references types from
  `yjs`, `y-protocols`, and `reticulum-js`.
- `npm run types` (`tsc`) **must pass after every change** — this is enforced by
  `AGENTS.md`. Treat type errors as build failures, not warnings.
- `lib0` types (`encoding.Encoder`, `decoding.Decoder`, `observable.ObservableV2`,
  etc.) are referenced the same way `y-webrtc` references them. Note `lib0` is a
  transitive dependency of `y-protocols`; if it is not resolvable it must be added
  as a direct dependency (ask first, per `AGENTS.md`).
- Emitted `.d.ts` files are excluded from version control (already in
  `.gitignore`).

## Implementation phases

### Phase 0 — Scaffolding
- Add `tsconfig.json` (`allowJs` + `checkJs` + `declaration` +
  `emitDeclarationOnly`) so `npm run types` passes against `src/`.
- Empty, fully JSDoc-annotated `src/index.js` re-exporting the (upcoming)
  provider.
- Confirm `npm run types` and `npm run format` are green.

### Phase 1 — Transport smoketest (foundation)
- A smoketest that spins up two in-process `Reticulum` instances (loopback
  interface), derives the same room destination name on each, announces, and
  establishes a `Link`, then exchanges raw bytes both ways.
- Validates discovery + Link transport before sync semantics land.

### Phase 2 — Provider skeleton
- `ReticulumProvider` constructor wiring (`Y.Doc`, `Awareness`, identity,
  Reticulum connect), `connect()`/`disconnect()`, `status` events.
- `Room` that announces and listens for announces/links; `peers` emission.
- No Yjs sync yet — just connection lifecycle.

### Phase 3 — Sync protocol layer
- `readMessage` / broadcast over peer Links.
- Doc `update` handler → broadcast sync `update`.
- Awareness update/query handlers.
- `synced` tracking across peers (mirror `checkIsSynced`).
- Smoketest: two providers, one edits, the other observes the change.

### Phase 4 — Resource-backed large transfers
- Route oversized payloads through `Resource`; reassemble and feed into the
  same `readMessage` path.
- Smoketest: large initial-doc sync.

### Phase 5 — Hardening & parity
- `maxConns` enforcement, reconnection, keepalive/timeout behavior, clean
  teardown (`destroy`), graceful announce removal on disconnect.
- Parity checklist against y-webrtc features.

## Open questions

- Default announce cadence and whether to send a path request up front to
  accelerate first-peer discovery on a fresh mesh.
- Whether/how to expose the configured Reticulum interfaces (auto vs. explicit
  TCP/WebSocket) or always prefer `connectToSharedInstance()` with a fallback.
- `maxConns` semantics: do we cap total Links, or per-room Links?
