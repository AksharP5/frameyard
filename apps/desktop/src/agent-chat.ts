/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { app, utilityProcess } from "electron";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

import type { UtilityProcess } from "electron";

type AgentChatOptions = {
  dataDir: string;
  mcpUrl: string | null;
  version: string;
  prepareTurn: (input: { cwd: string; text: string }) => Promise<() => void>;
};

const DEV_ORIGIN = process.env.FRAMEYARD_DEV_URL ?? "http://localhost:5173";
const RESTART_DELAYS_MS = [1000, 2000, 5000, 10_000];
const STOP_GRACE_MS = 3000;
// How long an ask for the endpoint waits for a host it had to start.
const START_WAIT_MS = 10_000;

let child: UtilityProcess | null = null;
let endpoint: { url: string } | null = null;
let options: AgentChatOptions | null = null;
let token = "";
let restarts = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
const interruptions = new Map<string, { proc: UtilityProcess; resolve(): void; reject(error: Error): void }>();

const waiting = new Set<() => void>();

function spawn(): void {
  if (!options || stopped) return;
  const path = join(app.getAppPath(), "dist", "agent-host.mjs");
  const proc = utilityProcess.fork(path, [], { serviceName: "Agent Chat", stdio: "inherit" });
  child = proc;
  const releases = new Map<string, () => void>();
  const prepareTurn = options.prepareTurn;

  proc.on("spawn", () => {
    proc.postMessage({
      type: "start",
      config: {
        token,
        dataDir: options!.dataDir,
        mcp: options!.mcpUrl ? { name: "diffusion", url: options!.mcpUrl } : null,
        version: options!.version,
        allowedOrigins: app.isPackaged ? ["file://", "null"] : ["file://", "null", DEV_ORIGIN],
      },
    });
  });

  proc.on("message", (message: { type?: string; url?: string; message?: string; id?: string; cwd?: string; text?: string; error?: string }) => {
    if (message?.type === "project-interrupted" && typeof message.id === "string") {
      const request = interruptions.get(message.id);
      if (request?.proc !== proc) return;
      interruptions.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve();
      return;
    }
    if (message?.type === "prepare-turn" && typeof message.id === "string" && typeof message.cwd === "string" && typeof message.text === "string") {
      if (child !== proc || stopped) return;
      const { id, cwd, text } = message;
      void prepareTurn({ cwd, text }).then((release) => {
        if (child !== proc || stopped) { release(); return; }
        releases.set(id, release);
        try { proc.postMessage({ type: "turn-prepared", id }); }
        catch (error) { releases.delete(id); release(); throw error; }
      }).catch((error: unknown) => {
        if (child !== proc || stopped) return;
        try { proc.postMessage({ type: "turn-prepared", id, error: error instanceof Error ? error.message : String(error) }); }
        catch { /* The exit handler releases any remaining reservations. */ }
      });
      return;
    }
    if (message?.type === "release-turn" && typeof message.id === "string") {
      releases.get(message.id)?.();
      releases.delete(message.id);
      return;
    }
    if (message?.type === "listening" && typeof message.url === "string") {
      endpoint = { url: message.url };
      restarts = 0;
      for (const wake of [...waiting]) {
        wake();
      }
      console.log(`[agent-chat] host listening at ${message.url.replace(/token=.*$/, "token=…")}`);
    } else if (message?.type === "error") {
      console.error(`[agent-chat] host failed to start: ${message.message}`);
    }
  });

  proc.on("exit", (code) => {
    for (const [id, request] of interruptions) {
      if (request.proc !== proc) continue;
      interruptions.delete(id);
      request.reject(new Error("Agent host exited before project cancellation completed"));
    }
    for (const release of releases.values()) release();
    releases.clear();
    if (child !== proc) return;
    child = null;
    endpoint = null;
    if (stopped) return;
    const delay = RESTART_DELAYS_MS[Math.min(restarts, RESTART_DELAYS_MS.length - 1)]!;
    restarts += 1;
    console.error(`[agent-chat] host exited (${code}); restarting in ${delay} ms`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      spawn();
    }, delay);
  });
}

/** Generates the token; the host is forked when it is first needed. Call once, after `whenReady`. */
export function configureAgentChat(next: AgentChatOptions): void {
  options = next;
  token = randomBytes(32).toString("base64url");
  stopped = false;
  restarts = 0;
}

/** Where the host is listening, starting it when it is not running; null when it does not come up in time. */
export function agentChatEndpoint(): Promise<{ url: string } | null> {
  if (endpoint || stopped || !options) {
    return Promise.resolve(endpoint);
  }
  // Not running and not about to restart: this is the first ask.
  if (!child && !restartTimer) {
    spawn();
  }

  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      waiting.delete(wake);
      resolve(endpoint);
    };
    const timer = setTimeout(wake, START_WAIT_MS);
    waiting.add(wake);
  });
}

/** Best effort: a host that does not come up leaves the chats behind. They aren't trashed with the folder. */
export async function deleteProjectChats(projectId: string): Promise<void> {
  if (!projectId) return;
  const running = await agentChatEndpoint();

  if (running) {
    child?.postMessage({ type: "deleteProject", projectId });
  }
}

/** Resolves after this project's harness turns and their cleanup have finished. */
export function cancelProjectAgents(dir: string): Promise<void> {
  const proc = child;
  if (!proc || !endpoint) return Promise.resolve();
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    interruptions.set(id, { proc, resolve, reject });
    try { proc.postMessage({ type: "interrupt-project", id, cwd: dir }); }
    catch (error) {
      interruptions.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Asks the host to stop (it kills its harness trees), then kills it after a grace period. */
export function stopAgentChat(): void {
  stopped = true;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  const proc = child;
  child = null;
  endpoint = null;
  for (const request of interruptions.values()) request.reject(new Error("Agent host stopped before project cancellation completed"));
  interruptions.clear();
  if (!proc) return;
  try {
    proc.postMessage({ type: "stop" });
  } catch {
    // Already gone.
  }
  const timer = setTimeout(() => proc.kill(), STOP_GRACE_MS);
  proc.once("exit", () => clearTimeout(timer));
}
