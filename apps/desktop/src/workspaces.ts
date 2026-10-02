import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import type { BrowserWindow } from "electron";
import type { ToolOutput } from "@diffusionstudio/dapi";
import { DapiError } from "@diffusionstudio/dapi";
import type { ProjectInfo } from "./main-channels";

type Row = ToolOutput<"workspace">["workspaces"][number];
type Job = Row["jobs"][number] & { controller: AbortController; done: Promise<void>; finish(): void; heavy: boolean };
type Workspace = {
  dir: string;
  name: string;
  id: string;
  window: BrowserWindow | null;
  ready: Promise<void>;
  loading: boolean;
  agentActive: boolean;
  jobs: Map<string, Job>;
  error?: string;
  idleTimer?: ReturnType<typeof setTimeout>;
};

type Dependencies = {
  createWindow(): BrowserWindow;
  open(window: BrowserWindow, dir: string): Promise<{ name: string; id?: string }>;
  changed(result: ToolOutput<"workspace">): void;
  release(dir: string): void;
};

/** One editor runtime per canonical project, released when nobody needs its GPU. */
export class Workspaces {
  private readonly projects = new Map<string, Workspace>();
  private readonly tracked = new WeakSet<BrowserWindow>();
  private readonly modelOwners = new WeakSet<BrowserWindow>();
  private readonly uiBusy = new WeakSet<BrowserWindow>();
  private readonly changing = new Set<string>();
  private heavyTail: Promise<void> = Promise.resolve();
  private stopped = false;

  private readonly deps: Dependencies;
  private readonly idleMs: number;

  constructor(deps: Dependencies, idleMs = 30_000) { this.deps = deps; this.idleMs = idleMs; }

  list(): ToolOutput<"workspace"> {
    return { workspaces: [...this.projects.values()].map((value): Row => {
      const jobs = [...value.jobs.values()].map(({ id, tool, state }) => ({ id, tool, state }));
      return {
        dir: value.dir, name: value.name, visible: value.window ? value.window.isVisible() || value.window.isMinimized() : false,
        agentActive: value.agentActive, jobs,
        status: value.loading ? "loading" : value.error ? "error" : (value.window && this.uiBusy.has(value.window)) || [...value.jobs.values()].some(job => job.state === "running" && job.heavy) ? "rendering" : jobs.some(job => job.state === "running") || value.agentActive || this.changing.has(value.dir) ? "working" : jobs.length ? "queued" : "idle",
        ...(value.error ? { error: value.error } : {}),
      };
    }) };
  }

  info(dir: string): { dir: string; name: string; id: string } {
    const project = this.projects.get(dir);
    if (!project) throw new Error("The project workspace is not open");
    return { dir, name: project.name, id: project.id };
  }

  directory(window: BrowserWindow): string | undefined {
    return this.owner(window)?.dir;
  }

  getWindow(dir: string): BrowserWindow | null {
    return this.projects.get(dir)?.window ?? null;
  }

  /** Keep a hidden editor alive while its own export or capture is running. */
  setBusy(window: BrowserWindow, busy: boolean): void {
    if (busy) this.uiBusy.add(window);
    else this.uiBusy.delete(window);
    const project = this.owner(window);
    if (project) {
      this.idle(project);
      this.publish();
    }
  }

  async open(path: string, signal?: AbortSignal): Promise<BrowserWindow> {
    return this.openRuntime(await this.project(path, signal), signal);
  }

  private async project(path: string, signal?: AbortSignal): Promise<Workspace> {
    if (this.stopped) throw new Error("Frameyard is shutting down");
    signal?.throwIfAborted();
    if (!isAbsolute(path)) throw new Error("The project directory must be absolute");
    const dir = await realpath(path);
    signal?.throwIfAborted();
    if (this.changing.has(dir)) throw new DapiError("busy", "Wait for this project's file change to finish.");
    let project = this.projects.get(dir);
    if (!project) {
      project = { dir, name: basename(dir), id: "", window: null, ready: Promise.resolve(), loading: false, agentActive: false, jobs: new Map() };
      this.projects.set(dir, project);
    }
    return project;
  }

  private async openRuntime(project: Workspace, signal?: AbortSignal): Promise<BrowserWindow> {
    if (this.stopped) throw new Error("Frameyard is shutting down");
    signal?.throwIfAborted();
    if (this.changing.has(project.dir)) throw new DapiError("busy", "Wait for this project's file change to finish.");
    if (!project.window || project.window.isDestroyed()) this.mount(project);
    this.keep(project);
    await this.waitReady(project, signal);
    if (!project.window || project.window.isDestroyed()) throw new Error("The project window closed while opening");
    this.idle(project);
    return project.window;
  }

