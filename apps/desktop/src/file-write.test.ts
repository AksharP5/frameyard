import { mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { abortFileWrite, closeFileWrite, FileWrites, openFileWrite } from "./file-write";

vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(fs.open) };
});
const { open: openOnDisk } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "frameyard-write-")); });
afterEach(async () => {
  vi.mocked(open).mockImplementation(openOnDisk);
  await rm(dir, { recursive: true, force: true });
});

it.each(["closed", "crashed"])("releases an output still opening when its renderer %s", async state => {
  const writes = new FileWrites();
  const opening = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  let alive = true;
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const handle = await openOnDisk(...args);
    opening.resolve();
    await finish.promise;
    return handle;
  });
  const path = join(dir, "export.mp4");
  const pending = writes.open(path, true, 7, () => alive);
  const failed = expect(pending).rejects.toThrow("renderer");
  await opening.promise;
  await writeFile(path, "another writer");
  if (state === "closed") alive = false;
  try {
    if (state === "crashed") await writes.abortOwner(7);
    finish.resolve();
    await failed;
    expect(await readdir(dir)).toEqual(["export.mp4"]);
    expect(await readFile(path, "utf8")).toBe("another writer");
  } finally {
    finish.resolve();
    await pending.catch(() => {});
    await writes.abortOwner(7);
  }
});

it("keeps output ownership separate and accepts fresh writes after a renderer cleanup", async () => {
  const writes = new FileWrites();
  const retired = await writes.open(join(dir, "retired.mp4"), true, 7, () => true);
  const kept = await writes.open(join(dir, "kept.mp4"), true, 8, () => true);
  try {
    expect(() => writes.get(kept, 7)).toThrow("another project window");
    expect(() => writes.take(kept, 7)).toThrow("another project window");
    await writes.abortOwner(7);
    expect(writes.get(retired, 7)).toBeUndefined();
    expect(writes.get(kept, 8)).toBeDefined();

    const fresh = await writes.open(join(dir, "fresh.mp4"), true, 7, () => true);
    const entry = writes.take(fresh, 7)!;
    expect(writes.get(fresh, 7)).toBeUndefined();
    await entry.handle.writeFile("repaired renderer");
    await closeFileWrite(entry, async () => {});
    expect(await readFile(join(dir, "fresh.mp4"), "utf8")).toBe("repaired renderer");
  } finally {
    await Promise.all([writes.abortOwner(7), writes.abortOwner(8)]);
  }
});

it("publishes a complete exclusive write", async () => {
  const path = join(dir, "export.mp4");
  const entry = await openFileWrite(path, true);
  await entry.handle.writeFile("rendered video");
  await closeFileWrite(entry, async () => {});
  expect(await readFile(path, "utf8")).toBe("rendered video");
});

it("preserves a file created while an exclusive write is in progress", async () => {
  const path = join(dir, "export.mp4");
  const entry = await openFileWrite(path, true);
  await entry.handle.writeFile("rendered video");
  await writeFile(path, "another writer");
  await expect(closeFileWrite(entry, async () => {})).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(path, "utf8")).toBe("another writer");
});

it("does not remove another writer's file when cancelled", async () => {
  const path = join(dir, "export.mp4");
  const entry = await openFileWrite(path, true);
  await writeFile(path, "another writer");
  await abortFileWrite(entry);
  expect(await readFile(path, "utf8")).toBe("another writer");
});

it("rejects an existing exclusive output before opening a temp write", async () => {
  const path = join(dir, "export.mp4");
  await writeFile(path, "original");
  await expect(openFileWrite(path, true)).rejects.toThrow("Output already exists");
  expect(await readFile(path, "utf8")).toBe("original");
});
