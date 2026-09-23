import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { build } from "esbuild";
import type { World } from "koota";
import type { SourceEdit, WriteResult } from "../../desktop/src/edit.ts";

const built = await build({
  entryPoints: [fileURLToPath(new URL("../../web/src/projects/edits.ts", import.meta.url))],
  bundle: true, write: false, format: "cjs", platform: "node",
  plugins: [{ name: "writer-boundaries", setup(build) {
    build.onResolve({ filter: /^(@\/engine\/editor|\.\/host|somoto)$/ }, ({ path }) => ({ path, external: true }));
  } }],
});

type Write = { edits: SourceEdit[]; resolve: (result: WriteResult) => void; reject: (error: Error) => void };

function fixture(storage = new Map<string, string>()) {
  const calls: Write[] = [];
  const waiting: ((write: Write) => void)[] = [];
  const stamps: Record<string, string>[] = [];
  let received = 0;
  const dependencies: Record<string, unknown> = {
    "./host": { writeProject: (_dir: string, edits: SourceEdit[]) => {
      const result = Promise.withResolvers<WriteResult>();
      const call = { edits, resolve: result.resolve, reject: result.reject };
      calls.push(call);
      waiting.shift()?.(call);
      return result.promise;
    } },
    "@/engine/editor": { getDocumentEditor: () => ({ restamp: (ids: Record<string, string>) => stamps.push(ids), unsettle() {}, discardPending() {} }) },
    somoto: { toast: { error() {} } },
  };
  const module = { exports: {} as typeof import("../../web/src/projects/edits.ts") };
  runInThisContext(`(function(require,module,exports,localStorage){${built.outputFiles[0].text}\n})`)(
    (name: string) => {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
      return dependencies[name];
    }, module, module.exports, {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    },
  );
  const world = {} as World;
  const writer = module.exports.createEditWriter("project", world);
  const nextWrite = () => {
    const call = calls[received++];
    return call ? Promise.resolve(call) : new Promise<Write>((resolve) => waiting.push(resolve));
  };
  return { ...module.exports, writer, world, calls, stamps, nextWrite, storage };
}

test("settles source writes in order, including changes held behind a new node's source id", async () => {
  const f = fixture();
  try {
    f.writer.push({ kind: "insert", source: "pending#1", parent: "index.tsx:scene", tag: "rect", props: { x: 0 } });
    const saved = f.flushProjectEdits(f.world);
    const first = await f.nextWrite();
    f.writer.push({ kind: "prop", source: "pending#1", name: "x", value: 80 });
    const alsoSaved = f.flushProjectEdits(f.world);
    assert.equal(f.calls.length, 1);
    first.resolve({ skipped: [], ids: { "pending#1": "index.tsx:clip" } });
    const second = await f.nextWrite();
    assert.deepEqual(second.edits, [{ kind: "set", source: "index.tsx:clip", props: { x: 80 } }]);
    let done = false;
    void saved.then(() => { done = true; });
    assert.equal(done, false);
    second.resolve({ skipped: [] });
    await Promise.all([saved, alsoSaved]);
    assert.deepEqual(f.stamps[0], { "pending#1": "index.tsx:clip" });
  } finally { f.writer.dispose(); }
});

test("mutation acknowledgements reject filesystem failures and skipped source edits", async () => {
  for (const failure of [new Error("disk is full"), { skipped: ["index.tsx:title (x)"] }]) {
    const f = fixture();
    try {
      f.writer.push({ kind: "prop", source: "index.tsx:title", name: "x", value: 40 });
      const saved = f.flushProjectEdits(f.world);
      const write = await f.nextWrite();
      if (failure instanceof Error) write.reject(failure);
      else write.resolve(failure);
      await assert.rejects(saved, /disk is full|Some edits could not be written/);
    } finally { f.writer.dispose(); }
  }
});

