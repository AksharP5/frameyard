/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { copyFile, lstat, mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const pathSchema = z.string().min(1).refine(value => !value.includes("\0"), "Paths cannot contain null bytes");
const findSchema = z.object({ folder: pathSchema, missing: z.array(z.object({ source: pathSchema, size: z.number().int().nonnegative().optional() }).strict()).max(10_000) }).strict();
const collectSchema = z.object({ dir: pathSchema, sources: z.array(pathSchema).max(10_000) }).strict();
export type FindMissingMediaRequest = z.infer<typeof findSchema>;
export type CollectMediaRequest = z.infer<typeof collectSchema>;
export type FindMissingMediaResult = Awaited<ReturnType<typeof findMissingMedia>>;
export type CollectMediaResult = Awaited<ReturnType<typeof collectMediaSources>>;

const MAX_ENTRIES = 200_000;
const MAX_DEPTH = 64;
const remote = (source: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(source);
const inside = (root: string, path: string) => { const value = relative(root, path); return value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value); };
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

async function directory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("The folder must be an absolute path");
  const root = await realpath(path);
  if (!(await stat(root)).isDirectory()) throw new Error("The selected folder is not a directory");
  return root;
}

/** Search the selected tree without following links or silently truncating matches. */
export async function findMissingMedia(input: FindMissingMediaRequest) {
  const { folder, missing } = findSchema.parse(input);
  const root = await directory(folder);
  const result = missing.map(({ source }) => ({ source, candidates: [] as string[] }));
  const names = new Map<string, number[]>();
  for (const [index, item] of missing.entries()) {
    if (remote(item.source)) continue;
    const name = basename(item.source.replaceAll("\\", "/"));
    names.set(name, [...(names.get(name) ?? []), index]);
  }
  if (!names.size) return result;
  const waiting = [{ path: root, depth: 0 }];
  let visited = 0, matches = 0;
  while (waiting.length) {
    const current = waiting.pop()!;
    const currentInfo = await lstat(current.path);
    if (currentInfo.isSymbolicLink() || !currentInfo.isDirectory()) continue;
    for (const entry of await readdir(current.path, { withFileTypes: true })) {
      if (++visited > MAX_ENTRIES) throw new Error("The search folder contains too many entries. Choose a narrower folder.");
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue;
      const path = join(current.path, entry.name);
      const targets = names.get(entry.name);
      if (targets) {
        const info = await lstat(path);
        if (!info.isSymbolicLink() && (info.isFile() || info.isDirectory())) {
          for (const index of targets) {
            if (missing[index]!.size !== undefined && (!info.isFile() || missing[index]!.size !== info.size)) continue;
            const candidates = result[index]!.candidates;
            if (candidates.length >= 100 || ++matches > 10_000) throw new Error("Too many matching media files were found. Choose a narrower folder.");
            candidates.push(path);
          }
        }
      }
      if (entry.isDirectory()) {
        if (current.depth >= MAX_DEPTH) throw new Error("The search folder is nested too deeply. Choose a narrower folder.");
        waiting.push({ path, depth: current.depth + 1 });
      }
    }
  }
  for (const item of result) item.candidates.sort();
  return result;
}

type Entry = { name: string; actual: string; info: Stats; entryInfo: Stats; directory: boolean };

