import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import type { CodexOptions } from "./codex-contracts";
import type { MainReply } from "./main-channels";
import { afterEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ restore: undefined as CodexOptions["restoreCheckpoint"] }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return { ipcMain: new EventEmitter(), dialog: {} };
});
vi.mock("./codex", () => ({ CodexService: class {
  constructor(options: CodexOptions) { native.restore = options.restoreCheckpoint; }
  async withProjectIdle<T>(dir: string, operation: (dir: string) => Promise<T>) { return operation(dir); }
  dispose() {}
} }));
vi.mock("./projects", () => ({ unwatchProject: vi.fn(), watchProject: vi.fn() }));
vi.mock("./agent-assets", () => ({ importAsset() {}, importGeneratedAsset() {}, searchAssets() {} }));
vi.mock("./hyperframes-catalog", () => ({ handleCatalogRequest() {} }));
vi.mock("./manim", () => ({ handleManimRequest() {} }));
vi.mock("./animations", () => ({ handleAnimationRequest() {} }));

import { ipcMain } from "electron";
import { MAIN_CHANNELS, MAIN_WIRE } from "./main-channels";
import { mainBridge } from "./main-manager";
import { registerAgentBridge } from "./agent-bridge";
import { Workspaces } from "./workspaces";
import { unwatchProject, watchProject } from "./projects";
import * as checkpoints from "./checkpoints";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "frameyard-checkpoint-workspaces-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dirs = [join(root, "first"), join(root, "second")];
  const saved = await Promise.all(dirs.map(async dir => {
    await mkdir(dir);
    await writeFile(join(dir, "index.tsx"), "before");
    const checkpoint = await checkpoints.createCheckpoint(dir, "Before");
    await writeFile(join(dir, "index.tsx"), "after");
    return checkpoint;
  }));
  const replies = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const windows: BrowserWindow[] = [];
  const manager = new Workspaces({
    createWindow: () => {
      let destroyed = false;
      const window = Object.assign(new EventEmitter(), {
        isDestroyed: () => destroyed, isVisible: () => true,
        destroy() { destroyed = true; window.emit("closed"); },
        webContents: Object.assign(new EventEmitter(), {
          isDestroyed: () => destroyed, isLoadingMainFrame: () => false,
          send(wire: string, reply: MainReply) {
            if (wire !== MAIN_WIRE.RESPONSE) return;
            const pending = replies.get(reply.id);
            replies.delete(reply.id);
            if (reply.ok) pending?.resolve(reply.data);
            else pending?.reject(new Error(reply.error));
          },
        }),
      }) as unknown as BrowserWindow;
      windows.push(window);
      return window;
    },
    open: async (_window, dir) => ({ name: dir }), changed() {}, release() {},
  });
  const bridge = registerAgentBridge(root, dir => dir ? manager.getWindow(dir) : null, {
    window: (dir, signal) => manager.open(dir, signal),
    run: (dir, name, signal, operation, heavy) => manager.run(dir, name, signal, operation, heavy),
    withProjectIdle: (dir, operation) => manager.withProjectIdle(dir, operation),
    event() {},
  });
  mainBridge.authorizeSender(event => windows.some(window => event.sender === window.webContents));
  const sender = (await manager.open(dirs[0]!)).webContents;
  cleanups.push(() => { bridge.dispose(); manager.dispose(); for (const window of windows) window.destroy(); });
  const restore = (mode: "manual" | "native", index = 0) => {
    const dir = dirs[index]!, id = saved[index]!.id;
    if (mode === "native") return native.restore!(dir, id);
    return new Promise<unknown>((resolve, reject) => {
      const requestId = String(replies.size);
      replies.set(requestId, { resolve, reject });
      ipcMain.emit(MAIN_WIRE.REQUEST, { sender }, {
        id: requestId, channel: MAIN_CHANNELS.CHECKPOINTS_RESTORE, data: { dir, id },
      });
    });
  };
  return { manager, dirs, restore };
}

it.each(["manual", "native"] as const)("%s restore refuses running and queued exports before touching files or watchers", async mode => {
  const { manager, dirs, restore } = await setup();
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const first = manager.run(dirs[0]!, "export", undefined, async () => { started.resolve(); await finish.promise; }, true);
  await started.promise;
  const queued = manager.run(dirs[1]!, "export", undefined, async () => undefined, true);
  try {
    await vi.waitFor(() => expect(manager.list().workspaces.find(row => row.dir === dirs[1])?.status).toBe("queued"));
    await expect(restore(mode)).rejects.toThrow("Finish or cancel");
    await expect(restore(mode, 1)).rejects.toThrow("Finish or cancel");
    expect(unwatchProject).not.toHaveBeenCalled();
    expect(await readFile(join(dirs[0]!, "index.tsx"), "utf8")).toBe("after");
  } finally { finish.resolve(); await Promise.all([first, queued]); }
  await restore(mode);
  expect(await readFile(join(dirs[0]!, "index.tsx"), "utf8")).toBe("before");
});

it.each(["manual", "native"] as const)("%s restore blocks new jobs and releases its reservation and watcher after failure", async mode => {
  const { manager, dirs, restore } = await setup();
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  vi.spyOn(checkpoints, "restoreCheckpoint").mockImplementationOnce(async () => {
    started.resolve(); await finish.promise; throw new Error("Restore failed");
  });
  const restoring = restore(mode);
  const failed = expect(restoring).rejects.toThrow("Restore failed");
  await started.promise;
  try {
    await expect(manager.run(dirs[0]!, "export", undefined, async () => undefined, true)).rejects.toMatchObject({ code: "busy" });
    await expect(manager.open(dirs[0]!)).rejects.toMatchObject({ code: "busy" });
    expect(() => manager.setAgent(dirs[0]!, true)).toThrow("file change to finish");
    expect(await manager.run(dirs[1]!, "capture", undefined, async () => "independent", true)).toBe("independent");
  } finally { finish.resolve(); await failed; }
  expect(watchProject).toHaveBeenCalledWith(manager.getWindow(dirs[0]!), dirs[0]);
  expect(await readFile(join(dirs[0]!, "index.tsx"), "utf8")).toBe("after");
  await restore(mode);
  expect(await readFile(join(dirs[0]!, "index.tsx"), "utf8")).toBe("before");
  expect(await manager.run(dirs[0]!, "context", undefined, async () => "ready")).toBe("ready");
});
