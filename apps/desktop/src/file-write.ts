import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { FileHandle } from "node:fs/promises";
import { tempPathFor } from "./atomic";

export type OpenFileWrite = {
  handle: FileHandle;
  path: string;
  temp: string;
  exclusive: boolean;
};

/** Each renderer owns its output handles until publishing or cancellation. */
export class FileWrites {
  private readonly entries = new Map<string, { entry: OpenFileWrite; owner: number }>();
  private readonly ownerVersions = new Map<number, number>();

  async open(path: string, exclusive: boolean, owner: number, isAlive: () => boolean): Promise<string> {
    const version = this.ownerVersions.get(owner) ?? 0;
    const entry = await openFileWrite(path, exclusive);
    if (!isAlive() || version !== (this.ownerVersions.get(owner) ?? 0)) {
      await abortFileWrite(entry);
      throw new Error("The output renderer closed before the file finished opening");
    }
    const id = randomUUID();
    this.entries.set(id, { entry, owner });
    return id;
  }

  get(id: string, owner: number): OpenFileWrite | undefined {
    const write = this.entries.get(id);
    if (write && write.owner !== owner) throw new Error("This output belongs to another project window");
    return write?.entry;
  }

  take(id: string, owner: number): OpenFileWrite | undefined {
    const entry = this.get(id, owner);
    this.entries.delete(id);
    return entry;
  }

  async abortOwner(owner: number): Promise<void> {
    this.ownerVersions.set(owner, (this.ownerVersions.get(owner) ?? 0) + 1);
    const writes = [...this.entries].filter(([, write]) => write.owner === owner);
    for (const [id] of writes) this.entries.delete(id);
    await Promise.all(writes.map(([, write]) => abortFileWrite(write.entry).catch(error => console.error("Could not release interrupted output", error))));
  }
}

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
