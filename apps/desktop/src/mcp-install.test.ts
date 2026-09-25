/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MCP_URL } from "@diffusionstudio/dapi";

vi.mock("electron", () => ({ app: { isPackaged: false } }));

import { applyMcp, healMcpRegistrations, mcpStatus } from "./mcp-install";

const homes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home(): string {
  const path = mkdtempSync(join(tmpdir(), "frameyard-mcp-install-"));
  homes.push(path);
  vi.stubEnv("HOME", path);
  return path;
}

it("writes an authenticated agent URL to a user-private config", () => {
  const root = home();
  expect(applyMcp({ add: ["cursor"], remove: [] }).added).toEqual(["cursor"]);
  const config = join(root, ".cursor", "mcp.json");
  const entry = JSON.parse(readFileSync(config, "utf8")).mcpServers.diffusion;
  expect(entry.url).toBe(mcpStatus().url);
  expect(new URL(entry.url).searchParams.get("token")).toMatch(/^[a-f0-9]{64}$/);
  expect(lstatSync(config).mode & 0o077).toBe(0);
});

it("connects and removes OpenCode without changing its other settings", () => {
  const root = home();
  const dir = join(root, ".config", "opencode");
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "opencode.json");
  writeFileSync(config, JSON.stringify({ model: "openai/gpt-5", mcp: { other: { type: "local", command: ["other"] } } }));

  expect(applyMcp({ add: ["opencode"], remove: [] }).added).toEqual(["opencode"]);
  const connected = JSON.parse(readFileSync(config, "utf8"));
  expect(connected.mcp.diffusion).toEqual({ type: "remote", enabled: true, url: mcpStatus().url });
  expect(mcpStatus().agents.find((agent) => agent.id === "opencode")).toMatchObject({ detected: true, connected: true });
  expect(lstatSync(config).mode & 0o077).toBe(0);

  expect(applyMcp({ add: [], remove: ["opencode"] }).removed).toEqual(["opencode"]);
  expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ model: "openai/gpt-5", mcp: { other: { type: "local", command: ["other"] } } });
});

it("repairs the old bare URL before leaving a private config behind", () => {
  const root = home();
  const dir = join(root, ".cursor");
  mkdirSync(dir);
  const config = join(dir, "mcp.json");
  writeFileSync(config, JSON.stringify({ mcpServers: { diffusion: { url: MCP_URL }, other: { command: "other" } } }), { mode: 0o644 });
  healMcpRegistrations();
  const servers = JSON.parse(readFileSync(config, "utf8")).mcpServers;
  expect(servers.diffusion.url).toBe(mcpStatus().url);
  expect(servers.other).toEqual({ command: "other" });
  expect(lstatSync(config).mode & 0o077).toBe(0);
  chmodSync(config, 0o644);
  healMcpRegistrations();
  expect(lstatSync(config).mode & 0o077).toBe(0);
});

it("leaves symlinked configs alone and continues past unreadable agent configs", () => {
  const root = home();
  mkdirSync(join(root, ".cursor"));
  const original = join(root, "original.json");
  writeFileSync(original, "{}\n");
  symlinkSync(original, join(root, ".cursor", "mcp.json"));
  expect(applyMcp({ add: ["cursor"], remove: [] }).failures).toHaveLength(1);
  expect(readFileSync(original, "utf8")).toBe("{}\n");

  rmSync(join(root, ".cursor", "mcp.json"));
  writeFileSync(join(root, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { diffusion: { url: MCP_URL } } }));
  writeFileSync(join(root, ".claude.json"), "{}", { mode: 0o000 });
  healMcpRegistrations();
  expect(JSON.parse(readFileSync(join(root, ".cursor", "mcp.json"), "utf8")).mcpServers.diffusion.url).toBe(mcpStatus().url);
});
