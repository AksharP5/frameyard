import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

test("CLI project flag and environment scope editor tools, workspaces, stdio, and animations", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "frameyard-project-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "dapi.cjs");
  const built = await build({
    entryPoints: [new URL("../src/index.ts", import.meta.url).pathname],
    bundle: true, platform: "node", format: "cjs", write: false,
    plugins: [{ name: "project-targeting-boundary", setup(builder) {
      builder.onResolve({ filter: /^\.\/(cli-client|mcp-proxy|animation)$/ }, ({ path }) => ({ path, namespace: "project-targeting" }));
      builder.onLoad({ filter: /.*/, namespace: "project-targeting" }, ({ path }) => ({ contents: {
        "./cli-client": `
          export const APP_NAME = 'Frameyard';
          export const call = async (name, input) => ({ name, input, success: true, issues: [] });
          export const isAppDown = () => false;
          export const launchApp = async () => false;
          export const ping = async () => {};
          export const waitForApp = async () => {};
        `,
        "./mcp-proxy": `export const runProxy = async project => console.log(JSON.stringify({project}));`,
        "./animation": `
          export const listAnimations = async project => ({project});
          export const renderAnimation = async (id, project) => ({id, project});
          export const convertAnimation = async (id, project) => ({id, project});
          export const exportAnimation = async (id, project) => ({id, project});
        `,
      }[path], loader: "js" }));
    } }],
  });
  await writeFile(path, built.outputFiles[0].text);

  async function run(args: string[], project?: string) {
    const env = { ...process.env };
    delete env.FRAMEYARD_PROJECT;
    if (project !== undefined) env.FRAMEYARD_PROJECT = project;
    const child = spawn(process.execPath, [path, ...args], { cwd: dir, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    return { code, stderr, output: stdout ? JSON.parse(stdout) : undefined };
  }

  const target = join(dir, "video");
  assert.deepEqual((await run(["--project", "video", "context"])).output, {
    name: "context", input: { project: target }, success: true, issues: [],
  });
  assert.deepEqual((await run(["tool", "editor_context", "--project", "video", "--args", '{"sceneId":"intro"}'])).output.input, {
    name: "editor_context", args: { sceneId: "intro" }, project: target,
  });
  assert.deepEqual((await run(["workspace", "send", "Make a video"], "video")).output.input, {
    action: "send", message: "Make a video", project: target,
  });
  assert.equal((await run(["--project", "video", "mcp"], "other-video")).output.project, target);
  assert.equal((await run(["animation", "render", "intro", "--project", "video"])).output.project, target);
  assert.deepEqual((await run(["workspace", "open", "video"])).output.input, { action: "open", dir: target });
  assert.deepEqual((await run(["open", "video", "--background"])).output.input, { dir: target, background: true });
  assert.deepEqual((await run(["context"])).output.input, {});
  const invalid = await run(["workspace", "send", "   ", "--project", "video"]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /message/);
  assert.equal(invalid.output, undefined);
});