test("disposing an old writer cannot unregister its replacement", async () => {
  const f = fixture();
  const replacement = f.createEditWriter("renamed project", f.world);
  f.writer.dispose();
  try {
    replacement.push({ kind: "text", source: "index.tsx:title", value: "Saved text" });
    const saved = f.flushProjectEdits(f.world);
    (await f.nextWrite()).resolve({ skipped: [] });
    await saved;
  } finally { replacement.dispose(); }
  await assert.rejects(f.flushProjectEdits(f.world), /writer is not ready/);
});

test("failed writes retain unsaved changes, retry only remaining edits, and keep inflight edits in order", async () => {
  const f = fixture();
  const states: string[] = [];
  const unsubscribe = f.subscribeProjectSaveState(f.world, state => states.push(state.status));
  try {
    f.writer.push({ kind: "insert", source: "pending#first", parent: "first.tsx:scene", tag: "rect", props: { x: 0 } });
    f.writer.push({ kind: "insert", source: "pending#second", parent: "second.tsx:scene", tag: "rect", props: { x: 0 } });
    const saved = f.flushProjectEdits(f.world);
    const first = await f.nextWrite();
    f.writer.push({ kind: "prop", source: "pending#first", name: "x", value: 40 });
    f.writer.push({ kind: "prop", source: "pending#second", name: "x", value: 80 });
    first.resolve({ skipped: ["pending#second"], ids: { "pending#first": "first.tsx:clip" }, remaining: [first.edits[1]], error: "disk is full" });
    await assert.rejects(saved, /disk is full/);
    assert.deepEqual(f.getProjectSaveState(f.world), { status: "failed", error: "disk is full", retryable: true });
    await assert.rejects(f.flushProjectEdits(f.world), /disk is full/);
    assert.equal(f.calls.length, 1);
    const retried = f.retryProjectEdits(f.world);
    const second = await f.nextWrite();
    assert.deepEqual(second.edits, [first.edits[1]]);
    second.resolve({ skipped: [], ids: { "pending#second": "second.tsx:clip" }, remaining: [] });
    const third = await f.nextWrite();
    assert.deepEqual(third.edits, [
      { kind: "set", source: "first.tsx:clip", props: { x: 40 } },
      { kind: "set", source: "second.tsx:clip", props: { x: 80 } },
    ]);
    third.resolve({ skipped: [], remaining: [] });
    await retried;
    assert.equal(f.getProjectSaveState(f.world).status, "saved");
    assert.ok(states.includes("dirty") && states.includes("saving") && states.includes("failed"));
  } finally { unsubscribe(); f.writer.dispose(); }
});

test("recoverable filesystem failures retry automatically without requiring another edit", async () => {
  const f = fixture();
  try {
    f.writer.push({ kind: "text", source: "index.tsx:title", value: "Saved after recovery" });
    const saved = f.flushProjectEdits(f.world);
    const first = await f.nextWrite();
    first.resolve({ skipped: ["index.tsx:title"], remaining: first.edits, error: "disk is full" });
    await assert.rejects(saved, /disk is full/);
    const retried = await f.nextWrite();
    assert.deepEqual(retried.edits, first.edits);
    retried.resolve({ skipped: [], remaining: [] });
    await f.flushProjectEdits(f.world);
    assert.equal(f.getProjectSaveState(f.world).status, "saved");
  } finally { f.writer.dispose(); }
});

test("ambiguous transport failures remain unsaved and cannot blindly retry structural edits", async () => {
  const f = fixture();
  try {
    f.writer.push({ kind: "insert", source: "pending#clip", parent: "index.tsx:scene", tag: "rect", props: {} });
    const saved = f.flushProjectEdits(f.world);
    (await f.nextWrite()).reject(new Error("IPC disconnected"));
    await assert.rejects(saved, /IPC disconnected/);
    const state = f.getProjectSaveState(f.world);
    assert.equal(state.status, "failed");
    assert.ok(state.status === "failed" && !state.retryable);
    await assert.rejects(f.retryProjectEdits(f.world), /Save confirmation was lost/);
    assert.equal(f.calls.length, 1);
  } finally { f.writer.dispose(); }
});

