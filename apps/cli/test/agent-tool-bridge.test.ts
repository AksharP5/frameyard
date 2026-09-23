import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { build } from "esbuild";
import type { CodexOptions, CodexToolResult } from "../../desktop/src/codex-contracts";

test("CLI and Codex calls share tool validation, editor replies, and forced project scope", async () => {
  const directory = new URL("../../desktop/src/", import.meta.url).pathname;
  const stubs = {
    "electron": `export const dialog = { async showSaveDialog(){ return {canceled:true}; } };`,
    "./main-manager": `export const handlers = new Map(); export const events = []; export const mainBridge = { handle(name,fn){handlers.set(name,fn)}, emit(window,name,data){events.push({name,data})} };`,
    "./codex": `export let options; export class CodexService { constructor(value){options=value} request(){} withProjectMutation(dir,operation){return operation(dir)} withProjectIdle(dir,operation){return operation(dir)} }`,
    "./agent-assets": `export async function importAsset(input){return input} export async function searchAssets(input){return input} export async function importGeneratedAsset(input){return input}`,
    "./hyperframes-catalog": `export async function handleCatalogRequest(input,catalog){return {...input,catalog}}`,
    "./projects": `export function unwatchProject(){} export function watchProject(){}`,
    "./manim": `export async function handleManimRequest(input){return input}`,
    "./animations": `export async function handleAnimationRequest(input){return input}`,
  };
  const bundle = await build({
    stdin: { contents: `export {registerAgentBridge} from './agent-bridge'; export {handlers,events} from './main-manager'; export {options} from './codex';`, resolveDir: directory },
    bundle: true, platform: "node", format: "esm", write: false,
    plugins: [{ name: "tool-boundary", setup(builder) {
      builder.onResolve({ filter: /^(electron|\.\/(main-manager|codex|agent-assets|hyperframes-catalog|manim|animations|projects))$/ }, ({ path }) => ({ path, namespace: "tool-boundary" }));
      builder.onLoad({ filter: /.*/, namespace: "tool-boundary" }, ({ path }) => ({ contents: stubs[path as keyof typeof stubs], loader: "js" }));
    } }],
  });
  const moduleSource = bundle.outputFiles[0].text + "\n//# sourceURL=diffusion-agent-tool-test.mjs";
  const app = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`) as {
    registerAgentBridge: typeof import("../../desktop/src/agent-bridge").registerAgentBridge;
    handlers: Map<string, (input: unknown) => Promise<CodexToolResult>>;
    events: { name: string; data: { id: string; dir: string; name: string; args: unknown } }[];
    options: CodexOptions;
  };
  // A preview iframe can still be loading while the editor is ready for tools.
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: Object.assign(new EventEmitter(), { isLoading: () => true, isLoadingMainFrame: () => false }) });
  app.registerAgentBridge("/unused", () => window as ReturnType<Parameters<typeof app.registerAgentBridge>[1]>);
  const call = app.handlers.get("agent:tool-call")!;
  const dir = "/project/open";
  const args = { url: "https://example.com/logo.png", title: "Logo", dir: "/project/other" };
  const imported = await call({ dir, name: "asset_import", args });
  assert.deepEqual(imported, await app.options.runTool(dir, "asset_import", args));
  assert.equal(imported.contentItems[0].type, "inputText");
  if (imported.contentItems[0].type !== "inputText") return;
  assert.equal(JSON.parse(imported.contentItems[0].text).dir, dir);
  const catalog = await call({ dir, name: "hyperframes_catalog", args: { action: "install", type: "block", name: "data-chart", dir: "/project/other" } });
  if (catalog.contentItems[0].type !== "inputText") return;
  assert.equal(JSON.parse(catalog.contentItems[0].text).dir, dir);
  const hyfrme = await call({ dir, name: "hyfrme_catalog", args: { action: "install", type: "block", name: "soft-blur-in", dir: "/project/other" } });
  if (hyfrme.contentItems[0].type !== "inputText") return;
  assert.deepEqual(JSON.parse(hyfrme.contentItems[0].text), { action: "install", type: "block", name: "soft-blur-in", dir, catalog: "hyfrme" });
  const manim = await call({ dir, name: "manim_animations", args: { action: "render", id: "diagram", dir: "/project/other" } });
  assert.equal(manim.contentItems[0].type, "inputText");
  if (manim.contentItems[0].type !== "inputText") return;
  assert.deepEqual(JSON.parse(manim.contentItems[0].text), { action: "render", id: "diagram", dir });
  const animation = await call({ dir, name: "project_animations", args: { action: "export", id: "title", output: "exports/title.mp4", dir: "/project/other" } });
  assert.equal(animation.contentItems[0].type, "inputText");
  if (animation.contentItems[0].type !== "inputText") return;
  assert.deepEqual(JSON.parse(animation.contentItems[0].text), { action: "export", id: "title", output: "exports/title.mp4", dir });
  await assert.rejects(call({ dir, name: "project_animations", args: { action: "delete", id: "title" } }));
  await assert.rejects(call({ dir, name: "unknown_tool", args: {} }));
  await assert.rejects(call({ dir, name: "editor_update", args: { id: "title", props: { opacity: 2 } } }));

  const pending = call({ dir, name: "editor_update", args: { id: "title", text: "Updated" } });
  const request = app.events.at(-1)!;
  assert.equal(request.name, "editor:tool");
  assert.equal(request.data.dir, dir);
  assert.deepEqual(request.data.args, { id: "title", text: "Updated" });
  const result: CodexToolResult = { success: true, contentItems: [{ type: "inputText", text: "saved" }] };
  await app.handlers.get("editor:tool-result")!({ id: request.data.id, result });
  assert.deepEqual(await pending, result);
});

test("agent tools cancel before delayed mutations and forward cancellation into animation operations", async () => {
  const stubs: Record<string, string> = {
    "electron": `export const dialog = {};`,
    "./main-manager": `export const mainBridge = { handle(){}, emit(){throw new Error('Unexpected editor mutation')} };`,
    "./codex": `export let beforeMutation = async () => {}; export function setBeforeMutation(fn){beforeMutation=fn} export class CodexService { constructor(){} async withProjectMutation(dir,operation){await beforeMutation(); return operation(dir)} }`,
    "./agent-assets": `export async function importAsset(){throw new Error('Unexpected asset mutation')} export function searchAssets(){} export function importGeneratedAsset(){}`,
    "./projects": `export function unwatchProject(){} export function watchProject(){}`,
    "./hyperframes-templates": `export function installWebsiteTemplate(){} export function templatePackageUrl(){} export const templateRepository = ''; export const templateRevision = ''; export const websiteTemplates = [];`,
    "../../cli/src/animation": `
      export const calls = [];
      function waitForAbort(action, signal) {
        calls.push({action,signal});
        signal.throwIfAborted();
        return new Promise((resolve,reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true}));
      }
      export function renderAnimation(id, dir, engine, signal){return waitForAbort(engine ?? 'render', signal)}
      export function convertAnimation(id, dir, options){return waitForAbort('editable', options.signal)}
      export function exportAnimation(id, dir, output, options){return waitForAbort('export', options.signal)}
      export function cancelAnimation(){} export function listAnimations(){return []}
    `,
  };
  const bundle = await build({
    stdin: {
      contents: `export {registerAgentBridge} from './agent-bridge'; export {setBeforeMutation} from './codex'; export {calls} from '../../cli/src/animation';`,
      resolveDir: new URL("../../desktop/src/", import.meta.url).pathname,
    },
    bundle: true, platform: "node", format: "esm", write: false,
    plugins: [{ name: "cancellation-boundary", setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path }) => path in stubs ? { path, namespace: "cancellation-boundary" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "cancellation-boundary" }, ({ path }) => ({ contents: stubs[path], loader: "js" }));
    } }],
  });
  const moduleSource = bundle.outputFiles[0].text + "\n//# sourceURL=diffusion-agent-tool-cancellation-test.mjs";
  const app = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`) as {
    registerAgentBridge: typeof import("../../desktop/src/agent-bridge").registerAgentBridge;
    setBeforeMutation: (callback: () => Promise<void>) => void;
    calls: { action: string; signal: AbortSignal }[];
  };
  const { runTool } = app.registerAgentBridge("/unused", () => null);
  const cancelled = new Error("Caller cancelled");
  for (const name of ["project_animations", "asset_import", "editor_update"]) {
    const controller = new AbortController();
    const gate = Promise.withResolvers<void>();
    app.setBeforeMutation(() => gate.promise);
    const pending = runTool("/project", name, { action: "render", id: "title" }, controller.signal);
    controller.abort(cancelled);
    gate.resolve();
    await assert.rejects(pending, (error) => error === cancelled);
  }
  assert.equal(app.calls.length, 0);
  app.setBeforeMutation(async () => {});
  for (const [name, action, expected] of [
    ["project_animations", "render", "render"],
    ["project_animations", "editable", "editable"],
    ["project_animations", "export", "export"],
    ["manim_animations", "render", "manim"],
    ["hyperframes_catalog", "render", "hyperframes"],
    ["hyfrme_catalog", "render", "hyperframes"],
  ]) {
    const controller = new AbortController();
    const pending = runTool("/project", name, { action, id: "title", output: "exports/title.mp4" }, controller.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(app.calls.at(-1), { action: expected, signal: controller.signal });
    controller.abort(cancelled);
    await assert.rejects(pending, (error) => error === cancelled);
  }
});
