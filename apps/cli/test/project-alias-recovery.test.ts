import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { createSignal } from "solid-js";
import { build } from "esbuild";
import type { World } from "koota";
import type { ProjectInfo, WriteResult } from "../../desktop/src/main-channels.ts";

const built = await build({
  stdin: {
    contents: `export {openProjectFolder,resolveProject,checkProject,refreshProject} from './projects/host'; export {createEditWriter} from './projects/edits';`,
    resolveDir: fileURLToPath(new URL("../../web/src/", import.meta.url)),
  },
  bundle: true, write: false, format: "cjs", platform: "node",
  tsconfig: fileURLToPath(new URL("../../web/tsconfig.app.json", import.meta.url)),
  plugins: [{ name: "project-boundaries", setup(builder) {
    builder.onResolve({ filter: /^(solid-js|somoto|@\/lib\/(ipc|db)|@\/engine\/editor)$/ }, ({ path }) => ({ path, external: true }));
  } }],
});

const alias = "/linked", canonical = "/actual";
const recoveryKey = (dir: string) => `diffusion-studio:edit-recovery:${dir}`;
const journal = (text: string) => JSON.stringify({ version: 1, updatedAt: "", safe: true, edits: [{ kind: "set", source: "index.tsx:title", props: {}, text }] });

function fixture(initial: Map<string, string> = new Map()) {
  const storage = new Map(initial);
  const project: ProjectInfo = { id: "project", dir: canonical, name: "actual", displayName: "Actual", entry: "index.tsx", createdAt: "", modifiedAt: "" };
  const previous: ProjectInfo = { ...project, dir: alias, name: "linked" };
  const records = new Map([[alias, previous]]);
  const gate = Promise.withResolvers<WriteResult>();
  let storageFails = false;
  const deps: Record<string, unknown> = {
    "solid-js": { createSignal },
    "@/engine/editor": { getDocumentEditor: () => ({ restamp() {} }) },
    somoto: { toast: { error() {} } },
    "@/lib/ipc": { mainBridge: { call: async (channel: string) => {
      if (channel === "projects:write") return gate.promise;
      assert.ok(["projects:init", "projects:get", "projects:resolve"].includes(channel), channel);
      return project;
    } } },
    "@/lib/db": {
      findProjectRecords: async (ref: string) => [...records.values()].filter(record => record.id === ref || record.name === ref),
      moveProjectRecord: async (from: string, to: string) => {
        const record = records.get(from);
        if (!record) return;
        records.delete(from);
        records.set(to, { ...record, dir: to });
      },
      rememberProject: async (record: ProjectInfo) => { records.set(record.dir, record); },
      updateProjectRecord: async (record: ProjectInfo) => { if (records.has(record.dir)) records.set(record.dir, record); },
    },
  };
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { if (storageFails) throw new Error("Storage quota exceeded"); storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  };
  const module = { exports: {} as Pick<typeof import("../../web/src/projects/host.ts"), "openProjectFolder" | "resolveProject" | "checkProject" | "refreshProject">
    & Pick<typeof import("../../web/src/projects/edits.ts"), "createEditWriter"> };
  runInThisContext(`(function(require,module,exports,window,localStorage){${built.outputFiles[0].text}\n})`)(
    (name: string) => { assert.ok(name in deps, name); return deps[name]; }, module, module.exports,
    { desktop: {}, localStorage }, localStorage,
  );
  return { ...module.exports, storage, records, previous, gate, failStorage: () => { storageFails = true; } };
}

test("remembered alias names and direct opens transfer recovery and the record to the canonical folder", async () => {
  for (const open of [
    (f: ReturnType<typeof fixture>) => f.resolveProject("linked"),
    (f: ReturnType<typeof fixture>) => f.openProjectFolder(alias),
    (f: ReturnType<typeof fixture>) => f.checkProject(f.previous),
    (f: ReturnType<typeof fixture>) => f.refreshProject(alias),
  ]) {
    const recovered = journal("Unsaved alias edit");
    const f = fixture(new Map([[recoveryKey(alias), recovered]]));
    assert.equal((await open(f))?.dir, canonical);
    assert.equal(f.storage.get(recoveryKey(alias)), undefined);
    assert.equal(f.storage.get(recoveryKey(canonical)), recovered);
    assert.deepEqual([...f.records.keys()], [canonical]);
    const writer = f.createEditWriter(canonical, {} as World);
    assert.equal(writer.getState().status, "failed");
    assert.match(writer.recovery()!, /Unsaved alias edit/);
    writer.dispose();
  }
});