test("confirmed failed edits survive restart with pending identities isolated from new clips", async () => {
  const f = fixture();
  f.writer.push({ kind: "insert", source: "pending#1", parent: "index.tsx:scene", tag: "rect", props: { x: 0 } });
  const saved = f.flushProjectEdits(f.world);
  const first = await f.nextWrite();
  f.writer.push({ kind: "prop", source: "pending#1", name: "x", value: 90 });
  first.resolve({ skipped: ["pending#1"], remaining: first.edits, error: "disk is full" });
  await assert.rejects(saved, /disk is full/);
  f.writer.dispose();
  assert.equal(f.storage.size, 1);
  const reopened = fixture(f.storage);
  try {
    const state = reopened.getProjectSaveState(reopened.world);
    assert.ok(state.status === "failed" && state.retryable);
    assert.equal(reopened.calls.length, 0);
    reopened.writer.push({ kind: "insert", source: "pending#1", parent: "index.tsx:scene", tag: "rect", props: { x: 200 } });
    const restored = reopened.retryProjectEdits(reopened.world);
    const retry = await reopened.nextWrite();
    const insert = retry.edits[0];
    const set = retry.edits[1];
    assert.ok(insert.kind === "insert" && set.kind === "set");
    assert.notEqual(insert.source, "pending#1");
    assert.equal(set.source, insert.source);
    assert.equal(set.props.x, 90);
    retry.resolve({ skipped: [], remaining: [], ids: { [insert.source]: "index.tsx:restored" } });
    const added = await reopened.nextWrite();
    assert.equal(added.edits.length, 1);
    assert.deepEqual(added.edits[0], { kind: "insert", source: "pending#1", parent: "index.tsx:scene", tag: "rect", props: { x: 200 } });
    added.resolve({ skipped: [], remaining: [], ids: { "pending#1": "index.tsx:new" } });
    await restored;
    assert.equal(reopened.storage.size, 0);
    assert.equal(reopened.getProjectSaveState(reopened.world).status, "saved");
  } finally { reopened.writer.dispose(); }
});

test("restart during an unconfirmed insert preserves its recovery copy and refuses unsafe replay", async () => {
  const f = fixture();
  f.writer.push({ kind: "insert", source: "pending#1", parent: "index.tsx:scene", tag: "rect", props: {} });
  const saving = f.flushProjectEdits(f.world);
  const write = await f.nextWrite();
  const crashedStorage = new Map(f.storage);
  write.reject(new Error("process stopped"));
  await assert.rejects(saving, /process stopped/);
  f.writer.dispose();
  const reopened = fixture(crashedStorage);
  try {
    const state = reopened.getProjectSaveState(reopened.world);
    assert.ok(state.status === "failed" && !state.retryable);
    await assert.rejects(reopened.retryProjectEdits(reopened.world), /unknown outcome/);
    const exported = reopened.getProjectRecovery(reopened.world);
    assert.ok(exported?.includes('"kind":"insert"'));
    assert.equal(reopened.calls.length, 0);
  } finally { reopened.writer.dispose(); }
});

test("a malformed recovery journal remains available for download and is never overwritten", () => {
  const original = '{"version":1,"edits":"damaged"}';
  const storage = new Map([["diffusion-studio:edit-recovery:project", original]]);
  const f = fixture(storage);
  try {
    const state = f.getProjectSaveState(f.world);
    assert.ok(state.status === "failed" && !state.retryable);
    assert.equal(f.getProjectRecovery(f.world), original);
    assert.equal(f.calls.length, 0);
  } finally { f.writer.dispose(); }
});

test("discarding recovery requires a settled save and clears only explicitly discarded work", async () => {
  const f = fixture();
  try {
    f.writer.push({ kind: "text", source: "index.tsx:title", value: "Unsaved title" });
    const saving = f.flushProjectEdits(f.world);
    const write = await f.nextWrite();
    assert.throws(() => f.discardProjectRecovery(f.world), /Wait for the current save/);
    assert.equal(f.storage.size, 1);
    write.reject(new Error("IPC disconnected"));
    await assert.rejects(saving, /IPC disconnected/);
    assert.equal(f.getProjectSaveState(f.world).status, "failed");
    f.discardProjectRecovery(f.world);
    assert.equal(f.storage.size, 0);
    assert.equal(f.getProjectRecovery(f.world), null);
    assert.equal(f.getProjectSaveState(f.world).status, "saved");
    await f.flushProjectEdits(f.world);
    assert.equal(f.calls.length, 1);
  } finally { f.writer.dispose(); }
});

