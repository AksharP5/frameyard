import assert from "node:assert/strict";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: [fileURLToPath(new URL("../../web/src/components/agent/video-context.tsx", import.meta.url))],
  write: false, format: "cjs", platform: "node", jsx: "transform",
});

function fixture() {
  const calls: string[] = [];
  const written = new Map<string, Blob>();
  const pendingWrite = Promise.withResolvers<void>();
  const pendingTranscript = Promise.withResolvers<void>();
  let transcriptFailure: Error | undefined;
  let writeFailure: Error | undefined;
  let waitForFrames: Promise<void> | undefined;
  let imageLimit: number | undefined;
  let onEdit: (() => void) | undefined;
  let dir = "/project";
  let activeId = "index.tsx:main";
  const scene = { get: (trait: string) => trait === "Source" ? { value: activeId } : trait === "Name" ? { value: "Main" } : { duration: 360, start: 0, end: 360 } };
  const world = { get: () => ({ value: 30 }) };
  const session = { world, project: { dir: () => dir } };
  let sourceState: { world: typeof world; status: "ready" | "loading" } = { world, status: "ready" };
  class TranscriptUnavailableError extends Error {
    readonly reason: "no-audio" | "no-speech";
    constructor(reason: "no-audio" | "no-speech") { super(reason); this.reason = reason; }
  }
  const dependencies: Record<string, unknown> = {
    "solid-js": {}, "@/components/ui/button": {},
    "@diffusionstudio/runtime": {
      Computed: "Computed", FrameRate: "FrameRate", Source: "Source", Name: "Name", isScene: () => true, getActiveEntity: () => scene,
      getEntityChildren: () => [90, 180, 270].map((start) => ({ get: () => ({ start, end: start + 30 }) })),
    },
    "@/dapi/session": { requireEditorSession: () => session, editorSession: () => session, editorLoadState: () => sourceState },
    "@/engine/editor": { getDocumentEditor: () => ({ onEdit(listener: () => void) { onEdit = listener; return () => { onEdit = undefined; calls.push("unsubscribed"); }; } }) },
    "@/lib/local-mode": { localMode: true },
    "@/projects/edits": { async flushProjectEdits() { calls.push("flushing"); await pendingWrite.promise; calls.push("flushed"); } },
    "@/utils/gen-ai": { TranscriptUnavailableError },
    "./full-transcript": { async captureFullTranscript() {
      calls.push("transcribing");
      await pendingTranscript.promise;
      if (transcriptFailure) throw transcriptFailure;
      return { projectDir: "/project", sceneId: "index.tsx:main", sceneName: "Main", duration: 12, path: "/project/assets/generated/full.json", assetPath: "generated/full.json", timing: "scene-seconds", capturedAt: "now" };
    } },
    "@/dapi/handlers/capture": { captureSceneFrames: async (current: typeof session, id: string, frames: number[], options: { sceneTime?: boolean }) => {
      calls.push("capturing");
      assert.equal(current, session);
      assert.equal(options.sceneTime, true, "captures must ignore the marked export range");
      assert.equal(id, "index.tsx:main");
      await waitForFrames;
      return frames.slice(0, imageLimit).map((frame) => ({ timecode: `${frame}f`, base64: btoa(`png:${frame}`) }));
    } },
    "@/projects/fs": { createProjectFS: (projectDir: string) => {
      assert.equal(projectDir, "/project");
      return {
        async write(path: string, blob: Blob) {
          calls.push("writing"); written.set(path, blob);
          if (writeFailure) throw writeFailure;
        },
        async remove(path: string) { calls.push("cleanup"); for (const key of written.keys()) if (key.startsWith(`${path}/`)) written.delete(key); },
      };
    } },
  };
  const module = { exports: {} as typeof import("../../web/src/components/agent/video-context") };
  runInThisContext(`(function(require,module,exports){${compiled.outputFiles[0].text}\n})`)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return {
    ...module.exports, calls, written,
    completeWrite: pendingWrite.resolve, completeTranscript: pendingTranscript.resolve,
    unavailable: (reason: "no-audio" | "no-speech") => { transcriptFailure = new TranscriptUnavailableError(reason); },
    fail: (failure: Error) => { transcriptFailure = failure; },
    failWrite: (failure: Error) => { writeFailure = failure; },
    reload: (status: "ready" | "loading") => { sourceState = { world, status }; },
    limitImages: (limit: number) => { imageLimit = limit; },
    delayFrames: () => {
      const pending = Promise.withResolvers<void>();
      waitForFrames = pending.promise;
      return pending.resolve;
    },
    edit: () => onEdit?.(), switchScene: () => { activeId = "index.tsx:other"; }, rename: () => { dir = "/renamed"; },
  };
}

