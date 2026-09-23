/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cp, lstat, mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

const EXCLUDED = new Set([
  ".diffusion", "node_modules", ".git", ".venv", "__pycache__",
  "build", "dist", "dist-ssr", "dist-contract", "out", "cache",
  "tsconfig.json", ".DS_Store",
]);

/** Prune generated directories before descent: a repo example may contain the destination itself. */
export function docsCopyFilter(path: string): boolean {
  return !EXCLUDED.has(basename(path));
}

/** Node's recursive cp rejects a descendant destination even when the filter excludes it. */
export async function copyDocs(source: string, destination: string): Promise<void> {
  if (!docsCopyFilter(source)) return;
  if (!(await lstat(source)).isDirectory()) return cp(source, destination);
  await mkdir(destination, { recursive: true });
  for (const name of await readdir(source)) {
    await copyDocs(join(source, name), join(destination, name));
  }
}