test("reopening a project waits for outgoing inserts and their queued edits before handing over recovery", async () => {
  const f = fixture();
  f.writer.push({ kind: "insert", source: "pending#1", parent: "index.tsx:scene", tag: "rect", props: {} });
  const saving = f.flushProjectEdits(f.world);
  const interrupted = assert.rejects(saving, /project changed/);
  const first = await f.nextWrite();
  f.writer.push({ kind: "prop", source: "pending#1", name: "x", value: 30 });
  f.writer.dispose();
  assert.throws(() => f.createEditWriter("project", f.world), /previous project edits/);
  let ready = false;
  const drained = f.waitForProjectEdits("project").then(() => { ready = true; });
  first.resolve({ skipped: [], remaining: [], ids: { "pending#1": "index.tsx:clip" } });
  const second = await f.nextWrite();
  assert.equal(ready, false);
  assert.deepEqual(second.edits, [{ kind: "set", source: "index.tsx:clip", props: { x: 30 } }]);
  second.resolve({ skipped: [], remaining: [] });
  await Promise.all([interrupted, drained]);
  assert.equal(f.storage.size, 0);
  const replacement = f.createEditWriter("project", f.world);
  try {
    assert.equal(replacement.getState().status, "saved");
    replacement.push({ kind: "text", source: "index.tsx:title", value: "New edit after reopening" });
    const saved = replacement.settle();
    const write = await f.nextWrite();
    assert.match([...f.storage.values()][0], /New edit after reopening/);
    write.resolve({ skipped: [], remaining: [] });
    await saved;
    assert.equal(f.calls.length, 3, "a confirmed insert must not be replayed on reopening");
  } finally { replacement.dispose(); }
});

test("reopening after a failed outgoing save keeps its confirmed or ambiguous recovery outcome", async () => {
  for (const retryable of [true, false]) {
    const f = fixture();
    f.writer.push({ kind: "insert", source: "pending#1", parent: "index.tsx:scene", tag: "rect", props: {} });
    const saving = f.flushProjectEdits(f.world);
    const failed = assert.rejects(saving, /save failed/);
    const write = await f.nextWrite();
    f.writer.dispose();
    const drained = f.waitForProjectEdits("project");
    if (retryable) write.resolve({ skipped: ["pending#1"], remaining: write.edits, error: "save failed" });
    else write.reject(new Error("save failed"));
    await Promise.all([failed, drained]);
    const replacement = f.createEditWriter("project", f.world);
    try {
      const state = replacement.getState();
      assert.ok(state.status === "failed" && state.retryable === retryable);
      replacement.push({ kind: "insert", source: "pending#1", parent: "index.tsx:scene", tag: "text", props: {}, text: "New text" });
      assert.match(replacement.recovery()!, /New text/);
      assert.equal(f.calls.length, 1, "reopening must not automatically replay recovery");
      if (retryable) {
        const retry = replacement.retry();
        const retained = await f.nextWrite();
        assert.equal(retained.edits.length, 1);
        assert.ok(retained.edits[0].kind === "insert");
        assert.notEqual(retained.edits[0].source, "pending#1");
        retained.resolve({ skipped: [], remaining: [], ids: { [retained.edits[0].source]: "index.tsx:restored" } });
        const fresh = await f.nextWrite();
        assert.equal(fresh.edits.length, 1);
        assert.equal(fresh.edits[0].kind, "insert");
        fresh.resolve({ skipped: [], remaining: [], ids: { "pending#1": "index.tsx:new" } });
        await retry;
        assert.equal(f.storage.size, 0);
      } else {
        await assert.rejects(replacement.retry(), /unknown outcome/);
        assert.equal(f.calls.length, 1);
      }
    } finally { replacement.dispose(); }
  }
});
