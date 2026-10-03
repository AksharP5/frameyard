import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: [new URL('../../../packages/runtime/src/media/shader.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'cjs', platform: 'node',
  external: ['../traits', '../utils/color'],
});

const code = `
@group(1) @binding(0) var<uniform> strength: f32;
@group(1) @binding(1) var<uniform> tint: vec4f;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return tint * strength;
}`;
type CompilationInfo = { messages: { type: string; lineNum: number; linePos: number; message: string }[] };

function fixture(compilationInfo: (source: string) => Promise<CompilationInfo> = async () => ({ messages: [] })) {
  class Buffer {
    destroys = 0;
    readonly size: number;
    readonly writes: { data: Float32Array; values: number[] }[] = [];
    constructor(size: number) { this.size = size; }
    destroy() { this.destroys++; }
  }
  class Texture {
    destroys = 0;
    readonly width: number;
    readonly height: number;
    constructor(size: number[]) { [this.width, this.height] = size; }
    destroy() { this.destroys++; }
    createView() { return {}; }
  }
  const buffers: Buffer[] = [], textures: Texture[] = [], errors: unknown[][] = [];
  const failure = { at: null as 'pipeline' | 'bind-group' | null };
  const device = {
    createShaderModule: ({ code: source }: { code: string }) => ({ getCompilationInfo: () => compilationInfo(source) }),
    createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}), createSampler: () => ({}),
    createRenderPipeline() {
      if (failure.at === 'pipeline') throw new Error('pipeline creation failed');
      return {};
    },
    createBindGroup() {
      if (failure.at === 'bind-group') throw new Error('bind group creation failed');
      return {};
    },
    createBuffer: ({ size }: { size: number }) => { const buffer = new Buffer(size); buffers.push(buffer); return buffer; },
    createTexture: ({ size }: { size: number[] }) => { const texture = new Texture(size); textures.push(texture); return texture; },
    createCommandEncoder: () => ({
      beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }),
      finish: () => ({}),
    }),
    queue: {
      writeBuffer: (buffer: Buffer, _offset: number, data: Float32Array) => buffer.writes.push({ data, values: [...data] }),
      submit() {}, copyExternalImageToTexture() {},
    },
  };
  const context = {
    unconfigures: 0,
    configure() {}, unconfigure() { this.unconfigures++; },
    getCurrentTexture: () => ({ createView: () => ({}) }),
  };
  class Canvas {
    width: number;
    height: number;
    constructor(width: number, height: number) { this.width = width; this.height = height; }
    getContext() { return context; }
  }
  const module = { exports: {} as Pick<typeof import('../../../packages/runtime/src/media/shader.ts'), 'ShaderHost'> };
  runInNewContext(compiled.outputFiles[0].text, {
    module,
    require: (name: string) => name === '../traits' ? {} : { parseColor: (value: string) => value === '#ff0055' ? 0xff0055 : null },
    OffscreenCanvas: Canvas,
    navigator: { gpu: { requestAdapter: async () => ({ requestDevice: async () => device }), getPreferredCanvasFormat: () => 'rgba8unorm' } },
    GPUShaderStage: { FRAGMENT: 1 }, GPUBufferUsage: { UNIFORM: 1, COPY_DST: 2 },
    GPUTextureUsage: { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4 },
    console: { error: (...args: unknown[]) => errors.push(args), warn() {} },
  });
  const host = new module.exports.ShaderHost();
  const draw = (uniforms: Parameters<typeof host.draw>[8]) => host.draw(
    { drawImage() {} } as unknown as CanvasRenderingContext2D,
    2, 2, null, 0, 0, [0, 0, 2, 2], 0, uniforms,
  );
  return { host, draw, buffers, textures, context, failure, errors };
}

