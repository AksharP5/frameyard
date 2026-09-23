/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

type PendingWrite = { content: string | null | undefined; timer: ReturnType<typeof setTimeout> };

// Source saves stage beside the original before an atomic rename.
const ignoredProjectPath = (path: string) => /^(?:\.diffusion|node_modules)(?:\/|$)|\.diffusion-save-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(path);

/** Keeps editor writes quiet while still observing edits made immediately after them. */
export class ProjectChanges {
  private readonly writes = new Map<string, PendingWrite>();
  private readonly dir: string;
  private readonly notify: (path: string) => void;
  private readonly settleMs: number;

  constructor(dir: string, notify: (path: string) => void, settleMs = 1000) {
    this.dir = dir;
    this.notify = notify;
    this.settleMs = settleMs;
  }

  /** Exact text, null for removal, or omitted for streaming binary output. */
  mark(path: string, content?: string | null): void {
    if (ignoredProjectPath(path)) return;
    clearTimeout(this.writes.get(path)?.timer);
    const pending = {
      content,
      timer: setTimeout(() => void this.verify(path, pending), this.settleMs),
    };
    this.writes.set(path, pending);
  }

  changed(path: string): void {
    if (ignoredProjectPath(path)) return;
    if (!this.writes.has(path)) this.notify(path);
  }

  private async verify(path: string, pending: PendingWrite): Promise<void> {
    const content = pending.content === undefined ? undefined : await readFile(join(this.dir, path), "utf8").catch((error: NodeJS.ErrnoException) => {
      return error.code === "ENOENT" ? null : undefined;
    });
    // Another editor write or disposal can happen while the read is pending.
    if (this.writes.get(path) !== pending) return;
    this.writes.delete(path);
    if (pending.content === undefined || content !== pending.content) this.notify(path);
  }

  dispose(): void {
    for (const { timer } of this.writes.values()) clearTimeout(timer);
    this.writes.clear();
  }
}
