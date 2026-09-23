import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { runInThisContext } from "node:vm";
import { buildSync } from "esbuild";
import type { CodexEvent, CodexOptions } from "../../desktop/src/codex-contracts.ts";

const source = fileURLToPath(new URL("../../desktop/src/codex.ts", import.meta.url));
const code = buildSync({ entryPoints: [source], bundle: true, platform: "node", format: "cjs", write: false }).outputFiles[0].text;
const module = { exports: {} as typeof import("../../desktop/src/codex.ts") };
runInThisContext(`(function(require,module,exports){${code}\n})`)(createRequire(import.meta.url), module, module.exports);
const { CodexService } = module.exports;

async function fixture(t: TestContext, overrides: Partial<CodexOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "diffusion codex "));
  const binary = join(dir, "fake-codex");
  const calls = join(dir, "calls.jsonl");
  const settings = join(dir, "native-settings.json");
  const config = join(dir, "native-config.json");
  await writeFile(config, JSON.stringify({ model: "configured-model", model_reasoning_effort: "xhigh", mcp_servers: { personal: {} } }));
  await writeFile(binary, `#!/usr/bin/env node
const {createInterface}=require('node:readline');
const {appendFileSync,existsSync,readFileSync,writeFileSync}=require('node:fs');
const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
const settingsPath=${JSON.stringify(settings)};
process.on('exit',()=>appendFileSync(${JSON.stringify(calls)},JSON.stringify({method:'process/exit',params:{}})+'\\n'));
const thread={id:'thread-1',cwd:${JSON.stringify(dir)},preview:'Original question',updatedAt:100,source:'cli',...(existsSync(settingsPath)?JSON.parse(readFileSync(settingsPath,'utf8')):{model:'configured-model',reasoningEffort:'high'}),turns:[{id:'old-turn',items:[{id:'u1',type:'userMessage',content:[{type:'text',text:'Original question'},{type:'text',text:'<diffusion_editor_context>private context'}]},{id:'a1',type:'agentMessage',text:'Original reply'}]}]};
const historyPath=settingsPath+'.turns';
if(existsSync(historyPath))thread.turns=JSON.parse(readFileSync(historyPath,'utf8'));
let requestId=100; let active; let ready=false; let interruptAttempts=0;
const notify=(method,params)=>send({method,params:{threadId:thread.id,turnId:'turn-1',...params}});
const complete=(status='completed')=>{thread.turns.at(-1).status=status;writeFileSync(historyPath,JSON.stringify(thread.turns));notify('turn/completed',{turn:{id:'turn-1',status}});};
createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line); const {id,method,params}=message;
 if(!method){appendFileSync(${JSON.stringify(calls)},JSON.stringify({method:'client/reply',params:message})+'\\n');if(active==='question')complete();if(active==='approval')complete();if(active==='tool'){thread.turns.at(-1).items.push({id:'a2',type:'agentMessage',text:message.result.contentItems[0].text});notify('item/agentMessage/delta',{itemId:'a2',delta:message.result.contentItems[0].text});complete();}return;}
 appendFileSync(${JSON.stringify(calls)},JSON.stringify({method,params})+'\\n');
 if(id===undefined)return;
 let result={};
 if(method==='account/read')result={account:{type:'chatgpt',email:'must-not-leak@example.test',planType:'pro'},requiresOpenaiAuth:true};
 if(method==='model/list')result={data:[{id:'picker-configured',model:'configured-model',displayName:'Configured model',isDefault:true,defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high',description:'Deep reasoning'},{reasoningEffort:'xhigh',description:'More reasoning'}]},{id:'picker-fast',model:'fast-model',displayName:'Fast model',isDefault:false,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low',description:'Fast responses'},{reasoningEffort:'medium',description:'Balanced responses'}]}],nextCursor:null};
 if(method==='skills/list')result={data:[{cwd:thread.cwd,errors:[],skills:[{name:'edit-video',path:'/skills/edit-video/SKILL.md',description:'Edit video',enabled:true}]}]};
 if(method==='config/read')result={config:JSON.parse(readFileSync(${JSON.stringify(config)},'utf8'))};
 if(method==='thread/read'||method==='thread/resume'){
  if(params.threadId==='missing'){send({id,error:{message:'Stored conversation is unavailable'}});return;}
  if(existsSync(historyPath))thread.turns=JSON.parse(readFileSync(historyPath,'utf8'));
  result={thread};
 }
 if(method==='thread/start')result={thread};
 if(method==='thread/list')result={data:[thread],nextCursor:null};
 if(method==='turn/steer'){if(params.expectedTurnId!=='turn-1'){send({id,error:{message:'Turn changed'}});return;} send({id,result:{turnId:'turn-1'}});notify('item/agentMessage/delta',{itemId:'steered',delta:params.input[0].text});return;}
 if(method==='turn/interrupt'){
  if(!ready){send({id,error:{message:'no active turn to interrupt'}});return;}
  if(active==='finish-during-interrupt'){complete();send({id,error:{message:'no active turn to interrupt'}});return;}
  if(active==='interrupt-error'&&interruptAttempts++===0){send({id,error:{message:'Interrupt transport rejected'}});return;}
  send({id,result});complete('interrupted');return;
 }
 if(method==='turn/start'){
  if(params.model)thread.model=params.model;
  if(params.effort)thread.reasoningEffort=params.effort;
  writeFileSync(settingsPath,JSON.stringify({model:thread.model,reasoningEffort:thread.reasoningEffort}));
  active=params.input[0].text;
  thread.turns.push({id:'turn-1',status:'inProgress',items:[{id:'u2',type:'userMessage',content:params.input}]});
  writeFileSync(historyPath,JSON.stringify(thread.turns));
  send({id,result:{turn:{id:'turn-1'}}});
  if(active==='delayed-start'||active==='complete-before-start'){
   const waiting=setInterval(()=>{if(!existsSync(settingsPath+'.activate'))return;clearInterval(waiting);if(active==='complete-before-start'){complete();return;}ready=true;notify('turn/started',{turn:{id:'turn-1',status:'inProgress'}});},5);
   return;
  }
  ready=true;notify('turn/started',{turn:{id:'turn-1',status:'inProgress'}});
  if(active==='interrupt-error'||active==='finish-during-interrupt')return;
  if(active==='hold')return;
  if(active==='question'){send({id:requestId++,method:'item/tool/requestUserInput',params:{threadId:thread.id,turnId:'turn-1',itemId:'ask',questions:[{id:'color',header:'Color',question:'Which color?',isOther:true,isSecret:false,options:[{label:'Blue',description:'Blue title'}]}]}});return;}
  if(active==='exit'){process.exit(7);return;}
  if(active==='approval'){send({id:requestId++,method:'item/commandExecution/requestApproval',params:{threadId:thread.id,turnId:'turn-1',itemId:'cmd',command:'safe command',reason:'Needs permission'}});return;}
  if(active==='tool'){send({id:requestId++,method:'item/tool/call',params:{threadId:thread.id,turnId:'turn-1',callId:'call',namespace:null,tool:'editor_context',arguments:{}}});return;}
  if(active==='image'){notify('item/completed',{item:{id:'img',type:'imageGeneration',result:'base64',revisedPrompt:'test',failure:null}});complete();return;}
  complete();return;
 }
 send({id,result});
});
`);
  await chmod(binary, 0o700);
  const events: CodexEvent[] = [];
  let listener: ((event: CodexEvent) => void) | undefined;
  const options: CodexOptions = {
    dataDir: dir, binary,
    runTool: async () => ({ contentItems: [{ type: "inputText", text: "live context" }], success: true }),
    ...overrides,
    onEvent: (event) => { events.push(event); listener?.(event); },
  };
  const service = new CodexService(options);
  t.after(() => { service.dispose(); });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const until = (predicate: (event: CodexEvent) => boolean) => new Promise<CodexEvent>((resolve, reject) => {
    const existing = events.find(predicate);
    if (existing) { resolve(existing); return; }
    const timeout = setTimeout(() => reject(new Error("Missing expected Codex event")), 3000);
    listener = (event) => { if (predicate(event)) { clearTimeout(timeout); listener = undefined; resolve(event); } };
  });
  return { dir, calls, settings, config, service, options, events, until };
}

