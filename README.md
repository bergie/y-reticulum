# Reticulum connector for [Yjs](https://github.com/yjs/yjs)

Propagates document updates over [Reticulum](https://reticulum.network/) mesh network.

* Public key encryption and authorization using [Reticulum Identities](https://reticulum.network/manual/zen.html#identity-and-nomadism)
* Flexible network topology and multiple interfaces ranging from TCP to LoRa and HF radio links
* Very little setup needed with Reticulum announce and discovery mechanisms
* Sync and awareness traffic rides a reliable, in-order, windowed Link Channel
  (retransmitted on lossy hops) for performant CRDT synchronization
* Larger CRDT updates are automatically transported as bz2 compressed Resources

Built on [reticulum-js](https://reticulum.js.org/) with aim to support browsers, Node.js, and Deno. For browsers, please read the [browser connectivity](https://reticulum.js.org/documents/Browser_Connectivity.html) notes.

## Status

Just getting started

## Install

```sh
npm i y-reticulum
```

## Usage

Clients connected to the same room name share document updates. In addition to
a `Y.Doc`, you pass a configured [@reticulum/core](https://reticulum.js.org/)
instance — the provider does not open network interfaces itself.

```js
import * as Y from "yjs"
import { Identity, Reticulum } from "@reticulum/core"
import { TCPClientInterface } from "@reticulum/node"
import { ReticulumProvider } from "y-reticulum"

// 1. Connect to the Reticulum mesh. Prefer the local shared instance (e.g. a
//    running `rnsd`); fall back to a direct TCP interface when there is none.
const rns = new Reticulum()
const shared = await rns.connectToSharedInstance()
if (!shared) {
  const tcp = new TCPClientInterface({ host: "127.0.0.1", port: 42424 })
  await tcp.connect()
  rns.addInterface(tcp, true)
}

// 2. An identity for this peer (persist it between runs in real apps so your
//    Reticulum address stays stable).
const identity = await Identity.generate()

// 3. Create the Yjs document and the provider.
const ydoc = new Y.Doc()
const provider = new ReticulumProvider("your-room-name", ydoc, {
  reticulum: rns,
  identity,
})

provider.on("status", ({ connected }) => console.log("connected:", connected))
provider.on("synced", ({ synced }) => console.log("synced:", synced))
provider.on("peers", ({ added, removed }) =>
  console.log("peers added:", added, "removed:", removed),
)

await provider.connect()

const yarray = ydoc.getArray("array")
```

## API

```js
new ReticulumProvider(roomName, ydoc[, opts])
```

`opts` accepts the following (all optional except `reticulum`):

```js
{
  // A configured Reticulum instance with at least one (default) interface
  // attached. Required — the provider does not open interfaces itself.
  reticulum,
  // Identity for this peer's room destination. Generated (non-persistent) if
  // omitted; supply your own to keep a stable address across restarts.
  identity,
  // Reuse an existing Awareness instance - see https://github.com/yjs/y-protocols
  awareness: new awarenessProtocol.Awareness(ydoc),
  // Upper bound on simultaneous peer Links. Mirrors y-webrtc's `maxConns`.
  maxConns: 20,
  // Cadence (ms) at which the room destination is re-announced for discovery.
  // Delegated to @reticulum/core's Destination.startAnnouncing, which clamps
  // to the 60s floor from the Reticulum spec (sub-minute intervals trigger
  // ingress rate limiting).
  announceIntervalMs: 60_000,
  // Optional access control. When set, peer links must prove their identity
  // (the initiator runs the signed identify handshake over the link) and pass
  // the policy before any room traffic flows. Refused links are torn down and
  // reported via the `refused` event. See "Access control" below.
  linkPolicy: ({ remoteIdentityHash, remoteDestinationHash, initiator }) =>
    allowed.has(remoteIdentityHash),
  // How long the responder waits for the initiator's identify handshake
  // before refusing the link. Only relevant with a `linkPolicy`.
  identifyTimeoutMs: 10_000,
  // Optional application-defined authorization phase. Runs on every peer link
  // after the identity is proven and before any room traffic flows: the
  // callback receives the live link plus a send/receive exchange bound to the
  // link's channel, so it can run its own protocol (e.g. a Dacar assertion
  // exchange) before Yjs sync is allowed to start. See "Access control"
  // below.
  authorizeLink: async ({ link, remoteIdentityHash, initiator, exchange }) => {
    if (initiator) {
      await exchange.send(encodeAssertionRequest(remoteIdentityHash))
      return verifyAssertionReply(await exchange.receive())
    }
    return answerAssertionRequest(await exchange.receive(), exchange)
  },
  // How long the authorization phase may run before the link is refused.
  // Only relevant with an `authorizeLink`.
  authorizeTimeoutMs: 10_000,
}
```

The provider extends `ObservableV2` and emits:

| Event | Payload | When |
| --- | --- | --- |
| `status` | `{ connected: boolean }` | the provider (dis)connects from the mesh |
| `synced` | `{ synced: boolean }` | sync state with the peer mesh changes |
| `peers` | `{ added: string[], removed: string[] }` | peers are discovered or drop off |
| `refused` | `{ refusals: Array<{ destinationHash: string \| null, identityHash: string \| null, initiator: boolean, reason?: string }> }` | a peer link was refused by the link policy or the authorization phase |

## Access control

Pass a `linkPolicy` to gate which peers may sync with your room. The policy is
a (possibly async) callback that receives the remote peer's
`remoteIdentityHash` (hex truncated hash of their long-term Reticulum
identity), their room `remoteDestinationHash` when known (initiator side;
`null` on the responder side, where it is only learnt after identify), and
`initiator` telling which side of the link you are. Return `true` to allow the
link, `false` to refuse it: refused links are torn down before any room traffic flows, and reported on the `refused` event.

The identity hash is cryptographically bound on both sides: on the initiator
side it comes from the peer's signed announce, on the responder side from the
signed identify handshake over the link. Peers that never identify (e.g. older
versions without ACL support) are refused after `identifyTimeoutMs` and
reported with a `null` identityHash.

Refusals carry a `reason` telling which gate declined: `"identify-timeout"`
(the peer never proved its identity), `"link-policy"` (the policy declined),
`"authorization"` (the authorizer declined or threw) or
`"authorization-timeout"` (the authorization phase exceeded
`authorizeTimeoutMs`).

Refusals make natural access requests: collect them and, when a user grants
access, add the peer's identity hash to your allow-list. The next announce
cycle connects the peers.

```js
const granted = new Set([myIdentityHash])
const provider = new ReticulumProvider("your-room-name", ydoc, {
  reticulum: rns,
  identity,
  linkPolicy: ({ remoteIdentityHash }) => granted.has(remoteIdentityHash),
})
provider.on("refused", ({ refusals }) => {
  for (const { identityHash } of refusals) {
    console.log("access request from", identityHash) // surface in your UI
  }
})
```

### Application-defined authorization (`authorizeLink`)

A `linkPolicy` only sees the peer's identity hash — enough for "is this peer
known to me", but not for authorization schemes where the decision needs an
exchange with the peer itself (for example verifying a Dacar assertion before
any sync traffic flows). Pass an `authorizeLink` callback to run your own
protocol on the link after the identity is proven and before any Yjs sync or
awareness traffic.

The callback receives the established `link`, the proven
`remoteIdentityHash` (and `remoteDestinationHash` when known, initiator side
only), which side of the link you are (`initiator`), and an `exchange` with
two methods bound to the link's channel:

- `exchange.send(payload)` delivers an application payload (`Uint8Array`) to
  the peer, as a reliable ordered channel message.
- `exchange.receive()` resolves with the next application payload from the
  peer; payloads arriving before the call are queued, so the two sides can
  start in either order.

Resolve `true` to allow the link — Yjs sync then starts, with anything the
peer sent meanwhile (typically its initial `syncStep1`) delivered first in
protocol order. Resolve `false`, throw, or exceed `authorizeTimeoutMs` to
refuse: the link is torn down and reported on the `refused` event with reason
`"authorization"` (or `"authorization-timeout"`). The phase composes with
`linkPolicy`, which is evaluated first, and runs on both sides of every link
— your protocol decides who speaks first via `initiator`.

```js
const provider = new ReticulumProvider("your-room-name", ydoc, {
  reticulum: rns,
  identity,
  authorizeLink: async ({ initiator, exchange }) => {
    if (initiator) {
      // Present our grant, then verify the peer's counter-grant
      await exchange.send(encodeAssertion(myGrant))
      return verifyAssertion(await exchange.receive())
    }
    // Responder: verify the initiator's grant, then present ours
    const remote = await exchange.receive()
    await exchange.send(encodeAssertion(myGrant))
    return verifyAssertion(remote)
  },
  authorizeTimeoutMs: 10_000,
})
```

## License

Licensed under the [EUPL 1.2](https://interoperable-europe.ec.europa.eu/collection/eupl/eupl-text-eupl-12).
