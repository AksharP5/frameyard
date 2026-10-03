/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What the watcher must and must not report. The app writes the files it
// watches, so the whole question is whether a change is its own — answered by
// content (see `noteContent`), which is what these pin down.

import { tmpdir } from "node:os";
import { watch } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shell } from "electron";

import { MAIN_CHANNELS, MAIN_WIRE } from "./main-channels";
import { TEMP_PREFIX, tempPathFor, writeFileAtomic } from "./atomic";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => tmpdir() },
  dialog: {},
  shell: { trashItem: vi.fn() },
  ipcMain: { on: () => { } },
}));

vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, watch: vi.fn(fs.watch) };
});

vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile), rename: vi.fn(fs.rename) };
});
const { readFile: readFileOnDisk, rename: renameOnDisk } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const { deleteProject, noteContent, noteRenamed, renameProject, unwatchProject, watchProject, writeManifest } = await import("./projects");

let dir: string;
let changed: string[] = [];

/** A window that only remembers which project files it was told about. */
const window = {
  isDestroyed: () => false,
  webContents: {
    isLoadingMainFrame: () => false,
    send: (wire: string, envelope: { channel: string; data: { path: string } }) => {
      if (wire === MAIN_WIRE.EVENT && envelope.channel === MAIN_CHANNELS.PROJECTS_CHANGED) {
        changed.push(envelope.data.path);
      }
    },
  },
} as unknown as Parameters<typeof watchProject>[0];

/** Long enough for an event to have arrived, for the cases where none may. */
const settle = (ms = 400): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for `path` to be reported, and fails the test when it never is. */
async function waitFor(path: string, timeout = 4000): Promise<void> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (changed.includes(path)) return;
    await settle(25);
  }
  expect(changed).toContain(path);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "watch-test-"));
  changed = [];
  watchProject(window, dir);
  await settle(100);
});

afterEach(async () => {
  vi.mocked(readFile).mockImplementation(readFileOnDisk);
  vi.mocked(rename).mockImplementation(renameOnDisk);
  unwatchProject(dir);
  await rm(dir, { recursive: true, force: true });
});