/** A complete sequence snapshot detects files added or changed while copying. */
async function sequenceSnapshot(root: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  const waiting = [{ name: "", depth: 0 }];
  while (waiting.length) {
    const current = waiting.pop()!;
    const path = join(root, current.name);
    const entryInfo = await lstat(path);
    const actual = await realpath(path);
    const info = await stat(actual);
    if (info.isDirectory()) {
      if (entryInfo.isSymbolicLink()) throw new Error(`Frame folders cannot contain symbolic-link directories: ${current.name}`);
      entries.push({ name: current.name, actual, info, entryInfo, directory: true });
      const children = await readdir(path);
      if (entries.length + waiting.length + children.length > MAX_ENTRIES) throw new Error("The frame folder contains too many entries to collect");
      if (children.length && current.depth >= MAX_DEPTH) throw new Error("The frame folder is nested too deeply to collect");
      for (const name of children) waiting.push({ name: join(current.name, name), depth: current.depth + 1 });
      continue;
    }
    if (!info.isFile()) throw new Error(`Frame folders can only contain regular files: ${current.name}`);
    entries.push({ name: current.name, actual, info, entryInfo, directory: false });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

async function stableCopy(source: string, destination: string, before: Stats): Promise<void> {
  await copyFile(source, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  if (!same(before, await stat(source))) throw new Error("The source changed while it was being collected");
}

/** Copy bytes into the project. Manifest relinking remains a separate, explicit editor operation. */
export async function collectMediaSources(input: CollectMediaRequest) {
  const { dir, sources } = collectSchema.parse(input);
  const root = await directory(dir);
  const copies: { source: string; path: string }[] = [];
  const failed: { source: string; error: string }[] = [];
  const copied = new Map<string, { path: string; info: Stats }>();
  const names = new Set<string>();
  let batch: string | undefined;

  for (const source of sources) {
    let staged: string | undefined;
    try {
      if (remote(source)) throw new Error("Remote media URLs cannot be collected. Download the original file first.");
      const requested = resolve(root, source);
      if (!isAbsolute(source) && !inside(root, requested)) throw new Error("Relative media paths must stay inside the project");
      const actual = await realpath(requested);
      const info = await stat(actual);
      if (!info.isFile() && !info.isDirectory()) throw new Error("Media must be a regular file or frame folder");
      if (info.isDirectory() && inside(actual, root)) throw new Error("A collected frame folder cannot contain the project itself");
      const previous = copied.get(actual);
      if (previous) {
        if (!same(previous.info, info)) throw new Error("The source changed during media collection");
        copies.push({ source, path: previous.path });
        continue;
      }
      const snapshot = info.isDirectory() ? await sequenceSnapshot(actual) : undefined;
      if (inside(root, actual) && (!snapshot || snapshot.every(entry => inside(root, entry.actual)))) {
        const path = relative(root, actual);
        copies.push({ source, path });
        copied.set(actual, { path, info });
        continue;
      }
      if (!batch) {
        const assets = join(root, "assets"), collected = join(assets, "collected");
        for (const path of [assets, collected]) {
          await mkdir(path, { recursive: true });
          const entry = await lstat(path);
          if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Collected media destinations must be regular project directories without symbolic links");
        }
        batch = join(collected, randomUUID());
        await mkdir(batch);
      }
      const originalName = basename(actual), extension = extname(originalName), stem = originalName.slice(0, originalName.length - extension.length);
      let name = originalName;
      for (let index = 2; names.has(name); index++) name = `${stem}-${index}${extension}`;
      names.add(name);
      staged = join(batch, `.pending-${randomUUID()}`);
      if (snapshot) {
        await mkdir(staged);
        for (const entry of snapshot) {
          const destination = join(staged, entry.name);
          if (entry.directory) { await mkdir(destination, { recursive: true }); continue; }
          await stableCopy(entry.actual, destination, entry.info);
        }
        const after = await sequenceSnapshot(actual);
        if (after.length !== snapshot.length || after.some((entry, index) => {
          const before = snapshot[index]!;
          return entry.name !== before.name || entry.actual !== before.actual || !same(entry.info, before.info) || !same(entry.entryInfo, before.entryInfo);
        })) throw new Error("The frame folder changed while it was being collected");
      } else {
        await stableCopy(actual, staged, info);
      }
      if (await realpath(requested) !== actual || !same(info, await stat(actual))) throw new Error("The media source changed while it was being collected");
      const destination = join(batch, name);
      await rename(staged, destination);
      staged = undefined;
      const path = relative(root, destination);
      copies.push({ source, path });
      copied.set(actual, { path, info });
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      if (staged) await rm(staged, { recursive: true, force: true }).catch(cleanup => {
        message += `; could not remove the incomplete copy: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`;
      });
      failed.push({ source, error: message });
    }
  }
  return { copies, failed };
}