  /** Register a project already opened through the user's editor. */
  async adopt(window: BrowserWindow, path: string): Promise<void> {
    const dir = await realpath(path);
    if (this.changing.has(dir)) throw new DapiError("busy", "Wait for this project's file change to finish.");
    const existing = this.projects.get(dir);
    if (existing?.window && existing.window !== window && !existing.window.isDestroyed()) {
      throw new Error("This project is already open in another workspace. Review it from Projects.");
    }
    for (const value of this.projects.values()) {
      if (value.window !== window || value.dir === dir) continue;
      if (this.busy(value)) throw new Error("Finish or cancel this project's work before changing projects");
      value.window = null;
      this.keep(value);
      this.deps.release(value.dir);
    }
    if (existing?.window === window) return;
    const project: Workspace = existing ?? { dir, name: basename(dir), id: "", window: null, ready: Promise.resolve(), loading: false, agentActive: false, jobs: new Map() };
    project.ready = Promise.resolve();
    project.loading = false;
    project.error = undefined;
    project.window = window;
    this.projects.set(dir, project);
    this.track(window);
    this.publish();
  }

  async detach(window: BrowserWindow, path: string): Promise<void> {
    const project = this.owner(window);
    if (!project || (project.dir !== path && project.dir !== await realpath(path))) return;
    if (this.busy(project)) throw new DapiError("busy", "Finish or cancel this project's work before leaving it.");
    this.keep(project);
    project.window = null;
    this.deps.release(project.dir);
    this.publish();
  }

  setAgent(dir: string, active: boolean, error?: string): void {
    if (active && this.changing.has(dir)) throw new DapiError("busy", "Wait for this project's file change to finish.");
    const project = this.projects.get(dir);
    if (!project) return;
    project.agentActive = active;
    project.error = error;
    this.publish();
    this.idle(project);
  }

  async show(dir: string, signal?: AbortSignal): Promise<void> {
    const window = await this.open(dir, signal);
    window.show();
    if (window.isMinimized()) window.restore();
    window.focus();
    this.publish();
  }

  /** GPU-heavy work is serialized across projects; edits and agent turns remain independent. */
  async run<T>(path: string, tool: string, signal: AbortSignal | undefined, operation: (window: BrowserWindow, signal: AbortSignal) => Promise<T>, heavy = false): Promise<T> {
    const project = await this.project(path, signal);
    const controller = new AbortController();
    const completion = Promise.withResolvers<void>();
    const job: Job = { id: randomUUID(), tool, state: heavy ? "queued" : "running", controller, heavy, done: completion.promise, finish: completion.resolve };
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    project.error = undefined;
    project.jobs.set(job.id, job);
    this.idle(project);
    this.publish();
    const previous = this.heavyTail;
    if (heavy) this.heavyTail = previous.then(() => completion.promise);
    try {
      if (heavy) await Promise.race([previous, new Promise<never>((_, reject) => {
        const canceled = () => reject(new DapiError("canceled", "The queued job was canceled."));
        if (controller.signal.aborted) canceled();
        else controller.signal.addEventListener("abort", canceled, { once: true });
        void previous.finally(() => controller.signal.removeEventListener("abort", canceled));
      })]);
      controller.signal.throwIfAborted();
      job.state = "running";
      this.publish();
      const window = await this.openRuntime(project, controller.signal);
      if (tool === "media_segment") this.modelOwners.add(window);
      return await operation(window, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) project.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      project.jobs.delete(job.id);
      // SAM retains its model per renderer; release hidden model owners before the next GPU job.
      if (project.window && this.modelOwners.has(project.window) && !this.running(project) && !this.uiBusy.has(project.window) && !project.window.isVisible() && !project.window.isMinimized()) this.releaseRuntime(project);
      job.finish();
      this.publish();
      this.idle(project);
    }
  }

  async cancel(path: string): Promise<void> {
    const project = this.projects.get(path) ?? this.projects.get(await realpath(path));
    if (!project) return;
    const jobs = [...project.jobs.values()];
    for (const job of jobs) job.controller.abort(new DapiError("canceled", "The project's work was canceled."));
    await Promise.all(jobs.map(job => job.done));
  }

  async close(path: string): Promise<void> {
    const dir = await realpath(path);
    const project = this.projects.get(dir);
    if (!project) return;
    if (this.busy(project)) throw new DapiError("busy", "Cancel or finish this project's work before closing it.");
    this.keep(project);
    this.projects.delete(dir);
    this.deps.release(dir);
    project.window?.destroy();
    this.publish();
  }

  /** Only the owning editor can flush its live state before moving the folder. */
  rename(path: string, window: BrowserWindow | null, operation: (dir: string) => Promise<ProjectInfo>): Promise<ProjectInfo> {
    return this.change(path, window, "renaming", async (dir, project) => {
      const result = await operation(dir);
      if (project) {
        if (result.dir !== dir) {
          this.projects.delete(dir);
          this.deps.release(dir);
          project.dir = result.dir;
          this.projects.set(result.dir, project);
        }
        project.name = result.displayName;
        project.id = result.id;
      }
      return result;
    });
  }

