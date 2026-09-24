/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { chmodSync, lstatSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { authenticatedMcpUrl, readOrCreateMcpToken } from "./mcp-auth-node";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home(): string {
  const path = mkdtempSync(join(tmpdir(), "frameyard-auth-test-"));
  homes.push(path);
  return path;
}

it("creates and reuses a credential accessible only to this OS user", () => {
  const root = home();
  const token = readOrCreateMcpToken(root);
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  expect(readOrCreateMcpToken(root)).toBe(token);
  expect(lstatSync(join(root, ".frameyard")).mode & 0o077).toBe(0);
  expect(lstatSync(join(root, ".frameyard", "mcp-token")).mode & 0o077).toBe(0);
  expect(authenticatedMcpUrl(token)).toContain(`token=${token}`);
});

it("tightens an owned directory and refuses a shared credential file", () => {
  const root = home();
  readOrCreateMcpToken(root);
  const dir = join(root, ".frameyard");
  chmodSync(dir, 0o755);
  expect(readOrCreateMcpToken(root)).toMatch(/^[a-f0-9]{64}$/);
  expect(lstatSync(dir).mode & 0o077).toBe(0);
  chmodSync(join(dir, "mcp-token"), 0o644);
  expect(() => readOrCreateMcpToken(root)).toThrow(/credential must be owned/);
});

it("refuses a symlink in place of the credential directory", () => {
  const root = home();
  symlinkSync(home(), join(root, ".frameyard"));
  expect(() => readOrCreateMcpToken(root)).toThrow(/directory must be owned/);
});