test("alias normalization keeps both conflicting journals and leaves the record unmoved", async () => {
  const initial = new Map([[recoveryKey(alias), journal("Alias edit")], [recoveryKey(canonical), journal("Canonical edit")]]);
  const f = fixture(initial);
  await assert.rejects(f.openProjectFolder(alias), /Open "\/actual" directly.*Both copies were kept/);
  assert.deepEqual(f.storage, initial);
  assert.deepEqual([...f.records.keys()], [alias]);
});

test("moving malformed recovery preserves its exact bytes and a storage failure preserves the original", async () => {
  const malformed = '{"edits":"damaged"}';
  const initial = new Map([[recoveryKey(alias), malformed]]);
  const failed = fixture(initial);
  failed.failStorage();
  await assert.rejects(failed.openProjectFolder(alias), /Storage quota exceeded/);
  assert.deepEqual(failed.storage, initial);
  assert.deepEqual([...failed.records.keys()], [alias]);
  const f = fixture(initial);
  await f.openProjectFolder(alias);
  assert.equal(f.storage.get(recoveryKey(canonical)), malformed);
  assert.equal(f.storage.has(recoveryKey(alias)), false);
});

test("alias migration waits for the outgoing save and transfers only its confirmed remaining recovery", async () => {
  for (const failed of [false, true]) {
    const f = fixture();
    const writer = f.createEditWriter(alias, {} as World);
    writer.push({ kind: "text", source: "index.tsx:title", value: "Outgoing alias edit" });
    writer.dispose();
    let opened = false;
    const opening = f.openProjectFolder(alias).then(project => { opened = true; return project; });
    await setImmediate();
    assert.equal(opened, false);
    assert.equal(f.storage.has(recoveryKey(alias)), true);
    assert.equal(f.storage.has(recoveryKey(canonical)), false);
    assert.deepEqual([...f.records.keys()], [alias]);
    f.gate.resolve(failed
      ? { skipped: ["index.tsx:title"], remaining: [{ kind: "set", source: "index.tsx:title", props: {}, text: "Outgoing alias edit" }], error: "Disk full" }
      : { skipped: [], remaining: [] });
    assert.equal((await opening).dir, canonical);
    assert.equal(f.storage.has(recoveryKey(alias)), false);
    if (failed) {
      const restored = JSON.parse(f.storage.get(recoveryKey(canonical))!);
      assert.equal(restored.safe, true);
      assert.equal(restored.edits[0].text, "Outgoing alias edit");
    } else {
      assert.equal(f.storage.size, 0);
    }
  }
});

test("alias recovery cannot be transferred behind a live writer, including after an older owner is disposed", async () => {
  const recovered = journal("Unsaved alias edit");
  const initial = new Map([[recoveryKey(alias), recovered]]);
  const f = fixture(initial);
  const world = {} as World;
  const previous = f.createEditWriter(canonical, world);
  const current = f.createEditWriter(canonical, world);
  previous.dispose();
  try {
    await assert.rejects(f.openProjectFolder(alias), /Close the current project "\/actual".*"\/linked"/);
    assert.deepEqual(f.storage, initial);
    assert.deepEqual([...f.records.keys()], [alias]);
    assert.equal(current.getState().status, "saved");
  } finally { current.dispose(); }
  assert.equal((await f.openProjectFolder(alias)).dir, canonical);
  assert.equal(f.storage.has(recoveryKey(alias)), false);
  assert.equal(f.storage.get(recoveryKey(canonical)), recovered);
  assert.deepEqual([...f.records.keys()], [canonical]);
});
