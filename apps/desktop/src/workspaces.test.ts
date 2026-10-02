import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, symlink, rm, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { afterEach, expect, it, vi } from "vitest";
import { Workspaces } from "./workspaces";

vi.mock("electron", () => ({ app: { isPackaged: false, getPath: () => tmpdir() }, dialog: {}, shell: { trashItem: (dir: string) => rename(dir, `${dir}-trashed`) }, ipcMain: { on: () => {} } }));
const { initProject, renameProject, deleteProject } = await import("./projects");

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });

function windowFor() {
  let destroyed = false, visible = false, minimized = false;
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed, isVisible: () => visible, isMinimized: () => minimized,
    focus: vi.fn(), restore: vi.fn(() => { minimized = false; visible = true; window.emit("show"); }), webContents: new EventEmitter(),
    show: () => { visible = true; minimized = false; window.emit("show"); },
    minimize: () => { minimized = true; visible = false; window.emit("hide"); },
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

it("keeps a hidden editor alive while its own export is busy", async () => {
  const { manager, dirs } = await setup(100);
  vi.useFakeTimers();
  const window = await manager.open(dirs[0]!);
  manager.setBusy(window, true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(window.isDestroyed()).toBe(false);
  manager.setBusy(window, false);
  await vi.advanceTimersByTimeAsync(100);
  expect(window.isDestroyed()).toBe(true);
});

it("protects an editor's export from workspace closure, departure and file replacement", async () => {
  const { manager, dirs, changed, release } = await setup();
  const window = await manager.open(dirs[0]!);
  const replace = vi.fn(async () => "restored");
  manager.setBusy(window, true);
  expect(changed).toHaveBeenLastCalledWith({ workspaces: [expect.objectContaining({ status: "rendering" })] });
  await expect(manager.close(dirs[0]!)).rejects.toMatchObject({ code: "busy" });
  await expect(manager.detach(window, dirs[0]!)).rejects.toMatchObject({ code: "busy" });
  await expect(manager.adopt(window, dirs[1]!)).rejects.toThrow("Finish or cancel");
  await expect(manager.withProjectIdle(dirs[0]!, replace)).rejects.toMatchObject({ code: "busy" });
  expect(replace).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
  expect(window.isDestroyed()).toBe(false);
  expect(manager.getWindow(dirs[0]!)).toBe(window);
  expect(await manager.withProjectIdle(dirs[1]!, replace)).toBe("restored");
  manager.setBusy(window, false);
  expect(await manager.withProjectIdle(dirs[0]!, replace)).toBe("restored");
  await manager.close(dirs[0]!);
  expect(window.isDestroyed()).toBe(true);
});

it("does not release a hidden segmentation model while its editor is exporting", async () => {
  const { manager, dirs } = await setup(100);
  vi.useFakeTimers();
  await manager.show(dirs[0]!);
  const window = manager.getWindow(dirs[0]!)!;
  await manager.run(dirs[0]!, "media_segment", undefined, async () => undefined, true);
  window.hide();
  manager.setBusy(window, true);
  await manager.run(dirs[0]!, "context", undefined, async () => undefined);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(window.isDestroyed()).toBe(false);
  manager.setBusy(window, false);
  await vi.advanceTimersByTimeAsync(100);
  expect(window.isDestroyed()).toBe(true);
});

it("keeps a minimized project window until it is explicitly hidden", async () => {
  const { manager, dirs } = await setup(100);
  vi.useFakeTimers();
  const window = await manager.show(dirs[0]!).then(() => manager.getWindow(dirs[0]!));
  expect(window).not.toBeNull();
  window!.minimize();
  expect(manager.list().workspaces[0]?.visible).toBe(true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(window!.isDestroyed()).toBe(false);
  window!.restore();
  window!.hide();
  await vi.advanceTimersByTimeAsync(100);
  expect(window!.isDestroyed()).toBe(true);
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


it("keeps a visible editor and independent work alive when one tool fails", async () => {
  const { manager, dirs } = await setup();
  await manager.show(dirs[0]!);
  const started = Promise.withResolvers<BrowserWindow>();
  const finish = Promise.withResolvers<void>();
  const working = manager.run(dirs[0]!, "editor_update", undefined, async window => { started.resolve(window); await finish.promise; });
  const window = await started.promise;
  try {
    await expect(manager.run(dirs[0]!, "context", undefined, async () => { throw new Error("Invalid layer"); })).rejects.toThrow("Invalid layer");
    expect(window.isDestroyed()).toBe(false);
  } finally { finish.resolve(); await working; }
});

it("opens only the running heavy project's renderer and evicts queued-only runtimes", async () => {
  const { manager, dirs, windows } = await setup(100);
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const running = manager.run(dirs[0]!, "export", undefined, async () => { started.resolve(); await finish.promise; }, true);
  await started.promise;
  const queued = dirs.slice(1).map(dir => manager.run(dir, "export", undefined, async () => undefined, true));
  try {
    await vi.waitFor(() => expect(manager.list().workspaces.filter(row => row.status === "queued")).toHaveLength(2));
    expect(windows).toHaveLength(1);
    vi.useFakeTimers();
    const reviewed = await manager.open(dirs[1]!);
    await vi.advanceTimersByTimeAsync(100);
    expect(reviewed.isDestroyed()).toBe(true);
  } finally { finish.resolve(); await Promise.all([running, ...queued]); }
});

it("recovers a crashed renderer immediately while leaving another project alive", async () => {
  const { manager, dirs } = await setup();
  const first = await manager.open(dirs[0]!);
  const other = await manager.open(dirs[1]!);
  first.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  expect(first.isDestroyed()).toBe(true);
  expect(await manager.open(dirs[0]!)).not.toBe(first);
  expect(other.isDestroyed()).toBe(false);
});

it("switching the visible project's owner does not leave stale window listeners", async () => {
  const { manager, dirs, release } = await setup();
  const window = await manager.open(dirs[0]!);
  await manager.adopt(window, dirs[1]!);
  expect(release).toHaveBeenCalledWith(dirs[0]);
  const oldOwner = await manager.open(dirs[0]!);
  manager.setAgent(dirs[0]!, true);
  const preventDefault = vi.fn();
  window.emit("close", { preventDefault });
  expect(preventDefault).not.toHaveBeenCalled();
  expect(window.listenerCount("close")).toBe(1);
  expect(oldOwner.isDestroyed()).toBe(false);
});

it("adopts a repaired editor without retaining the failed bootstrap", async () => {
  const { dirs } = await setup();
  const failed = windowFor(), repaired = windowFor();
  const manager = new Workspaces({ createWindow: () => failed, open: async () => { throw new Error("Invalid source"); }, changed: vi.fn(), release: vi.fn() });
  cleanups.push(() => { manager.dispose(); repaired.destroy(); });
  await expect(manager.open(dirs[0]!)).rejects.toThrow("Invalid source");
  await manager.adopt(repaired, dirs[0]!);
  expect(await manager.open(dirs[0]!)).toBe(repaired);
  expect(manager.list().workspaces[0]?.status).toBe("idle");
});

it("releases segmentation resources even with a same-project heavy job queued", async () => {
  const { manager, dirs } = await setup();
  const started = Promise.withResolvers<BrowserWindow>(), finish = Promise.withResolvers<void>();
  const tracking = manager.run(dirs[0]!, "media_segment", undefined, async window => { started.resolve(window); await finish.promise; }, true);
  const modelOwner = await started.promise;
  const next = manager.run(dirs[0]!, "export", undefined, async window => {
    expect(modelOwner.isDestroyed()).toBe(true);
    expect(window).not.toBe(modelOwner);
    expect(window.isDestroyed()).toBe(false);
  }, true);
  finish.resolve();
  await Promise.all([tracking, next]);
});

it("a stale bootstrap failure cannot destroy a replacement runtime", async () => {
  const { dirs } = await setup();
  const old = windowFor(), replacement = windowFor();
  const windows = [old, replacement];
  const firstLoad = Promise.withResolvers<{ name: string }>();
  const manager = new Workspaces({ createWindow: () => windows.shift()!, open: vi.fn().mockImplementationOnce(() => firstLoad.promise).mockResolvedValue({ name: "Replacement" }), changed: vi.fn(), release: vi.fn() });
  cleanups.push(() => { manager.dispose(); old.destroy(); replacement.destroy(); });
  const first = manager.open(dirs[0]!);
  const failed = expect(first).rejects.toThrow("Old bootstrap failed");
  await vi.waitFor(() => expect(manager.getWindow(dirs[0]!)).toBe(old));
  old.destroy();
  expect(await manager.open(dirs[0]!)).toBe(replacement);
  firstLoad.reject(new Error("Old bootstrap failed"));
  await failed;
  expect(replacement.isDestroyed()).toBe(false);
  expect(manager.list().workspaces[0]).toMatchObject({ name: "Replacement", status: "idle" });
});

it("blocks departure during work and ignores cleanup from an older editor owner", async () => {
  const { manager, dirs, release } = await setup();
  const window = await manager.open(dirs[0]!);
  manager.setAgent(dirs[0]!, true);
  await expect(manager.detach(window, dirs[0]!)).rejects.toMatchObject({ code: "busy" });
  expect(manager.getWindow(dirs[0]!)).toBe(window);
  manager.setAgent(dirs[0]!, false);
  await manager.detach(window, dirs[0]!);
  expect(window.isDestroyed()).toBe(false);
  const replacement = await manager.open(dirs[0]!);
  release.mockClear();
  await manager.detach(window, dirs[0]!);
  expect(manager.getWindow(dirs[0]!)).toBe(replacement);
  expect(release).not.toHaveBeenCalled();
});

it("releases hidden segmentation models after another running tool finishes", async () => {
  const { manager, dirs } = await setup();
  const started = Promise.withResolvers<BrowserWindow>(), finish = Promise.withResolvers<void>();
  const inspecting = manager.run(dirs[0]!, "context", undefined, async window => { started.resolve(window); await finish.promise; });
  const window = await started.promise;
  await manager.run(dirs[0]!, "media_segment", undefined, async () => undefined, true);
  expect(window.isDestroyed()).toBe(false);
  finish.resolve();
  await inspecting;
  expect(window.isDestroyed()).toBe(true);
});

it("can release a deleted project's old editor mapping", async () => {
  const { manager, dirs } = await setup();
  const window = await manager.open(dirs[0]!);
  await rm(dirs[0]!, { recursive: true });
  await manager.detach(window, dirs[0]!);
  expect(manager.getWindow(dirs[0]!)).toBeNull();
});

it("keeps one owning workspace through a real folder rename and its editor rewatch", async () => {
  const { manager, dirs, release, windows } = await setup();
  const original = await initProject(null, dirs[0]!);
  const window = await manager.open(original.dir);
  const renamed = await manager.rename(original.dir, window, dir => renameProject(dir, "Renamed"));
  expect(renamed.id).toBe(original.id);
  expect(manager.directory(window)).toBe(renamed.dir);
  expect(manager.info(renamed.dir)).toEqual({ dir: renamed.dir, name: "Renamed", id: original.id });
  await manager.detach(window, original.dir).catch(() => {});
  await manager.adopt(window, renamed.dir);
  expect(await manager.open(renamed.dir)).toBe(window);
  expect(windows).toHaveLength(1);
  expect(manager.list().workspaces).toHaveLength(1);
  expect(release).toHaveBeenCalledWith(original.dir);
  await manager.close(renamed.dir);
  expect(window.isDestroyed()).toBe(true);
});

it("refuses an active agent, running tool or another window before changing project files", async () => {
  const { manager, dirs } = await setup();
  const original = await initProject(null, dirs[0]!);
  const before = await readFile(`${original.dir}/package.json`, "utf8");
  const window = await manager.open(original.dir);
  const rename = vi.fn((dir: string) => renameProject(dir, "Renamed"));
  manager.setAgent(original.dir, true);
  await expect(manager.rename(original.dir, window, rename)).rejects.toMatchObject({ code: "busy" });
  manager.setAgent(original.dir, false);
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const job = manager.run(original.dir, "context", undefined, async () => { started.resolve(); await finish.promise; });
  await started.promise;
  try {
    await expect(manager.rename(original.dir, window, rename)).rejects.toMatchObject({ code: "busy" });
  } finally { finish.resolve(); await job; }
  const other = await manager.open(dirs[1]!);
  await expect(manager.rename(original.dir, other, rename)).rejects.toThrow("from its editor");
  expect(rename).not.toHaveBeenCalled();
  expect(await readFile(`${original.dir}/package.json`, "utf8")).toBe(before);
  expect(manager.getWindow(original.dir)).toBe(window);
});

it("reserves only the renaming project and releases the reservation after a failed rename", async () => {
  const { manager, dirs } = await setup();
  await initProject(null, dirs[0]!);
  const window = await manager.open(dirs[0]!);
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const renaming = manager.rename(dirs[0]!, window, async () => {
    started.resolve(); await finish.promise; throw new Error("Disk unavailable");
  });
  const failure = expect(renaming).rejects.toThrow("Disk unavailable");
  await started.promise;
  try {
    await expect(manager.open(dirs[0]!)).rejects.toMatchObject({ code: "busy" });
    await expect(manager.run(dirs[0]!, "context", undefined, async () => undefined)).rejects.toMatchObject({ code: "busy" });
    expect(() => manager.setAgent(dirs[0]!, true)).toThrow("file change to finish");
    expect(await manager.run(dirs[1]!, "context", undefined, async () => "independent")).toBe("independent");
  } finally { finish.resolve(); await failure; }
  expect(await manager.open(dirs[0]!)).toBe(window);
  expect(manager.list().workspaces.filter(row => row.dir === dirs[0])).toHaveLength(1);
});

it("renames a closed dashboard project without creating a workspace or releasing an unmoved watcher", async () => {
  const { manager, dirs, release } = await setup();
  const original = await initProject(null, dirs[0]!);
  const renamed = await manager.rename(original.dir, null, dir => renameProject(dir, "Renamed"));
  expect(renamed.id).toBe(original.id);
  expect(manager.list().workspaces).toEqual([]);
  const window = await manager.open(renamed.dir);
  release.mockClear();
  await manager.rename(renamed.dir, window, dir => renameProject(dir, "Renamed"));
  expect(release).not.toHaveBeenCalled();
  expect(manager.getWindow(renamed.dir)).toBe(window);
});

it("refuses to delete a project owned by active work or another editor", async () => {
  const { manager, dirs } = await setup();
  const original = await initProject(null, dirs[0]!);
  const window = await manager.open(original.dir);
  const trash = vi.fn(deleteProject);
  manager.setAgent(original.dir, true);
  await expect(manager.delete(original.dir, window, trash)).rejects.toMatchObject({ code: "busy" });
  manager.setAgent(original.dir, false);
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const job = manager.run(original.dir, "export", undefined, async () => { started.resolve(); await finish.promise; }, true);
  await started.promise;
  try {
    await expect(manager.delete(original.dir, window, trash)).rejects.toMatchObject({ code: "busy" });
  } finally { finish.resolve(); await job; }
  const other = await manager.open(dirs[1]!);
  await expect(manager.delete(original.dir, other, trash)).rejects.toThrow("from its editor");
  expect(trash).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(`${original.dir}/package.json`, "utf8")).projectId).toBe(original.id);
});

it("forgets a deleted project while its owning editor can leave and other projects stay open", async () => {
  const { manager, dirs, root, release } = await setup();
  const original = await initProject(null, dirs[0]!);
  const alias = join(root, "alias");
  await symlink(original.dir, alias);
  const window = await manager.open(original.dir);
  const other = await manager.open(dirs[1]!);
  expect(await manager.delete(alias, window, deleteProject)).toBe(original.id);
  expect(manager.directory(window)).toBeUndefined();
  expect(manager.list().workspaces.map(row => row.dir)).toEqual([dirs[1]]);
  expect(release).toHaveBeenCalledWith(original.dir);
  expect(window.isDestroyed()).toBe(false);
  await manager.detach(window, original.dir);
  expect(manager.getWindow(dirs[1]!)).toBe(other);
  await expect(readFile(`${original.dir}/package.json`)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(`${original.dir}-trashed/package.json`, "utf8")).projectId).toBe(original.id);
  expect(await manager.delete(dirs[2]!, null, deleteProject)).toBe("");
  expect(manager.list().workspaces.map(row => row.dir)).toEqual([dirs[1]]);
});

it("reserves a deleting project and restores its ownership when trash fails", async () => {
  const { manager, dirs, release } = await setup();
  const window = await manager.open(dirs[0]!);
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const deleting = manager.delete(dirs[0]!, window, async () => {
    started.resolve(); await finish.promise; throw new Error("Trash unavailable");
  });
  const failure = expect(deleting).rejects.toThrow("Trash unavailable");
  await started.promise;
  try {
    await expect(manager.open(dirs[0]!)).rejects.toMatchObject({ code: "busy" });
    await expect(manager.run(dirs[0]!, "context", undefined, async () => undefined)).rejects.toMatchObject({ code: "busy" });
    await expect(manager.rename(dirs[0]!, window, dir => renameProject(dir, "Moved"))).rejects.toMatchObject({ code: "busy" });
    await expect(manager.delete(dirs[0]!, window, deleteProject)).rejects.toMatchObject({ code: "busy" });
    await expect(manager.detach(window, dirs[0]!)).rejects.toMatchObject({ code: "busy" });
    await expect(manager.adopt(window, dirs[1]!)).rejects.toThrow("Finish or cancel");
    expect(() => manager.setAgent(dirs[0]!, true)).toThrow("finish");
    expect(await manager.run(dirs[1]!, "context", undefined, async () => "independent")).toBe("independent");
  } finally { finish.resolve(); await failure; }
  expect(release).not.toHaveBeenCalledWith(dirs[0]);
  expect(await manager.open(dirs[0]!)).toBe(window);
  expect(await manager.delete(dirs[0]!, window, deleteProject)).toBe("");
});

it("waits for an opening editor before replacing files and leaves closed projects unmounted", async () => {
  const { dirs } = await setup();
  const ready = Promise.withResolvers<{ name: string }>();
  const window = windowFor();
  const createWindow = vi.fn(() => window);
  const manager = new Workspaces({ createWindow, open: () => ready.promise, changed() {}, release() {} });
  cleanups.push(() => { manager.dispose(); window.destroy(); });
  const opening = manager.open(dirs[0]!);
  await vi.waitFor(() => expect(manager.list().workspaces[0]?.status).toBe("loading"));
  const replace = vi.fn(async () => "restored");
  try {
    await expect(manager.withProjectIdle(dirs[0]!, replace)).rejects.toMatchObject({ code: "busy" });
    expect(replace).not.toHaveBeenCalled();
  } finally { ready.resolve({ name: "Ready" }); await opening; }
  expect(await manager.withProjectIdle(dirs[1]!, replace)).toBe("restored");
  expect(createWindow).toHaveBeenCalledTimes(1);
  expect(manager.list().workspaces.map(row => row.dir)).toEqual([dirs[0]]);
});
