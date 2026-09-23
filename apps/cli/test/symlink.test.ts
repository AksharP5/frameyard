import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("Linux dev CLI link is user-local and preserves unrelated files", { skip: process.platform !== "linux" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "diffusion-symlink-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const preload = join(dir, "home.cjs");
  // Override only the child process's home lookup; never touch the user's PATH.
  await writeFile(preload, 'require("node:os").homedir = () => process.env.DIFFUSION_TEST_HOME; require("node:module").syncBuiltinESMExports();');
  const script = fileURLToPath(new URL("../scripts/symlink.mjs", import.meta.url));
  const target = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const link = join(dir, ".local", "bin", "dapi");
  const run = (action: string) => spawnSync(process.execPath, ["--require", preload, script, action], {
    encoding: "utf8", env: { ...process.env, DIFFUSION_TEST_HOME: dir },
  });

  assert.equal(run("create").status, 0);
  assert.equal(await readlink(link), target);
  assert.equal(run("create").status, 0);
  assert.equal(run("remove").status, 0);
  await writeFile(link, "another program");
  assert.equal(run("create").status, 1);
  assert.equal(run("remove").status, 1);
  assert.equal(await readFile(link, "utf8"), "another program");
});
