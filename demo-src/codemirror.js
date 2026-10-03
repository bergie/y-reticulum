import * as Y from 'yjs'
// @ts-ignore
import { yCollab } from 'y-codemirror.next'
import {
  Identity,
  Reticulum,
} from "@reticulum/core";
import {
  WebSocketClientInterface,
} from "@reticulum/core/src/interfaces/websocket.js";
import { ReticulumProvider } from '../src/index.js'

import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { javascript } from '@codemirror/lang-javascript'

import * as random from 'lib0/random'

export const usercolors = [
  { color: '#30bced', light: '#30bced33' },
  { color: '#6eeb83', light: '#6eeb8333' },
  { color: '#ffbc42', light: '#ffbc4233' },
  { color: '#ecd444', light: '#ecd44433' },
  { color: '#ee6352', light: '#ee635233' },
  { color: '#9ac2c9', light: '#9ac2c933' },
  { color: '#8acb88', light: '#8acb8833' },
  { color: '#1be7ff', light: '#1be7ff33' }
]

// select a random color for this user
export const userColor = usercolors[random.uint32() % usercolors.length]

const ydoc = new Y.Doc()

const rns = new Reticulum();
const sock = new WebSocketClientInterface({ host: "127.0.0.1", port: 45236 })
await sock.connect()
rns.addInterface(sock, true)
const identity = await Identity.generate();
const provider = new ReticulumProvider('codemirror6-demo-room', ydoc, {
  reticulum: rns,
  identity,
})
provider.on("status", ({ connected }) => console.log("connected:", connected))
provider.on("synced", ({ synced }) => console.log("synced:", synced))
provider.on("peers", ({ added, removed }) =>
  console.log("peers added:", added, "removed:", removed),
);
await provider.connect()

const ytext = ydoc.getText('codemirror')

const undoManager = new Y.UndoManager(ytext)

provider.awareness.setLocalStateField('user', {
  name: 'Anonymous ' + Math.floor(Math.random() * 100),
  color: userColor.color,
  colorLight: userColor.light
})

const state = EditorState.create({
  doc: ytext.toString(),
  extensions: [
    basicSetup,
    javascript(),
    yCollab(ytext, provider.awareness, { undoManager })
  ]
})

const view = new EditorView({ state, parent: /** @type {HTMLElement} */ (document.querySelector('#editor')) })
