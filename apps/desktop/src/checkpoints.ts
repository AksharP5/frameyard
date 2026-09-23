/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { constants } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { checkpointIdSchema, checkpointLabelSchema, checkpointSchema, editorRecoverySchema, type EditorRecovery } from "./checkpoint-contracts";

// Only regular files are tracked; empty directories are not retained. Symlinks and excluded names stay untouched.
// .animation-* names are reserved for render staging; retained sources and final assets are included.
const excluded = new Set([".diffusion", ".git", "node_modules", ".venv", "venv", "__pycache__", ".cache"]);
const excludedName = (name: string) => excluded.has(name) || name.startsWith(".animation-");
const safePath = z.string().min(1).refine(path => path.split("/").every(part =>
  part !== "" && part !== "." && part !== ".." && !excludedName(part) && !part.includes("\\") && !part.includes("\0")));
const fileSchema = z.object({
  path: safePath, size: z.number().int().nonnegative(), mtime: z.number(), ctime: z.number(), mode: z.number().int().min(0).max(0o777),
});
const manifestSchema = checkpointSchema.extend({ files: z.array(fileSchema) }).refine(value => {
  const paths = new Set(value.files.map(file => file.path));
  if (paths.size !== value.files.length || value.files.length !== value.fileCount || value.bytes !== value.files.reduce((sum, file) => sum + file.size, 0)) return false;
  return value.files.every(file => {
    for (let slash = file.path.indexOf("/"); slash !== -1; slash = file.path.indexOf("/", slash + 1)) {
      if (paths.has(file.path.slice(0, slash))) return false;
    }
    return true;
  });
});
type Manifest = z.infer<typeof manifestSchema>;
const pending = new Map<string, Promise<unknown>>();

async function serialized<T>(dir: string, run: (root: string) => Promise<T>): Promise<T> {
  const root = await realpath(dir);
  const previous = pending.get(root) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(() => run(root));
  pending.set(root, operation);
  try { return await operation; }
  finally { if (pending.get(root) === operation) pending.delete(root); }
}

