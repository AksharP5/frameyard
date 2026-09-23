import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { launchApp } from "../src/launch.ts";

test("Linux launch forwards background state and clears Electron's Node mode", { skip: process.platform !== "linux" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "diffusion-launch-"));
  const executable = join(dir, "editor with spaces");
  const output = join(dir, "args");
  const before = { ...process.env };
  t.after(async () => {
    process.env = before;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(executable, '#!/bin/sh\nprintf "%s\\n" "${ELECTRON_RUN_AS_NODE-unset}" "$@" > "$DIFFUSION_LAUNCH_TEST_OUTPUT"\n', { mode: 0o755 });
  process.env.DIFFUSION_APP_EXECUTABLE = executable;
  process.env.DIFFUSION_LAUNCH_TEST_OUTPUT = output;
  process.env.ELECTRON_RUN_AS_NODE = "1";

  for (const background of [true, false]) {
    assert.equal(await launchApp(background), true);
    let contents: string | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      contents = await readFile(output, "utf8").catch(() => undefined);
      if (contents) break;
      await setTimeout(10);
    }
    assert.equal(contents, background ? "unset\n--hidden\n" : "unset\n");
    await rm(output);
  }
  process.env.DIFFUSION_APP_EXECUTABLE = join(dir, "missing");
  assert.equal(await launchApp(false), false);
});
