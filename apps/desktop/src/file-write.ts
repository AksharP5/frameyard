import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { FileHandle } from "node:fs/promises";
import { tempPathFor } from "./atomic";

export type OpenFileWrite = {
  handle: FileHandle;
  path: string;
  temp: string;
  exclusive: boolean;
};

export async function openFileWrite(path: string, exclusive: boolean): Promise<OpenFileWrite> {
  await mkdir(dirname(path), { recursive: true });
  if (exclusive) {
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (existing) throw new Error(`Output already exists: ${path}`);
  }
  const temp = tempPathFor(path);
  return { handle: await open(temp, "wx"), path, temp, exclusive };
}

export async function closeFileWrite(entry: OpenFileWrite, beforePublish: (temp: string, path: string) => Promise<void>): Promise<void> {
  try {
    await entry.handle.close();
    await beforePublish(entry.temp, entry.path);
    if (entry.exclusive) {
      // A hard link publishes only if no other writer claimed the name.
      await link(entry.temp, entry.path);
      await unlink(entry.temp);
    } else {
      await rename(entry.temp, entry.path);
    }
  } catch (error) {
    await unlink(entry.temp).catch(() => {});
    throw error;
  }
}

export async function abortFileWrite(entry: OpenFileWrite): Promise<void> {
  try {
    await entry.handle.close();
  } finally {
    await unlink(entry.temp).catch(() => {});
  }
}
