import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { afterEach, expect, it, vi } from "vitest";
import { Workspaces } from "./workspaces";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });

function windowFor() {
  let destroyed = false, visible = false;
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed, isVisible: () => visible, isMinimized: () => false,
    focus: vi.fn(), restore: vi.fn(),
    show: () => { visible = true; window.emit("show"); },
    hide: () => { visible = false; window.emit("hide"); },
    destroy: () => { destroyed = true; window.emit("closed"); },
  });
  return window as unknown as BrowserWindow;
}

async function setup(idleMs = 30_000) {
  const root = await mkdtemp(join(tmpdir(), "frameyard-workspaces-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dirs = [join(root, "a"), join(root, "b"), join(root, "c")];
  await Promise.all(dirs.map(dir => mkdir(dir)));
  const windows: BrowserWindow[] = [];
  const changed = vi.fn(), release = vi.fn();
  const manager = new Workspaces({
    createWindow: () => { const window = windowFor(); windows.push(window); return window; },
    open: async (_window, dir) => ({ name: dir.split("/").at(-1)!, id: dir }),
    changed, release,
  }, idleMs);
  cleanups.push(() => { manager.dispose(); for (const window of windows) if (!window.isDestroyed()) window.destroy(); });
  return { manager, dirs, root, windows, changed, release };
}

it("isolates three projects, reuses canonical paths, and keeps review independent", async () => {
  const { manager, dirs, root, windows } = await setup();
  const alias = join(root, "alias");
  await symlink(dirs[0], alias);
  const [first, second, third] = await Promise.all(dirs.map(dir => manager.open(dir)));
  expect(new Set([first, second, third]).size).toBe(3);
  expect(await manager.open(alias)).toBe(first);
  await manager.show(dirs[1]!);
  expect(manager.list().workspaces.filter(row => row.visible).map(row => row.dir)).toEqual([dirs[1]]);
  manager.setAgent(dirs[0]!, true);
  manager.setAgent(dirs[2]!, true);
  await expect(manager.close(dirs[0]!)).rejects.toMatchObject({ code: "busy" });
  await manager.close(dirs[1]!);
  expect(second.isDestroyed()).toBe(true);
  expect(first.isDestroyed()).toBe(false);
  expect(third.isDestroyed()).toBe(false);
  expect(windows).toHaveLength(3);
});

it("queues heavy jobs while independent project edits still run, and cancels only the requested project", async () => {
  const { manager, dirs } = await setup();
  const running = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const first = manager.run(dirs[0]!, "export", undefined, async () => { started.resolve(); await running.promise; return "a"; }, true);
  await started.promise;
  const queued = manager.run(dirs[1]!, "export", undefined, async () => "b", true);
  const queuedFailure = expect(queued).rejects.toMatchObject({ code: "canceled" });
  await vi.waitFor(() => expect(manager.list().workspaces.find(row => row.dir === dirs[1])?.status).toBe("queued"));
  expect(await manager.run(dirs[2]!, "editor_update", undefined, async () => "edited")).toBe("edited");
  await manager.cancel(dirs[1]!);
  await queuedFailure;
  const third = vi.fn(async () => "c");
  const tail = manager.run(dirs[2]!, "capture", undefined, third, true);
  await vi.waitFor(() => expect(manager.list().workspaces.find(row => row.dir === dirs[2])?.status).toBe("queued"));
  expect(third).not.toHaveBeenCalled();
  running.resolve();
  expect(await first).toBe("a");
  expect(await tail).toBe("c");
});

it("keeps the GPU reservation through cancellation cleanup", async () => {
  const { manager, dirs } = await setup();
  const started = Promise.withResolvers<void>(), cleaning = Promise.withResolvers<void>(), cleaned = Promise.withResolvers<void>();
  const first = manager.run(dirs[0]!, "export", undefined, async (_window, signal) => {
    started.resolve();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    cleaning.resolve();
    await cleaned.promise;
  }, true);
  await started.promise;
  const next = vi.fn(async () => undefined);
  const second = manager.run(dirs[1]!, "export", undefined, next, true);
  const cancellation = manager.cancel(dirs[0]!);
  await cleaning.promise;
  expect(next).not.toHaveBeenCalled();
  expect(manager.list().workspaces.find(row => row.dir === dirs[0])?.jobs).toHaveLength(1);
  cleaned.resolve();
  await Promise.all([first, second, cancellation]);
  expect(next).toHaveBeenCalledOnce();
});

it("releases idle hidden runtimes and recreates them without stopping agent work", async () => {
  const { manager, dirs, windows, release } = await setup(100);
  vi.useFakeTimers();
  const hidden = await manager.open(dirs[0]!);
  manager.setAgent(dirs[0]!, true);
  await manager.show(dirs[1]!);
  await vi.advanceTimersByTimeAsync(100);
  expect(hidden.isDestroyed()).toBe(true);
  expect(release).toHaveBeenCalledWith(dirs[0]);
  expect(manager.list().workspaces[0]?.agentActive).toBe(true);
  expect(windows[1]?.isDestroyed()).toBe(false);
  expect(await manager.open(dirs[0]!)).not.toBe(hidden);
});

it("never evicts a hidden runtime with a pending job", async () => {
  const { manager, dirs } = await setup(100);
  vi.useFakeTimers();
  const finished = Promise.withResolvers<void>(), started = Promise.withResolvers<BrowserWindow>();
  const job = manager.run(dirs[0]!, "capture", undefined, async window => { started.resolve(window); await finished.promise; });
  const window = await started.promise;
  await vi.advanceTimersByTimeAsync(1000);
  expect(window.isDestroyed()).toBe(false);
  finished.resolve();
  await job;
  await vi.advanceTimersByTimeAsync(100);
  expect(window.isDestroyed()).toBe(true);
});


it("releases a failed bootstrap and retries the repaired project immediately", async () => {
  const { dirs } = await setup();
  const windows: BrowserWindow[] = [];
  const open = vi.fn().mockRejectedValueOnce(new Error("Invalid project source")).mockResolvedValue({ name: "Repaired" });
  const manager = new Workspaces({
    createWindow: () => { const window = windowFor(); windows.push(window); return window; },
    open, changed: vi.fn(), release: vi.fn(),
  });
  cleanups.push(() => { manager.dispose(); for (const window of windows) if (!window.isDestroyed()) window.destroy(); });
  await expect(manager.open(dirs[0]!)).rejects.toThrow("Invalid project source");
  expect(windows[0]!.isDestroyed()).toBe(true);
  expect(await manager.open(dirs[0]!)).toBe(windows[1]);
  expect(manager.list().workspaces[0]).toMatchObject({ name: "Repaired", status: "idle" });
});

it("releases a hidden segmentation model owner before another project's heavy job", async () => {
  const { manager, dirs } = await setup();
  const window = await manager.open(dirs[0]!);
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const tracking = manager.run(dirs[0]!, "media_segment", undefined, async () => { started.resolve(); await finish.promise; }, true);
  await started.promise;
  const capture = manager.run(dirs[1]!, "capture", undefined, async () => {
    expect(window.isDestroyed()).toBe(true);
  }, true);
  finish.resolve();
  await Promise.all([tracking, capture]);
});
