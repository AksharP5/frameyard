import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const solid: typeof import("solid-js") = require(require.resolve("solid-js").replace("server.cjs", "solid.cjs"));
const built = await build({
  stdin: {
    contents: "export * from './bridge'; export * from './session';",
    resolveDir: fileURLToPath(new URL("../../web/src/dapi", import.meta.url)),
  },
  bundle: true, write: false, platform: "node", format: "cjs", external: ["solid-js"],
});

function fixture() {
  const listeners = new Map<string, (payload: unknown) => void>();
  const replies: unknown[] = [];
  const module = { exports: {} as typeof import("../../web/src/dapi/bridge") & typeof import("../../web/src/dapi/session") };
  runInNewContext(`(function(require,module,exports){${built.outputFiles[0].text}\n})`, {
    window: { desktop: {
      on: (name: string, handler: (payload: unknown) => void) => listeners.set(name, handler),
      send: (_name: string, reply: unknown) => replies.push(reply),
    } },
    AbortController, setTimeout, clearTimeout,
  })((name: string) => name === "solid-js" ? solid : require(name), module, module.exports);
  return { ...module.exports, listeners, replies };
}

test("canceled bootstrap tools never execute after handlers register", async () => {
  const { toolBridge, listeners, replies } = fixture();
  listeners.get("dapi:call")!({ id: "canceled", tool: "context", args: {} });
  listeners.get("dapi:cancel")!({ id: "canceled" });
  listeners.get("dapi:call")!({ id: "live", tool: "context", args: {} });
  let runs = 0;
  const handlers = { context: async () => { runs++; return "ready"; } };
  const unregister = toolBridge.register(handlers as Parameters<typeof toolBridge.register>[0], () => ({} as ReturnType<Parameters<typeof toolBridge.register>[1]>));
  await setImmediate();
  assert.equal(runs, 1);
  assert.equal(JSON.stringify(replies), JSON.stringify([{ id: "live", ok: true, data: "ready" }]));
  unregister();
});

test("project readiness waits for the requested fresh frame and cleans up cancellation", async () => {
  const api = fixture();
  const [frame, setFrame] = solid.createSignal(10);
  const session = { world: {}, project: { dir: () => "/requested" }, engine: { frame } } as Parameters<typeof api.setEditorSession>[0];
  assert.ok(session && typeof session !== "function");
  api.setEditorSession(session);
  const controller = new AbortController();
  const canceled = api.waitForEditorSession("/requested", controller.signal);
  controller.abort();
  await assert.rejects(canceled, { code: "canceled" });
  await assert.rejects(api.waitForEditorSession("/requested", controller.signal));

  let settled = false;
  const pending = api.waitForEditorSession("/requested").then(value => { settled = true; return value; });
  api.setEditorLoadState({ world: session.world, status: "ready", mountedFrame: 10 });
  await Promise.resolve();
  assert.equal(settled, false);
  setFrame(11);
  assert.equal(await pending, session);

  api.setEditorLoadState({ world: session.world, status: "error", error: "Cannot compile scene.tsx" });
  await assert.rejects(api.waitForEditorSession("/requested"), /Cannot compile scene.tsx/);
});
