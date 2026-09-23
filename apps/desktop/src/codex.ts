import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { codexImagesSchema, type CodexImage } from "./codex-image-contracts";
import { CodexRequests } from "./codex-requests";
import { listCapabilities, validateSkills } from "./codex-capabilities";
import { CodexAppServer, object, optionalString, string } from "./codex-protocol";
import { annotationSchema, timeRangeSchema } from "./annotation-contracts";
import { videoFramesSchema, type VideoFrames } from "./video-frame-contracts";
import { createCheckpoint } from "./checkpoints";
import { checkpointIdSchema } from "./checkpoint-contracts";
import type { CodexConversation, CodexEventData, CodexModel, CodexOptions, CodexRequest, CodexResponse, CodexSession, CodexUndo } from "./codex-contracts";

const CONTEXT_MARKER = "<diffusion_editor_context>";
const instructions = `You are the editing agent inside Frameyard on Linux. Work in the current project folder. Preserve the user's source files and manual edits. Read the project's AGENTS.md and reference docs before editing. Use the native shell to author editable Solid JSX and render Manim or HyperFrames sources; use dapi context, check, capture, and export to verify changes. Author motion graphics as native individually editable layers whenever possible: text, rect, ellipse, path, groups, masks, paints and keyframe tracks. Native layers support z depth, rotationX/Y, scene camera motion and materials/effects. Read reference/jsx/motion-workspace.md in the installed Frameyard docs path from the MCP instructions for exact properties. Use literal, stable IDs and props so manual edits round-trip. Every authored visible object must remain separately selectable and editable, including nested components. A retained HTML/Python source with one rendered video is not full layer editability. For a HyperFrames or Manim component use project_animations action editable to create a native layered JSX component, then insert that component only when placement is requested. Inspect conversion issues; never quietly substitute incomplete conversion or a rasterized clip for editable objects. For unsupported effects, recreate them as native layers or explain the exact remaining limitation. Keep original animation source for further revisions. Never flatten the entire project to one video unless the user asks. The supplied editor context describes selected nodes and the playhead at send time; use editor_context for fresh context and editor_capture to inspect the current frame. When an annotation is attached, its marked area and note take precedence for words such as this or here. The attached image is a frozen frame with the area outlined in cyan. annotation.region uses normalized top-left scene coordinates (0 to 1); multiply by annotation.sceneSize for source pixels. annotation.sceneId, time in seconds, and frame identify the original reference even if the playhead or selection later changes. When timeRange is attached, it identifies timeRange.sceneId in scene seconds at frameRate. The range is frozen when attached and takes precedence over the current playhead or timeline workarea. For an edit to existing content, apply it from start inclusive to end exclusive. Combine it with annotation.region when both are attached; preserve the image outside that region and the scene before and after the range. For adding or remixing new content, place it at timeRange.start and keep its natural duration unless the user explicitly asks to fit, trim, or retime it to the interval. A range beyond the current scene duration is a valid insertion location. Extend an explicit scene end to at least the new clip end, rounded up to a scene frame, without shortening the scene or changing the original timing of existing layers. A narrow marked interval is not a request to squeeze a full template into it. Verify the scene duration and the inserted clip timing after placement. Verify captures just before, inside, and at the end of the edited interval or inserted clip with dapi capture --scene-time so the playback/export workarea does not offset these times. sceneTiming.timelineRange describes the playback/export workarea only; it is not an explicit edit request. Without an attached range, use timing stated in the message, the selected clip duration, or clarify timing when necessary. For black this out, add an opaque black cover over the marked region for the requested interval. For blur, apply a real blur or pixelation to the referenced area, not a solid cover. For zoom, change the composition or clip framing, not the editor viewport camera. effectReference identifies an exact native Effects library preset and its settings. Inspect it with editor_effects {id}; add it with editor_add_preset {preset, sceneId, start, end, settings} and revise an existing preset using editor_update_preset {id, settings, start, end}. For these tools convert annotation.region to settings.region=[x,y,width,height]; use attached sceneSize and frameRate to reject stale geometry. Use only the controls listed for that preset, and follow its documented limits. These presets stay editable and use the live scene; do not render a HyperFrames asset for them. Selecting an effect reference alone does not authorize an edit. For Highlight requests, use editor_add_highlight to enlarge live footage over the composited scene. Pass annotation.region directly, annotation.sceneId and sceneSize, and timeRange.start/end and frameRate when attached. Use mode center to move the region toward the center or destination, or in-place to enlarge it where it is. Timing is scene seconds with an exclusive end; this effect follows the exact requested interval. Its source stays editable, and it does not duplicate footage or audio. For an existing highlight use editor_update with its source ID to revise region, magnification, destination, mode, dim, blur, radius, shadow, enter, exit or timing. Read reference/effects.md in the installed Frameyard docs path from the MCP instructions. Selecting an effect only attaches a reference; add it when the user requests placement. Preserve source and verify the result by capturing the referenced scene and time. Without an annotation, treat selected IDs as the primary referents for words such as this or these. catalogReferences contain the exact catalog provider and full item manifest, including source file paths and preview URLs. Refer to those exact items when discussing them. A catalog attachment alone does not request a project change. Use the corresponding hyperframes_catalog or hyfrme_catalog tool to inspect or install source when the user requests editing, and render only when a rendered asset is needed. HyperFrames items of type template are the editable video templates from hyperframes.dev. For a requested remix, install the attached template with hyperframes_catalog action install, read its TEMPLATE.md and manifest variables, edit its declared defaults in the HTML with correct HTML entity encoding and keep __template_baseline__.html unchanged, customize its assets, register it in diffusion.animations and convert it to native editable layers with project_animations action editable when its individual contents must remain editable. Render a preview with hyperframes_catalog action render if useful, preserving the source. Import a flattened video only when that is the requested deliverable. Do not reconstruct a template from its preview video. For launch videos and animation requests, read reference/animation.md in the installed Frameyard docs path from the MCP instructions. Keep HyperFrames HTML/GSAP or Manim Python source inside the project and register it under diffusion.animations in package.json with output inside assets. Hyfrme catalog installations use the HyperFrames renderer. Match dimensions and frameRate to the intended video. For overlays, register transparent: true with output assets/<name>.frames and leave source backgrounds transparent. Opaque scenes use .mp4. Use project_animations to list, render, cancel or export; dapi animation list/render/export offers the same local workflow. Rendered animations appear in Animations for playback and scrubbing before placement. A preview does not require a timeline insert; use editor_insert_asset with fit=contain only when the user asks to add it. animationReferences (or legacy manimReferences) identify exact retained source, class, output and library path; read that source before revising. Transparent sequences preview over a checkerboard and preserve their rendered frame rate. Keep the sequence folder and its hidden metadata intact. To deliver an individual animation for Resolve, use project_animations action export with an output path, or dapi animation export. Transparent overlays require .mov (ProRes 4444 with alpha); opaque clips use .mp4. Export does not require a scene. Use the editor timeline to assemble launch sequences when requested, preserving individual source assets and editable scene timing. When fullTranscript is attached, read its entire JSON file at path before planning edits. It contains the full audible scene with word-level times in scene seconds, independent of the playback/export workarea. Use its sceneId and capturedAt to identify the frozen reference; recuts after that capture may need a fresh transcript. Use assetPath as captions src to reuse it instead of transcribing again. The attachment provides context and does not itself request captions or video changes. When videoContext is attached, read its saved manifest and fullTranscript.path if present. The attached images are a sampled overview of the composited scene, each labeled in scene seconds. They are not an exhaustive record of every shot or motion. Match transcript words to their times; inspect the relevant time and nearby frames with editor_capture {sceneId, time} before deciding where an animation fits. Check for faces, captions and other content across the entire proposed overlay interval, not just one frame. Describe uncertain occlusion or missing coverage honestly. The saved manifest and PNG paths remain available in terminal sessions; use image inspection tools to reopen them. These references are frozen; recuts or other later edits require fresh context. Attaching video context alone does not authorize timeline changes. Use available asset and template tools when useful. Use built-in image generation for requested original images; completed images are imported automatically. Existing native CLI conversations can use the same tools through dapi tool <name> --args followed by a JSON object; dapi tool --help lists them. Use dapi capture for image files to inspect. Scope file changes to this project. Do not install software, publish, or send messages elsewhere unless the user requests it.`;

