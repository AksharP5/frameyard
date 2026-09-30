import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentToolResult, ToolResult } from "@diffusionstudio/dapi";
import { toolByName } from "@diffusionstudio/dapi";
import { afterEach, expect, it, vi } from "vitest";
import type { HttpServerDeps } from "./http";

const http = vi.hoisted(() => ({ createSession: undefined as HttpServerDeps["createSession"] | undefined }));

vi.mock("./http", () => ({
  DapiHttpServer: class {
    constructor(deps: HttpServerDeps) { http.createSession = deps.createSession; }
    get url() { return "http://127.0.0.1:3274/mcp"; }
  },
}));
vi.mock("@diffusionstudio/dapi/mcp-auth-node", () => ({
  readOrCreateMcpToken: () => "11".repeat(32),
  authenticatedMcpUrl: (_token: string, base: string) => base,
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return { app: new EventEmitter(), ipcMain: new EventEmitter(), BrowserWindow: { getAllWindows: () => [] } };
});

import { Workspaces } from "../workspaces";
import { RendererCalls } from "./renderer-calls";
import { DapiServer } from "./server";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function windowFor() {
  let destroyed = false;
  let visible = false;
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    isMinimized: () => false,
    focus: vi.fn(),
    restore: vi.fn(),
    show: () => { visible = true; window.emit("show"); },
    hide: () => { visible = false; window.emit("hide"); },
    destroy: () => { destroyed = true; window.emit("closed"); },
  });
  return window as unknown as BrowserWindow;
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "frameyard-mcp-routing-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dirs = { a: join(root, "a"), b: join(root, "b"), foreground: join(root, "foreground") };
  await Promise.all(Object.values(dirs).map(dir => mkdir(dir)));
  const alias = join(root, "alias-a");
  await symlink(dirs.a, alias);
  const windows = new Map<BrowserWindow, string>();
  const workspaces = new Workspaces({
    createWindow: windowFor,
    open: async (window, dir) => { windows.set(window, dir); return { name: dir, id: dir }; },
    changed: () => {},
    release: () => {},
  });
  cleanups.push(() => {
    workspaces.dispose();
    for (const window of windows.keys()) if (!window.isDestroyed()) window.destroy();
  });
  let foreground = await workspaces.open(dirs.foreground);
  const renderer = new RendererCalls();
  vi.spyOn(renderer, "call").mockImplementation(async (name, _args, _signal, window) => {
    if (name !== "context") throw new Error(`Unexpected renderer tool: ${name}`);
    const dir = window && windows.get(window);
    if (!dir) throw new Error("Renderer target is not a project workspace");
    const context: ToolResult<"context"> = {
      rootDir: root, projectDir: dir, currentTime: null, fontFamilies: [], generations: [], masks: [],
    };
    return context;
  });
  const runAgentTool = vi.fn(async (dir: string, name: string, args: Record<string, unknown>): Promise<AgentToolResult> => ({
    success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ dir, name, args }) }],
  }));
  new DapiServer({
    renderer, workspaces, getWindow: () => foreground,
    onOpenProject: (window, show) => { foreground = window; if (show) window.show(); },
    workspaceAction: async request => {
      if (request.action === "list") return workspaces.list();
      const target = request.dir ?? request.project;
      if (!target) throw new Error("Supply a project directory");
      const dir = await realpath(target);
      if (request.action === "open") await workspaces.open(dir);
      else if (request.action === "close") await workspaces.close(dir);
      else throw new Error(`Unexpected workspace action: ${request.action}`);
      return workspaces.list();
    },
    version: "test", logs: () => [], docsDir: null, onFirstConnection: () => {}, runAgentTool,
  });

  async function connect(initialProject?: string) {
    if (!http.createSession) throw new Error("HTTP session factory was not registered");
    const session = http.createSession(initialProject);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await session.connect(serverTransport);
    const client = new Client({ name: "parallel-agent-test", version: "test" });
    await client.connect(clientTransport);
    cleanups.push(async () => { await client.close(); await session.close(); });
    return client;
  }

  return {
    dirs, alias, workspaces, connect, runAgentTool,
    changeForeground: async () => { foreground = await workspaces.open(dirs.foreground); foreground.show(); },
  };
}

async function projectContext(client: Client, project?: string) {
  const result = await client.callTool({ name: "context", arguments: project === undefined ? {} : { project } });
  expect(result.isError).not.toBe(true);
  return toolByName("context").output.parse(result.structuredContent);
}

it.each(["workspace", "open"] as const)("binds independent sessions through %s and keeps foreground changes and overrides isolated", async (opening) => {
  const { dirs, alias, workspaces, connect, changeForeground, runAgentTool } = await setup();
  const [a, b] = await Promise.all([connect(), connect()]);
  const opened = await Promise.all([
    a.callTool({ name: opening, arguments: opening === "workspace" ? { action: "open", dir: alias } : { dir: alias, background: true } }),
    b.callTool({ name: opening, arguments: opening === "workspace" ? { action: "open", dir: dirs.b } : { dir: dirs.b, background: true } }),
  ]);
  for (const result of opened) expect(result.isError).not.toBe(true);
  expect(workspaces.list().workspaces).toHaveLength(3);
  await changeForeground();
  const contexts = await Promise.all([projectContext(a), projectContext(b)]);
  expect(contexts.map(result => result.projectDir)).toEqual([dirs.a, dirs.b]);

  expect((await projectContext(a, dirs.b)).projectDir).toBe(dirs.b);
  expect((await projectContext(a)).projectDir).toBe(dirs.a);
  await a.callTool({ name: "agent_tool", arguments: { name: "editor_update", args: { id: "intro" } } });
  await b.callTool({ name: "agent_tool", arguments: { name: "editor_context", project: alias } });
  expect(runAgentTool.mock.calls.map(([dir, name, args]) => ({ dir, name, args }))).toEqual([
    { dir: dirs.a, name: "editor_update", args: { id: "intro" } },
    { dir: dirs.a, name: "editor_context", args: {} },
  ]);
  expect((await projectContext(b)).projectDir).toBe(dirs.b);

  const closed = await b.callTool({ name: "workspace", arguments: { action: "close" } });
  expect(closed.isError).not.toBe(true);
  expect(workspaces.list().workspaces.map(row => row.dir)).not.toContain(dirs.b);
  await b.close();
  expect((await projectContext(a)).projectDir).toBe(dirs.a);
});

it("honors initial project bindings without opening the foreground or rebinding explicit overrides", async () => {
  const { dirs, alias, connect, changeForeground, runAgentTool } = await setup();
  const [a, b] = await Promise.all([connect(alias), connect(dirs.b)]);
  await changeForeground();
  const contexts = await Promise.all([projectContext(a), projectContext(b)]);
  expect(contexts.map(result => result.projectDir)).toEqual([dirs.a, dirs.b]);
  await a.callTool({ name: "agent_tool", arguments: { name: "editor_context" } });
  expect(runAgentTool.mock.calls[0]?.[0]).toBe(dirs.a);
  expect((await projectContext(a, dirs.b)).projectDir).toBe(dirs.b);
  await b.close();
  expect((await projectContext(a)).projectDir).toBe(dirs.a);
});
