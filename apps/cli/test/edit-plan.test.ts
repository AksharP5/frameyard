import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { writeEditPlan } from "../src/edit-plan.ts";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "dapi edit plan "));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const media = join(dir, 'take "one" & two.mp4');
  await writeFile(media, "media fixture");
  return { dir, media, plan: join(dir, "plan.json"), output: join(dir, "cuts.tsx") };
}

type Element = {
  tag: string;
  props: Record<string, string | number>;
  children: Element[];
};

function renderComponent(source: string): Element {
  const { code } = transformSync(source, { loader: "tsx", format: "cjs", jsxFactory: "element" });
  const module: { exports: { default?: () => Element } } = { exports: {} };
  runInNewContext(code, {
    module,
    element: (tag: string, props: Element["props"], ...children: Element[]) => ({ tag, props, children }),
  });
  assert.ok(module.exports.default);
  return module.exports.default();
}

test("writes editable contiguous cuts with original source windows and safely escaped labels", async (t) => {
  const f = await fixture(t);
  const label = '\"}); throw new Error("injected"); // <video> & ${value}';
  await writeFile(f.plan, JSON.stringify([
    { source: f.media, in: 2.25, out: 4.75, id: "opening", label },
    { source: 'take "one" & two.mp4', in: 9, out: 10.125 },
  ]));
  const result = await writeEditPlan(f.plan, f.output);
  const tree = renderComponent(await readFile(f.output, "utf8"));
  assert.equal(result.duration, 3.625);
  assert.equal(tree.tag, "sequence");
  assert.equal(tree.children.length, 2);
  assert.deepEqual(tree.children.map(({ props }) => [props.start, props.sourceIn, props.sourceOut]), [[0, 2.25, 4.75], [2.5, 9, 10.125]]);
  assert.ok(tree.children.every((child) => child.tag === "video" && child.props.src === f.media));
  assert.equal(tree.children[0].props.name, label);
  assert.equal(tree.children[0].props.id, "opening");
});

test("accepts video-use cut EDLs and keeps automatic identities stable across reordering", async (t) => {
  const f = await fixture(t);
  const first = { source: "take", start: 3, end: 4, beat: "Intro" };
  const second = { source: "take", start: 8, end: 10 };
  const plan = { sources: { take: f.media }, ranges: [first, second] };
  await writeFile(f.plan, JSON.stringify(plan));
  await writeEditPlan(f.plan, f.output);
  const original = renderComponent(await readFile(f.output, "utf8")).children;
  assert.equal(original[0].props.name, "Intro");
  await writeFile(f.plan, JSON.stringify({ ...plan, ranges: [second, first, first] }));
  const revised = join(f.dir, "revised.tsx");
  await writeEditPlan(f.plan, revised);
  const children = renderComponent(await readFile(revised, "utf8")).children;
  assert.equal(children[0].props.id, original[1].props.id);
  assert.equal(children[1].props.id, original[0].props.id);
  assert.equal(new Set(children.map((child) => child.props.id)).size, 3);
});

test("rejects invalid cuts and unsupported effects before creating output", async (t) => {
  const f = await fixture(t);
  const cut = { source: f.media, in: 0, out: 1 };
  const invalid = [
    [],
    [{ ...cut, in: -1 }],
    [{ ...cut, in: "0" }],
    [{ ...cut, out: 0 }],
    [{ ...cut, out: null }],
    [{ ...cut, source: join(f.dir, "missing.mp4") }],
    [{ ...cut, source: f.dir }],
    [{ ...cut, id: 'x" onLoad="alert(1)' }],
    [{ ...cut, id: "duplicate" }, { ...cut, id: "duplicate" }],
    { sources: { take: f.media }, ranges: [{ source: "unknown", start: 0, end: 1 }] },
    { sources: { take: f.media }, ranges: [{ source: "take", start: 0, end: 1 }], grade: "auto" },
  ];
  for (const plan of invalid) {
    await writeFile(f.plan, JSON.stringify(plan));
    await assert.rejects(writeEditPlan(f.plan, f.output));
    await assert.rejects(readFile(f.output), { code: "ENOENT" });
  }
  await writeFile(f.plan, '[{"source":"take.mp4","in":0,"out":1e309}]');
  await assert.rejects(writeEditPlan(f.plan, f.output), /finite/);
});

test("refuses to overwrite existing output, including the plan itself", async (t) => {
  const f = await fixture(t);
  await writeFile(f.plan, JSON.stringify([{ source: f.media, in: 0, out: 1 }]));
  await writeFile(f.output, "manual edits");
  await assert.rejects(writeEditPlan(f.plan, f.output), /already exists/);
  assert.equal(await readFile(f.output, "utf8"), "manual edits");
  await assert.rejects(writeEditPlan(f.plan, f.plan), /new .tsx file/);
});
