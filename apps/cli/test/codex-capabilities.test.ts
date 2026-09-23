import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import { buildSync } from "esbuild";

const source = fileURLToPath(new URL("../../desktop/src/codex-capabilities.ts", import.meta.url));
const code = buildSync({ entryPoints: [source], bundle: true, platform: "node", format: "cjs", write: false }).outputFiles[0].text;
const module = { exports: {} as typeof import("../../desktop/src/codex-capabilities.ts") };
runInThisContext(`(function(require,module,exports){${code}\n})`)(createRequire(import.meta.url), module, module.exports);
const { listCapabilities, validateSkills } = module.exports;
const skill = { name: "captions", path: "/skills/captions/SKILL.md", description: "Add captions", enabled: true };
const skillResponse = { data: [{ cwd: "/project", skills: [skill, { ...skill, path: "/disabled", enabled: false }], errors: [] }] };

test("capabilities filters disabled skills and exposes paginated MCP inventory without configuration or schemas", async () => {
  const result = await listCapabilities(async (method, params) => {
    if (method === "skills/list") {
      assert.deepEqual(params, { cwds: ["/project"], forceReload: true });
      return skillResponse;
    }
    assert.equal(method, "mcpServerStatus/list");
    assert.equal(params.threadId, "thread");
    return params.cursor ? { data: [{ name: "other", runtimeStatus: null, authStatus: "notLoggedIn", tools: {} }], nextCursor: null }
      : { data: [{ name: "assets", runtimeStatus: "connected", tools: { search: { inputSchema: { private: "hidden" } } }, env: { TOKEN: "secret" } }], nextCursor: "page2" };
  }, "/project", "thread");
  assert.deepEqual(result, { skills: [{ name: skill.name, path: skill.path, description: skill.description }], mcpServers: [{ name: "assets", status: "connected", toolCount: 1 }, { name: "other", status: "authenticationRequired", toolCount: 0 }], errors: [] });
});

test("skill invocation validates exact enabled native skills and deduplicates attachments", async () => {
  const request = async () => skillResponse;
  assert.deepEqual(await validateSkills(request, "/project", [skill, skill]), [{ type: "skill", name: skill.name, path: skill.path }]);
  for (const selection of [{ ...skill, path: "/arbitrary" }, { ...skill, path: "/disabled" }, { ...skill, name: "other" }]) {
    await assert.rejects(validateSkills(request, "/project", [selection]), /unavailable or disabled/);
  }
  await assert.rejects(validateSkills(request, "/other-project", [skill]), /unavailable or disabled/);
});

test("a failing MCP inventory does not hide available skills or its error", async () => {
  const result = await listCapabilities(async (method) => {
    if (method === "skills/list") return skillResponse;
    throw new Error("MCP connection failed");
  }, "/project");
  assert.equal(result.skills.length, 1);
  assert.deepEqual(result.mcpServers, []);
  assert.deepEqual(result.errors, ["MCP servers: MCP connection failed"]);
});