describe("watchProject", () => {
  it("coalesces duplicate events without delaying a source edit behind a file burst", async () => {
    const files = Array.from({ length: 120 }, (_, index) => `asset-${index}.txt`);
    for (const file of [...files, "index.tsx"]) noteContent(join(dir, file), "same\n");
    await Promise.all([...files, "index.tsx"].map(file => writeFile(join(dir, file), "same\n")));
    await settle();
    vi.mocked(readFile).mockClear();

    const args: readonly unknown[] | undefined = vi.mocked(watch).mock.calls.findLast(args => args[0] === dir);
    const listener = args?.find(value => typeof value === "function");
    if (typeof listener !== "function") throw new Error("The project directory has no watcher");
    for (let index = 0; index < 1000; index++) listener("change", files[0]);
    for (const file of files) listener("change", file);
    await writeFile(join(dir, "index.tsx"), "changed\n");
    listener("change", "index.tsx");

    await waitFor("index.tsx", 1000);
    expect(vi.mocked(readFile).mock.calls.filter(([path]) => path === join(dir, files[0]!))).toHaveLength(1);
    expect(changed).toEqual(["index.tsx"]);
  });

  it("ignores native media caches and Git metadata while watching authored lookalikes", async () => {
    unwatchProject(dir);
    const ignored = [".cache/playback", ".cache/original-audio", ".git"];
    await Promise.all([...ignored, "assets/.cache"].map(path => mkdir(join(dir, path), { recursive: true })));
    vi.mocked(watch).mockClear();
    vi.mocked(readFile).mockClear();
    watchProject(window, dir);
    await Promise.all(ignored.map(path => writeFile(join(dir, path, "generated.bin"), "generated\n")));
    await settle();
    expect(changed).toEqual([]);
    expect(vi.mocked(watch).mock.calls.some(([path]) => String(path).startsWith(join(dir, ".cache")) || String(path).startsWith(join(dir, ".git")))).toBe(false);
    expect(vi.mocked(readFile).mock.calls).toEqual([]);

    await writeFile(join(dir, ".gitignore"), "ignore patterns\n");
    await writeFile(join(dir, "assets/.cache", "authored.tsx"), "authored component\n");
    await waitFor(".gitignore");
    await waitFor("assets/.cache/authored.tsx");
  });

  it("reads an outside edit that arrives while an earlier digest is pending", async () => {
    const file = join(dir, "index.tsx");
    const reading = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
    let blocked = false;
    vi.mocked(readFile).mockImplementation(async (path, options) => {
      const content = await readFileOnDisk(path, options);
      if (path === file && !blocked) {
        blocked = true;
        reading.resolve();
        await finish.promise;
      }
      return content;
    });
    try {
      await writeFile(file, "old\n");
      await reading.promise;
      await writeFile(file, "new\n");
      finish.resolve();
      await vi.waitFor(() => expect(changed.filter(path => path === "index.tsx")).toHaveLength(2));
    } finally { finish.resolve(); }
  });

  it("does not publish an old file read after its watcher is replaced", async () => {
    const file = join(dir, "index.tsx");
    const reading = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
    let blocked = false;
    vi.mocked(readFile).mockImplementation(async (path, options) => {
      const content = await readFileOnDisk(path, options);
      if (path === file && !blocked) {
        blocked = true;
        reading.resolve();
        await finish.promise;
      }
      return content;
    });
    try {
      await writeFile(file, "old\n", "utf8");
      await reading.promise;
      unwatchProject(dir);
      watchProject(window, dir);
      finish.resolve();
      await settle();
      expect(changed).toEqual([]);
      await writeFile(file, "new\n", "utf8");
      await waitFor("index.tsx");
    } finally { finish.resolve(); }
  });

  it("keeps reporting source edits when the project folder cannot be renamed", async () => {
    await writeFile(join(dir, "index.tsx"), "export const stage = 1;\n", "utf8");
    await waitFor("index.tsx");
    changed = [];
    vi.mocked(rename).mockImplementation((from, to) => {
      if (from === dir) return Promise.reject(Object.assign(new Error("Permission denied"), { code: "EACCES" }));
      return renameOnDisk(from, to);
    });
    expect(await renameProject(dir, "Renamed")).toMatchObject({ dir, displayName: "Renamed" });
    await writeFile(join(dir, "index.tsx"), "export const stage = 2;\n", "utf8");
    await waitFor("index.tsx");
  });

  it("keeps reporting source edits after moving the project to Trash fails", async () => {
    vi.mocked(shell.trashItem).mockRejectedValueOnce(new Error("Trash unavailable"));
    await expect(deleteProject(dir)).rejects.toThrow("Trash unavailable");
    await writeFile(join(dir, "index.tsx"), "export const stage = 1;\n", "utf8");
    await waitFor("index.tsx");
  });

  it("reports a file someone else writes", async () => {
    await writeFile(join(dir, "index.tsx"), "export const stage = 1;\n", "utf8");
    await waitFor("index.tsx");
  });

  // Without this the claim above proves nothing: a rename that never reached
  // the watcher would look exactly like a claim that worked.
  it("reports a file someone else replaces by rename", async () => {
    await writeFileAtomic(join(dir, "index.tsx"), "export const stage = 1;\n");
    await waitFor("index.tsx");
  });

  it("says nothing about a write the app claimed", async () => {
    const file = join(dir, "index.tsx");
    const text = "export const stage = 1;\n";
    noteContent(file, text);
    await writeFileAtomic(file, text);

    await settle();
    expect(changed).toEqual([]);
  });

  it("reports an outside edit that lands right after one of the app's own", async () => {
    const file = join(dir, "index.tsx");
    noteContent(file, "ours\n");
    await writeFileAtomic(file, "ours\n");
    // No claim: this one is someone else's, however close behind it comes.
    await writeFile(file, "theirs\n", "utf8");

    await waitFor("index.tsx");
  });

  it("says nothing about a write that changes nothing", async () => {
    const file = join(dir, "notes.txt");
    await writeFile(file, "same\n", "utf8");
    await waitFor("notes.txt");

    changed = [];
    await writeFile(file, "same\n", "utf8");
    await settle();
    expect(changed).toEqual([]);
  });

  it("reports a file someone else deletes", async () => {
    const file = join(dir, "notes.txt");
    await writeFile(file, "here\n", "utf8");
    await waitFor("notes.txt");

    changed = [];
    await rm(file);
    await waitFor("notes.txt");
  });

  it("ignores the temp files an atomic write leaves in the folder", async () => {
    await writeFile(join(dir, `${TEMP_PREFIX}index.tsx.1-1`), "half a file", "utf8");
    await settle();
    expect(changed).toEqual([]);
  });

  it("says nothing about an asset streamed to a temp file and renamed into place", async () => {
    await mkdir(join(dir, "assets"), { recursive: true });
    await waitFor("assets");
    const file = join(dir, "assets", "clip.bin");

    changed = [];
    const temp = tempPathFor(file);
    const handle = await open(temp, "wx");
    // Positioned chunks, the way an encoder writes one.
    await handle.write(Buffer.from("chunk one"), 0, 9, 0);
    await settle();
    await handle.write(Buffer.from(" and two"), 0, 8, 9);
    await handle.close();
    await settle();
    // Nothing has appeared where the library looks, so there is nothing to say.
    expect(changed).toEqual([]);

    await noteRenamed(temp, file);
    await rename(temp, file);
    await settle();
    expect(changed).toEqual([]);
  });

  it("reports an asset someone else renames into place", async () => {
    await mkdir(join(dir, "assets"), { recursive: true });
    await waitFor("assets");

    changed = [];
    const temp = tempPathFor(join(dir, "assets", "clip.bin"));
    await writeFile(temp, "theirs", "utf8");
    await rename(temp, join(dir, "assets", "clip.bin"));

    await waitFor("assets/clip.bin");
  });

  // The claim for a file too big to hash is its size and mtime, which a rename
  // has to carry across untouched for `noteRenamed` to mean anything.
  it("says nothing about a file too big to hash, claimed before its rename", async () => {
    const file = join(dir, "assets", "big.bin");
    await mkdir(join(dir, "assets"), { recursive: true });
    await waitFor("assets");

    changed = [];
    const temp = tempPathFor(file);
    await writeFile(temp, Buffer.alloc(9 * 1024 * 1024, 7));
    await noteRenamed(temp, file);
    await rename(temp, file);

    await settle();
    expect(changed).toEqual([]);
  });

  it("says nothing about the manifest it writes itself", async () => {
    await writeManifest(dir, { assets: [{ source: "assets/clip.mp4" }] });
    await settle();
    expect(changed).toEqual([]);
  });
});