test("new and resumed sessions inherit Codex config while editor guidance stays in turn context", async (t) => {
  const f = await fixture(t);
  const configured = {
    approval_policy: "never", default_permissions: ":danger-full-access",
    developer_instructions: "Use my normal coding conventions.",
    features: { plugins: true, hooks: true, code_mode: true },
    mcp_servers: { "personal.tools": { enabled: true } },
  };
  await writeFile(f.config, JSON.stringify(configured));
  await f.service.request({ method: "send", input: { dir: f.dir, text: "First request", context: { currentTime: 2 } } });
  await f.until((event) => event.type === "turn" && event.status === "completed");
  await f.service.request({ method: "release", input: { dir: f.dir } });
  // Reload current config on resume, including clearing old Studio developer instructions.
  await writeFile(f.config, JSON.stringify({ ...configured, approval_policy: "on-request", developer_instructions: null }));
  const nextEvent = f.events.length;
  await f.service.request({ method: "send", input: { dir: f.dir, text: "Continue", context: { currentTime: 4 } } });
  await f.until((event) => f.events.indexOf(event) >= nextEvent && event.type === "turn" && event.status === "completed");
  const calls = (await readFile(f.calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
  const started = calls.find(({ method }) => method === "thread/start")!.params;
  const resumed = calls.find(({ method }) => method === "thread/resume")!.params;
  const { dynamicTools, ...startSettings } = started;
  assert.ok(Array.isArray(dynamicTools) && dynamicTools.some((tool) => tool.name === "editor_context"));
  assert.deepEqual(startSettings, { cwd: f.dir, approvalPolicy: "never", developerInstructions: configured.developer_instructions, serviceName: "diffusion_studio", threadSource: "diffusion_studio" });
  assert.deepEqual(resumed, { threadId: "thread-1", cwd: f.dir, approvalPolicy: "on-request", developerInstructions: "" });
  const turn = calls.find(({ method }) => method === "turn/start")!.params;
  assert.ok(Array.isArray(turn.input));
  assert.match(turn.input[1].text, /<diffusion_editor_guidance>/);
  assert.deepEqual(JSON.parse(turn.input[1].text.split("\n")[1]), { currentTime: 2 });
});

test("uses local account, live editor tools, and persistent history without replacing failed resumes", async (t) => {
  const f = await fixture(t);
  const status = await f.service.request({ method: "status", input: {} });
  assert.ok(!JSON.stringify(status).includes("must-not-leak"));
  assert.ok(status.method === "status");
  assert.deepEqual(status.result.defaults, { model: "configured-model", reasoningEffort: "xhigh" });
  assert.equal(status.result.models[1].id, "picker-fast");
  assert.equal(status.result.models[1].model, "fast-model");
  assert.deepEqual(status.result.models[1].supportedReasoningEfforts.map((option) => option.reasoningEffort), ["low", "medium"]);
  await f.service.request({ method: "send", input: { dir: f.dir, text: "tool", context: { selected: ["title"] } } });
  await f.until((event) => event.type === "turn" && event.status === "completed");
  assert.ok(f.events.some((event) => event.type === "delta" && event.text === "live context" && event.dir === f.dir));
  f.service.dispose();
  const resumed = new CodexService(f.options);
  t.after(() => resumed.dispose());
  const loaded = await resumed.request({ method: "load", input: { dir: f.dir } });
  assert.equal(loaded.method, "load");
  if (loaded.method !== "load") throw new Error("Wrong response");
  assert.deepEqual(loaded.result?.messages.map(({ text }) => text), ["Original question", "Original reply", "tool", "live context"]);
  assert.equal(loaded.result?.activeTurn, false);
  assert.deepEqual(loaded.result?.settings, { model: "configured-model", reasoningEffort: "high" });
  await assert.rejects(resumed.request({ method: "load", input: { dir: f.dir, threadId: "missing" } }), /Stored conversation is unavailable/);
  const stillSaved = await resumed.request({ method: "load", input: { dir: f.dir } });
  assert.deepEqual(stillSaved, loaded, "a failed history lookup preserves the saved conversation and its new messages");
  const calls = (await readFile(f.calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
  assert.equal(calls.filter(({ method }) => method === "thread/start").length, 1);
  const turn = calls.find(({ method }) => method === "turn/start");
  assert.ok(turn);
  assert.equal("model" in turn.params, false);
  assert.equal("effort" in turn.params, false);
});

test("model and reasoning selections use native identifiers, validate compatibility, and survive resume", async (t) => {
  const f = await fixture(t);
  const message = { dir: f.dir, text: "Use the faster model", context: {} };
  await assert.rejects(f.service.request({ method: "send", input: { ...message, model: "fast-model", reasoningEffort: "xhigh" } }), /does not support xhigh reasoning/);
  await assert.rejects(f.service.request({ method: "send", input: { ...message, model: "picker-fast" } }), /not available/);
  await f.service.request({ method: "send", input: { ...message, model: "fast-model", reasoningEffort: "medium" } });
  await f.until((event) => event.type === "turn" && event.status === "completed");
  f.service.dispose();
  const resumed = new CodexService(f.options);
  t.after(() => resumed.dispose());
  const loaded = await resumed.request({ method: "load", input: { dir: f.dir } });
  assert.ok(loaded.method === "load");
  assert.deepEqual(loaded.result?.settings, { model: "fast-model", reasoningEffort: "medium" });
  const nextEvent = f.events.length;
  await resumed.request({ method: "send", input: { ...message, text: "Keep these settings" } });
  await f.until((event) => f.events.indexOf(event) >= nextEvent && event.type === "turn" && event.status === "completed");
  const calls = (await readFile(f.calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
  const turns = calls.filter(({ method }) => method === "turn/start");
  assert.equal(turns.length, 2);
  assert.equal(turns[0].params.model, "fast-model");
  assert.equal(turns[0].params.effort, "medium");
  assert.equal("model" in turns[1].params, false);
  assert.equal("effort" in turns[1].params, false);
});

test("switching models without a reasoning override uses the new model's supported default", async (t) => {
  const f = await fixture(t);
  await f.service.request({ method: "send", input: { dir: f.dir, text: "Change model", context: {}, model: "fast-model" } });
  await f.until((event) => event.type === "turn" && event.status === "completed");
  const loaded = await f.service.request({ method: "load", input: { dir: f.dir } });
  assert.ok(loaded.method === "load");
  assert.deepEqual(loaded.result?.settings, { model: "fast-model", reasoningEffort: "low" });
});

test("terminal handoff releases the native writer and reads outside changes before resuming", async (t) => {
  const f = await fixture(t);
  await f.service.request({ method: "send", input: { dir: f.dir, text: "Keep this thread", context: {}, model: "fast-model", reasoningEffort: "medium" } });
  await f.until((event) => event.type === "turn" && event.status === "completed");
  const release = await f.service.request({ method: "release", input: { dir: f.dir } });
  assert.ok(release.method === "release");
  assert.match(release.result.command, /--model=fast-model/);
  assert.match(release.result.command, /model_reasoning_effort="medium"/);
  assert.ok((await readFile(f.calls, "utf8")).includes('"method":"process/exit"'));
  await writeFile(f.settings, JSON.stringify({ model: "configured-model", reasoningEffort: "xhigh" }));
  const viewed = await f.service.request({ method: "load", input: { dir: f.dir } });
  assert.ok(viewed.method === "load");
  assert.deepEqual(viewed.result?.settings, { model: "configured-model", reasoningEffort: "xhigh" });
  assert.ok(!(await readFile(f.calls, "utf8")).includes('"method":"thread/resume"'));
  const nextEvent = f.events.length;
  const sent = await f.service.request({ method: "send", input: { dir: f.dir, text: "Continue inside the editor", context: {} } });
  assert.ok(sent.method === "send");
  assert.equal(sent.result.threadId, viewed.result?.session.id);
  await f.until((event) => f.events.indexOf(event) >= nextEvent && event.type === "turn" && event.status === "completed");
  assert.ok((await readFile(f.calls, "utf8")).includes('"method":"thread/resume"'));
});

test("resume commands keep paths, model settings, and option-like IDs as literal shell arguments", async (t) => {
  const f = await fixture(t);
  const id = "--name='$(printf injected)'";
  const model = "--model='$(printf injected)'\nnext";
  const effort = "high'; printf injected; '";
  await writeFile(f.settings, JSON.stringify({ id, model, reasoningEffort: effort }));
  await f.service.request({ method: "new", input: { dir: f.dir } });
  const result = await f.service.request({ method: "release", input: { dir: f.dir } });
  assert.ok(result.method === "release");
  const tokens = execFileSync("bash", ["-c", `codex() { printf '%s\\0' "$@"; }\n${result.result.command}`], { encoding: "utf8" }).split("\0").slice(0, -1);
  assert.deepEqual(tokens, ["resume", `--cd=${f.dir}`, `--model=${model}`, "-c", `model_reasoning_effort=${JSON.stringify(effort)}`, "--", id]);
});

test("reopening a working conversation restores its pending approval until the UI answers", async (t) => {
  const f = await fixture(t);
  await f.service.request({ method: "send", input: { dir: f.dir, text: "approval", context: {} } });
  const approval = await f.until((event) => event.type === "approval");
  await assert.rejects(f.service.request({ method: "release", input: { dir: f.dir } }), /already working/);
  assert.equal(f.events.some((event) => event.type === "turn" && event.status === "completed"), false);
  const reopened = await f.service.request({ method: "load", input: { dir: f.dir } });
  assert.ok(reopened.method === "load" && reopened.result?.activeTurn);
  const pending = reopened.result.pendingApproval;
  assert.ok(pending);
  assert.deepEqual(pending, approval);
  if (approval.type !== "approval") throw new Error("Expected approval");
  await f.service.request({ method: "approve", input: { requestId: pending.requestId, decision: "accept" } });
  await f.until((event) => event.type === "turn" && event.status === "completed");
  const completed = await f.service.request({ method: "load", input: { dir: f.dir } });
  assert.ok(completed.method === "load" && !completed.result?.activeTurn);
  assert.equal(completed.result?.pendingApproval, undefined);
  await assert.rejects(f.service.request({ method: "approve", input: { requestId: approval.requestId, decision: "accept" } }), /no longer pending/);
});

test("sends the frozen area, time range and catalog references independently of the current playhead", async (t) => {
  const toolCalls: string[] = [];
  const f = await fixture(t, { runTool: async (_dir, name) => {
    toolCalls.push(name);
    return { contentItems: [], success: true };
  } });
  const catalogReferences = [{ catalog: "hyperframes", item: {
    name: "code-typing", type: "block", title: "Code Typing", description: "Animated code reveal", tags: ["code"],
    files: [{ path: "blocks/code-typing/index.html", target: "index.html", type: "file" }],
    dimensions: { width: 1920, height: 1080 }, duration: 6,
    variables: { code: { type: "string", default: "console.log('Hello')" } },
    preview: { video: "https://static.heygen.ai/code-typing.mp4" },
  } }];
  const annotation = {
    sceneId: "original-scene", sceneName: "Original", time: 2, frame: 60,
    sceneSize: { width: 1920, height: 1080 },
    region: { x: 0.25, y: 0.5, width: 0.5, height: 0.25 }, note: "Zoom here",
    imageUrl: "data:image/png;base64,aGVsbG8=",
  };
  const timeRange = { sceneId: annotation.sceneId, sceneName: annotation.sceneName, start: 1, end: 3, frameRate: 30 };
  await assert.rejects(f.service.request({ method: "send", input: { dir: f.dir, text: "Zoom here", context: {}, annotation, timeRange: { ...timeRange, sceneId: "other-scene" } } }), /same scene/);
  await f.service.request({ method: "send", input: { dir: f.dir, text: "Zoom here", context: { currentTime: 9, catalogReferences }, annotation, timeRange } });
  await f.until((event) => event.type === "turn" && event.status === "completed");
  const calls = (await readFile(f.calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method: string; params: { input?: { type: string; text?: string; url?: string }[] } });
  const input = calls.find((call) => call.method === "turn/start")?.params.input;
  assert.ok(input);
  assert.deepEqual(input[2], { type: "image", url: annotation.imageUrl });
  const context = JSON.parse(input[1].text!.split("\n")[1]);
  const { imageUrl: _image, ...metadata } = annotation;
  assert.deepEqual(context, { currentTime: 9, catalogReferences, annotation: metadata, timeRange });
  assert.ok(!input[1].text!.includes(annotation.imageUrl));
  assert.deepEqual(toolCalls, []);
});

test("passes an insertion range beyond the scene end without clipping the range or template duration", async (t) => {
  const f = await fixture(t);
  const timeRange = { sceneId: "demo", sceneName: "Area notes", start: 16.4, end: 520 / 30, frameRate: 30 };
  const context = {
    currentTime: 0,
    sceneTiming: { sceneId: "demo", duration: 6, frameRate: 30 },
    catalogReferences: [{ catalog: "hyperframes", item: { name: "chatgpt-exchange", type: "template", duration: 14.9 } }],
  };
  await f.service.request({ method: "send", input: { dir: f.dir, text: "Make this exchange about Radio Atlas", context, timeRange } });
  await f.until((event) => event.type === "turn" && event.status === "completed");
  const calls = (await readFile(f.calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method: string; params: { input?: { text: string }[] } });
  const input = calls.find((call) => call.method === "turn/start")?.params.input;
  assert.ok(input);
  assert.deepEqual(JSON.parse(input[1].text.split("\n")[1]), { ...context, timeRange });
});

test("waits for generated imports and reports import or subprocess failure", async (t) => {
  let rejectImport: ((error: Error) => void) | undefined;
  const started = Promise.withResolvers<void>();
  const f = await fixture(t, { importGenerated: () => new Promise((_resolve, reject) => {
    rejectImport = reject;
    started.resolve();
  }) });
  await f.service.request({ method: "send", input: { dir: f.dir, text: "image", context: {} } });
  await started.promise;
  assert.ok(rejectImport);
  assert.equal(f.events.some((event) => event.type === "turn" && event.status !== "started"), false);
  rejectImport(new Error("Cannot save generated image"));
  const failed = await f.until((event) => event.type === "turn" && event.status === "failed");
  assert.ok(failed.type === "turn" && failed.error === "Cannot save generated image");
  await f.service.request({ method: "send", input: { dir: f.dir, text: "exit", context: {} } });
  const exited = await f.until((event) => event.type === "turn" && event.error?.includes("exited with code 7") === true);
  assert.ok(exited.type === "turn" && exited.status === "failed");
});

test("sends video frames as timestamped native images and rejects paths outside saved video context", async (t) => {
  const f = await fixture(t);
  const { mkdir } = await import("node:fs/promises");
  const folder = join(f.dir, ".diffusion", "video-context", "snapshot");
  await mkdir(folder, { recursive: true });
  const path = join(folder, "frame.png");
  await writeFile(path, Buffer.from("iVBORw0KGgo=", "base64"));
  const frame = { sceneId: "demo", time: 2.5, path };
  const outside = join(f.dir, "outside.png");
  await writeFile(outside, "image");
  await assert.rejects(f.service.request({ method: "send", input: { dir: f.dir, text: "Inspect video", context: {}, videoFrames: [{ ...frame, path: outside }] } }), /video context folder/);
  await assert.rejects(f.service.request({ method: "send", input: { dir: f.dir, text: "Inspect video", context: {}, videoFrames: Array.from({ length: 13 }, () => frame) } }));
  await f.service.request({ method: "send", input: { dir: f.dir, text: "Inspect video", context: { videoContext: { frames: [frame] } }, videoFrames: [frame] } });
  await f.until((event) => event.type === "turn" && event.status === "completed");
  const calls = (await readFile(f.calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method: string; params: { input?: { type: string; text?: string; path?: string }[] } });
  const input = calls.find((call) => call.method === "turn/start")?.params.input;
  assert.ok(input);
  assert.match(input[2].text!, /scene demo at 2.500 seconds/);
  assert.deepEqual(input[3], { type: "localImage", path });
});


test("agent turns save source checkpoints before edits and reserve the project against restores", async (t) => {
  const f = await fixture(t, { runTool: async (dir) => {
    await writeFile(join(dir, "index.tsx"), "after agent edit");
    return { success: true, contentItems: [{ type: "inputText", text: "edited" }] };
  } });
  const source = join(f.dir, "index.tsx");
  await writeFile(source, "before agent edit");
  await f.service.request({ method: "send", input: { dir: f.dir, text: "tool", context: {} } });
  await f.until((event) => event.type === "turn" && event.status === "completed");
  const store = join(f.dir, ".diffusion", "checkpoints");
  const [id] = await readdir(store);
  assert.equal(await readFile(join(store, id, "files", "index.tsx"), "utf8"), "before agent edit");
  assert.equal(await readFile(source, "utf8"), "after agent edit");
  assert.equal(JSON.parse(await readFile(join(store, id, "manifest.json"), "utf8")).label, "Before agent: tool");

  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const operation = f.service.withProjectIdle(f.dir, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  await assert.rejects(f.service.request({ method: "send", input: { dir: f.dir, text: "blocked", context: {} } }), /already working/);
  release.resolve();
  await operation;
  await f.service.request({ method: "send", input: { dir: f.dir, text: "approval", context: {} } });
  await f.until((event) => event.type === "approval");
  await assert.rejects(f.service.withProjectIdle(f.dir, async () => {}), /Stop the active agent turn/);
  await f.service.request({ method: "cancel", input: { dir: f.dir } });
});

test("a failed checkpoint prevents a native agent turn from starting", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.dir, ".diffusion"), "not a directory");
  await assert.rejects(f.service.request({ method: "send", input: { dir: f.dir, text: "Do the edit", context: {} } }));
  const calls = await readFile(f.calls, "utf8");
  assert.equal(calls.includes('"method":"turn/start"'), false);
  assert.equal(f.events.some((event) => event.type === "turn"), false);
});

test("host turns checkpoint and reserve the canonical project while allowing editor tools", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.dir, "index.tsx"), "before host edit");
  const alias = `${f.dir}-alias`;
  await symlink(f.dir, alias);
  t.after(() => rm(alias));
  const release = await f.service.prepareExternalTurn(alias, "Host edit");
  const store = join(f.dir, ".diffusion", "checkpoints");
  const [id] = await readdir(store);
  assert.equal(await readFile(join(store, id, "files", "index.tsx"), "utf8"), "before host edit");
  await assert.rejects(f.service.withProjectIdle(f.dir, async () => {}), /active agent/);
  await assert.rejects(f.service.prepareExternalTurn(f.dir, "Concurrent chat"), /active agent/);
  await assert.rejects(f.service.request({ method: "send", input: { dir: f.dir, text: "Native edit" } }), /already working/);
  assert.equal(await f.service.withProjectMutation(f.dir, async () => "tool result"), "tool result");
  release();
  const nextRelease = await f.service.prepareExternalTurn(f.dir, "Next turn");
  release();
  await assert.rejects(f.service.withProjectIdle(f.dir, async () => {}), /active agent/);
  nextRelease();
  await f.service.withProjectIdle(f.dir, async () => {});
});

test("host checkpoint failures and native turns leave no unsafe host reservation", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.dir, ".diffusion"), "not a directory");
  await assert.rejects(f.service.prepareExternalTurn(f.dir, "Host edit"));
  await f.service.withProjectIdle(f.dir, async () => {});
  await rm(join(f.dir, ".diffusion"));
  await f.service.request({ method: "send", input: { dir: f.dir, text: "hold" } });
  await assert.rejects(f.service.prepareExternalTurn(f.dir, "Host edit"), /active agent/);
  await f.service.request({ method: "cancel", input: { dir: f.dir } });
});

