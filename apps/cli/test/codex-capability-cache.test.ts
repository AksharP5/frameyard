import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import { build } from "esbuild";
import type { CodexCapabilities } from "../../desktop/src/codex-capabilities.ts";

const require = createRequire(import.meta.url);
const solid: typeof import("solid-js") = require(require.resolve("solid-js").replace("server.cjs", "solid.cjs"));
const built = await build({
  entryPoints: [fileURLToPath(new URL("../../web/src/components/agent/use-codex-capabilities.ts", import.meta.url))],
  bundle: true, write: false, format: "cjs", platform: "node",
  plugins: [{ name: "capability-boundaries", setup(build) {
    build.onResolve({ filter: /.*/ }, ({ path, kind }) => kind === "entry-point" ? undefined : { path, external: true });
  } }],
});
const capabilities = (name: string): CodexCapabilities => ({ skills: [{ name, path: `/skills/${name}`, description: name }], mcpServers: [], errors: [] });

function fixture() {
  type Response = { method: "capabilities"; result: CodexCapabilities };
  const requests: { dir: string; resolve(response: Response): void; reject(error: Error): void }[] = [];
  const dependencies: Record<string, unknown> = {
    "solid-js": solid,
    "@desktop/main-channels": { MAIN_CHANNELS: { CODEX_REQUEST: "codex:request" } },
    "@/lib/ipc": { mainBridge: { call(channel: string, request: { method: string; input: { dir: string } }) {
      assert.equal(channel, "codex:request");
      assert.equal(request.method, "capabilities");
      return new Promise<Response>((resolve, reject) => requests.push({ dir: request.input.dir, resolve, reject }));
    } } },
  };
  const module = { exports: {} as typeof import("../../web/src/components/agent/use-codex-capabilities.ts") };
  runInThisContext(`(function(require,module,exports){${built.outputFiles[0].text}\n})`)(
    (name: string) => { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name]; }, module, module.exports,
  );
  return solid.createRoot((dispose) => {
    const [directory, setDirectory] = solid.createSignal<string | undefined>("/project-a");
    const [enabled, setEnabled] = solid.createSignal(true);
    return { catalog: module.exports.createCodexCapabilities(directory, enabled), requests, setDirectory, setEnabled, dispose };
  });
}

test("suggestions and the picker share pending and cached results, with an explicit refresh", async () => {
  const { catalog, requests, dispose } = fixture();
  try {
    const first = catalog.load();
    assert.equal(catalog.load(), first);
    assert.equal(catalog.load(true), first);
    assert.equal(catalog.loading(), true);
    assert.equal(requests.length, 1);
    const initial = capabilities("captions");
    requests[0].resolve({ method: "capabilities", result: initial });
    await first;
    assert.deepEqual(catalog.result(), initial);
    assert.equal(catalog.loading(), false);
    await catalog.load();
    assert.equal(requests.length, 1);
    const refresh = catalog.load(true);
    assert.equal(requests.length, 2);
    requests[1].resolve({ method: "capabilities", result: capabilities("updated") });
    await refresh;
    assert.equal(catalog.result()?.skills[0].name, "updated");
  } finally { dispose(); }
});

test("switching projects clears cached data and ignores stale responses while the new project loads", async () => {
  const { catalog, requests, setDirectory, dispose } = fixture();
  try {
    const initial = catalog.load();
    requests[0].resolve({ method: "capabilities", result: capabilities("old") });
    await initial;
    const stale = catalog.load(true);
    setDirectory("/project-b");
    assert.equal(catalog.result(), undefined);
    const current = catalog.load();
    assert.deepEqual(requests.map(({ dir }) => dir), ["/project-a", "/project-a", "/project-b"]);
    requests[1].resolve({ method: "capabilities", result: capabilities("stale") });
    await stale;
    assert.equal(catalog.result(), undefined);
    assert.equal(catalog.loading(), true);
    assert.equal(catalog.load(), current, "old completion must not clear the new pending request");
    requests[2].resolve({ method: "capabilities", result: capabilities("current") });
    await current;
    assert.equal(catalog.result()?.skills[0].name, "current");
  } finally { dispose(); }
});

test("failed catalogs expose the error and can retry without caching the failure", async () => {
  const { catalog, requests, dispose } = fixture();
  try {
    const failed = catalog.load();
    requests[0].reject(new Error("Codex unavailable"));
    await failed;
    assert.equal(catalog.error(), "Codex unavailable");
    assert.equal(catalog.loading(), false);
    assert.equal(catalog.result(), undefined);
    const retry = catalog.load();
    assert.equal(catalog.error(), "");
    requests[1].resolve({ method: "capabilities", result: capabilities("recovered") });
    await retry;
    assert.equal(catalog.result()?.skills[0].name, "recovered");
  } finally { dispose(); }
});

test("disabled harnesses and missing projects do not load or accept results from a previous scope", async () => {
  const { catalog, requests, setDirectory, setEnabled, dispose } = fixture();
  try {
    const stale = catalog.load();
    setEnabled(false);
    await catalog.load();
    assert.equal(requests.length, 1);
    requests[0].reject(new Error("Old project failed"));
    await stale;
    assert.equal(catalog.error(), "");
    assert.equal(catalog.result(), undefined);
    assert.equal(catalog.loading(), false);
    setDirectory(undefined);
    setEnabled(true);
    await catalog.load();
    assert.equal(requests.length, 1);
    setDirectory("/project-b");
    const current = catalog.load();
    requests[1].resolve({ method: "capabilities", result: capabilities("current") });
    await current;
    assert.equal(catalog.result()?.skills[0].name, "current");
  } finally { dispose(); }
});