  delete(path: string, window: BrowserWindow | null, operation: (dir: string) => Promise<string>): Promise<string> {
    return this.change(path, window, "deleting", async dir => {
      const id = await operation(dir);
      this.projects.delete(dir);
      this.deps.release(dir);
      // The invoking editor stays alive to receive its reply and leave the project.
      return id;
    });
  }

  private change<T>(path: string, window: BrowserWindow | null, action: "renaming" | "deleting", operation: (dir: string, project?: Workspace) => Promise<T>): Promise<T> {
    return this.withProjectIdle(path, dir => {
      const project = this.projects.get(dir);
      if (project?.window && !project.window.isDestroyed() && project.window !== window) {
        throw new DapiError("busy", `${action === "renaming" ? "Rename" : "Delete"} this open project from its editor. Review it from Projects first.`);
      }
      return operation(dir, project);
    });
  }

  /** File replacement must not overlap editor jobs, even those waiting for the GPU. */
  async withProjectIdle<T>(path: string, operation: (dir: string) => Promise<T>): Promise<T> {
    if (this.stopped) throw new Error("Frameyard is shutting down");
    const dir = await realpath(path);
    const project = this.projects.get(dir);
    if (this.changing.has(dir) || (project && this.busy(project))) {
      throw new DapiError("busy", "Finish or cancel this project's work before changing its files.");
    }
    this.changing.add(dir);
    if (project) this.keep(project);
    this.publish();
    try {
      return await operation(dir);
    } finally {
      this.changing.delete(dir);
      this.publish();
      if (project && this.projects.get(project.dir) === project) this.idle(project);
    }
  }

  dispose(): void {
    this.stopped = true;
    for (const project of this.projects.values()) {
      this.keep(project);
      for (const job of project.jobs.values()) job.controller.abort();
    }
  }

  private mount(project: Workspace): void {
    const window = this.deps.createWindow();
    project.window = window;
    project.loading = true;
    project.error = undefined;
    this.track(window);
    const ready: Promise<void> = this.deps.open(window, project.dir).then(({ name, id }) => {
      if (project.window !== window) throw new Error("The project window closed while opening");
      project.name = name;
      project.id = id ?? "";
    }).catch(error => {
      if (project.window === window) {
        project.error = error instanceof Error ? error.message : String(error);
        this.releaseRuntime(project);
      }
      throw error;
    }).finally(() => {
      if (project.ready !== ready) return;
      project.loading = false;
      this.publish();
      this.idle(project);
    });
    project.ready = ready;
    // Opening is shared by callers; keep failures handled even if one caller cancels its wait.
    void project.ready.catch(() => {});
    this.publish();
  }

  private owner(window: BrowserWindow): Workspace | undefined {
    return [...this.projects.values()].find(project => project.window === window);
  }

  private track(window: BrowserWindow): void {
    if (this.tracked.has(window)) return;
    this.tracked.add(window);
    window.on("close", event => {
      const project = this.owner(window);
      if (!project) return;
      if (!this.busy(project)) return;
      event.preventDefault();
      window.hide();
    });
    window.on("show", () => { const project = this.owner(window); if (project) { this.keep(project); this.publish(); } });
    window.on("hide", () => { const project = this.owner(window); if (project) { this.idle(project); this.publish(); } });
    window.webContents.on("render-process-gone", () => {
      const project = this.owner(window);
      if (!project) return;
      this.releaseRuntime(project);
      this.publish();
    });
    window.on("closed", () => {
      const project = this.owner(window);
      if (!project) return;
      this.keep(project);
      project.window = null;
      this.deps.release(project.dir);
      this.publish();
    });
  }

  private waitReady(project: Workspace, signal?: AbortSignal): Promise<void> {
    if (!signal) return project.ready;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new DapiError("canceled", "Opening the project was canceled."));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void project.ready.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  private keep(project: Workspace): void {
    clearTimeout(project.idleTimer);
    project.idleTimer = undefined;
  }

  private busy(project: Workspace): boolean {
    return project.agentActive || project.loading || project.jobs.size > 0 || this.changing.has(project.dir) || !!(project.window && this.uiBusy.has(project.window));
  }

  private running(project: Workspace): boolean {
    return [...project.jobs.values()].some(job => job.state === "running");
  }

  private idle(project: Workspace): void {
    this.keep(project);
    if (this.stopped || project.loading || this.changing.has(project.dir) || this.running(project) || !project.window || project.window.isVisible() || project.window.isMinimized() || this.uiBusy.has(project.window)) return;
    project.idleTimer = setTimeout(() => {
      this.releaseRuntime(project);
      this.publish();
    }, this.idleMs);
    project.idleTimer.unref();
  }

  private releaseRuntime(project: Workspace): void {
    this.keep(project);
    const window = project.window;
    project.window = null;
    this.deps.release(project.dir);
    window?.destroy();
  }

  private publish(): void { this.deps.changed(this.list()); }
}
