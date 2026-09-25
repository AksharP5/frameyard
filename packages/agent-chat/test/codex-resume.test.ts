/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { CodexHarness } from "../src/host/codex";

import type { ChatEvent } from "../src/protocol";

const directories: string[] = [];

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeCodex(error: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "frameyard-codex-resume-"));
  directories.push(dir);
  const binary = join(dir, "codex");
  const calls = join(dir, "calls.txt");
  writeFileSync(binary, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let reply;
  if (request.method === "thread/resume") reply = process.env.RESUME_ERROR
    ? { error: { code: -32602, message: process.env.RESUME_ERROR } }
    : { result: {} };
  else if (request.method === "thread/start") {
    appendFileSync(process.env.CALLS_FILE, "start\\n");
    reply = { result: { thread: { id: "fresh-thread" } } };
  } else reply = { result: {} };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply }) + "\\n");
});
`);
  chmodSync(binary, 0o755);
  const events: ChatEvent[] = [];
  const options = {
    cwd: dir,
    model: "gpt-6-sol",
    resume: { codex: { threadId: "saved-thread" } } as const,
    mcp: null,
    env: { env: { ...process.env, DIFFUSION_CODEX_PATH: binary, RESUME_ERROR: error ?? "", CALLS_FILE: calls } as Record<string, string>, extraDirs: [] },
    emit: (event: ChatEvent) => events.push(event),
  };
  return { calls, events, options };
}

it("keeps a saved Codex thread when resume fails for another reason", async () => {
  const { calls, options } = fakeCodex("Model not found for this thread");
  await expect(new CodexHarness().open(options)).rejects.toThrow("Model not found for this thread");
  expect(existsSync(calls)).toBe(false);
});

it("starts a new Codex thread only when the saved thread is missing", async () => {
  const { calls, events, options } = fakeCodex("no rollout found for thread id saved-thread");
  const session = await new CodexHarness().open(options);
  expect(session.resume).toEqual({ codex: { threadId: "fresh-thread" } });
  expect(readFileSync(calls, "utf8")).toBe("start\n");
  expect(events.some((event) => event.type === "item.completed" && event.item.kind === "notice" && event.item.text.includes("started fresh"))).toBe(true);
  await session.close();
});

it("does not replace a saved thread after a malformed resume response", async () => {
  const { calls, options } = fakeCodex(null);
  await expect(new CodexHarness().open(options)).rejects.toThrow("resumed thread id");
  expect(existsSync(calls)).toBe(false);
});