test('shader uniforms reset omitted components and reuse their upload arrays', async () => {
  const f = fixture();
  try {
    f.host.setCode(code);
    await f.host.whenReady();
    assert.equal(f.draw({ strength: 0.75, tint: [1, 0.5, 0.25, 1] }), true);
    const strength = f.buffers.find(buffer => buffer.size === 4)!;
    const tint = f.buffers.find(buffer => buffer.size === 16)!;
    f.draw({ tint: [0.5] });
    assert.deepEqual(strength.writes.at(-1)!.values, [0], 'removing a scalar restores its documented zero default');
    assert.deepEqual(tint.writes.at(-1)!.values, [0.5, 0, 0, 0], 'short arrays do not retain preceding components');
    f.draw({ tint: '#ff0055' });
    assert.deepEqual(tint.writes.at(-1)!.values, [1, 0, Math.fround(1 / 3), 1]);
    f.draw({ tint: '' });
    assert.deepEqual(tint.writes.at(-1)!.values, [0, 0, 0, 0], 'an empty color cannot retain the preceding tint');
    f.draw(null);
    assert.deepEqual(tint.writes.at(-1)!.values, [0, 0, 0, 0]);
    assert.ok(strength.writes.every(write => write.data === strength.writes[0].data));
    assert.ok(tint.writes.every(write => write.data === tint.writes[0].data));
  } finally { f.host.dispose(); }
});

test('changing shader code retires its buffers and texture and renders passthrough while compiling', async () => {
  const pending = Promise.withResolvers<CompilationInfo>();
  const f = fixture(source => source.includes('// pending') ? pending.promise : Promise.resolve({ messages: [] }));
  try {
    f.host.setCode(code);
    await f.host.whenReady();
    f.draw({ strength: 1 });
    const oldBuffers = [...f.buffers];
    const oldTexture = f.textures[0];
    f.host.setCode(code + '\n// pending');
    assert.equal(f.host.ready, false);
    assert.equal(f.draw({ strength: 0.5 }), false, 'the previous shader cannot keep replacing the media');
    assert.ok(oldBuffers.every(buffer => buffer.destroys === 1));
    assert.equal(oldTexture.destroys, 1);
    pending.resolve({ messages: [] });
    await f.host.whenReady();
    assert.equal(f.host.ready, true);
    f.draw({ strength: 0.5 });
  } finally { pending.resolve({ messages: [] }); f.host.dispose(); f.host.dispose(); }
  assert.ok(f.buffers.every(buffer => buffer.destroys === 1));
  assert.ok(f.textures.every(texture => texture.destroys === 1));
  assert.equal(f.context.unconfigures, 1);
});

test('failed shader compilation retires active and partially created buffers', async () => {
  for (const failure of ['wgsl', 'pipeline', 'bind-group'] as const) {
    const f = fixture(async source => ({ messages: source.includes('// invalid') ? [{ type: 'error', lineNum: 1, linePos: 1, message: 'invalid WGSL' }] : [] }));
    try {
      f.host.setCode(code);
      await f.host.whenReady();
      f.failure.at = failure === 'wgsl' ? null : failure;
      f.host.setCode(code + (failure === 'wgsl' ? '\n// invalid' : '\n// edited'));
      await f.host.whenReady();
      assert.equal(f.host.ready, false, failure);
      assert.equal(f.draw({ strength: 1 }), false);
      assert.equal(f.errors.length, 1);
      assert.ok(f.buffers.every(buffer => buffer.destroys === 1), `${failure}: all allocated buffers are released`);
    } finally { f.host.dispose(); }
    assert.ok(f.buffers.every(buffer => buffer.destroys === 1));
  }
});

test('superseded or disposed shader compilations cannot install a stale pipeline', async () => {
  for (const stop of ['supersede', 'dispose'] as const) {
    const started = Promise.withResolvers<void>(), pending = Promise.withResolvers<CompilationInfo>();
    const f = fixture(source => {
      if (!source.includes('// pending')) return Promise.resolve({ messages: [] });
      started.resolve();
      return pending.promise;
    });
    try {
      f.host.setCode(code + '\n// pending');
      const stale = f.host.whenReady();
      await started.promise;
      if (stop === 'supersede') {
        f.host.setCode(code);
        await f.host.whenReady();
      } else f.host.dispose();
      const count = f.buffers.length;
      pending.resolve({ messages: [] });
      await stale;
      await setImmediate();
      assert.equal(f.buffers.length, count, `${stop}: stale compilation allocates no buffers`);
      assert.equal(f.host.ready, stop === 'supersede');
      assert.equal(f.draw({ strength: 1 }), stop === 'supersede');
    } finally { pending.resolve({ messages: [] }); f.host.dispose(); }
    assert.ok(f.buffers.every(buffer => buffer.destroys === 1));
  }
});
