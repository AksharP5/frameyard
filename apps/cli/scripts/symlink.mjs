/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const action = process.argv[2];
if (action !== "create" && action !== "remove") throw new Error("Expected create or remove.");
if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Supported on macOS and Linux.");

const target = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const link = process.platform === "darwin" ? "/opt/homebrew/bin/dapi" : join(homedir(), ".local", "bin", "dapi");
const current = await lstat(link).catch((error) => {
  if (error.code !== "ENOENT") throw error;
  return undefined;
});

if (current) {
  if (!current.isSymbolicLink() || resolve(dirname(link), await readlink(link)) !== target) {
    throw new Error(`Refusing to ${action} ${link}: it belongs to another installation. Move it first.`);
  }
  if (action === "remove") await unlink(link);
} else if (action === "create") {
  await mkdir(dirname(link), { recursive: true });
  await symlink(target, link);
}

console.log(`${action === "create" ? "Linked" : "Removed"} ${link}`);
