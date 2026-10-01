/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { realpath } from "node:fs/promises";
import type { BrowserWindow } from "electron";
import type { Workspaces } from "../workspaces";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DapiError, MCP_HOST, MCP_PATH, MCP_PORT, toolByName, tools } from "@diffusionstudio/dapi";
import { authenticatedMcpUrl, readOrCreateMcpToken } from "@diffusionstudio/dapi/mcp-auth-node";
import { mainHandlers } from "./handlers";
import { DapiHttpServer } from "./http";
import { instructions } from "./docs";
import { RendererCalls } from "./renderer-calls";
import { serveCatalog } from "./tools-session";

import type { AgentToolResult, LogEntry, ToolArgs, ToolOutput, GenericTool } from "@diffusionstudio/dapi";
import type { AppWindow, MainContext, MainToolName } from "./handler";

/**
 * The name the server introduces itself with, and so the namespace an agent
 * shows the tools under: `mcp__diffusion__<tool>`. The same word as our URL
 * scheme, and not `dapi`, which is the CLI.
 */
const SERVER_NAME = "diffusion";

export type DapiServerDeps = {
  port?: number;
  renderer?: RendererCalls;
  workspaces?: Workspaces;
  getWindow?(): BrowserWindow | null;
  getDefaultProject?(): string | undefined;
  onOpenProject?(window: BrowserWindow, show: boolean): void;
  workspaceAction?(request: ToolArgs<"workspace">, signal: AbortSignal): Promise<ToolOutput<"workspace">>;
  window?: AppWindow;
  version: string;
  /** The app's console buffer, for `logs` and `report`. */
  logs(): LogEntry[];
  /** Called once, on the first connection: an agent is driving, so the UI may step back. */
  onFirstConnection?(): void;
  /** The staged docs: INSTRUCTIONS.md, their path, and the skill headers, all for every session. Null when not staged. */
  docsDir: string | null;
  /** Project-aware editing tools retained by Frameyard's native agent bridge. */
  runAgentTool(dir: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult>;
};

/**
 * The app's MCP server: Streamable HTTP on a fixed loopback port, the URL
 * agents register and the `dapi` CLI calls. Each client gets its own MCP
 * session over one catalog. Main-process tools run here; renderer tools are
 * forwarded over IPC and their results presented (files written, small
 * images inlined) before they go back out.
 */
export class DapiServer {
  private readonly deps: DapiServerDeps;
  private readonly renderer: RendererCalls;
  private readonly http: DapiHttpServer;
  private readonly token = readOrCreateMcpToken();
  private instructionsText: string | null = null;
  private httpReady: Promise<boolean> = Promise.resolve(false);

  constructor(deps: DapiServerDeps) {
    if (deps.port !== undefined && (!Number.isInteger(deps.port) || deps.port < 1 || deps.port > 65535)) throw new Error("Invalid Frameyard MCP port");
    this.deps = deps;
    this.renderer = deps.renderer ?? new RendererCalls();
    for (const tool of tools) {
      if (tool.environment === "main" && !(tool.name in mainHandlers)) {
        throw new Error(`Main-process tool "${tool.name}" has no handler`);
      }
    }
    this.http = new DapiHttpServer({
      host: MCP_HOST,
      port: deps.port ?? MCP_PORT,
      path: MCP_PATH,
      token: this.token,
      createSession: project => this.createSession(project),
      onFirstConnection: () => deps.onFirstConnection?.(),
    });
  }

  /** The URL agents register. */
  get url(): string {
    return authenticatedMcpUrl(this.token, this.http.url);
  }

  start(): void {
    this.renderer.start();
    // A taken port is the one way this fails. The app is still usable
    // without agents, so it is logged, not fatal; `mcpUrl()` says so.
    this.httpReady = this.http.start().then(
      () => true,
      (error: Error) => {
        console.error(`[dapi] cannot serve MCP on ${MCP_HOST}:${MCP_PORT}: ${error.message}`);
        return false;
      },
    );
  }

  /** The HTTP URL once it is being served; null when the port could not be bound. */
  async mcpUrl(): Promise<string | null> {
    return (await this.httpReady) ? this.url : null;
  }

  stop(): void {
    this.http.stop();
  }

  /** One MCP server over the whole catalog. The docs and skills are plain files; the instructions say where. */
  private createSession(initialProject?: string): McpServer {
    this.instructionsText ??= instructions(this.deps.docsDir);
    // `name` is the machine identity, and matches the key we write into agent
    // configs; `title` is what a client shows a person.
    const session = new McpServer({ name: SERVER_NAME, title: "Frameyard", version: this.deps.version }, { instructions: this.instructionsText });
    let project = initialProject;
    serveCatalog(session, async (tool, args, signal) => {
      const input = args as { project?: string };
      const target = input.project ?? project ?? this.deps.getDefaultProject?.();
      if (tool.name === "workspace") {
        if (!this.deps.workspaceAction) throw new Error("Project workspaces are unavailable");
        const request = toolByName("workspace").input.parse(args);
        const result = await this.deps.workspaceAction({ ...request, project: target }, signal);
        if (request.action === "open" || request.action === "send") project = await realpath(request.dir ?? target!);
        if (request.action === "close" && project === await realpath(request.dir ?? target!)) project = undefined;
        return result;
      }
      if (tool.name === "open") {
        const request = toolByName("open").input.parse(args);
        if (this.deps.workspaces) {
          const dir = await realpath(request.dir);
          const window = await this.deps.workspaces.open(dir, signal);
          project = dir;
          this.deps.onOpenProject?.(window, !request.background);
          return this.deps.workspaces.info(dir);
        }
        const result = await this.renderer.call(tool.name, args, signal, this.deps.getWindow?.() ?? undefined);
        project = await realpath(request.dir);
        return result;
      }
      if (tool.environment === "main") return this.runInMain(tool.name as MainToolName, args, signal, target);
      return this.runRenderer(tool, args, signal, target);
    });
    return session;
  }

  private runRenderer(tool: GenericTool, args: unknown, signal: AbortSignal, project?: string): Promise<unknown> {
    const workspaces = this.deps.workspaces;
    if (project && workspaces) {
      const heavy = ["export", "capture", "media_segment", "media_filmstrip", "media_waveform"].includes(tool.name);
      return workspaces.run(project, tool.name, signal, (window, jobSignal) =>
        this.renderer.call(tool.name, { ...args as object, project: workspaces.directory(window) }, jobSignal, window, true), heavy);
    }
    return this.renderer.call(tool.name, args, signal, this.deps.getWindow?.() ?? undefined);
  }

  private runInMain(name: MainToolName, args: unknown, signal: AbortSignal, project?: string): Promise<unknown> {
    const ctx: MainContext = {
      signal,
      logs: this.deps.logs,
      version: this.deps.version,
      window: this.deps.window,
      workspace: request => {
        if (!this.deps.workspaceAction) throw new Error("Project workspaces are unavailable");
        return this.deps.workspaceAction(request, signal);
      },
      runAgentTool: async (tool, args) => {
        if (project) return this.deps.runAgentTool(await realpath(project), tool, args, signal);
        const context = toolByName("context").output.parse(await this.renderer.call("context", {}, signal, this.deps.getWindow?.() ?? undefined));
        if (!context.projectDir) throw new DapiError("no-project", "Open a project before calling an editor tool.");
        signal.throwIfAborted();
        return this.deps.runAgentTool(context.projectDir, tool, args, signal);
      },
    };
    // Each handler takes its own parsed args; the map's union type cannot
    // express that pairing, so the call site widens.
    return (mainHandlers[name] as (args: unknown, ctx: MainContext) => Promise<unknown>)(args, ctx);
  }
}