test("checkpoint reservations exclude unfinished renders and imports while agent tools still work", async (t) => {
  const f = await fixture(t);
  const rendering = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const render = f.service.withProjectMutation(f.dir, async () => { rendering.resolve(); await finish.promise; });
  await rendering.promise;
  await assert.rejects(f.service.withProjectIdle(f.dir, async () => {}), /render or asset operation/);
  await assert.rejects(f.service.request({ method: "send", input: { dir: f.dir, text: "tool", context: {} } }), /render or asset operation/);
  finish.resolve();
  await render;
  await f.service.withProjectIdle(f.dir, async () => {
    await assert.rejects(f.service.withProjectMutation(f.dir, async () => {}), /checkpoint or turn preparation/);
  });
  await f.service.request({ method: "send", input: { dir: f.dir, text: "approval", context: {} } });
  await f.until((event) => event.type === "approval");
  assert.equal(await f.service.withProjectMutation(f.dir, async () => "agent render completed"), "agent render completed");
  await assert.rejects(f.service.withProjectIdle(f.dir, async () => {}), /Stop the active agent turn/);
  await f.service.request({ method: "cancel", input: { dir: f.dir } });
});


test("immediate Stop waits for native activation and shares concurrent interruption requests", async (t) => {
  const f = await fixture(t);
  await f.service.request({ method: "send", input: { dir: f.dir, text: "delayed-start" } });
  const stopped = Promise.all([
    f.service.request({ method: "cancel", input: { dir: f.dir } }),
    f.service.request({ method: "cancel", input: { dir: f.dir } }),
  ]);
  const checked = assert.doesNotReject(stopped);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const before = await readFile(f.calls, "utf8");
  await writeFile(f.settings + ".activate", "ready");
  await checked;
  assert.equal(before.includes('"method":"turn/interrupt"'), false, "start acknowledgement does not mean the turn is active");
  await f.until((event) => event.type === "turn" && event.status === "interrupted");
  const calls = (await readFile(f.calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(calls.filter((call) => call.method === "turn/interrupt").length, 1);
  assert.equal(f.events.some((event) => event.type === "turn" && event.status === "failed"), false);
});

test("Stop awaiting activation respects a completed turn without sending an interrupt", async (t) => {
  const f = await fixture(t);
  await f.service.request({ method: "send", input: { dir: f.dir, text: "complete-before-start" } });
  const stopped = assert.doesNotReject(f.service.request({ method: "cancel", input: { dir: f.dir } }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  await writeFile(f.settings + ".activate", "complete");
  await stopped;
  await f.until((event) => event.type === "turn" && event.status === "completed");
  assert.equal((await readFile(f.calls, "utf8")).includes('"method":"turn/interrupt"'), false);
});

test("unexpected interrupt errors remain visible and Stop can retry", async (t) => {
  const f = await fixture(t);
  await f.service.request({ method: "send", input: { dir: f.dir, text: "interrupt-error" } });
  await assert.rejects(f.service.request({ method: "cancel", input: { dir: f.dir } }), /Interrupt transport rejected/);
  assert.equal(f.events.some((event) => event.type === "turn" && event.status !== "started"), false);
  await f.service.request({ method: "cancel", input: { dir: f.dir } });
  await f.until((event) => event.type === "turn" && event.status === "interrupted");
});

test("Stop accepts native completion racing an interrupt rejection", async (t) => {
  const f = await fixture(t);
  await f.service.request({ method: "send", input: { dir: f.dir, text: "finish-during-interrupt" } });
  await f.service.request({ method: "cancel", input: { dir: f.dir } });
  await f.until((event) => event.type === "turn" && event.status === "completed");
  assert.equal(f.events.some((event) => event.type === "turn" && (event.status === "interrupted" || event.status === "failed")), false);
});

test("steers the active native turn with fresh context and no second checkpoint", async (t) => {
  const f = await fixture(t);
  const sent = await f.service.request({ method: "send", input: { dir: f.dir, text: "hold", context: {} } });
  assert.ok(sent.method === "send");
  const reopened = await f.service.request({ method: "load", input: { dir: f.dir } });
  assert.ok(reopened.method === "load");
  assert.equal(reopened.result?.activeTurnId, sent.result.turnId);
  const rendering = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const render = f.service.withProjectMutation(f.dir, async () => { rendering.resolve(); await release.promise; });
  await rendering.promise;
  const next = { dir: f.dir, text: "Make it blue instead", context: { currentTime: 5 }, expectedTurnId: sent.result.turnId };
  await assert.rejects(f.service.request({ method: "send", input: { ...next, expectedTurnId: "old-turn" } }), /turn has ended/);
  await assert.rejects(f.service.request({ method: "send", input: { ...next, model: "fast-model" } }), /between turns/);
  const steered = await f.service.request({ method: "send", input: next });
  assert.deepEqual(steered, sent);
  await f.until((event) => event.type === "delta" && event.text === next.text);
  release.resolve();
  await render;
  assert.equal((await readdir(join(f.dir, ".diffusion", "checkpoints"))).length, 1);
  await f.service.request({ method: "cancel", input: { dir: f.dir } });
  await f.until((event) => event.type === "turn" && event.status === "interrupted");
  await assert.rejects(f.service.request({ method: "send", input: next }), /turn has ended/);
  const calls = (await readFile(f.calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 1);
  const steer = calls.find((call) => call.method === "turn/steer");
  assert.equal(steer.params.expectedTurnId, "turn-1");
  assert.equal(JSON.parse(steer.params.input[1].text.split("\n")[1]).currentTime, 5);
});


test("native skills are validated and attached when starting and steering", async (t) => {
  const f = await fixture(t);
  const selected = { name: "edit-video", path: "/skills/edit-video/SKILL.md" };
  await assert.rejects(f.service.request({ method: "send", input: { dir: f.dir, text: "hold", context: {}, skills: [{ ...selected, path: "/unknown" }] } }), /unavailable or disabled/);
  await f.service.request({ method: "send", input: { dir: f.dir, text: "hold", context: {}, skills: [selected] } });
  await f.service.request({ method: "send", input: { dir: f.dir, text: "Use that skill here", context: {}, skills: [selected], expectedTurnId: "turn-1" } });
  await f.service.request({ method: "cancel", input: { dir: f.dir } });
  const calls = (await readFile(f.calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  for (const method of ["turn/start", "turn/steer"]) {
    const input = calls.find((call) => call.method === method).params.input;
    assert.deepEqual(input.find((entry: { type: string }) => entry.type === "skill"), { type: "skill", ...selected });
  }
});

test("native questions survive reopening, accept answers, and cancel with their turn", async (t) => {
  const f = await fixture(t);
  await f.service.request({ method: "send", input: { dir: f.dir, text: "question", context: {} } });
  const event = await f.until((event) => event.type === "requests" && event.requests.length > 0);
  assert.ok(event.type === "requests");
  const request = event.requests[0];
  const reopened = await f.service.request({ method: "load", input: { dir: f.dir } });
  assert.ok(reopened.method === "load");
  assert.deepEqual(reopened.result?.pendingRequests, [request]);
  await assert.rejects(f.service.request({ method: "respond", input: { requestId: request.id, response: { action: "accept", answers: {} } } }), /Answer Color/);
  await f.service.request({ method: "respond", input: { requestId: request.id, response: { action: "accept", answers: { color: ["Red"] } } } });
  await f.until((event) => event.type === "turn" && event.status === "completed");
  await assert.rejects(f.service.request({ method: "respond", input: { requestId: request.id, response: { action: "cancel" } } }), /no longer pending/);
  const calls = (await readFile(f.calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.find((call) => call.method === "client/reply").params.result, { answers: { color: { answers: ["Red"] } } });
  const offset = f.events.length;
  await f.service.request({ method: "send", input: { dir: f.dir, text: "question", context: {} } });
  await f.until((event) => f.events.indexOf(event) >= offset && event.type === "requests" && event.requests.length > 0);
  await f.service.request({ method: "cancel", input: { dir: f.dir } });
  assert.ok(f.events.slice(offset).some((event) => event.type === "requests" && event.requests.length === 0));
});

test("reference images and area/time markings reach new turns and live steering as native attachments", async (t) => {
  const f = await fixture(t);
  const images = [{ name: "reference.png", url: "data:image/png;base64,aGVsbG8=" }];
  const annotation = {
    sceneId: "demo", sceneName: "Demo", time: 2, frame: 60,
    sceneSize: { width: 1920, height: 1080 },
    region: { x: 0.2, y: 0.3, width: 0.4, height: 0.5 }, note: "This area",
    imageUrl: "data:image/png;base64,d29ybGQ=",
  };
  const timeRange = { sceneId: "demo", sceneName: "Demo", start: 2, end: 4, frameRate: 30 };
  await assert.rejects(f.service.request({ method: "send", input: { dir: f.dir, text: "hold", context: {}, images: [{ ...images[0], url: "https://example.test/image.png" }] } }));
  await f.service.request({ method: "send", input: { dir: f.dir, text: "hold", context: {}, images } });
  await f.service.request({ method: "send", input: { dir: f.dir, text: "Use these references", context: { currentTime: 9 }, images, annotation, timeRange, expectedTurnId: "turn-1" } });
  await f.service.request({ method: "cancel", input: { dir: f.dir } });
  const calls = (await readFile(f.calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const start = calls.find((call) => call.method === "turn/start").params.input;
  const steer = calls.find((call) => call.method === "turn/steer").params.input;
  assert.deepEqual(start.filter((item: { type: string }) => item.type === "image"), [{ type: "image", url: images[0].url }]);
  assert.deepEqual(steer.filter((item: { type: string }) => item.type === "image"), [
    { type: "image", url: annotation.imageUrl }, { type: "image", url: images[0].url },
  ]);
  const context = JSON.parse(steer[1].text.split("\n")[1]);
  assert.deepEqual(context.timeRange, timeRange);
  assert.deepEqual(context.annotation.region, annotation.region);
  assert.equal(context.currentTime, 9);
  assert.equal(steer[1].text.includes(images[0].url), false, "image bytes stay out of editor context");
  assert.equal((await readdir(join(f.dir, ".diffusion", "checkpoints"))).length, 1);
});


test("undo retains the exact preturn checkpoint across service restarts and is consumed after restoring", async (t) => {
  const restored: string[] = [];
  const f = await fixture(t, {
    runTool: async (dir) => {
      await writeFile(join(dir, "index.tsx"), "agent edit");
      return { success: true, contentItems: [{ type: "inputText", text: "edited" }] };
    },
    restoreCheckpoint: async (dir, id) => {
      const [mapping] = (await readdir(join(dir, "codex-projects"))).filter((name) => name.endsWith(".undo.json"));
      assert.equal(JSON.parse(await readFile(join(dir, "codex-projects", mapping), "utf8")), null);
      restored.push(id);
      await writeFile(join(dir, "index.tsx"), await readFile(join(dir, ".diffusion", "checkpoints", id, "files", "index.tsx")));
    },
  });
  await writeFile(join(f.dir, "index.tsx"), "before agent");
  await f.service.request({ method: "send", input: { dir: f.dir, text: "tool", context: {} } });
  const finished = await f.until((event) => event.type === "turn" && event.status === "completed");
  assert.ok(finished.type === "turn" && finished.undo);
  assert.equal(finished.undo.threadId, "thread-1");
  assert.equal(finished.undo.turnId, "turn-1");
  assert.equal(await readFile(join(f.dir, "index.tsx"), "utf8"), "agent edit");
  await f.service.request({ method: "release", input: { dir: f.dir } });
  const resumed = new CodexService(f.options);
  t.after(() => resumed.dispose());
  const loaded = await resumed.request({ method: "load", input: { dir: f.dir } });
  assert.ok(loaded.method === "load" && loaded.result?.undo);
  assert.deepEqual(loaded.result.undo, finished.undo);
  await writeFile(join(f.dir, "index.tsx"), "later manual edit");
  const input = { dir: f.dir, threadId: finished.undo.threadId, turnId: finished.undo.turnId };
  assert.deepEqual(await resumed.request({ method: "undo", input }), { method: "undo", result: null });
  assert.deepEqual(restored, [finished.undo.checkpointId]);
  assert.equal(await readFile(join(f.dir, "index.tsx"), "utf8"), "before agent");
  await assert.rejects(resumed.request({ method: "undo", input }), /no longer the last agent turn/);
  const after = await resumed.request({ method: "load", input: { dir: f.dir } });
  assert.ok(after.method === "load");
  assert.equal(after.result?.undo, undefined);
});

test("undo rejects stale identities and excludes active turns, renders and checkpoint operations", async (t) => {
  let restores = 0;
  const f = await fixture(t, { restoreCheckpoint: async () => { restores++; } });
  const input = { dir: f.dir, threadId: "thread-1", turnId: "turn-1" };
  await f.service.request({ method: "send", input: { dir: f.dir, text: "hold", context: {} } });
  await assert.rejects(f.service.request({ method: "undo", input }), /already working/);
  const active = await f.service.request({ method: "load", input: { dir: f.dir } });
  assert.ok(active.method === "load");
  assert.equal(active.result?.undo, undefined);
  await f.service.request({ method: "cancel", input: { dir: f.dir } });
  await f.until((event) => event.type === "turn" && event.status === "interrupted");
  await assert.rejects(f.service.request({ method: "undo", input: { ...input, threadId: "other" } }), /Switch back/);
  await assert.rejects(f.service.request({ method: "undo", input: { ...input, turnId: "old-turn" } }), /no longer the last agent turn/);
  await f.service.withProjectMutation(f.dir, async () => {
    await assert.rejects(f.service.request({ method: "undo", input }), /render or asset operation/);
  });
  await f.service.withProjectIdle(f.dir, async () => {
    await assert.rejects(f.service.request({ method: "undo", input }), /already working/);
  });
  assert.equal(restores, 0);
  await f.service.request({ method: "undo", input });
  assert.equal(restores, 1);
});

test("failed restores retain Undo, while a later external native turn invalidates it", async (t) => {
  let restores = 0;
  const f = await fixture(t, { restoreCheckpoint: async () => { restores++; throw new Error("Restore failed"); } });
  await f.service.request({ method: "send", input: { dir: f.dir, text: "edit", context: {} } });
  await f.until((event) => event.type === "turn" && event.status === "completed");
  const input = { dir: f.dir, threadId: "thread-1", turnId: "turn-1" };
  await assert.rejects(f.service.request({ method: "undo", input }), /Restore failed/);
  const retry = await f.service.request({ method: "load", input: { dir: f.dir } });
  assert.ok(retry.method === "load" && retry.result?.undo);
  const historyPath = f.settings + ".turns";
  const turns = JSON.parse(await readFile(historyPath, "utf8"));
  turns.at(-1).status = "inProgress";
  await writeFile(historyPath, JSON.stringify(turns));
  await assert.rejects(f.service.request({ method: "undo", input }), /no longer the last agent turn/);
  const inProgress = await f.service.request({ method: "load", input: { dir: f.dir } });
  assert.ok(inProgress.method === "load");
  assert.equal(inProgress.result?.undo, undefined);
  await writeFile(historyPath, JSON.stringify([...turns, { id: "external-turn", status: "completed", items: [] }]));
  await assert.rejects(f.service.request({ method: "undo", input }), /no longer the last agent turn/);
  const advanced = await f.service.request({ method: "load", input: { dir: f.dir } });
  assert.ok(advanced.method === "load");
  assert.equal(advanced.result?.undo, undefined);
  assert.equal(restores, 1);
});
