import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  notify: (_method: string, _params: Record<string, unknown>) => {},
  call: async (_method: string, _params: Record<string, unknown>): Promise<unknown> => undefined,
  exited: (_error: Error) => {},
  requests: [] as { method: string; params: Record<string, unknown> }[],
}));
vi.mock("./checkpoints", () => ({ createCheckpoint: async () => ({ id: "00000000-0000-4000-8000-000000000001" }) }));
vi.mock("./codex-protocol", async importOriginal => {
  const original = await importOriginal<typeof import("./codex-protocol")>();
  let counter = 0;
  const threads = new Map<string, { id: string; cwd: unknown; turns: unknown[] }>();
  return { ...original, CodexAppServer: class {
    constructor(options: { notification: typeof fake.notify; serverRequest: typeof fake.call; exited: typeof fake.exited }) {
      fake.notify = options.notification; fake.call = options.serverRequest; fake.exited = options.exited;
    }
    async request(method: string, params: Record<string, unknown>) {
      fake.requests.push({ method, params });
      if (method === "config/read") return { config: {} };
      if (method === "thread/start") {
        const thread = { id: `thread-${++counter}`, cwd: params.cwd, turns: [] };
        threads.set(thread.id, thread);
        return { thread };
      }
      if (method === "thread/read" || method === "thread/resume") return { thread: threads.get(String(params.threadId)) };
      if (method === "turn/start") {
        const turn = { id: `turn-${params.threadId}` };
        fake.notify("turn/started", { threadId: params.threadId, turn });
        return { turn };
      }
      if (method === "turn/interrupt") { fake.notify("turn/completed", { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } }); return {}; }
      throw new Error(`Unexpected method ${method}`);
    }
    dispose() { fake.exited(new Error("Codex connection closed")); }
  } };
});
import { CodexService } from "./codex";
import { Workspaces } from "./workspaces";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); fake.requests.length = 0; });

it("runs three native Codex projects independently and cancels only one", async () => {
  const root = await mkdtemp(join(tmpdir(), "frameyard-codex-parallel-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dirs = [join(root,"a"),join(root,"b"),join(root,"c")];
  await Promise.all(dirs.map(dir=>mkdir(dir)));
  const event = vi.fn();
  const service = new CodexService({ dataDir: root, onEvent: event, runTool: async () => ({ success: true, contentItems: [] }) });
  const turns = await Promise.all(dirs.map(dir => service.request({ method: "send", input: { dir, text: "Build this video", context: {} } })));
  expect(turns.every(turn=>turn.method === "send")).toBe(true);
  expect(fake.requests.filter(request=>request.method === "turn/start")).toHaveLength(3);
  await expect(service.request({ method: "send", input: { dir: dirs[0]!, text:"Again", context:{} } })).rejects.toThrow("already working");
  await service.request({ method: "cancel", input: { dir: dirs[1]! } });
  await vi.waitFor(()=>expect(event).toHaveBeenCalledWith(expect.objectContaining({ dir:dirs[1],type:"turn",status:"interrupted" })));
  for (const dir of [dirs[0]!,dirs[2]!]) await expect(service.request({ method:"new",input:{dir} })).rejects.toThrow("already working");
  service.dispose();
});

it("Stop cancels only its turn's tools and retains the GPU slot until their cleanup finishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "frameyard-codex-stop-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const first = join(root, "first"), second = join(root, "second");
  await Promise.all([mkdir(first), mkdir(second)]);
  const manager = new Workspaces({
    createWindow: () => Object.assign(new EventEmitter(), {
      isDestroyed: () => false, isVisible: () => true, webContents: new EventEmitter(), destroy() {},
    }) as unknown as BrowserWindow,
    open: async (_window, dir) => ({ name: dir }), changed() {}, release() {},
  });
  const started = Promise.withResolvers<void>(), cleaning = Promise.withResolvers<void>(), cleaned = Promise.withResolvers<void>();
  let firstSignal: AbortSignal | undefined;
  const events = vi.fn();
  const service = new CodexService({ dataDir: root, onEvent: events,
    runTool: (dir, name, _args, signal) => manager.run(dir, name, signal, async (_window, jobSignal) => {
      if (dir === first) {
        firstSignal = signal;
        started.resolve();
        await new Promise<void>(resolve => jobSignal.addEventListener("abort", () => resolve(), { once: true }));
        cleaning.resolve();
        await cleaned.promise;
        jobSignal.throwIfAborted();
      }
      return { success: true, contentItems: [] };
    }, true),
  });
  try {
    const turn = await service.request({ method: "send", input: { dir: first, text: "Capture", context: {} } });
    if (turn.method !== "send") throw new Error("Expected a new turn");
    const tool = fake.call("item/tool/call", { ...turn.result, tool: "editor_capture", arguments: {} });
    await started.promise;
    const next = vi.fn(async () => "exported");
    const exporting = manager.run(second, "export", undefined, next, true);
    await vi.waitFor(() => expect(manager.list().workspaces.find(row => row.dir === second)?.status).toBe("queued"));
    await service.request({ method: "cancel", input: { dir: first } });
    await cleaning.promise;
    expect(firstSignal?.aborted).toBe(true);
    expect(next).not.toHaveBeenCalled();
    expect(manager.list().workspaces.find(row => row.dir === first)?.jobs).toHaveLength(1);
    cleaned.resolve();
    await expect(tool).resolves.toMatchObject({ success: false });
    await expect(exporting).resolves.toBe("exported");
    expect(next).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: "turn", status: "interrupted" })));
  } finally { cleaned.resolve(); service.dispose(); manager.dispose(); }
});

