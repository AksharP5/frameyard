import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { abortFileWrite, closeFileWrite, openFileWrite } from "./file-write";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "frameyard-write-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

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
