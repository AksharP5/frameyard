import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { build } from "esbuild";
import type { Asset, Transcript } from "@diffusionstudio/assets";

const built = await build({
  stdin: {
    contents: `
      export { createRuntimeWorld, FrameRate, Caption, Chars, getSourceFrameAt, ClassicCaptionDecoder, CascadeCaptionDecoder, SpotlightCaptionDecoder, WhisperCaptionDecoder, PaperCaptionDecoder, GuineaCaptionDecoder, StarkCaptionDecoder } from '@diffusionstudio/runtime';
      export { createRuntimeDocument } from '@diffusionstudio/reconciler';
      export { SOURCE_ATTR } from '@diffusionstudio/jsx';
      export { getEditHistory } from '../../engine/history';
      export { planTranscriptCut, applyTranscriptCut } from './transcript-cut';
    `,
    resolveDir: fileURLToPath(new URL("../../web/src/components/agent/", import.meta.url)),
  },
  bundle: true, write: false, format: "cjs", platform: "node", conditions: ["browser"],
  tsconfig: fileURLToPath(new URL("../../web/tsconfig.app.json", import.meta.url)),
  logOverride: { "empty-import-meta": "silent" },
});
type Runtime = Pick<typeof import("@diffusionstudio/runtime"), "createRuntimeWorld" | "FrameRate" | "Caption" | "Chars" | "getSourceFrameAt" | "ClassicCaptionDecoder" | "CascadeCaptionDecoder" | "SpotlightCaptionDecoder" | "WhisperCaptionDecoder" | "PaperCaptionDecoder" | "GuineaCaptionDecoder" | "StarkCaptionDecoder">;
const module = { exports: {} as Runtime
  & Pick<typeof import("@diffusionstudio/reconciler"), "createRuntimeDocument">
  & Pick<typeof import("@diffusionstudio/jsx"), "SOURCE_ATTR">
  & Pick<typeof import("../../web/src/engine/history"), "getEditHistory">
  & typeof import("../../web/src/components/agent/transcript-cut")
};
class Element {}
runInThisContext(`(function(module,exports,HTMLCanvasElement,HTMLElement,Element){${built.outputFiles[0].text}\n})`)(module, module.exports, Element, Element, Element);
const { createRuntimeWorld, createRuntimeDocument, FrameRate, Caption, Chars, SOURCE_ATTR, getSourceFrameAt, getEditHistory, planTranscriptCut, applyTranscriptCut, ...decoders } = module.exports;

function fixture() {
  const world = createRuntimeWorld("caption-source-trim");
  world.set(FrameRate, { value: 100 });
  const document = createRuntimeDocument(world);
  let index = 0;
  const add = (tag: string, props: Record<string, unknown>, parent = document.stage) => {
    const node = document.createElement(tag);
    document.setProperty(node, SOURCE_ATTR, `test.tsx:${++index}`);
    for (const [key, value] of Object.entries(props)) document.setProperty(node, key, value);
    document.insertNode(parent, node);
    return node;
  };
  const scene = add("Scene", { active: true, end: 2 });
  return { world, document, add, scene };
}

function asset(words: Transcript[number]["words"]): Asset {
  return {
    type: "TRANSCRIPT", id: "words", path: "words.json", source: "assets/words.json",
    mimeType: "application/json", createdAt: "now",
    handle: { getFile: async () => new File([JSON.stringify([{ text: words.map(word => word.text).join(" "), words }])], "words.json") },
  };
}

test("all caption presets remove cut words from both halves and restore them on undo", async () => {
  const transcript = asset([
    { text: "I", start: 0.1, end: 0.15 },
    { text: "uh", start: 0.15, end: 0.2 },
    { text: "go", start: 0.2, end: 0.25 },
  ]);
  for (const Decoder of Object.values(decoders)) {
    const f = fixture();
    try {
      f.add("Audio", { end: 2 }, f.scene);
      const caption = f.add("Captions", { end: 2 }, f.scene);
      const decoder = new Decoder(transcript);
      await decoder.initialized;
      decoder.seekTo(f.world, caption.entity, 0.12);
      const original = caption.entity.get(Chars)?.value;
      applyTranscriptCut(f.world, planTranscriptCut(f.world, f.scene.entity, 15, 20));
      decoder.seekTo(f.world, caption.entity, 0.12);
      assert.equal(caption.entity.get(Chars)?.value, "I", Decoder.name);
      const copy = f.scene.children.find(node => node !== caption && node.entity.has(Caption))!;
      const second = new Decoder(transcript);
      await second.initialized;
      second.seekTo(f.world, copy.entity, getSourceFrameAt(copy.entity, 17) / 100);
      assert.equal(copy.entity.get(Chars)?.value, "go", Decoder.name);
      applyTranscriptCut(f.world, planTranscriptCut(f.world, f.scene.entity, 5, 10));
      getEditHistory(f.world).undo();
      getEditHistory(f.world).undo();
      decoder.seekTo(f.world, caption.entity, 0.12);
      assert.equal(caption.entity.get(Chars)?.value, original, Decoder.name);
      decoder.dispose();
      second.dispose();
    } finally { f.world.destroy(); }
  }
});

test("caption trimming uses source time at changed speeds and keeps partially audible words", async () => {
  const f = fixture();
  try {
    const caption = f.add("Captions", { start: 1, sourceIn: 0.1, sourceOut: 0.3, playbackRate: 2 }, f.scene);
    const decoder = new decoders.WhisperCaptionDecoder(asset([
      { text: "before", start: 0, end: 0.1 },
      { text: "edge", start: 0.1, end: 0.16 },
      { text: "keep", start: 0.16, end: 0.3 },
      { text: "after", start: 0.3, end: 0.4 },
    ]));
    await decoder.initialized;
    decoder.seekTo(f.world, caption.entity, getSourceFrameAt(caption.entity, 104) / 100);
    assert.equal(caption.entity.get(Chars)?.value, "edge keep");
    f.document.setProperty(caption, "sourceIn", 0.13);
    decoder.seekTo(f.world, caption.entity, getSourceFrameAt(caption.entity, 102) / 100);
    assert.equal(caption.entity.get(Chars)?.value, "edge keep", "the audible part of a boundary word remains");
    f.document.setProperty(caption, "sourceIn", 0.16);
    decoder.seekTo(f.world, caption.entity, getSourceFrameAt(caption.entity, 101) / 100);
    assert.equal(caption.entity.get(Chars)?.value, "keep", "a word ending exactly at sourceIn is excluded");
    decoder.dispose();
  } finally { f.world.destroy(); }
});
