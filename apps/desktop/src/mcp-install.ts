/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Registers the app's MCP server with the agents on this machine, one agent
// at a time as the settings page asks: an authenticated loopback URL for agents
// that speak HTTP, the bundled `dapi mcp` proxy for the rest. No PATH
// symlink and no admin prompt — that is `cli-install.ts`, for people who
// type `dapi`.

import { app } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MCP_URL } from "@diffusionstudio/dapi";
import { authenticatedMcpUrl, readOrCreateMcpToken } from "@diffusionstudio/dapi/mcp-auth-node";
import { AGENT_TARGETS, agentTarget, needsBinary, readServer, removeServer, upsertServer } from "./mcp-config";

import type { AgentTarget, McpServerSpec } from "./mcp-config";
import type { McpAgentStatus, McpApplyRequest, McpApplyResult, McpStatus } from "./main-channels";

// The dev workflow links the workspace build into Homebrew's bin
// (`symlink:create` in apps/cli); that is the binary a dev build registers.
const DEV_BINARY = "/opt/homebrew/bin/dapi";

/** The bundled `dapi` binary, or null when none is available (an unstaged dev build). */
export function dapiBinary(): string | null {
  const command = app.isPackaged ? join(process.resourcesPath, "cli", "bin", "dapi") : DEV_BINARY;
  return existsSync(command) ? command : null;
}

function spec(): McpServerSpec {
  return { url: authenticatedMcpUrl(readOrCreateMcpToken()), command: dapiBinary() ?? "", args: ["mcp"] };
}

function configPath(target: AgentTarget): string {
  return join(homedir(), target.config);
}

function readConfig(target: AgentTarget): string | null {
  const path = configPath(target);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function writeConfig(target: AgentTarget, text: string): void {
  const path = configPath(target);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const directory = lstatSync(dir);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o022) !== 0) {
    throw new Error(`Agent config directory must be owned by this user and not writable by others: ${dir}`);
  }
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.uid !== process.getuid?.())) {
    throw new Error(`Agent config must be a regular file owned by this user: ${path}`);
  }
  const temporary = join(dir, `.frameyard-mcp-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

/**
 * Why this agent cannot be connected from this build, or null when it can.
 * Only the stdio agents have reasons: a build without the `dapi` binary has
 * nothing for them to run, and a quarantined first launch runs from a
 * translocated read-only mount whose path won't survive the next launch —
 * registering it would dangle.
 */
function unavailableReason(target: AgentTarget, current: McpServerSpec): string | null {
  if (!needsBinary(target)) return null;
  if (current.command === "") return "Needs the dapi command line tool, which this build does not include.";
  if (app.isPackaged && current.command.includes("/AppTranslocation/")) {
    return "Move Frameyard to the Applications folder and relaunch it first.";
  }
  return null;
}

function agentStatus(target: AgentTarget, current: McpServerSpec): McpAgentStatus {
  let registered: ReturnType<typeof readServer> = null;
  let readError = false;
  try {
    registered = readServer(readConfig(target), target.format);
  } catch {
    readError = true;
  }
  return {
    id: target.id,
    label: target.label,
    detected: existsSync(join(homedir(), target.marker)),
    connected: registered !== null && (registered.url === undefined || registered.url === current.url),
    config: configPath(target),
    unavailable: readError ? "Cannot read this agent's config." : unavailableReason(target, current),
  };
}

/** Every agent we know, with whether it is on this machine and whether its config carries our entry. */
export function mcpStatus(): McpStatus {
  const current = spec();
  return { url: current.url, agents: AGENT_TARGETS.map((target) => agentStatus(target, current)) };
}

/**
 * Writes our entry into the configs of `add` and takes it out of the configs
 * of `remove`, one file at a time, so one unreadable config does not stop
 * the rest. Other servers in the same file are left alone either way.
 */
export function applyMcp(request: McpApplyRequest): McpApplyResult {
  const current = spec();
  const result: McpApplyResult = { added: [], removed: [], failures: [] };

  for (const id of request.add) {
    const target = agentTarget(id);
    const reason = unavailableReason(target, current);
    if (reason) {
      result.failures.push({ id, error: reason });
      continue;
    }
    try {
      writeConfig(target, upsertServer(readConfig(target), target.format, target.entry(current)));
      result.added.push(id);
    } catch (e) {
      result.failures.push({ id, error: `${target.config}: ${(e as Error).message}` });
    }
  }

  for (const id of request.remove) {
    const target = agentTarget(id);
    try {
      const next = removeServer(readConfig(target), target.format);
      if (next !== null) writeConfig(target, next);
      result.removed.push(id);
    } catch (e) {
      result.failures.push({ id, error: `${target.config}: ${(e as Error).message}` });
    }
  }

  return result;
}

/**
 * Refresh our authenticated HTTP URLs and moved stdio binaries on launch.
 * Entries the user wrote for something else are left alone.
 */
export function healMcpRegistrations(): void {
  const current = spec();

  for (const target of AGENT_TARGETS) {
    let text: string | null;
    let registered: ReturnType<typeof readServer>;
    try {
      text = readConfig(target);
      registered = readServer(text, target.format);
    } catch {
      continue;
    }
    if (registered?.url && !needsBinary(target)) {
      let ours = false;
      try {
        const url = new URL(registered.url);
        ours = `${url.origin}${url.pathname}` === MCP_URL && [...url.searchParams.keys()].every((key) => key === "token");
      } catch {
        // A custom or malformed URL is not ours to repair.
      }
      if (ours) {
        try {
          if (registered.url !== current.url) writeConfig(target, upsertServer(text, target.format, target.entry(current)));
          else if (text !== null && (lstatSync(configPath(target)).mode & 0o077) !== 0) writeConfig(target, text);
        } catch {
          // The settings page remains available as a manual fix.
        }
      }
      continue;
    }
    if (!app.isPackaged || current.command === "" || current.command.includes("/AppTranslocation/")) continue;
    if (!registered?.command) continue;
    const ours = registered.command.includes("Frameyard") || registered.command.includes("Diffusion Studio") || registered.command.includes("/AppTranslocation/");
    if (!ours) continue;
    const entry = target.entry(current);
    if (registered.command === entry.command) continue;
    try {
      writeConfig(target, upsertServer(text, target.format, entry));
    } catch {
      // best effort — the settings page remains as a manual fix
    }
  }
}
