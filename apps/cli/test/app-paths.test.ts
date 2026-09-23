import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectsDirectory, userDataDirectory } from "../../desktop/src/app-paths.ts";

test("Frameyard reuses existing settings and projects and gives fresh installs their own folders", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "frameyard-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(userDataDirectory(root), join(root, "Frameyard"));
  assert.equal(projectsDirectory(root), join(root, "Frameyard"));

  await mkdir(join(root, "Diffusion Studio Linux"));
  await mkdir(join(root, "Diffusion Studio"));
  assert.equal(userDataDirectory(root), join(root, "Diffusion Studio Linux"));
  assert.equal(projectsDirectory(root), join(root, "Diffusion Studio"));

  await mkdir(join(root, "Frameyard"));
  assert.equal(userDataDirectory(root), join(root, "Frameyard"));
  assert.equal(projectsDirectory(root), join(root, "Frameyard"));
});
