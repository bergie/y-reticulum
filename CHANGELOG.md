# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `discovered` provider event, fired whenever an announce for the room arrives from the mesh — before any glare or link-policy decision, so apps can narrate room propagation even when no link forms (payload: `{ remoteHex }`)
- `announced` provider event, fired when the room's destination goes on air: once at connect (the first announce fires immediately) and after each early-burst re-announce. The periodic re-announce cadence is delegated to `@reticulum/core` and does not fire it

### Fixed

- Stale peer links: when a peer died without tearing its link down (crash, reload, killed worker), its announce was ignored because the room still considered the destination linked, leaving both sides unsynced until the Reticulum link timeout expired. An announce from a linked peer now checks whether a live (`ACTIVE`) link actually exists; if not, the stale connection is destroyed — with the usual `peers removed` bookkeeping — and a fresh link is initiated, so recovery takes one announce instead of minutes. A re-announce while the link is live remains a no-op
- Slow first discovery after connect: the immediate first announce races interface readiness at the relay (a just-connected WebSocket client is not yet a viable repeater path), and when it is dropped, discovery stalls for a full announce interval — compounded by the glare rule, where only the larger destination hash initiates and thus needs to receive the peer's announce. The room now repeats the announce 1 s, 4 s and 10 s after connect, so a dropped first announce costs seconds instead of a minute; the periodic cadence takes over after. Note that a refused link is re-attempted on each new announce, so refusals can now repeat within seconds rather than at the announce interval
- Publishing from CI: the `publish-npm` workflow job ran `npm publish` without installing dependencies, so the `prepublishOnly` type-generation step (`tsc`) failed because npx fetched the wrong `tsc` stub package instead of the local TypeScript. The job now runs `npm ci` first, and the `types` script invokes `tsc` directly from `node_modules` instead of through `npx`

## [0.3.0] - 2026-10-04

### Added

- Optional `authorizeLink` provider option: an application-defined authorization phase on every peer link, run after the identity is proven and before any room traffic flows. The authorizer receives the live link plus a `send`/`receive` exchange bound to the link's channel (reliable, ordered, inbound payloads queued), so it can run its own protocol — e.g. noflo-ui's Dacar on-link assertion exchange (noflo-ui work document #25 §6.2) — before Yjs sync starts. A `false` verdict, a throw, or exceeding `authorizeTimeoutMs` tears the link down and reports it via `refused`; anything the peer sent meanwhile is stashed and only delivered once the phase passes
- Refusals reported via the `refused` event now carry a `reason`: `"identify-timeout"`, `"link-policy"`, `"authorization"`, or `"authorization-timeout"`
- The package now ships generated TypeScript declarations: the `tsc` output (`dist/*.d.ts`, emitted by `npm run types`) is published alongside the source and referenced through the `types` and `exports` fields, so consumers typecheck against real declarations instead of `allowJs` inference of the JSDoc source. Declarations are emitted by `prepublishOnly` on publish

## [0.2.1] - 2026-10-03

### Fixed

- Link-setup race that dropped the peer's initial sync traffic: with a `linkPolicy` set, the initiator could send its `syncStep1` + awareness while the responder was still awaiting the identify handshake / policy decision, before `YjsSyncMessage` was registered on the channel. Those messages were dropped by the channel (`Unable to find constructor for Channel MSGTYPE 0x1`), notably losing the initiator's initial awareness state. The room now primes each link's channel (registers the message type and stashes early inbound payloads) as soon as the link exists, and flushes the stash when the `PeerConn` takes over
## [0.2.0] - 2026-10-03

### Added

- Optional `linkPolicy` provider option: an application-supplied callback that decides whether a peer link may carry room traffic, evaluated on both the initiator and responder sides once the remote identity is cryptographically proven (via the signed announce on the initiator side, via the signed `LINKIDENTIFY` handshake on the responder side)
- Optional `identifyTimeoutMs` provider option: how long the responder waits for the initiator's identify handshake before refusing the link (default 10 s)
- `refused` provider event, fired when a peer link was refused by the link policy, so apps can surface access requests ("peer X wants to join")
- Browser demo build (`tsdown.config.js`, `demo-src/`)

## [0.1.3] - 2026-09-21

## [0.1.2] - 2026-09-21

### Changed

- Updated `@reticulum/core` and `@reticulum/node` to `^0.8.2`

## [0.1.1] - 2026-08-04

### Changed

- Updated `@reticulum/core` and `@reticulum/node` to `^0.6.0`

### Added

- Release automation

## [0.1.0] - 2026-08-01

### Added

- Initial release: Reticulum network transport connector for Yjs
- Document and awareness synchronization between peers over Reticulum Links
- Compressed resource support via `@digitaldefiance/bzip2-wasm`
- Reconnection handling with automatic re-establishment and re-syncing of dropped Links
- Periodic re-announces to ensure destination discoverability
- Tests running on Node, Deno, and Bun
