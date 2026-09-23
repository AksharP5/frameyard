import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const compiled = await build({
  entryPoints: [fileURLToPath(new URL("../../desktop/src/agent-assets.ts", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "node", packages: "external",
});
// Keep package imports resolvable from the repository while loading its TS.
const modulePath = join(import.meta.dirname, `.agent-assets-${process.pid}.mjs`);
await writeFile(modulePath, compiled.outputFiles[0].text);
const assets = await import(modulePath) as typeof import("../../desktop/src/agent-assets.ts");
await rm(modulePath);

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"><path fill="#123456" d="M0 0h24v16H0z"/></svg>';

test("generated image imports deduplicate concurrent bytes and preserve provenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "diffusion-assets-"));
  try {
    const input = { dir, prompt: "A blue rectangle", result: Buffer.from(svg).toString("base64") };
    const [first, second] = await Promise.all([assets.importGeneratedAsset(input), assets.importGeneratedAsset({ ...input, title: "Another title" })]);
    assert.equal(first.path, second.path);
    assert.notEqual(first.deduplicated, second.deduplicated);
    assert.deepEqual([first.width, first.height, first.mimeType], [24, 16, "image/svg+xml"]);
    assert.equal(await readFile(first.path, "utf8"), svg);
    assert.equal((await readdir(join(dir, "assets", "acquired"))).length, 1);
    const records = (await readFile(first.provenancePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 2);
    assert.equal(records[0].prompt, input.prompt);
    assert.ok(records.some((record) => record.title === "Another title"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("WebP pixels decode before publication; a valid header alone is insufficient", async () => {
  const dir = await mkdtemp(join(tmpdir(), "diffusion-assets-"));
  try {
    const result = "UklGRj4AAABXRUJQVlA4IDIAAADQAgCdASoYABAAPm0qkkWkIqGYBABABsSxgDsAAIGwAP725gf/UREFJLD/8Qu9jCgAAA==";
    const imported = await assets.importGeneratedAsset({ dir, prompt: "A blue rectangle", result });
    assert.deepEqual([imported.width, imported.height, imported.mimeType], [24, 16, "image/webp"]);
    const truncated = Buffer.from(result, "base64").subarray(0, 30).toString("base64");
    await assert.rejects(assets.importGeneratedAsset({ dir, prompt: "Truncated pixels", result: truncated }), /decoding failed/);
    assert.equal((await readdir(join(dir, "assets", "acquired"))).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("imports reject active SVG, invalid base64, unsafe URLs, and unapproved files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "diffusion-assets-"));
  try {
    for (const source of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/image.png"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><path onload="alert(1)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(&#104;ttps://example.com/x)"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>',
      '<html><body>not an image</body></html>',
    ]) await assert.rejects(assets.importGeneratedAsset({ dir, prompt: "test", result: Buffer.from(source).toString("base64") }));
    await assert.rejects(assets.importGeneratedAsset({ dir, prompt: "test", result: "invalid$base64" }), /base64/);
    await assert.rejects(assets.importGeneratedAsset({ dir, prompt: "test", savedPath: "/etc/passwd" }), /outside/);
    for (const url of ["file:///etc/passwd", "http://example.com/a.png", "https://user:pass@example.com/a.png", "https://127.0.0.1/a.png", "https://[::ffff:127.0.0.1]/a.png"]) {
      await assert.rejects(assets.importAsset({ dir, title: "test", url }), /public HTTPS/);
    }
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("generated paths and destination symlinks cannot escape the project or overwrite files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "diffusion-assets-"));
  const outside = await mkdtemp(join(tmpdir(), "diffusion-assets-outside-"));
  try {
    const source = join(dir, "generated.svg");
    await writeFile(source, svg);
    const imported = await assets.importGeneratedAsset({ dir, prompt: "test", savedPath: source });
    const original = "user-owned changed content";
    await writeFile(imported.path, original);
    await assert.rejects(assets.importGeneratedAsset({ dir, prompt: "test", savedPath: source }), /not overwritten/);
    assert.equal(await readFile(imported.path, "utf8"), original);
    await writeFile(join(outside, "secret.svg"), svg);
    await symlink(join(outside, "secret.svg"), join(dir, "outside.svg"));
    await assert.rejects(assets.importGeneratedAsset({ dir, prompt: "test", savedPath: join(dir, "outside.svg") }), /outside/);
    const redirected = join(dir, "redirected");
    await mkdir(redirected);
    await symlink(outside, join(redirected, "assets"));
    await assert.rejects(assets.importGeneratedAsset({ dir: redirected, prompt: "test", result: Buffer.from(svg).toString("base64") }), /outside/);
    assert.deepEqual(await readdir(outside), ["secret.svg"]);
    assert.ok(imported.libraryPath.includes(createHash("sha256").update(svg).digest("hex")));
  } finally { await rm(dir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
