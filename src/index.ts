/**
 * makerchip-view-client — a thin, promise-based client for the Makerchip
 * Third-Party View API.
 *
 * A "view" is a third-party web page embedded as an iframe inside the Makerchip
 * IDE. This client implements the `postMessage` wire protocol so a view can:
 *
 *   - call IDE methods and await their results     (RPC → Promise)
 *   - emit and receive bus events                  (pub/sub)
 *   - expose methods the IDE/host may call         (host → view RPC)
 *
 * Which bus-event types a view may emit or receive is fixed by the `channel`
 * contract the *opener* declares when the view is created (`produces` /
 * `subscribes`), not chosen at runtime. This client is only the runtime
 * mechanism within that grant: the IDE drops outbound events not in `produces`
 * and never delivers types not in `subscribes`.
 *
 * The wire protocol is the normative contract; this library is a faithful,
 * dependency-free binding over it. See the Makerchip Third-Party View API spec
 * for the authoritative message shapes.
 */

/** The wire-protocol version this client speaks. */
export const WIRE_VERSION = 1 as const;

/** A bus-event envelope as delivered from the IDE to the view. */
export interface BusEnvelope<T = unknown> {
  v: number;
  /** The event source, stamped by the IDE (e.g. "ide"). */
  source: string;
  type: string;
  payload: T;
  target?: string | string[];
}

/** Handler invoked for an inbound bus event of a given `type`. */
export type BusHandler<T = unknown> = (payload: T, envelope: BusEnvelope<T>) => void;

/** A method the view exposes for the IDE/host to call (host → view RPC). */
export type ExposedMethod = (...args: any[]) => unknown | Promise<unknown>;

/** The minimal surface of a window we post messages to. */
export interface PostTarget {
  postMessage(message: any, targetOrigin: string): void;
}

export interface ConnectOptions {
  /**
   * The peer window to communicate with. Defaults to `window.parent` when this
   * page is embedded (i.e. `window.parent !== window`). Provide explicitly for
   * testing or non-standard embeddings.
   */
  peerWindow?: Window | PostTarget;
  /** `targetOrigin` passed to `postMessage`. Defaults to `"*"`. */
  targetOrigin?: string;
  /**
   * Post the `ready` handshake automatically (on a microtask, after any
   * synchronous `on`/`expose` registrations). Default `true`.
   */
  autoReady?: boolean;
  /** Reject a pending `call()` after this many ms. Default `0` (never). */
  callTimeoutMs?: number;
}

export interface ViewClient {
  /** True when a peer window was found (the page is embedded in the IDE). */
  readonly embedded: boolean;

  /**
   * Call a method on the IDE and await its result. Rejects if the view is not
   * embedded, on an `rpc-error` reply, or on timeout (when `callTimeoutMs` set).
   */
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;

  /**
   * Emit a bus event to the IDE. The IDE stamps `source` (do not set it) and
   * drops the event unless `type` is in the view's `produces` contract.
   */
  emit(type: string, payload?: unknown, opts?: { target?: string | string[] }): void;

  /**
   * Register a handler for an inbound bus event `type`. The IDE only delivers
   * types in the view's `subscribes` contract, so this routes received events —
   * it does not itself grant a subscription. Returns an unsubscribe function.
   */
  on<T = unknown>(type: string, handler: BusHandler<T>): () => void;

  /** Remove a previously registered bus-event handler. */
  off(type: string, handler: BusHandler): void;

  /** Register methods the IDE/host may invoke (host → view RPC). */
  expose(methods: Record<string, ExposedMethod>): void;

  /** Post the `ready` handshake (idempotent). Called automatically unless
   * `autoReady` is `false`. */
  ready(): void;