const defaultTools = [
  { name: "editor_context", description: "Read live project, scene, selection, and playhead context from the editor.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "editor_capture", description: "Capture a composited frame at the playhead or optional sceneId and time in scene seconds.", inputSchema: { type: "object", properties: { sceneId: { type: "string" }, time: { type: "number", minimum: 0 } }, additionalProperties: false } },
] satisfies NonNullable<CodexOptions["tools"]>;

type ActiveTurn = {
  dir: string;
  threadId: string;
  turnId?: string;
  cancelled: boolean;
  finished: boolean;
  started: PromiseWithResolvers<void>;
  interrupt?: Promise<void>;
  generated: Promise<void>[];
  imageError?: string;
  checkpointId: string;
  undo?: Promise<CodexUndo | undefined>;
  undoError?: string;
};

function session(value: unknown): CodexSession {
  const row = object(value);
  const preview = (optionalString(row.preview) ?? "").split(CONTEXT_MARKER)[0].trim();
  return {
    id: string(row.id, "thread id"),
    name: optionalString(row.name) || preview.slice(0, 120) || "New conversation",
    preview: preview.slice(0, 500),
    cwd: string(row.cwd, "thread directory"),
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0,
    source: optionalString(row.source) ?? "other",
  };
}

/** Render only chat text; command output and image bytes stay out of transcript IPC. */
export function conversation(value: unknown): CodexConversation {
  const thread = object(value);
  const messages: CodexConversation["messages"] = [];
  for (const rawTurn of Array.isArray(thread.turns) ? thread.turns : []) {
    const turn = object(rawTurn);
    for (const rawItem of Array.isArray(turn.items) ? turn.items : []) {
      const item = object(rawItem);
      const id = string(item.id, "message id");
      if (item.type === "agentMessage" && typeof item.text === "string") {
        messages.push({ id, role: "assistant", text: item.text });
      }
      if (item.type === "userMessage" && Array.isArray(item.content)) {
        const text = item.content.flatMap((value) => {
          const content = object(value);
          return content.type === "text" && typeof content.text === "string" && !content.text.startsWith(CONTEXT_MARKER) ? [content.text] : [];
        }).join("\n");
        messages.push({ id, role: "user", text });
      }
    }
  }
  return {
    session: session(thread), messages,
    settings: { model: optionalString(thread.model) ?? null, reasoningEffort: optionalString(thread.reasoningEffort) ?? null },
  };
}

export class CodexService {
  private options: CodexOptions;
  private server: CodexAppServer;
  private active = new Map<string, ActiveTurn>();
  private externalTurns = new Set<string>();
  private loaded = new Map<string, string>();
  private busy = new Set<string>();
  private mutations = new Map<string, number>();
  private pendingCancel = new Set<string>();
  private releasing: Promise<void> | undefined;
  private requests = new CodexRequests(() => {
    for (const turn of this.active.values()) {
      this.emit(turn, { type: "requests", requests: this.requests.list(turn.threadId) });
    }
  });
  private approvals = new Map<string, { turn: ActiveTurn; event: NonNullable<CodexConversation["pendingApproval"]>; resolve: (result: { decision: "accept" | "decline" }) => void }>();

  constructor(options: CodexOptions) {
    this.options = options;
    this.server = new CodexAppServer({
      binary: options.binary,
      notification: (method, params) => this.notification(method, params),
      serverRequest: (method, params) => this.serverRequest(method, params),
      exited: (error) => {
        this.loaded.clear();
        for (const turn of this.active.values()) void this.finish(turn, "failed", error.message);
      },
    });
  }

  async request(request: CodexRequest): Promise<CodexResponse> {
    if (this.releasing) await this.releasing;
    object(request);
    const input = object(request.input);
    if (request.method === "status") return { method: "status", result: await this.status(input.dir === undefined ? undefined : await realpath(string(input.dir, "project directory"))) };
    if (request.method === "respond") {
      this.requests.respond(string(input.requestId, "request id"), input.response);
      return { method: "respond", result: null };
    }
    if (request.method === "approve") {
      const id = string(input.requestId, "approval request id");
      const approval = this.approvals.get(id);
      if (!approval) throw new Error("This approval is no longer pending");
      if (input.decision !== "accept" && input.decision !== "decline") throw new Error("Invalid approval decision");
      this.approvals.delete(id);
      approval.resolve({ decision: input.decision });
      return { method: "approve", result: null };
    }
    const dir = await realpath(string(input.dir, "project directory"));
    if (!(await stat(dir)).isDirectory()) throw new Error("The project path is not a directory");
    if (this.releasing) await this.releasing;
    if (request.method === "capabilities") return { method: "capabilities", result: await listCapabilities((method, params) => this.server.request(method, params), dir, this.loaded.get(dir)) };
    if (request.method === "sessions") {
      const result = object(await this.server.request("thread/list", {
        cwd: dir, limit: 30, sortKey: "updated_at", cursor: optionalString(input.cursor), searchTerm: optionalString(input.search),
      }));
      if (!Array.isArray(result.data)) throw new Error("Codex returned an invalid session list");
      return { method: "sessions", result: { sessions: result.data.map(session), cursor: optionalString(result.nextCursor) ?? null } };
    }
    if (request.method === "cancel") {
      const turn = this.active.get(dir);
      if (turn) {
        turn.cancelled = true;
        this.declineApprovals(turn);
        this.requests.cancel(turn.threadId);
        await this.interrupt(turn);
      }
      if (!turn && this.busy.has(dir)) this.pendingCancel.add(dir);
      return { method: "cancel", result: null };
    }
    const steering = request.method === "send" && input.expectedTurnId !== undefined;
    if (this.externalTurns.has(dir)) throw new Error("Another agent is already working in this project");
    if (this.busy.has(dir) || (this.active.has(dir) && request.method !== "load" && !steering)) throw new Error("Codex is already working in this project");
    if (this.mutations.has(dir) && request.method !== "load" && !steering) throw new Error("Wait for the current render or asset operation to finish");
    this.busy.add(dir);
    try {
      if (request.method === "load") {
        const threadId = optionalString(input.threadId) ?? await this.savedThread(dir);
        if (!threadId) return { method: "load", result: null };
        const active = this.active.get(dir);
        if (active && active.threadId !== threadId) throw new Error("Stop the current turn before switching conversations");
        const thread = await this.readThread(dir, threadId);
        await this.saveThread(dir, threadId);
        const current = this.active.get(dir);
        const pendingApproval = [...this.approvals.values()].findLast(({ turn }) => turn === current)?.event;
        return { method: "load", result: { ...conversation(thread), activeTurn: current !== undefined, activeTurnId: current?.turnId, pendingRequests: this.requests.list(threadId), pendingApproval, undo: current ? undefined : await this.latestUndo(dir, thread) } };
      }
      if (request.method === "undo") {
        const threadId = string(input.threadId, "thread id");
        const turnId = string(input.turnId, "turn id");
        if (await this.savedThread(dir) !== threadId) throw new Error("Switch back to this conversation before undoing its turn");
        const undo = await this.latestUndo(dir, await this.readThread(dir, threadId));
        if (!undo || undo.threadId !== threadId || undo.turnId !== turnId) throw new Error("This is no longer the last agent turn available to undo");
        if (!this.options.restoreCheckpoint) throw new Error("Checkpoint restore is unavailable");
        await this.saveMapping(dir, null, ".undo");
        try { await this.options.restoreCheckpoint(dir, undo.checkpointId); }
        catch (error) {
          await this.saveMapping(dir, undo, ".undo").catch((mappingError: unknown) => {
            throw new AggregateError([error, mappingError], `${error instanceof Error ? error.message : String(error)} Undo could not be recovered: ${mappingError instanceof Error ? mappingError.message : String(mappingError)}`);
          });
          throw error;
        }
        return { method: "undo", result: null };
      }
      if (request.method === "new") return { method: "new", result: { ...conversation(await this.create(dir)), activeTurn: false } };
      if (request.method === "release") {
        const threadId = await this.savedThread(dir);
        if (!threadId) throw new Error("There is no conversation to resume");
        const thread = await this.readThread(dir, threadId);
        const config = object(object(await this.server.request("config/read", { cwd: dir, includeLayers: false })).config);
        const model = optionalString(thread.model) ?? optionalString(config.model);
        const effort = optionalString(thread.reasoningEffort) ?? optionalString(config.model_reasoning_effort);
        const command = [
          "codex", "resume", `--cd=${dir}`,
          ...(model ? [`--model=${model}`] : []),
          ...(effort ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
          "--", threadId,
        ].map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
        if (this.active.size || this.busy.size > 1) throw new Error("Stop active Codex turns before continuing in a terminal");
        // Unsubscribing leaves native writer locks held; closing stdio relinquishes them.
        this.releasing = this.server.disconnect();
        try {
          await this.releasing;
        } finally {
          this.releasing = undefined;
        }
        return { method: "release", result: { command } };
      }
      if (request.method === "send") {
        const text = string(input.text, "message").trim();
        if (!text || text.length > 30_000) throw new Error("Message must contain 1 to 30,000 characters");
        const images = codexImagesSchema.parse(input.images ?? []);
        const annotation = input.annotation === undefined ? undefined : annotationSchema.parse(input.annotation);
        const timeRange = input.timeRange === undefined ? undefined : timeRangeSchema.parse(input.timeRange);
        if (annotation && timeRange && annotation.sceneId !== timeRange.sceneId) throw new Error("The area and time range must refer to the same scene");
        const { imageUrl, ...area } = annotation ?? {};
        const videoFrames = input.videoFrames === undefined ? [] : videoFramesSchema.parse(input.videoFrames);
        let imageBytes = 0;
        for (const frame of videoFrames) {
          const path = await realpath(frame.path);
          const rel = relative(join(dir, ".diffusion", "video-context"), path);
          if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || extname(path) !== ".png") throw new Error("Video frames must be saved in this project's video context folder");
          const info = await stat(path);
          imageBytes += info.size;
          if (!info.isFile() || !info.size || imageBytes > 32_000_000) throw new Error("Video frame files are empty or too large");
          frame.path = path;
        }
        const context = JSON.stringify({ ...object(input.context ?? {}), ...(annotation ? { annotation: area } : {}), ...(timeRange ? { timeRange } : {}) });
        if (context.length > 250_000) throw new Error("Editor context is too large");
        if (input.skills !== undefined && (!Array.isArray(input.skills) || input.skills.length > 20)) throw new Error("Choose up to 20 skills per message");
        const rawSkills: unknown[] = Array.isArray(input.skills) ? input.skills : [];
        const selectedSkills = rawSkills.map((value) => {
          const skill = object(value);
          return { name: string(skill.name, "skill name"), path: string(skill.path, "skill path") };
        });
        const skills = await validateSkills((method, params) => this.server.request(method, params), dir, selectedSkills);
        if (steering) {
          const turn = this.active.get(dir);
          const expectedTurnId = string(input.expectedTurnId, "active turn id");
          if (!turn || turn.finished || turn.cancelled || turn.turnId !== expectedTurnId) throw new Error("That turn has ended. Send your message again to continue.");
          if (input.model !== undefined || input.reasoningEffort !== undefined) throw new Error("Model settings can only change between turns");
          const result = object(await this.server.request("turn/steer", {
            threadId: turn.threadId, expectedTurnId,
            input: this.messageInput(text, context, imageUrl, videoFrames, skills, images),
          }));
          return { method: "send", result: { threadId: turn.threadId, turnId: string(result.turnId, "turn id") } };
        }
        let threadId = await this.savedThread(dir);
        if (!threadId || this.loaded.get(dir) !== threadId) {
          const thread = threadId ? await this.resume(dir, threadId) : await this.create(dir);
          threadId = string(thread.id, "thread id");
        }
        if (this.pendingCancel.has(dir)) throw new Error("Codex turn was cancelled");
        const settings = await this.turnSettings(threadId, input);
        this.options.onEvent({ dir, threadId, type: "activity", text: "Saving checkpoint…" });
        const checkpoint = await createCheckpoint(dir, `Before agent: ${text.replace(/\s+/g, " ").slice(0, 140)}`);
        if (this.pendingCancel.has(dir)) throw new Error("Codex turn was cancelled");
        return { method: "send", result: await this.send(dir, threadId, checkpoint.id, text, context, settings, imageUrl, videoFrames, skills, images) };
      }
      throw new Error("Unknown Codex request");
    } finally {
      this.busy.delete(dir);
      this.pendingCancel.delete(dir);
    }
  }

  dispose(): void {
    this.server.dispose();
  }

  /** Reserve the project before a utility-process agent can edit its files. */
  async prepareExternalTurn(path: string, text: string): Promise<() => void> {
    return this.withProjectIdle(path, async (dir) => {
      await createCheckpoint(dir, `Before agent: ${text.replace(/\s+/g, " ").slice(0, 140)}`);
      this.externalTurns.add(dir);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.externalTurns.delete(dir);
      };
    });
  }

  /** Checkpoint operations and native turns share the same project reservation. */
  async withProjectIdle<T>(path: string, operation: (dir: string) => Promise<T>): Promise<T> {
    const dir = await realpath(string(path, "project directory"));
    if (this.busy.has(dir) || this.active.has(dir) || this.externalTurns.has(dir)) throw new Error("Stop the active agent turn before changing checkpoints");
    if (this.mutations.has(dir)) throw new Error("Wait for the current render or asset operation before changing checkpoints");
    this.busy.add(dir);
    try {
      return await operation(dir);
    } finally {
      this.busy.delete(dir);
      this.pendingCancel.delete(dir);
    }
  }

  /** Renders and imports may run within an agent turn, but never across a checkpoint. */
  async withProjectMutation<T>(path: string, operation: (dir: string) => Promise<T>): Promise<T> {
    const dir = await realpath(string(path, "project directory"));
    if (this.busy.has(dir) && !this.active.has(dir)) throw new Error("Wait for the project checkpoint or turn preparation to finish");
    this.mutations.set(dir, (this.mutations.get(dir) ?? 0) + 1);
    try {
      return await operation(dir);
    } finally {
      const remaining = (this.mutations.get(dir) ?? 1) - 1;
      if (remaining) this.mutations.set(dir, remaining);
      else this.mutations.delete(dir);
    }
  }

  private async status(dir?: string) {
    const accountResult = object(await this.server.request("account/read", { refreshToken: false }));
    const raw = accountResult.account ? object(accountResult.account) : null;
    const account = raw ? { type: string(raw.type, "account type"), plan: optionalString(raw.planType) ?? null } : null;
    const models = await this.models();
    const config = object(object(await this.server.request("config/read", { cwd: dir, includeLayers: false })).config);
    const model = optionalString(config.model) ?? models.find((model) => model.isDefault)?.model ?? null;
    return {
      account,
      requiresLogin: account === null && accountResult.requiresOpenaiAuth !== false,
      models,
      defaults: { model, reasoningEffort: optionalString(config.model_reasoning_effort) ?? models.find((entry) => entry.model === model)?.defaultReasoningEffort ?? null },
    };
  }

  private async models(): Promise<CodexModel[]> {
    const models: CodexModel[] = [];
    let cursor: string | undefined;
    do {
      const result = object(await this.server.request("model/list", { limit: 100, cursor }));
      if (!Array.isArray(result.data)) throw new Error("Codex returned an invalid model list");
      for (const value of result.data) {
        const model = object(value);
        if (!Array.isArray(model.supportedReasoningEfforts)) throw new Error("Codex returned invalid reasoning options");
        models.push({
          id: string(model.id, "model id"), model: string(model.model, "model"),
          name: string(model.displayName, "model name"), isDefault: model.isDefault === true,
          defaultReasoningEffort: string(model.defaultReasoningEffort, "default reasoning effort"),
          supportedReasoningEfforts: model.supportedReasoningEfforts.map((value) => {
            const option = object(value);
            return { reasoningEffort: string(option.reasoningEffort, "reasoning effort"), description: optionalString(option.description) ?? "" };
          }),
        });
      }
      cursor = optionalString(result.nextCursor);
    } while (cursor);
    return models;
  }

  private async turnSettings(threadId: string, input: Record<string, unknown>): Promise<{ model?: string; effort?: string }> {
    if (input.model === undefined && input.reasoningEffort === undefined) return {};
    const requestedModel = input.model === undefined ? undefined : string(input.model, "model");
    const reasoningEffort = input.reasoningEffort === undefined ? undefined : string(input.reasoningEffort, "reasoning effort");
    const currentModel = requestedModel ?? optionalString(object(object(await this.server.request("thread/read", { threadId, includeTurns: false })).thread).model);
    const model = (await this.models()).find((model) => model.model === currentModel);
    if (!model) throw new Error("This model is not available in your local Codex session");
    const effort = reasoningEffort ?? model.defaultReasoningEffort;
    if (!model.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort)) throw new Error(`${model.name} does not support ${effort} reasoning`);
    return { model: requestedModel, effort };
  }

  private async threadSettings(dir: string) {
    const result = object(await this.server.request("config/read", { cwd: dir, includeLayers: false }));
    const config = object(result.config);
    return {
      cwd: dir,
      // Resume retains these old thread overrides unless we replace them with the user's config.
      approvalPolicy: config.approval_policy ?? undefined,
      developerInstructions: optionalString(config.developer_instructions) ?? "",
    };
  }

  private async create(dir: string): Promise<Record<string, unknown>> {
    const result = object(await this.server.request("thread/start", {
      ...await this.threadSettings(dir),
      serviceName: "diffusion_studio",
      threadSource: "diffusion_studio",
      dynamicTools: (this.options.tools ?? defaultTools).map((tool) => ({ type: "function", ...tool })),
    }));
    const thread = object(result.thread);
    const id = string(thread.id, "thread id");
    await this.saveThread(dir, id);
    this.loaded.set(dir, id);
    return thread;
  }

  private async resume(dir: string, threadId: string): Promise<Record<string, unknown>> {
    // Inspect before resuming: selecting a session cannot silently move it to another project.
    await this.readThread(dir, threadId);
    const result = object(await this.server.request("thread/resume", { threadId, ...await this.threadSettings(dir) }));
    const thread = object(result.thread);
    this.loaded.set(dir, string(thread.id, "thread id"));
    return thread;
  }

  private async readThread(dir: string, threadId: string): Promise<Record<string, unknown>> {
    const thread = object(object(await this.server.request("thread/read", { threadId, includeTurns: true })).thread);
    if (await realpath(string(thread.cwd, "thread directory")) !== dir) throw new Error("This conversation belongs to a different project folder");
    return thread;
  }

  private messageInput(text: string, context: string, imageUrl?: string, videoFrames: VideoFrames = [], skills: Awaited<ReturnType<typeof validateSkills>> = [], images: CodexImage[] = []) {
    return [
      { type: "text", text, text_elements: [] },
      { type: "text", text: `${CONTEXT_MARKER}\n${context}\n</diffusion_editor_context>\n<diffusion_editor_guidance>\n${instructions}\n</diffusion_editor_guidance>`, text_elements: [] },
      ...skills,
      ...(imageUrl ? [{ type: "image", url: imageUrl }] : []),
      ...images.map(({ url }) => ({ type: "image", url })),
      ...videoFrames.flatMap((frame) => [
        { type: "text", text: `${CONTEXT_MARKER}\nVideo reference: scene ${frame.sceneId} at ${frame.time.toFixed(3)} seconds.\n</diffusion_editor_context>`, text_elements: [] },
        { type: "localImage", path: frame.path },
      ]),
    ];
  }

  private async send(dir: string, threadId: string, checkpointId: string, text: string, context: string, settings: { model?: string; effort?: string }, imageUrl?: string, videoFrames: VideoFrames = [], skills: Awaited<ReturnType<typeof validateSkills>> = [], images: CodexImage[] = []) {
    const turn: ActiveTurn = { dir, threadId, checkpointId, cancelled: false, finished: false, started: Promise.withResolvers<void>(), generated: [] };
    this.active.set(dir, turn);
    try {
      const result = object(await this.server.request("turn/start", {
        threadId,
        ...settings,
        input: this.messageInput(text, context, imageUrl, videoFrames, skills, images),
      }));
      turn.turnId = string(object(result.turn).id, "turn id");
      await this.rememberUndo(turn);
      if (!turn.finished) this.emit(turn, { type: "turn", status: "started" });
      return { threadId, turnId: turn.turnId };
    } catch (error) {
      await this.finish(turn, "failed", error instanceof Error ? error.message : "Could not start Codex turn");
      throw error;
    }
  }

  private async savedThread(dir: string): Promise<string | undefined> {
    try {
      return string(object(JSON.parse(await readFile(this.mappingPath(dir), "utf8"))).threadId, "saved thread id");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private mappingPath(dir: string, suffix = ""): string {
    return join(this.options.dataDir, "codex-projects", createHash("sha256").update(dir).digest("hex") + suffix + ".json");
  }

  private async saveThread(dir: string, threadId: string): Promise<void> {
    await this.saveMapping(dir, { dir, threadId });
  }

  private async saveMapping(dir: string, value: unknown, suffix = ""): Promise<void> {
    await mkdir(join(this.options.dataDir, "codex-projects"), { recursive: true });
    const path = this.mappingPath(dir, suffix);
    const temporary = path + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  }

  private async latestUndo(dir: string, thread: Record<string, unknown>): Promise<CodexUndo | undefined> {
    let value: unknown;
    try { value = JSON.parse(await readFile(this.mappingPath(dir, ".undo"), "utf8")); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
    if (value === null) return undefined;
    const row = object(value);
    const undo = { threadId: string(row.threadId, "undo thread id"), turnId: string(row.turnId, "undo turn id"), checkpointId: checkpointIdSchema.parse(row.checkpointId) };
    if (undo.threadId !== thread.id || !Array.isArray(thread.turns) || !thread.turns.length) return undefined;
    const latest = object(thread.turns.at(-1));
    if (latest.id !== undo.turnId || latest.status === "inProgress") return undefined;
    return undo;
  }

  private rememberUndo(turn: ActiveTurn): Promise<CodexUndo | undefined> {
    if (!turn.turnId) return Promise.resolve(undefined);
    if (turn.undo) return turn.undo;
    const undo = { threadId: turn.threadId, turnId: turn.turnId, checkpointId: turn.checkpointId };
    turn.undo = this.saveMapping(turn.dir, undo, ".undo").then(() => undo).catch((error: unknown) => {
      turn.undoError = `Could not save Undo for this turn: ${error instanceof Error ? error.message : String(error)}`;
      this.emit(turn, { type: "activity", text: turn.undoError });
      return undefined;
    });
    return turn.undo;
  }

  private emit(turn: ActiveTurn, event: CodexEventData): void {
    this.options.onEvent({ dir: turn.dir, threadId: turn.threadId, turnId: turn.turnId, ...event });
  }

  private interrupt(turn: ActiveTurn): Promise<void> {
    return turn.interrupt ??= turn.started.promise.then(async () => {
      if (turn.finished) return;
      await this.server.request("turn/interrupt", { threadId: turn.threadId, turnId: turn.turnId });
    }).catch((error: unknown) => {
      turn.interrupt = undefined;
      if (turn.finished) return;
      throw error;
    });
  }

  private notification(method: string, params: Record<string, unknown>): void {
    const turn = [...this.active.values()].find((active) => active.threadId === params.threadId);
    if (!turn || turn.finished) return;
    const turnId = optionalString(params.turnId);
    if (turn.turnId && turnId && turn.turnId !== turnId) return;
    if (turnId) turn.turnId ??= turnId;
    if (method === "turn/started") {
      const id = string(object(params.turn).id, "turn id");
      if (turn.turnId && turn.turnId !== id) return;
      turn.turnId = id;
      // turn/start can acknowledge before the native turn accepts an interrupt.
      turn.started.resolve();
      return;
    }
    if (method === "item/agentMessage/delta") {
      const text = optionalString(params.delta);
      if (text) this.emit(turn, { type: "delta", itemId: string(params.itemId, "message id"), text });
      return;
    }
    if (method === "item/started") {
      const item = object(params.item);
      const label = item.type === "commandExecution" ? "Running a command" : item.type === "fileChange" ? "Editing project files" : item.type === "imageGeneration" ? "Generating image" : item.type === "webSearch" ? "Searching the web" : item.type === "dynamicToolCall" ? `Using ${optionalString(item.tool) ?? "editor tool"}` : item.type === "mcpToolCall" ? `Using ${optionalString(item.server) ?? "MCP"} / ${optionalString(item.tool) ?? "tool"}` : null;
      if (label) this.emit(turn, { type: "activity", text: label });
      return;
    }
    if (method === "item/completed") {
      const item = object(params.item);
      if (item.type === "imageGeneration") {
        turn.generated.push(this.importImage(turn, item).catch((error: unknown) => { turn.imageError = error instanceof Error ? error.message : "Could not import generated image"; }));
      }
      return;
    }
    if (method === "error" && params.willRetry !== true) {
      void this.finish(turn, "failed", optionalString(object(params.error).message) ?? "Codex turn failed");
      return;
    }
    if (method === "turn/completed") {
      const result = object(params.turn);
      if (turn.turnId && result.id !== turn.turnId) return;
      turn.turnId ??= string(result.id, "turn id");
      const status = result.status === "completed" ? "completed" : result.status === "interrupted" ? "interrupted" : "failed";
      const error = result.error ? optionalString(object(result.error).message) : undefined;
      void this.finish(turn, status, error);
    }
  }

  private async importImage(turn: ActiveTurn, item: Record<string, unknown>): Promise<void> {
    if (item.failure) throw new Error(optionalString(object(item.failure).message) ?? "Image generation failed");
    if (!this.options.importGenerated) throw new Error("Generated image import is unavailable");
    const asset = await this.options.importGenerated(turn.dir, {
      savedPath: optionalString(item.savedPath), result: optionalString(item.result) ?? "", prompt: optionalString(item.revisedPrompt) ?? "Generated image",
    });
    this.emit(turn, { type: "generated", asset });
  }

  private async finish(turn: ActiveTurn, status: "completed" | "interrupted" | "failed", error?: string): Promise<void> {
    if (turn.finished) return;
    turn.finished = true;
    turn.started.resolve();
    this.declineApprovals(turn);
    this.requests.cancel(turn.threadId);
    await Promise.all(turn.generated);
    const undo = await this.rememberUndo(turn);
    if (this.active.get(turn.dir) === turn) this.active.delete(turn.dir);
    this.emit(turn, { type: "turn", status: turn.imageError ? "failed" : status, error: error ?? turn.imageError ?? turn.undoError, undo });
  }

  private declineApprovals(turn: ActiveTurn): void {
    for (const [id, approval] of this.approvals) {
      if (approval.turn !== turn) continue;
      this.approvals.delete(id);
      approval.resolve({ decision: "decline" });
    }
  }

  private async serverRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "currentTime/read") return { currentTimeAt: Math.floor(Date.now() / 1000) };
    const turn = [...this.active.values()].find((active) => active.threadId === params.threadId && !active.finished);
    const optionalTurn = method === "mcpServer/elicitation/request" && params.turnId == null;
    if (!turn || (turn.turnId && params.turnId !== turn.turnId && !optionalTurn)) throw new Error("This editor turn is no longer active");
    if (method === "item/tool/requestUserInput" || method === "item/permissions/requestApproval" || method === "mcpServer/elicitation/request") {
      return this.requests.request(randomUUID(), method, params);
    }
    if (method === "item/tool/call") {
      const name = string(params.tool, "tool name");
      const supported = (this.options.tools ?? defaultTools).some((tool) => tool.name === name);
      if (params.namespace || !supported) throw new Error("Unknown editor tool");
      return this.options.runTool(turn.dir, name, params.arguments).catch((error: unknown) => ({
        contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : "Editor tool failed" }], success: false,
      }));
    }
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const requestId = randomUUID();
      return new Promise((resolve) => {
        const event: NonNullable<CodexConversation["pendingApproval"]> = {
          dir: turn.dir, threadId: turn.threadId, turnId: turn.turnId,
          type: "approval", requestId, kind: method.includes("commandExecution") ? "command" : "file",
          text: [optionalString(params.reason), optionalString(params.command), optionalString(params.grantRoot)].filter(Boolean).join("\n") || "Codex requests additional permissions",
        };
        this.approvals.set(requestId, { turn, event, resolve });
        this.options.onEvent(event);
      });
    }
    throw new Error(`Unsupported Codex client request: ${method}`);
  }
}
