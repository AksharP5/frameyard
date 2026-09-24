/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MCP_URL } from "./mcp";

/** Shared by the desktop and CLI; the containing directory is private to this OS user. */
export function readOrCreateMcpToken(home = homedir()): string {
  const dir = join(home, ".frameyard");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(dir);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.()) {
    throw new Error(`MCP credential directory must be owned by this user: ${dir}`);
  }
  if ((directory.mode & 0o077) !== 0) chmodSync(dir, 0o700);

  const path = join(dir, "mcp-token");
  try {
    return readToken(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const token = randomBytes(32).toString("hex");
  const temporary = join(dir, `mcp-token-${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, token, { flag: "wx", mode: 0o600 });
    try {
      linkSync(temporary, path);
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }

  return readToken(path);
}

function readToken(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0) {
      throw new Error(`MCP credential must be owned by this user and private: ${path}`);
    }
    const existing = readFileSync(fd, "utf8");
    if (!/^[a-f0-9]{64}$/.test(existing)) throw new Error(`Invalid MCP credential: ${path}`);
    return existing;
  } finally {
    closeSync(fd);
  }
}

export function authenticatedMcpUrl(token: string, base = MCP_URL): string {
  const url = new URL(base);
  url.searchParams.set("token", token);
  return url.toString();
}
