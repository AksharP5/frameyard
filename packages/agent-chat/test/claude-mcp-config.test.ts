/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));
vi.mock("../src/host/env", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/host/env")>(),
  resolveBinary: () => "/test/claude",
  resolveClaudeExecutable: (path: string) => path,
}));

import { ClaudeHarness } from "../src/host/claude";

it("passes a private MCP config path to Claude and removes it on close", async () => {
  let finish: ((value: IteratorResult<never>) => void) | undefined;
  queryMock.mockImplementation(() => ({
    [Symbol.asyncIterator]() { return this; },
    next: () => new Promise<IteratorResult<never>>((resolve) => { finish = resolve; }),
    close: () => finish?.({ done: true, value: undefined as never }),
  }));
  const token = "a".repeat(64);
  const session = await new ClaudeHarness("test").open({
    cwd: "/tmp", model: "test", mcp: { name: "diffusion", url: `http://127.0.0.1:3274/mcp?token=${token}&client=chat` },
    env: { env: {}, extraDirs: [] }, emit: () => {},
  });
  const turn = session.send("hello", "test", () => {});
  const options = queryMock.mock.calls[0]![0].options;
  const path = options.extraArgs["mcp-config"];
  expect(options.mcpServers).toEqual({});
  expect(JSON.stringify(options)).not.toContain(token);
  expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.diffusion.url).toContain(token);
  expect(statSync(dirname(path)).mode & 0o077).toBe(0);
  expect(statSync(path).mode & 0o077).toBe(0);
  await session.close();
  expect(existsSync(path)).toBe(false);
  expect(await turn).toMatchObject({ status: "interrupted" });
});
