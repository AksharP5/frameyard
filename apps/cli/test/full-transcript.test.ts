import assert from "node:assert/strict";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Asset, AssetLibrary, PartialAsset, Transcript } from "@diffusionstudio/assets";
import type { Entity, World } from "koota";
import { transcriptionWindows, mergeTranscriptWindow } from "../../web/src/utils/transcription-windows.ts";
import { parseTranscript } from "../../web/src/components/agent/transcript-data.ts";

const compiled = await build({
  entryPoints: [fileURLToPath(new URL("../../web/src/utils/gen-ai.ts", import.meta.url))],
  bundle: true, write: false, format: "cjs", platform: "node",
  plugins: [{ name: "transcription-boundaries", setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path, kind }) => kind === "entry-point" ? undefined : { path, external: true });
  } }],
});

function fixture(duration = 12) {
  const symbols = Object.fromEntries(["Ai", "AssetId", "Audio", "Computed", "FrameRate", "Hidden", "Muted", "Paint", "Project", "Source", "Workarea"].map((name) => [name, Symbol(name)]));
  const workarea = { start: 60, end: 120 };
  const scene = { get: (trait: symbol) => trait === symbols.Source ? { value: "index.tsx:main" } : trait === symbols.Workarea ? workarea : trait === symbols.Computed ? { start: 90, end: duration * 30, duration: (duration - 3) * 30 } : undefined };
  const audio = { has: (trait: symbol) => trait === symbols.AssetId || trait === symbols.Audio };
  const captureRange = { value: workarea as typeof workarea | undefined };
  const stored: { blob: Blob; asset: Asset }[] = [];
  const partials: PartialAsset[] = [];
  const calls = { render: 0, transcribe: 0, flush: 0, disposed: 0 };
  const rendered: { start: number; end: number }[] = [];
  const captureCodes: (string | undefined)[] = [];
  let failure: Error | undefined;
  let hasAudio = true;
  let words: Transcript | ((range: { start: number; end: number }) => Transcript) = [{ text: "early late", words: [{ text: "early", start: 0.1, end: 0.5 }, { text: "late", start: 9, end: 10 }] }];
  const library = {
    list: () => stored.map(({ asset }) => asset),
    partials: () => partials,
    generated: (key: string) => stored.find(({ asset }) => asset.generation?.key === key)?.asset
      ?? partials.find((partial) => partial.generation.key === key),
    async reserve(options: { key: string; folder?: string; name: string; type: Asset["type"] }) {
      const partial: PartialAsset = {
        id: `partial-${options.key}`,
        path: `${options.folder ? `${options.folder}/` : ""}${options.name}`,
        type: options.type,
        createdAt: "now",
        generation: { key: options.key },
        state: "pending",
      };
      partials.push(partial);
      return partial;
    },
    async remove(entries: PartialAsset[]) {
      for (const entry of entries) {
        const index = partials.indexOf(entry);
        if (index >= 0) partials.splice(index, 1);
      }
    },
    fail(partial: PartialAsset, error: string) { partial.state = "error"; partial.error = error; },
    async store(blob: Blob, options: { name: string; folder: string; generation: { key: string } }) {
      const asset: Asset = { type: "TRANSCRIPT", id: String(stored.length), path: `${options.folder}/${options.name}`, source: `assets/${options.folder}/${options.name}`, mimeType: "application/json", createdAt: "now", generation: options.generation, handle: { getFile: async () => new File([blob], options.name) } };
      const partial = partials.findIndex((entry) => entry.generation.key === options.generation.key);
      if (partial >= 0) partials.splice(partial, 1);
      stored.push({ blob, asset });
      return asset;
    },
    async flush() { calls.flush++; },
  };
  const dependencies: Record<string, unknown> = {
    "@diffusionstudio/jsx": { parseSource: () => ({ locator: "main" }) },
    "@diffusionstudio/runtime": { ...symbols, GenAi: class {}, getEntityTree: () => hasAudio ? [audio] : [], PaintType: { VIDEO: "video" } },
    "@diffusionstudio/assets": {
      GENERATED_DIR: "generated",
      assetName: (asset: Asset | PartialAsset) => asset.path.split("/").at(-1),
      isPartialAsset: (entry: Asset | PartialAsset): entry is PartialAsset => "state" in entry,
    },
    "@/engine/capture": { createCapture: async (_world: unknown, _scene: unknown, options: { code?: string }) => {
      captureCodes.push(options.code);
      return { code: "frozen source", world: {}, node: {
      add: (trait: symbol) => { assert.equal(trait, symbols.Workarea); },
      set: (trait: symbol, range: typeof workarea) => { assert.equal(trait, symbols.Workarea); captureRange.value = range; },
    }, dispose() { calls.disposed++; } }; } },
    "@diffusionstudio/encoder": { createEncoder: async () => ({ render: async () => {
      calls.render++;
      if (failure) return { type: "error", error: failure };
      const range = captureRange.value;
      const window = { start: range ? range.start / 30 : 0, end: range ? range.end / 30 : duration };
      rendered.push(window);
      return { type: "success", data: JSON.stringify(window) };
    } }) },
    "@/utils/local-transcription": { transcribeFile: async (file: File) => {
      calls.transcribe++;
      const range = JSON.parse(await file.text());
      assert.equal(calls.disposed, calls.render, "capture is disposed before loading Whisper");
      return { segments: typeof words === "function" ? words(range) : words };
    } },
    "@/utils/transcription-windows": { transcriptionWindows, mergeTranscriptWindow },
    "@/lib/local-mode": { localMode: true },
    "@/utils": { assert },
    "somoto": { toast: { error() {} } },
    "@/components/genai/config": {}, "@/lib/uploads": {}, "@/lib/analytics": {}, "@/lib/trpc": {},
  };
  const module = { exports: {} as typeof import("../../web/src/utils/gen-ai") };
  runInThisContext(`(function(require,module,exports){${compiled.outputFiles[0].text}\n})`)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`);
    return dependencies[name];
  }, module, module.exports);
  const ai = new module.exports.EditorGenAi(library as unknown as AssetLibrary, "test", "/project");
  const transcribe = (seed: number) => ai.transcribe({ get: (trait: symbol) => trait === symbols.FrameRate ? { value: 30 } : undefined } as unknown as World, scene as unknown as Entity, seed);
  return { transcribe, stored, calls, rendered, captureCodes, scene, symbols, workarea, setWords: (next: typeof words) => { words = next; }, failRender: (error: Error) => { failure = error; }, removeAudio: () => { hasAudio = false; } };
}

test("full scene transcription ignores the export range, preserves word times, and persists before returning", async () => {
  const f = fixture();
  const asset = await f.transcribe(5);
  assert.equal(asset.generation?.key, "transcript:local-v5:main:5");
  assert.deepEqual(f.rendered, [{ start: 0, end: 12 }], "transcription includes speech outside the marked export range");
  assert.deepEqual(JSON.parse(await f.stored[0].blob.text())[0].words.map((word: { start: number }) => word.start), [0.1, 9]);
  assert.deepEqual(f.scene.get(f.symbols.Workarea), f.workarea);
  assert.deepEqual(f.calls, { render: 1, transcribe: 1, flush: 1, disposed: 1 });
  assert.equal(await f.transcribe(5), asset);
  await f.transcribe(6);
  assert.equal(f.calls.transcribe, 2, "a fresh attachment must capture edits after a previous take");
});

test("long transcripts bound each capture and preserve scene times across overlapping windows", async () => {
  const f = fixture(130);
  const sceneWords = [
    { text: "first", start: 0.1, end: 0.5 },
    { text: "crossing", start: 59.7, end: 60.3 },
    { text: "second", start: 61, end: 62 },
    { text: "last", start: 129, end: 129.9 },
  ];
  f.setWords(({ start, end }) => [{ text: "", words: sceneWords.filter((word) => word.start >= start && word.end <= end).map((word) => ({ ...word, start: word.start - start, end: word.end - start })) }]);
  await f.transcribe(1);
  assert.deepEqual(f.rendered, [{ start: 0, end: 62 }, { start: 58, end: 122 }, { start: 118, end: 130 }]);
  assert.deepEqual(f.captureCodes, [undefined, "frozen source", "frozen source"]);
  const result: Transcript = JSON.parse(await f.stored[0].blob.text());
  assert.deepEqual(result.flatMap((segment) => segment.words), sceneWords);
  assert.deepEqual(f.calls, { render: 3, transcribe: 3, flush: 1, disposed: 3 });
});

test("Whisper timestamp drift at a window seam keeps one word without removing actual repeated speech", async () => {
  for (const repeatedStart of [659.22, 659.3]) {
    const f = fixture(670);
    const page = { text: "page", start: 659.26, end: 660.68 };
    const following = [
      { text: "where", start: 660.82, end: 661.3 },
      { text: "not", start: 665.64, end: 665.8 },
      { text: "not", start: 665.8, end: 666.1 },
    ];
    f.setWords(({ start }) => {
      const words = start === 598 ? [page]
        : start === 658 ? [{ text: "page", start: repeatedStart, end: 660.82 }, ...following] : [];
      return [{ text: "", words: words.map((word) => ({ ...word, start: word.start - start, end: word.end - start })) }];
    });
    await f.transcribe(1);
    const result = parseTranscript(JSON.parse(await f.stored[0].blob.text()));
    assert.deepEqual(result.flatMap((segment) => segment.words), [page, ...following]);
    assert.deepEqual(result.map((segment) => segment.text), ["page", "where not not"]);
  }
});

test("window stitching preserves boundary words despite reverse drift and punctuation changes", async () => {
  for (const example of [
    { first: { text: "page", start: 59.4, end: 60.8 }, next: { text: "page", start: 59.3, end: 60.6 } },
    { first: { text: "page", start: 59.26, end: 60.68 }, next: { text: "page,", start: 59.22, end: 60.82 } },
  ]) {
    const f = fixture(70);
    const repetition = { text: "page", start: 60.9, end: 61.2 };
    f.setWords(({ start }) => [{ text: "", words: (start === 0 ? [example.first, repetition] : [example.next, repetition])
      .map((word) => ({ ...word, start: word.start - start, end: word.end - start })) }]);
    await f.transcribe(1);
    const result = parseTranscript(JSON.parse(await f.stored[0].blob.text()));
    assert.deepEqual(result.flatMap((segment) => segment.words), [example.first, repetition]);
    assert.equal(result.map((segment) => segment.text).join(" "), "page page");
  }
});

test("a seam without a safe matching word uses one ordered start-time cut", () => {
  const [first, second] = [...transcriptionWindows(70, 30)];
  for (const nextText of ["different", "same"]) {
    const previous = mergeTranscriptWindow([], [{ text: "", words: [
      { text: "same", start: 59.9, end: 60.3 },
      { text: "context", start: 60.5, end: 60.6 },
    ] }], first);
    const result = parseTranscript(mergeTranscriptWindow(previous, [{ text: "", words: [
      { text: nextText, start: 1.8, end: 2.2 },
      { text: "before", start: 1.85, end: 1.9 },
      { text: "after", start: 2.1, end: 2.4 },
    ] }], second));
    assert.deepEqual(result.flatMap((segment) => segment.words).map((word) => word.text), ["same", "after"]);
  }
});

test("final transcription window keeps edge speech and excludes words starting outside the scene", async () => {
  const f = fixture(70);
  f.setWords(({ start }) => [{ text: "", words: start === 0 ? [{ text: "first", start: 0, end: 0.2 }] : [
    { text: "last", start: 11.7, end: 12 },
    { text: "outside", start: 12, end: 12.1 },
  ] }]);
  await f.transcribe(1);
  const result = parseTranscript(JSON.parse(await f.stored[0].blob.text()));
  assert.deepEqual(result.flatMap((segment) => segment.words), [
    { text: "first", start: 0, end: 0.2 },
    { text: "last", start: 69.7, end: 70 },
  ]);
});

test("malformed transcription timestamps fail before storing an asset", async () => {
  for (const words of [
    [{ text: "bad", start: -1, end: 1 }],
    [{ text: "bad", start: 1, end: 0 }],
    [{ text: "bad", start: 0, end: Infinity }],
    [{ text: "later", start: 2, end: 3 }, { text: "earlier", start: 1, end: 2 }],
  ]) {
    const f = fixture();
    f.setWords([{ text: "", words }]);
    await assert.rejects(f.transcribe(1), /invalid or unordered word timestamps/);
    assert.equal(f.stored.length, 0);
  }
});

test("failed audio rendering releases the capture and preserves the failure without saving a transcript", async () => {
  const f = fixture(130);
  f.failRender(new Error("Audio source could not be read"));
  await assert.rejects(f.transcribe(1), /Audio source could not be read/);
  assert.equal(f.calls.disposed, 1);
  assert.equal(f.calls.transcribe, 0);
  assert.equal(f.stored.length, 0);
});

test("silent scene transcription reports no speech without persisting an empty attachment", async () => {
  const f = fixture();
  f.setWords([]);
  await assert.rejects(f.transcribe(1), { name: "TranscriptUnavailableError", reason: "no-speech", message: /No speech detected/ });
  assert.equal(f.stored.length, 0);
  assert.equal(f.calls.disposed, 1);
});

test("a scene without audio has an explicit unavailable transcript status without starting an encoder", async () => {
  const f = fixture();
  f.removeAudio();
  await assert.rejects(f.transcribe(1), { name: "TranscriptUnavailableError", reason: "no-audio", message: /No audio found/ });
  assert.deepEqual(f.calls, { render: 0, transcribe: 0, flush: 0, disposed: 0 });
});

const attachmentCode = await build({
  entryPoints: [fileURLToPath(new URL("../../web/src/components/agent/full-transcript.tsx", import.meta.url))],
  write: false, format: "cjs", platform: "node", jsx: "transform",
});

function attachmentFixture({ delayTranscript = false } = {}) {
  const pendingWrite = Promise.withResolvers<void>();
  const pendingTranscript = Promise.withResolvers<void>();
  const operations: string[] = [];
  let dir = "/project";
  let sceneId = "index.tsx:main";
  let onEdit: (() => void) | undefined;
  const ai = { async transcribe() {
    operations.push("transcribed");
    if (delayTranscript) await pendingTranscript.promise;
    return { source: "assets/generated/full.json", path: "generated/full.json" };
  } };
  const world = { get: (trait: string) => trait === "Ai" ? ai : { value: 30 } };
  let sourceState: { world: typeof world; status: "ready" | "loading" | "error" } = { world, status: "ready" };
  let currentWorld: typeof world | undefined = world;
  const project = { dir: () => dir };
  const scene = { get: (trait: string) => trait === "Source" ? { value: sceneId } : trait === "Name" ? { value: "Main" } : { start: 90, end: 360, duration: 270 } };
  const dependencies: Record<string, unknown> = {
    "solid-js": {}, "@/components/ui/button": {},
    "@diffusionstudio/runtime": { Ai: "Ai", Source: "Source", Name: "Name", Computed: "Computed", FrameRate: "FrameRate", getActiveEntity: () => scene, isScene: () => true },
    "@diffusionstudio/assets": { isAbsoluteSource: (source: string) => source.startsWith("/") },
    "@/dapi/session": { requireEditorSession: () => ({ world, project }), editorSession: () => currentWorld && { world: currentWorld, project }, editorLoadState: () => sourceState },
    "@/engine/editor": { getDocumentEditor: () => ({ onEdit(listener: () => void) { onEdit = listener; return () => { onEdit = undefined; }; } }) },
    "@/lib/local-mode": { localMode: true },
    "@/projects/edits": { async flushProjectEdits() {
      operations.push("flushing");
      await pendingWrite.promise;
      operations.push("flushed");
    } },
  };
  const module = { exports: {} as typeof import("../../web/src/components/agent/full-transcript") };
  runInThisContext(`(function(require,module,exports){${attachmentCode.outputFiles[0].text}\n})`)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return {
    capture: module.exports.captureFullTranscript, operations,
    completeWrite: pendingWrite.resolve, completeTranscript: pendingTranscript.resolve,
    rename: () => { dir = "/renamed"; }, close: () => { currentWorld = undefined; },
    switchScene: () => { sceneId = "index.tsx:other"; }, edit: () => onEdit?.(),
    reload: (status: typeof sourceState.status) => { sourceState = { world, status }; },
    listening: () => onEdit !== undefined,
  };
}

test("transcript attachment waits for pending timeline edits before capturing audio", async () => {
  const f = attachmentFixture();
  const attachment = f.capture();
  assert.deepEqual(f.operations, ["flushing"]);
  f.completeWrite();
  const result = await attachment;
  assert.deepEqual(f.operations, ["flushing", "flushed", "transcribed"]);
  assert.equal(result.path, "/project/assets/generated/full.json");
  assert.equal(result.duration, 12);
  assert.equal(f.listening(), false);
});

test("project and scene changes during save prevent transcription of stale context", async () => {
  for (const change of ["rename", "close", "switchScene", "edit"] as const) {
    const f = attachmentFixture();
    const attachment = f.capture();
    f[change]();
    f.completeWrite();
    await assert.rejects(attachment, /project or scene changed/);
    assert.deepEqual(f.operations, ["flushing", "flushed"]);
    assert.equal(f.listening(), false);
  }
});

test("full transcript capture rejects loading scenes and changes while transcription is pending", async () => {
  for (const status of ["loading", "error"] as const) {
    const f = attachmentFixture();
    f.reload(status);
    await assert.rejects(f.capture(), /finish loading/);
    assert.deepEqual(f.operations, []);
    assert.equal(f.listening(), false);
  }
  for (const change of ["rename", "close", "switchScene", "edit", "reload"] as const) {
    const f = attachmentFixture({ delayTranscript: true });
    f.completeWrite();
    const attachment = f.capture();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.operations.at(-1), "transcribed");
    if (change === "reload") f.reload("ready");
    else f[change]();
    f.completeTranscript();
    await assert.rejects(attachment, /project or scene changed/);
    assert.equal(f.listening(), false);
  }
});
