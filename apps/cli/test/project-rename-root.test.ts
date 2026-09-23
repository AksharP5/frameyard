import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { build } from "esbuild";

import type { ProjectRecord } from "../../web/src/lib/db.ts";

const source = fileURLToPath(new URL("../../web/src/", import.meta.url));
const compiled = await build({
  stdin: { contents: "export { renameProject, resolveProject } from './projects/host';", resolveDir: source },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  plugins: [{
    name: "project-boundaries",
    setup(build) {
      build.onResolve({ filter: /^@\/lib\/db$/ }, () => ({ path: `${source}/lib/db.ts` }));
      build.onResolve({ filter: /^(solid-js|idb|nanoid|@desktop\/main-channels|@\/lib\/ipc)$/ }, ({ path }) => ({ path, external: true }));
    },
  }],
});

function fixture(registered = true) {
  const original: ProjectRecord = {
    id: "stable-project-id",
    dir: "/external/old",
    name: "old",
    displayName: "Old",
    entry: "index.tsx",
    modifiedAt: "modified",
    createdAt: "created",
    recordedAt: "recorded",
    lastOpenedAt: "opened",
    cover: null,
  };
  const renamed = { ...original, dir: "/external/renamed", name: "renamed", displayName: "Renamed" };
  const records = new Map<string, ProjectRecord>(registered ? [[original.dir, original]] : []);
  let failRename = false;

  const store = {
    get: async (dir: string) => records.get(dir),
    put: async (record: ProjectRecord) => { records.set(record.dir, record); },
    delete: async (dir: string) => { records.delete(dir); },
  };
  const database = {
    get: async (_store: string, dir: string) => records.get(dir),
    put: async (_store: string, record: ProjectRecord) => { records.set(record.dir, record); },
    getAllFromIndex: async () => [...records.values()],
    transaction: () => ({ store, done: Promise.resolve() }),
  };
  const dependencies: Record<string, unknown> = {
    idb: { openDB: async () => database },
    nanoid: { nanoid: () => "unused" },
    "solid-js": {
      createSignal: (initial: unknown) => {
        let current = initial;
        return [() => current, (value: unknown) => { current = value; }];
      },
    },
    "@desktop/main-channels": {
      MAIN_CHANNELS: {
        PROJECTS_RENAME: "rename",
        PROJECTS_RESOLVE: "resolve",
      },
    },
    "@/lib/ipc": {
      mainBridge: {
        async call(channel: string, input: { dir: string }) {
          if (channel === "rename") {
            assert.equal(input.dir, original.dir);
            if (failRename) throw new Error("Folder is locked");
            return renamed;
          }
          if (channel === "resolve") return input.dir === renamed.dir ? renamed : null;
          throw new Error(`Unexpected channel ${channel}`);
        },
      },
    },
  };

  function load() {
    const module = {
      exports: {} as Pick<typeof import("../../web/src/projects/host.ts"), "renameProject" | "resolveProject">,
    };
    runInThisContext(`(function(require,module,exports,window){${compiled.outputFiles[0]!.text}\n})`)(
      (name: string) => {
        assert.ok(name in dependencies, name);
        return dependencies[name];
      },
      module,
      module.exports,
      { desktop: {}, localStorage: { getItem: () => null, setItem: () => {} } },
    );
    return module.exports;
  }

  return {
    ...load(),
    load,
    records,
    original,
    renamed,
    failRename: () => { failRename = true; },
  };
}

test("renaming a remembered project moves its record and resolves the same project after reload", async () => {
  const f = fixture();
  assert.deepEqual(await f.renameProject(f.original.dir, "Renamed"), f.renamed);
  assert.equal(f.records.has(f.original.dir), false);
  assert.equal(f.records.get(f.renamed.dir)?.id, f.original.id);
  assert.equal(f.records.get(f.renamed.dir)?.recordedAt, f.original.recordedAt);
  assert.deepEqual(await f.load().resolveProject(f.renamed.id), f.renamed);
  assert.equal(f.records.size, 1);
});

test("renaming an unregistered project records its new folder", async () => {
  const f = fixture(false);
  await f.renameProject(f.original.dir, "Renamed");
  assert.equal(f.records.size, 1);
  assert.equal(f.records.get(f.renamed.dir)?.id, f.renamed.id);
});

test("a rejected filesystem rename leaves the project record unchanged", async () => {
  const f = fixture();
  f.failRename();
  await assert.rejects(f.renameProject(f.original.dir, "Renamed"), /Folder is locked/);
  assert.deepEqual(f.records.get(f.original.dir), f.original);
  assert.equal(f.records.has(f.renamed.dir), false);
});

test("renaming onto a stale destination replaces that record without duplicating the project", async () => {
  const f = fixture();
  f.records.set(f.renamed.dir, { ...f.renamed, id: "stale-project-id" });
  await f.renameProject(f.original.dir, "Renamed");
  assert.equal(f.records.size, 1);
  assert.equal(f.records.get(f.renamed.dir)?.id, f.original.id);
});
