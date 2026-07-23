# Reticulum connector for [Yjs](https://github.com/yjs/yjs)

Propagates document updates over [Reticulum](https://reticulum.network/) mesh network.

* Public key encryption and authorization using [Reticulum Identities](https://reticulum.network/manual/zen.html#identity-and-nomadism)
* Flexible network topology and multiple interfaces ranging from TCP to LoRa and HF radio links
* Very little setup needed with Reticulum announce and discovery mechanisms
* Sync and awareness traffic rides a reliable, in-order, windowed Link Channel
  (retransmitted on lossy hops) for performant CRDT synchronization
* Larger CRDT updates are automatically transported as bz2 compressed Resources

Built on [reticulum-js](https://reticulum.js.org/) with aim to support both browsers and Node.js. For browsers, please read the [browser connectivity](https://reticulum.js.org/documents/Browser_Connectivity.html) notes.

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

> Running in a browser? See the reticulum-js
> [browser connectivity](https://reticulum.js.org/documents/Browser_Connectivity.html)
> notes for how to attach an interface.

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
  announceIntervalMs: 30_000,
}
```

The provider extends `ObservableV2` and emits:

| Event | Payload | When |
| --- | --- | --- |
| `status` | `{ connected: boolean }` | the provider (dis)connects from the mesh |
| `synced` | `{ synced: boolean }` | sync state with the peer mesh changes |
| `peers` | `{ added: string[], removed: string[] }` | peers are discovered or drop off |

## License

Licensed under the [EUPL 1.2](https://interoperable-europe.ec.europa.eu/collection/eupl/eupl-text-eupl-12).