test("video overview has bounded whole-scene coverage and samples both sides of cuts", () => {
  const { planVideoContextFrames: plan } = fixture();
  const frames = plan(900, [150, 450, 750]);
  assert.equal(frames.length, 12);
  for (const frame of [0, 149, 150, 449, 450, 749, 750, 899]) assert.ok(frames.includes(frame));
  assert.deepEqual(frames, [...frames].sort((a, b) => a - b));
  assert.deepEqual(plan(1, []), [0]);
  assert.deepEqual(plan(3, [1, 2, 3]), [0, 1, 2]);
  assert.ok(plan(90_000, Array.from({ length: 30_000 }, (_, i) => i * 3)).length <= 12);
});

test("video context saves timed frames and full transcript references after edits finish", async () => {
  const f = fixture();
  const pending = f.captureVideoContext();
  assert.deepEqual(f.calls, ["flushing"]);
  f.completeWrite();
  f.completeTranscript();
  const result = await pending;
  assert.equal(result.duration, 12);
  assert.equal(result.transcriptStatus, "available");
  assert.equal(result.fullTranscript?.path, "/project/assets/generated/full.json");
  assert.equal(result.frames[0].time, 0);
  assert.equal(result.frames.at(-1)?.time, 359 / 30);
  assert.equal(f.calls[0], "flushing");
  assert.ok(f.calls.indexOf("flushed") < f.calls.indexOf("transcribing"));
  assert.ok(f.calls.indexOf("transcribing") < f.calls.indexOf("capturing"));
  for (const frame of result.frames) {
    assert.match(frame.path, /^\/project\/\.diffusion\/video-context\/[a-f0-9-]+\/frame-\d{2}\.png$/);
    assert.equal(await f.written.get(frame.path.slice("/project/".length))?.text(), `png:${Math.round(frame.time * result.frameRate)}`);
  }
  assert.deepEqual(JSON.parse(await f.written.get(result.path.slice("/project/".length))!.text()), result);
  assert.equal(f.calls.at(-1), "unsubscribed");
});

test("silent video keeps its visual context but transcription failures remain errors", async () => {
  for (const reason of ["no-audio", "no-speech"] as const) {
    const f = fixture();
    f.unavailable(reason);
    f.completeWrite(); f.completeTranscript();
    const result = await f.captureVideoContext();
    assert.equal(result.transcriptStatus, reason);
    assert.equal(result.fullTranscript, undefined);
    assert.ok(result.frames.length > 0);
  }
  const f = fixture();
  const error = new Error("Whisper process failed");
  f.fail(error);
  f.completeWrite(); f.completeTranscript();
  await assert.rejects(f.captureVideoContext(), (cause) => cause === error);
  assert.equal(f.calls.includes("capturing"), false);
  assert.equal(f.written.size, 0);
});

test("scene edits, scene switches, and renames discard a pending video attachment", async () => {
  for (const change of ["edit", "switchScene", "rename"] as const) {
    const f = fixture();
    const pending = f.captureVideoContext();
    f.completeWrite();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(f.calls.includes("transcribing"));
    f[change]();
    f.completeTranscript();
    await assert.rejects(pending, /project or scene changed/);
    assert.equal(f.calls.includes("capturing"), false);
    assert.equal(f.written.size, 0);
    assert.equal(f.calls.at(-1), "unsubscribed");
  }
});

test("external source reloads discard video context during transcription or frame capture even when world and scene IDs stay the same", async () => {
  for (const phase of ["transcribing", "capturing"] as const) {
    for (const status of ["loading", "ready"] as const) {
      const f = fixture();
      const completeFrames = f.delayFrames();
      const pending = f.captureVideoContext();
      f.completeWrite();
      if (phase === "capturing") f.completeTranscript();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(f.calls.at(-1), phase);
      f.reload(status);
      f.completeTranscript(); completeFrames();
      await assert.rejects(pending, /project or scene changed/);
      assert.equal(f.written.size, 0);
      assert.equal(f.calls.at(-1), "unsubscribed");
    }
  }
});

test("missing captured frames cannot produce an empty or incorrectly timed video attachment", async () => {
  for (const count of [0, 1]) {
    const f = fixture();
    f.limitImages(count);
    f.completeWrite(); f.completeTranscript();
    await assert.rejects(f.captureVideoContext(), /did not capture every requested frame/);
    assert.equal(f.written.size, 0);
  }
});

test("canceling a video attachment releases its edit listener without persisting context", async () => {
  const f = fixture();
  const controller = new AbortController();
  const pending = f.captureVideoContext({ signal: controller.signal });
  controller.abort();
  f.completeWrite();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(f.written.size, 0);
  assert.deepEqual(f.calls, ["flushing", "flushed", "unsubscribed"]);
});

test("a failed frame write removes the incomplete context and preserves the failure", async () => {
  const f = fixture();
  const error = new Error("Disk is full");
  f.failWrite(error);
  f.completeWrite(); f.completeTranscript();
  await assert.rejects(f.captureVideoContext(), (cause) => cause === error);
  assert.equal(f.written.size, 0);
  assert.deepEqual(f.calls.slice(-3), ["writing", "cleanup", "unsubscribed"]);
});