async function regularDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe checkpoint directory: ${path}`);
}

async function storage(root: string): Promise<string> {
  await regularDirectory(join(root, ".diffusion"));
  const dir = join(root, ".diffusion/checkpoints");
  await regularDirectory(dir);
  return dir;
}

async function scan(root: string, prefix = ""): Promise<Manifest["files"]> {
  const files: Manifest["files"] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (excludedName(entry.name) || entry.isSymbolicLink()) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    safePath.parse(path);
    if (entry.isDirectory()) files.push(...await scan(root, path));
    else if (entry.isFile()) {
      const stat = await lstat(join(root, path));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`File changed while checkpointing: ${path}`);
      files.push({ path, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs, mode: stat.mode & 0o777 });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function readManifest(store: string, id: string): Promise<Manifest> {
  checkpointIdSchema.parse(id);
  const path = join(store, id);
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe checkpoint directory");
  const manifestPath = join(path, "manifest.json");
  if (!(await lstat(manifestPath)).isFile()) throw new Error("Unsafe checkpoint manifest");
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  if (manifest.id !== id) throw new Error("Checkpoint ID does not match its directory");
  return manifest;
}

async function manifests(store: string): Promise<Manifest[]> {
  const ids = (await readdir(store)).filter(id => checkpointIdSchema.safeParse(id).success);
  return (await Promise.all(ids.map(id => readManifest(store, id)))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function requireSafeParents(root: string, path: string): Promise<void> {
  let current = root;
  for (const part of path.split("/")) {
    current = join(current, part);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error(`Checkpoint path contains a symbolic link: ${path}`);
    if (info && !info.isFile() && !info.isDirectory()) throw new Error(`Checkpoint path is not a regular file or directory: ${path}`);
  }
}

async function removeEmptyDirectories(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (excludedName(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    await removeEmptyDirectories(path);
    await rmdir(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error;
    });
  }
}

async function requireReplaceableDirectory(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (excludedName(entry.name) || entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
      throw new Error(`Cannot replace directory containing excluded data: ${path}`);
    }
    if (entry.isDirectory()) await requireReplaceableDirectory(join(path, entry.name));
  }
}

async function create(root: string, label: string, automatic = false, editorRecovery?: EditorRecovery): Promise<Manifest> {
  checkpointLabelSchema.parse(label);
  const store = await storage(root);
  const previous = (await manifests(store))[0];
  const prior = new Map(previous?.files.map(file => [file.path, file]));
  const files = await scan(root);
  const id = randomUUID();
  const stage = join(store, `.pending-${id}`);
  await mkdir(join(stage, "files"), { recursive: true });
  try {
    for (const file of files) {
      const output = join(stage, "files", file.path);
      await mkdir(dirname(output), { recursive: true });
      await requireSafeParents(root, file.path);
      const old = prior.get(file.path);
      if (previous && old && old.size === file.size && old.mtime === file.mtime && old.ctime === file.ctime && old.mode === file.mode) {
        const source = join(store, previous.id, "files", file.path);
        await requireSafeParents(join(store, previous.id), `files/${file.path}`);
        const sourceInfo = await lstat(source);
        if (!sourceInfo.isFile() || sourceInfo.size !== file.size) throw new Error(`Damaged checkpoint file: ${file.path}`);
        await link(source, output);
      } else {
        await copyFile(join(root, file.path), output, constants.COPYFILE_FICLONE);
      }
      const after = await lstat(join(root, file.path));
      if (!after.isFile() || after.size !== file.size || after.mtimeMs !== file.mtime || after.ctimeMs !== file.ctime) {
        throw new Error(`File changed while checkpointing: ${file.path}. Try again when editing finishes.`);
      }
    }
    const manifest: Manifest = { id, ...(automatic ? { automatic: true } : {}), label: label.trim(), createdAt: new Date().toISOString(), fileCount: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0), files };
    if (editorRecovery) await writeFile(join(stage, "editor-recovery.json"), JSON.stringify(editorRecovery));
    await writeFile(join(stage, "manifest.json"), JSON.stringify(manifest));
    await rename(stage, join(store, id));
    return manifest;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export function createCheckpoint(dir: string, label: string) {
  return serialized(dir, async root => checkpointSchema.parse(await create(root, label)));
}

/** Keep ten editor-created recovery snapshots; manual checkpoints are retained. */
export function createRecoveryCheckpoint(dir: string, editorRecovery?: EditorRecovery) {
  const recovery = editorRecoverySchema.optional().parse(editorRecovery);
  return serialized(dir, async root => {
    const checkpoint = await create(root, 'Automatic recovery', true, recovery);
    const store = await storage(root);
    for (const obsolete of (await manifests(store)).filter(item => item.automatic).slice(10)) {
      await rm(join(store, obsolete.id), { recursive: true });
    }
    return checkpointSchema.parse(checkpoint);
  });
}

export function listCheckpoints(dir: string) {
  return serialized(dir, async root => (await manifests(await storage(root))).map(value => checkpointSchema.parse(value)));
}

export function restoreCheckpoint(dir: string, id: string) {
  return serialized(dir, async root => {
    const store = await storage(root);
    const target = await readManifest(store, id);
    for (const file of target.files) {
      await requireSafeParents(root, file.path);
      await requireSafeParents(join(store, id), `files/${file.path}`);
      const stat = await lstat(join(store, id, "files", file.path));
      if (!stat.isFile() || stat.size !== file.size) throw new Error(`Missing or damaged checkpoint file: ${file.path}`);
      const current = await lstat(join(root, file.path)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw error;
      });
      if (current?.isDirectory()) await requireReplaceableDirectory(join(root, file.path));
    }
    const recovery = await create(root, `Before restoring ${target.label}`.slice(0, 160));
    try {
      for (const file of recovery.files) {
        await requireSafeParents(root, file.path);
        await rm(join(root, file.path));
      }
      // Only remove empty directories; excluded data and symlinks remain untouched.
      await removeEmptyDirectories(root);
      for (const file of target.files) {
        const output = join(root, file.path);
        await requireSafeParents(root, file.path);
        await mkdir(dirname(output), { recursive: true });
        await copyFile(join(store, id, "files", file.path), output, constants.COPYFILE_FICLONE);
        await chmod(output, file.mode);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Restore failed: ${detail}. Your previous project is preserved in checkpoint ${recovery.id}.`, { cause: error });
    }
    return { restored: checkpointSchema.parse(target), recovery: checkpointSchema.parse(recovery) };
  });
}