it.each(["failed", "exit", "dispose"] as const)("%s cancels abandoned tools without poisoning the next turn", async ending => {
  const root = await mkdtemp(join(tmpdir(), "frameyard-codex-tool-end-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const events = vi.fn();
  const signals: AbortSignal[] = [];
  const service = new CodexService({ dataDir: root, onEvent: events, runTool: async (_dir, _name, _args, signal) => {
    if (!signal) throw new Error("Native tool has no turn signal");
    signals.push(signal);
    if (signals.length === 1) await new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    return { success: true, contentItems: [] };
  } });
  try {
    const turn = await service.request({ method: "send", input: { dir: root, text: "Edit", context: {} } });
    if (turn.method !== "send") throw new Error("Expected a new turn");
    const abandoned = fake.call("item/tool/call", { ...turn.result, tool: "editor_context", arguments: {} });
    expect(signals[0]?.aborted).toBe(false);
    if (ending === "failed") fake.notify("error", { threadId: turn.result.threadId, error: { message: "Turn failed" } });
    if (ending === "exit") fake.exited(new Error("Process exited"));
    if (ending === "dispose") service.dispose();
    expect(signals[0]?.aborted).toBe(true);
    await expect(abandoned).resolves.toMatchObject({ success: false });
    await vi.waitFor(() => expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: "turn", status: "failed" })));
    const next = await service.request({ method: "send", input: { dir: root, text: "Next", context: {} } });
    if (next.method !== "send") throw new Error("Expected another turn");
    await fake.call("item/tool/call", { ...next.result, tool: "editor_context", arguments: {} });
    expect(signals[1]?.aborted).toBe(false);
    expect(signals[1]).not.toBe(signals[0]);
    fake.notify("turn/completed", { threadId: next.result.threadId, turn: { id: next.result.turnId, status: "completed" } });
    await vi.waitFor(() => expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: "turn", status: "completed" })));
    expect(signals[1]?.aborted).toBe(false);
    await service.request({ method: "cancel", input: { dir: root } });
    expect(signals[1]?.aborted).toBe(false);
  } finally { service.dispose(); }
});
