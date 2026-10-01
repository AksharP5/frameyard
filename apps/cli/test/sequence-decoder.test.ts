import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { build } from "esbuild";
import type { SequenceAsset } from "../../../packages/assets/src/types.ts";
import type { SequenceDecoder } from "../../../packages/runtime/src/media/sequence.ts";

const compiled = await build({
  entryPoints: [new URL("../../../packages/runtime/src/media/sequence.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "cjs", platform: "node",
});

type Bitmap = { name: string; width: number; height: number; close(): void };

function fixture(options: {
  read?: (name: string) => Promise<File>;
  decode?: (file: File) => Promise<Bitmap>;
  draw?: (name: string | undefined) => void;
  listError?: Error;
  listReady?: Promise<void>;
  frameCount?: number;
} = {}) {
  class Canvas {
    width: number;
    height: number;
    constructor(width: number, height: number) { this.width = width; this.height = height; }
    getContext() {
      return { clearRect() {}, drawImage(image: { name?: string }) { options.draw?.(image.name); }, resetTransform() {}, translate() {}, rotate() {} };
    }
  }
  const read = options.read ?? (async (name: string) => new File([name], name));
  const decode = options.decode ?? (async (file: File) => ({ name: file.name, width: 2, height: 2, close() {} }));
  const exports: { SequenceDecoder?: typeof SequenceDecoder } = {};
  const context = { module: { exports }, OffscreenCanvas: Canvas, VideoFrame: class {}, createImageBitmap: decode, Error, setTimeout, clearTimeout };
  runInNewContext(compiled.outputFiles[0].text, context);
  const Decoder = context.module.exports.SequenceDecoder!;
  const asset: SequenceAsset = {
    id: "animation", path: "animation.frames", source: "assets/animation.frames", createdAt: "", mimeType: "image/png",
    type: "SEQUENCE", width: 2, height: 2, duration: (options.frameCount ?? 2) / 30, frameRate: 30,
    handle: { getFile: () => read("frame000001.png") },
    directoryHandle: { async *entries() {
      if (options.listReady) await options.listReady;
      if (options.listError) throw options.listError;
      for (let index = 1; index <= (options.frameCount ?? 2); index++) {
        const name = `frame${String(index).padStart(6, "0")}.png`;
        yield [name, { kind: "file", getFile: () => read(name) }];
      }
    } },
  };
  return (cached = false) => new Decoder(asset, cached);
}

test("an unreadable sequence frame fails preview and export instead of repeating the previous picture", async () => {
  for (const failure of ["read", "decode"]) {
    let broken = true;
    const create = fixture({
      read: async (name) => {
        if (broken && name === "frame000002.png" && failure === "read") throw new Error("file disappeared");
        return new File([name], name);
      },
      decode: async (file) => {
        if (broken && file.name === "frame000002.png" && failure === "decode") throw new Error("invalid PNG");
        return { name: file.name, width: 2, height: 2, close() {} };
      },
    });
    const decoder = create();
    try {
      await decoder.seekTo(0, 30);
      assert.ok(decoder.toBitmap());
      await assert.rejects(decoder.seekTo(1, 30), /frame000002\.png in animation\.frames: Error: (file disappeared|invalid PNG)/);
      assert.equal(decoder.errored, true);
      assert.equal(decoder.toBitmap(), null);
    } finally { decoder.dispose(); }

    // Re-rendering changes the asset identity and creates a fresh decoder.
    broken = false;
    const repaired = create();
    try {
      await repaired.seekTo(1, 30);
      assert.equal(repaired.errored, false);
      assert.ok(repaired.toBitmap());
    } finally { repaired.dispose(); }
  }
});

test("a failed realtime background fill exposes the missing-media state without rejecting an unawaited seek", async () => {
  const create = fixture({ decode: async (file) => {
    if (file.name === "frame000002.png") throw new Error("invalid PNG");
    return { name: file.name, width: 2, height: 2, close() {} };
  } });
  const decoder = create(true);
  try {
    await decoder.initialized;
    await decoder.seekTo(0, 30);
    await setImmediate();
    assert.equal(decoder.errored, true);
    assert.equal(decoder.toBitmap(), null);
    await decoder.seekTo(1, 30);
    decoder.hasCache = false;
    await assert.rejects(decoder.seekTo(1, 30), /frame000002\.png.*invalid PNG/);
  } finally { decoder.dispose(); }
});

test("a missing frame directory fails an awaited seek", async () => {
  const decoder = fixture({ listError: new Error("directory disappeared") })();
  try {
    await assert.rejects(decoder.seekTo(0, 30), /animation\.frames.*directory disappeared/);
    assert.equal(decoder.toBitmap(), null);
  } finally { decoder.dispose(); }
});

test("disposing during a pending frame read or decode suppresses cancellation errors and releases the bitmap", async () => {
  for (const stage of ["read", "decode"]) {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let closed = 0;
    const decoder = fixture({
      read: async (name) => {
        if (stage === "read") { started.resolve(); await release.promise; throw new Error("read canceled"); }
        return new File([name], name);
      },
      decode: async (file) => {
        started.resolve();
        await release.promise;
        return { name: file.name, width: 2, height: 2, close() { closed++; } };
      },
    })();
    const seek = decoder.seekTo(0, 30);
    await started.promise;
    decoder.dispose();
    release.resolve();
    await seek;
    assert.equal(decoder.errored, false);
    assert.equal(decoder.toBitmap(), null);
    assert.equal(closed, stage === "decode" ? 1 : 0);
  }
});

test("repeated playback seeks preserve a sequence's pending first picture and forward prefetch", async () => {
  for (const advance of [false, true]) {
    const reads: { name: string; done: ReturnType<typeof Promise.withResolvers<File>> }[] = [];
    const decoder = fixture({ frameCount: 60, read: async (name) => {
      const done = Promise.withResolvers<File>();
      reads.push({ name, done });
      return done.promise;
    } })(true);
    try {
      await decoder.initialized;
      await decoder.seekTo(0, 30);
      await setImmediate();
      assert.equal(reads.length, 1);
      for (const frame of [1, 2, 3]) await decoder.seekTo(advance ? frame : 0, 30);
      reads[0].done.resolve(new File([], reads[0].name));
      await setImmediate();
      assert.equal(decoder.cache.has(0), true, 'an advancing or repeated target must not discard a completed useful read');
      assert.equal(reads[1]?.name, 'frame000002.png', 'forward prefetch continues from the pending frame');
      if (!advance) assert.ok(decoder.toBitmap(), 'startup must present the first picture even when its read took more than one tick');
    } finally {
      decoder.dispose();
      for (const read of reads) read.done.resolve(new File([], read.name));
    }
  }
});

test("sequence playback catches up after an initial read stall and continues from its prefetched frames", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const reads: string[] = [];
  const decoder = fixture({ frameCount: 120, read: async (name) => {
    reads.push(name);
    if (name === 'frame000001.png') { started.resolve(); await release.promise; }
    return new File([], name);
  } })(true);
  try {
    await decoder.initialized;
    await decoder.seekTo(0, 30);
    await started.promise;
    for (const frame of [1, 2, 3]) await decoder.seekTo(frame, 30);
    release.resolve();
    await setImmediate();
    assert.equal(decoder.cache.has(0), true);
    for (let frame = 4; frame < 100; frame++) {
      await decoder.seekTo(frame, 30);
      await setImmediate();
      assert.equal(decoder.cache.has(frame), true, `frame ${frame} should be ready as playback advances`);
      assert.ok(decoder.toBitmap());
    }
    assert.equal(new Set(reads).size, reads.length, 'normal forward playback does not reread discarded in-flight frames');
  } finally { release.resolve(); decoder.dispose(); }
});

test("playback preparation refills idle sequences without waking paused same-frame seeks", async () => {
  for (const frameCount of [1, 2, 60]) {
    const decoder = fixture({ frameCount })(true);
    try {
      await decoder.initialized;
      await decoder.seekTo(0, 30);
      await setImmediate();
      assert.ok(decoder.toBitmap());
      decoder.idle();
      await decoder.seekTo(0, 30);
      assert.equal(decoder.mode, 'idle');
      assert.ok(decoder.toBitmap());
      assert.equal(decoder.cache.atlas.width, 0);
      assert.equal(decoder.prepareForPlayback(0, 30, frameCount), false);
      await setImmediate();
      assert.equal(decoder.prepareForPlayback(0, 30, frameCount), true);
      assert.equal(decoder.mode, 'alive');
    } finally { decoder.dispose(); }
  }
});

test("sequence preparation waits for forward frames only inside the clip's trim", async () => {
  for (const end of [1, 60]) {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const decoder = fixture({ frameCount: 60, read: async (name) => {
      if (name === 'frame000002.png') { started.resolve(); await release.promise; }
      return new File([], name);
    } })(true);
    try {
      await decoder.initialized;
      assert.equal(decoder.prepareForPlayback(0, 30, end), false);
      await started.promise;
      assert.ok(decoder.toBitmap());
      assert.equal(decoder.prepareForPlayback(0, 30, end), end === 1);
      release.resolve();
      await setImmediate();
      assert.equal(decoder.prepareForPlayback(0, 30, end), true);
      decoder.frameRate = 30000 / 1001;
      assert.equal(decoder.prepareForPlayback(58, 60000 / 1001, 60), true, 'a retimed trim tail needs only its final source frame');
      assert.equal(decoder.currentFrame, 29);
    } finally { release.resolve(); decoder.dispose(); }
  }
});

test("sequence preparation waits for directory initialization and the first decoded frames", async () => {
  const listed = Promise.withResolvers<void>();
  const read = Promise.withResolvers<void>();
  const decoder = fixture({ listReady: listed.promise, read: async (name) => {
    await read.promise;
    return new File([], name);
  } })(true);
  try {
    assert.equal(decoder.prepareForPlayback(0, 30, 2), false);
    listed.resolve();
    await decoder.initialized;
    assert.equal(decoder.prepareForPlayback(0, 30, 2), false);
    read.resolve();
    await setImmediate();
    assert.equal(decoder.prepareForPlayback(0, 30, 2), true);
    assert.ok(decoder.toBitmap());
  } finally { listed.resolve(); read.resolve(); decoder.dispose(); }
});

test("cold sequence seeks hold the last picture through a higher-rate project's final tick", async () => {
  for (const cached of [false, true]) {
    const listed = Promise.withResolvers<void>();
    const reads: string[] = [];
    const decoder = fixture({ frameCount: 30, listReady: listed.promise, read: async (name) => {
      reads.push(name);
      return new File([], name);
    } })(cached);
    try {
      // Export can request a frame before the directory has finished loading.
      if (cached) { listed.resolve(); await decoder.initialized; }
      const seek = decoder.seekTo(59, 60);
      listed.resolve();
      await seek;
      await setImmediate();
      assert.ok(decoder.toBitmap(), '0.983 seconds is inside the one-second sequence');
      assert.deepEqual(reads, ['frame000030.png']);
      await decoder.seekTo(60, 60);
      await setImmediate();
      assert.ok(decoder.toBitmap(), 'a transition extending past the source holds its last picture');
      assert.deepEqual(reads, ['frame000030.png']);
    } finally { listed.resolve(); decoder.dispose(); }
  }
});

test("higher-rate sequence exports decode each held source picture only once", async () => {
  const reads: string[] = [];
  const decoder = fixture({ frameCount: 30, read: async (name) => {
    reads.push(name);
    return new File([], name);
  } })();
  try {
    for (let frame = 0; frame < 60; frame++) await decoder.seekTo(frame, 60);
    assert.equal(reads.length, 30, '60 output frames require only 30 PNG reads and decodes');
    assert.equal(new Set(reads).size, 30);
    assert.ok(decoder.toBitmap());
  } finally { decoder.dispose(); }
});

test("export reuse preserves full resolution when switching to and from cached preview", async () => {
  let decoded = 0;
  const decoder = fixture({ decode: async (file) => {
    decoded++;
    return { name: file.name, width: 1920, height: 1080, close() {} };
  } })(true);
  try {
    await decoder.initialized;
    await decoder.seekTo(0, 30);
    await setImmediate();
    assert.equal(decoder.toBitmap()?.width, 960);
    for (const frame of [0, 1]) {
      decoder.hasCache = false;
      await decoder.seekTo(frame, 30);
      assert.equal(decoder.toBitmap()?.width, 1920, 'export must decode beyond the preview resolution');
      const before = decoded;
      await decoder.seekTo(frame, 30);
      assert.equal(decoded, before, 'an unchanged full-resolution picture needs no second decode');
      decoder.hasCache = true;
      await decoder.seekTo(1, 30);
    }
  } finally { decoder.dispose(); }
});

test("returning to a displayed sequence picture cancels an older pending export seek", async () => {
  for (const cached of [false, true]) {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const drawn: (string | undefined)[] = [];
    let block = false;
    let closed = 0;
    const decoder = fixture({
      draw: (name) => drawn.push(name),
      decode: async (file) => {
        if (block && file.name === 'frame000002.png') { started.resolve(); await release.promise; }
        return { name: file.name, width: 2, height: 2, close() { closed++; } };
      },
    })(cached);
    try {
      await decoder.initialized;
      await decoder.seekTo(0, 30);
      await setImmediate();
      block = true;
      decoder.hasCache = false;
      const pending = decoder.seekTo(1, 30);
      await started.promise;
      decoder.hasCache = cached;
      await decoder.seekTo(0, 30);
      const before = drawn.length;
      const closedBefore = closed;
      release.resolve();
      await pending;
      assert.equal(drawn.length, before, 'the obsolete frame cannot replace the requested picture');
      assert.equal(closed, closedBefore + 1, 'the canceled decoded bitmap is released');
    } finally { release.resolve(); decoder.dispose(); }
  }
});