  /** Tear down: remove the message listener and reject any pending calls. */
  destroy(): void;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Create a {@link ViewClient} and (unless `autoReady` is disabled) begin the
 * handshake with the Makerchip IDE.
 */
export function connect(options: ConnectOptions = {}): ViewClient {
  const targetOrigin = options.targetOrigin ?? "*";
  const autoReady = options.autoReady ?? true;
  const callTimeoutMs = options.callTimeoutMs ?? 0;

  const g: any = typeof globalThis !== "undefined" ? globalThis : {};
  const defaultPeer: PostTarget | undefined =
    typeof window !== "undefined" && window.parent && window.parent !== window
      ? (window.parent as PostTarget)
      : undefined;
  const peer = (options.peerWindow ?? defaultPeer) as PostTarget | undefined;
  const embedded = !!peer;

  const handlers = new Map<string, Set<BusHandler>>();
  const exposed: Record<string, ExposedMethod> = {};
  const pending = new Map<number, Pending>();
  let seq = 0;
  let readySent = false;
  let destroyed = false;

  function post(message: any): void {
    if (peer) peer.postMessage(message, targetOrigin);
  }

  function onMessage(ev: MessageEvent): void {
    if (destroyed) return;
    // When the event carries a source, only accept messages from our peer.
    if (peer && ev.source && ev.source !== (peer as unknown)) return;

    const m: any = ev.data;
    if (!m || m.v !== WIRE_VERSION) return;

    if (m.kind === "rpc-result" || m.kind === "rpc-error") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (p.timer) clearTimeout(p.timer);
      if (m.kind === "rpc-error") p.reject(new Error(String(m.error ?? "rpc-error")));
      else p.resolve(m.result);
      return;
    }

    if (m.kind === "rpc-call") {
      void handleRpcCall(m);
      return;
    }

    // Bus event: has a string `type` and no `kind`. The `ready` control message
    // is view→IDE only and never delivered back to us.
    if (typeof m.type === "string" && m.type !== "ready") {
      const set = handlers.get(m.type);
      if (!set) return;
      for (const h of [...set]) {
        try {
          h(m.payload, m as BusEnvelope);
        } catch (e) {
          // Handler errors are the consumer's concern; surface, don't swallow.
          // eslint-disable-next-line no-console
          console.error("[makerchip-view-client] bus handler error:", e);
        }
      }
    }
  }

  async function handleRpcCall(m: any): Promise<void> {
    const fn = exposed[m.method];
    if (typeof fn !== "function") {
      post({ v: WIRE_VERSION, kind: "rpc-call-error", id: m.id, error: `unknown method: ${m.method}` });
      return;
    }
    try {
      const result = await fn(...(m.args ?? []));
      post({ v: WIRE_VERSION, kind: "rpc-call-result", id: m.id, result });
    } catch (e: any) {
      post({ v: WIRE_VERSION, kind: "rpc-call-error", id: m.id, error: String(e?.message ?? e) });
    }
  }

  const client: ViewClient = {
    get embedded() {
      return embedded;
    },

    call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
      if (!embedded) {
        return Promise.reject(
          new Error('makerchip-view-client: not embedded in a Makerchip IDE (no peer window)'),
        );
      }
      const id = ++seq;
      const promise = new Promise<T>((resolve, reject) => {
        const entry: Pending = { resolve, reject };
        if (callTimeoutMs > 0) {
          entry.timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`makerchip-view-client: RPC "${method}" timed out after ${callTimeoutMs}ms`));
          }, callTimeoutMs);
        }
        pending.set(id, entry);
      });
      post({ v: WIRE_VERSION, kind: "rpc", id, target: "ide", method, args });
      return promise;
    },

    emit(type: string, payload?: unknown, opts?: { target?: string | string[] }): void {
      if (!embedded) return;
      const env: any = { v: WIRE_VERSION, type, payload };
      if (opts?.target !== undefined) env.target = opts.target;
      post(env);
    },

    on<T = unknown>(type: string, handler: BusHandler<T>): () => void {
      let set = handlers.get(type);
      if (!set) {
        set = new Set();
        handlers.set(type, set);
      }
      set.add(handler as BusHandler);
      return () => client.off(type, handler as BusHandler);
    },

    off(type: string, handler: BusHandler): void {
      const set = handlers.get(type);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) handlers.delete(type);
    },

    expose(methods: Record<string, ExposedMethod>): void {
      Object.assign(exposed, methods);
    },

    ready(): void {
      if (!embedded || readySent) return;
      readySent = true;
      post({ v: WIRE_VERSION, type: "ready" });
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      if (typeof g.removeEventListener === "function") {
        g.removeEventListener("message", onMessage);
      }
      for (const p of pending.values()) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error("makerchip-view-client: destroyed"));
      }
      pending.clear();
      handlers.clear();
    },
  };

  if (embedded && typeof g.addEventListener === "function") {
    g.addEventListener("message", onMessage);
  }
  if (embedded && autoReady) {
    // Defer to a microtask so synchronous on()/expose() calls complete first.
    const q: (cb: () => void) => void =
      typeof queueMicrotask === "function"
        ? queueMicrotask
        : (cb) => void Promise.resolve().then(cb);
    q(() => client.ready());
  }

  return client;
}

export default connect;
