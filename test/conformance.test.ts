import { afterEach, describe, expect, it } from "vitest";
import { connect, WIRE_VERSION, type ConnectOptions, type ViewClient } from "../src/index";

/** Track created clients so we can tear them down between tests. */
const created: ViewClient[] = [];

function makePeer() {
  const sent: any[] = [];
  const peer = {
    postMessage: (m: any, _o: string) => {
      sent.push(m);
    },
  };
  return { peer, sent };
}

function connectT(opts: ConnectOptions): ViewClient {
  const v = connect(opts);
  created.push(v);
  return v;
}

function deliver(data: any): void {
  globalThis.dispatchEvent(new MessageEvent("message", { data }));
}

afterEach(() => {
  created.splice(0).forEach((v) => v.destroy());
});

describe("wire conformance", () => {
  it("posts a ready handshake after connect (autoReady)", async () => {
    const { peer, sent } = makePeer();
    connectT({ peerWindow: peer });
    await Promise.resolve(); // let the microtask-scheduled ready() run
    expect(sent).toContainEqual({ v: WIRE_VERSION, type: "ready" });
  });

  it("does not send ready when autoReady is false, until ready() is called", () => {
    const { peer, sent } = makePeer();
    const view = connectT({ peerWindow: peer, autoReady: false });
    expect(sent.find((m) => m.type === "ready")).toBeUndefined();
    view.ready();
    view.ready(); // idempotent
    expect(sent.filter((m) => m.type === "ready")).toHaveLength(1);
  });

  it("emits an RPC envelope with the documented shape and resolves on rpc-result", async () => {
    const { peer, sent } = makePeer();
    const view = connectT({ peerWindow: peer, autoReady: false });
    const pr = view.call("getCompileStatus", "abc");
    const rpc = sent.find((m) => m.kind === "rpc");
    expect(rpc).toEqual({
      v: WIRE_VERSION,
      kind: "rpc",
      id: rpc.id,
      target: "ide",
      method: "getCompileStatus",
      args: ["abc"],
    });
    deliver({
      v: WIRE_VERSION,
      kind: "rpc-result",
      id: rpc.id,
      result: { id: "abc", model: "success", sim: "pending" },
    });
    await expect(pr).resolves.toEqual({ id: "abc", model: "success", sim: "pending" });
  });

  it("rejects a call on an rpc-error reply", async () => {
    const { peer, sent } = makePeer();
    const view = connectT({ peerWindow: peer, autoReady: false });
    const pr = view.call("nope");
    const rpc = sent.find((m) => m.kind === "rpc");
    deliver({ v: WIRE_VERSION, kind: "rpc-error", id: rpc.id, error: "bad method" });
    await expect(pr).rejects.toThrow("bad method");
  });

  it("emit posts a bus envelope with no kind and no source", () => {
    const { peer, sent } = makePeer();
    const view = connectT({ peerWindow: peer, autoReady: false });
    view.emit("sourceHover", { line: 12 }, { target: "editor" });
    const ev = sent.find((m) => m.type === "sourceHover");
    expect(ev).toEqual({ v: WIRE_VERSION, type: "sourceHover", payload: { line: 12 }, target: "editor" });
    expect(ev.kind).toBeUndefined();
    expect(ev.source).toBeUndefined();
  });

  it("dispatches inbound bus events to on() handlers, and off() unsubscribes", () => {
    const { peer } = makePeer();
    const view = connectT({ peerWindow: peer, autoReady: false });
    const seen: any[] = [];
    const unsub = view.on("compile-result", (payload, env) => seen.push([payload, env.source]));

    deliver({ v: WIRE_VERSION, source: "ide", type: "compile-result", payload: { which: "start", id: "x" } });
    expect(seen).toEqual([[{ which: "start", id: "x" }, "ide"]]);

    unsub();
    deliver({ v: WIRE_VERSION, source: "ide", type: "compile-result", payload: { which: "vcd", id: "x" } });
    expect(seen).toHaveLength(1); // no new delivery after unsubscribe
  });

  it("ignores messages with a mismatched wire version", () => {
    const { peer } = makePeer();
    const view = connectT({ peerWindow: peer, autoReady: false });
    const seen: any[] = [];
    view.on("theme", (p) => seen.push(p));
    deliver({ v: 999, source: "ide", type: "theme", payload: { dark: true } });
    expect(seen).toEqual([]);
  });

  it("answers an IDE->view rpc-call via an exposed method", async () => {
    const { peer, sent } = makePeer();
    const view = connectT({ peerWindow: peer, autoReady: false });
    view.expose({ add: (a: number, b: number) => a + b });
    deliver({ v: WIRE_VERSION, kind: "rpc-call", id: 7, method: "add", args: [2, 3] });
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toContainEqual({ v: WIRE_VERSION, kind: "rpc-call-result", id: 7, result: 5 });
  });

  it("replies with rpc-call-error for an unknown exposed method", async () => {
    const { peer, sent } = makePeer();
    connectT({ peerWindow: peer, autoReady: false });
    deliver({ v: WIRE_VERSION, kind: "rpc-call", id: 9, method: "missing", args: [] });
    await Promise.resolve();
    const reply = sent.find((m) => m.kind === "rpc-call-error" && m.id === 9);
    expect(reply.error).toContain("missing");
  });

  it("reports not embedded when there is no peer window", async () => {
    const view = connectT({ peerWindow: undefined });
    expect(view.embedded).toBe(false);
    await expect(view.call("x")).rejects.toThrow(/not embedded/);
  });
});
