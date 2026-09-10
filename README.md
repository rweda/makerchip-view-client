# makerchip-view-client

A thin, promise-based client for the **Makerchip Third-Party View API**.

A *view* is a third-party web page embedded as an iframe inside the
[Makerchip](https://makerchip.com) IDE. This library implements the `postMessage`
wire protocol so your view can talk to the IDE without hand-rolling message
plumbing:

- **call IDE methods and await results** — RPC that returns a `Promise`
- **emit / receive bus events** — e.g. compile results, theme changes
- **expose methods the IDE can call** — host → view RPC

Zero runtime dependencies. Ships ESM, CommonJS, and a browser global (IIFE).

> Which bus-event types a view may emit or receive is fixed by the `channel`
> contract the *opener* declares when the view is created (`produces` /
> `subscribes`) — not chosen at runtime. `emit`/`on` are the runtime mechanism
> within that grant; the IDE drops outbound events not in `produces` and never
> delivers types not in `subscribes`.

> The wire protocol is the normative contract. This library is a faithful
> binding over it — most views should use this client, but anything it does can
> be reproduced with raw `postMessage`.

## Install

```sh
npm install @rweda/makerchip-view-client
```

Or load the browser global directly from a CDN (no build step):

```html
<script src="https://cdn.jsdelivr.net/npm/@rweda/makerchip-view-client/dist/index.global.js"></script>
<script>
  const view = MakerchipView.connect();
</script>
```

## Quick start

```ts
import { connect } from "@rweda/makerchip-view-client";

const view = connect();

// 1. Read the context the IDE opened this view with.
const ctx = await view.call("getContext");
// ctx = { mnemonic, params, theme: { dark } }

// 2. React to the IDE's theme and compile lifecycle.
view.on("theme", ({ dark }) => document.body.classList.toggle("dark", dark));
view.on("compile-result", ({ which, id, success }) => {
  if (which === "start") view.call("setStatus", "working");
  if (which === "sandpiper") view.call("setStatus", success ? "success" : "fail");
});

// 3. Ask the IDE for a compile's status.
const status = await view.call("getCompileStatus", ctx.params?.id);
// status = { id, model, sim } | null   (model/sim: "pending" | "success" | "fail")

// 4. Call any other IDE method the channel grants.
await view.call("setStatus", "success");
```

`connect()` posts a `ready` handshake automatically (on a microtask, after your
synchronous `on(...)`/`expose(...)` registrations), so no queued inbound events
are missed.

## API

### `connect(options?): ViewClient`

| Option          | Default                       | Description                                             |
| --------------- | ----------------------------- | ------------------------------------------------------- |
| `peerWindow`    | `window.parent` when embedded | The window to exchange messages with.                   |
| `targetOrigin`  | `"*"`                         | `targetOrigin` for `postMessage`.                       |
| `autoReady`     | `true`                        | Send the `ready` handshake automatically after connect. |
| `callTimeoutMs` | `0` (never)                   | Reject a pending `call()` after this many ms.           |

### `ViewClient`

- **`embedded: boolean`** — `true` when a peer window was found. When `false`,
  `call()` rejects, so a view can also run standalone.
- **`wireVersion: number`** — the negotiated wire protocol version (currently `1`).
- **`call<T>(method, ...args): Promise<T>`** — invoke an IDE method; resolves
  with its result or rejects on an error reply / timeout. IDE methods (e.g.
  `getContext`, `getCompileStatus`, `setStatus`) are documented with the IDE, not
  this client — pass their names and args through `call`.
- **`emit(type, payload?, { target? }): void`** — emit a bus event. The IDE
  stamps the `source` (do not set it) and drops it unless `type` is in the
  view's `produces` contract.
- **`on<T>(type, handler): () => void`** — register a handler for an inbound bus
  event (one of the types in the view's `subscribes` contract). Returns an
  unsubscribe function. `handler(payload, envelope)`. The `envelope` carries the
  IDE-resolved trust stamps `origin` (web origin of the responsible participant —
  the nearest view in the sender's creation chain that has its own origin, when
  known) and `author` (that participant's identity, present only when it differs
  from `source`), plus `sameOrigin()` — `true` when the event came from a view
  served from this view's own origin. These stamps are set by the IDE and cannot
  be forged by a peer view.
- **`off(type, handler): void`** — remove a handler.
- **`expose(methods): void`** — register methods the IDE/host may call
  (host → view RPC), when the channel is opened with RPC enabled.
- **`ready(): void`** — send the `ready` handshake (idempotent; automatic unless
  `autoReady: false`).
- **`destroy(): void`** — remove the message listener and reject pending calls.

Also exported: **`WIRE_VERSION`**, **`WIRE_MIN_VERSION`**, **`WIRE_MAX_VERSION`**,
the **`sameOrigin(a, b)`** helper, and the TypeScript types
`ViewClient`, `ConnectOptions`, `BusEnvelope`, `BusHandler`,
`ExposedMethod`, `PostTarget`.

## Development

```sh
npm install
npm test          # vitest wire-conformance suite
npm run build     # tsup → dist/ (ESM + CJS + IIFE + .d.ts)
npm run typecheck # tsc --noEmit
```

Publishing is automated: pushing a `v*` tag runs the `Publish` workflow, which
tests, builds, and runs `npm publish --provenance`. Set an `NPM_TOKEN` repo
secret (or configure npm trusted publishing / OIDC) first.

## License

[MIT](./LICENSE) © Redwood EDA, LLC
