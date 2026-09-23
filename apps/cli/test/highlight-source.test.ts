import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build, transformSync } from "esbuild";
import type { applyEdits } from "../../desktop/src/edit.ts";

const built = await build({
  entryPoints: [fileURLToPath(new URL("../../desktop/src/edit.ts", import.meta.url))],
  bundle: true, write: false, format: "cjs", platform: "node", external: ["ts-morph"],
});
const module = { exports: {} as { applyEdits: typeof applyEdits } };
runInNewContext(`(function(require,module,exports){${built.outputFiles[0].text}\n})`)(createRequire(import.meta.url), module, module.exports);

test("highlight crop, destination and frame timing round-trip through source insertion and edits", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "highlight-source-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "index.tsx"), 'export default () => <stage id="stage"><scene id="scene" width={3840} height={2160} /></stage>;');
  const props = { region: [75 / 3840, 90 / 2160, 450 / 3840, 250 / 2160], start: 1 / 120, end: 2 / 120, destination: [1 / 3, 2 / 3] };
  const result = await module.exports.applyEdits({ dir }, [{ kind: "insert", source: "pending#effect", parent: "index.tsx:scene", tag: "highlight", props }]);
  assert.equal(result.skipped.length, 0);
  const source = result.ids?.["pending#effect"];
  assert.ok(source);
  await module.exports.applyEdits({ dir }, [{ kind: "set", source, props: { end: 13 / 120 } }]);
  const code = transformSync(await readFile(join(dir, "index.tsx"), "utf8"), { loader: "tsx", format: "cjs", jsxFactory: "element" }).code;
  type Node = { tag: string; props: typeof props; children: Node[] };
  const compiled = { exports: {} as { default: () => Node } };
  runInNewContext(code, { module: compiled, element: (tag: string, props: Node["props"], ...children: Node[]) => ({ tag, props, children }) });
  const effect = compiled.exports.default().children[0].children[0];
  assert.equal(effect.tag, "highlight");
  assert.deepEqual(Array.from(effect.props.region), props.region);
  assert.deepEqual(Array.from(effect.props.destination), props.destination);
  assert.equal(effect.props.start, 1 / 120);
  assert.equal(effect.props.end, 13 / 120);
});


test("Preset settings preserve fractional regions through source edits", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "preset-source-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "index.tsx"), 'export default () => <stage id="stage"><scene id="scene" width={3840} height={2160} /></stage>;');
  const settings = { region: [75 / 3840, 90 / 2160, 450 / 3840, 250 / 2160], amount: 8 };
  const props = { preset: "frameyard-pixelate", settings, start: 1 / 120, end: 13 / 120 };
  const result = await module.exports.applyEdits({ dir }, [{ kind: "insert", source: "pending#effect", parent: "index.tsx:scene", tag: "preset", props }]);
  assert.equal(result.skipped.length, 0);
  const source = result.ids?.["pending#effect"];
  assert.ok(source);
  const updated = { ...settings, amount: 16 };
  await module.exports.applyEdits({ dir }, [{ kind: "set", source, props: { settings: updated } }]);
  const code = transformSync(await readFile(join(dir, "index.tsx"), "utf8"), { loader: "tsx", format: "cjs", jsxFactory: "element" }).code;
  type Node = { tag: string; props: typeof props; children: Node[] };
  const compiled = { exports: {} as { default: () => Node } };
  runInNewContext(code, { module: compiled, element: (tag: string, props: Node["props"], ...children: Node[]) => ({ tag, props, children }) });
  const effect = compiled.exports.default().children[0].children[0];
  assert.equal(effect.tag, "preset");
  assert.deepEqual(JSON.parse(JSON.stringify(effect.props.settings)), updated);
  assert.equal(effect.props.start, 1 / 120);
  assert.equal(effect.props.end, 13 / 120);
});
