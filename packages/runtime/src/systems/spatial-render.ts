import type { Entity, World } from 'koota';
import { aabbFromTransformedRect, multiply2D, scale2D, translate2D, type Mat2D } from '../math';
import { Cache, Computed, Hidden, Mode, RenderSurface, Root, Stage, StrokeStyle } from '../traits';
import { StrokeJoin } from '../constants';

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Canvas = HTMLCanvasElement | OffscreenCanvas;
type PlaneRenderer = {
  source: Canvas; sourceContext: Context; canvas: OffscreenCanvas;
  gl: WebGL2RenderingContext; program: WebGLProgram;
  matrix: WebGLUniformLocation; size: WebGLUniformLocation; uvScale: WebGLUniformLocation;
  texture: WebGLTexture; matrixValues: Float32Array;
  buffer: WebGLBuffer; maximumSize: number; textureWidth: number; textureHeight: number;
};
const renderers = new WeakMap<World, PlaneRenderer>();

function createRenderer(): PlaneRenderer {
  const source = typeof document === 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
  const sourceContext = source.getContext('2d') as Context | null;
  const canvas = new OffscreenCanvas(1, 1);
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: true });
  if (!sourceContext || !gl) throw new Error('Spatial layers require WebGL 2 and a 2D drawing context');
  const program = gl.createProgram();
  if (!program) throw new Error('Could not create the spatial layer renderer');
  const shaders = [
    [gl.VERTEX_SHADER, `#version 300 es
      in vec2 position;
      uniform mat3 plane;
      uniform vec2 size;
      uniform vec2 uvScale;
      out vec2 uv;
      void main() {
        vec3 p = plane * vec3(position, 1.0);
        gl_Position = vec4(2.0 * p.x / size.x - p.z, p.z - 2.0 * p.y / size.y, 0.0, p.z);
        uv = position * uvScale;
      }`],
    [gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      uniform sampler2D image;
      in vec2 uv;
      out vec4 color;
      void main() { color = texture(image, uv); }`],
  ] as const;
  for (const [type, code] of shaders) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Could not allocate a spatial shader');
    gl.shaderSource(shader, code);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Spatial shader: ${gl.getShaderInfoLog(shader)}`);
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Spatial renderer: ${gl.getProgramInfoLog(program)}`);
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error('Could not allocate spatial geometry');
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  const attribute = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(attribute);
  gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
  const texture = gl.createTexture();
  const matrix = gl.getUniformLocation(program, 'plane');
  const size = gl.getUniformLocation(program, 'size');
  const uvScale = gl.getUniformLocation(program, 'uvScale');
  if (!texture || !matrix || !size || !uvScale) throw new Error('Could not initialize spatial renderer uniforms');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.uniform1i(gl.getUniformLocation(program, 'image'), 0);
  const maximumSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
  return { source, sourceContext, canvas, gl, program, matrix, size, uvScale, texture, buffer, maximumSize, textureWidth: 0, textureHeight: 0, matrixValues: new Float32Array(9) };
}

/** Rasterize native paints once, then project their plane on the GPU. The authored objects remain native. */
export function drawSpatialLayer(world: World, entity: Entity, plane: Mat2D, scene: Entity, draw: () => void): void {
  const surface = world.get(RenderSurface)!;
  const output = surface.ctx!;
  const frame = entity.get(Computed)!;
  const sceneFrame = scene.get(Computed)!;
  if (frame.width <= 0 || frame.height <= 0) return;
  if (Math.abs(plane.g ?? 0) < 1e-9 && Math.abs(plane.h ?? 0) < 1e-9) {
    const denominator = plane.i ?? 1;
    output.save();
    output.transform(plane.a / denominator, plane.b / denominator, plane.c / denominator,
      plane.d / denominator, plane.e / denominator, plane.f / denominator);
    try { draw(); } finally { output.restore(); }
    return;
  }
  let renderer = renderers.get(world);
  if (!renderer) {
    renderer = createRenderer();
    renderers.set(world, renderer);
    const root = world.get(Root);
    const release = world.onRemove(Stage, removed => {
      if (removed !== root) return;
      const renderer = renderers.get(world);
      if (renderer) {
        renderer.gl.deleteTexture(renderer.texture);
        renderer.gl.deleteBuffer(renderer.buffer);
        renderer.gl.deleteProgram(renderer.program);
        renderer.gl.getExtension('WEBGL_lose_context')?.loseContext();
        renderer.source.width = renderer.source.height = renderer.canvas.width = renderer.canvas.height = 1;
      }
      renderers.delete(world);
      release();
    });
  }
  const strokePadding = Math.max(0, ...(entity.get(Cache)?.strokes ?? []).filter(stroke => !stroke.has(Hidden)).map(stroke => {
    const style = stroke.get(StrokeStyle);
    return (stroke.get(Computed)?.strokeWidth ?? 1) / 2 * ((style?.join ?? StrokeJoin.MITER) === StrokeJoin.MITER ? style?.miterLimit ?? 10 : 1);
  }));
  const padding = Math.ceil(strokePadding + Math.max(2, ...((entity.get(Cache)?.shadows ?? []).map(shadow => {
    const values = shadow.get(Computed)!;
    return values.blur * 3 + Math.max(Math.abs(values.offsetX), Math.abs(values.offsetY));
  })), frame.blur * 3));
  const sourceWidth = frame.width + padding * 2, sourceHeight = frame.height + padding * 2;
  const projected = multiply2D(plane, translate2D(-padding, -padding));
  const bounds = aabbFromTransformedRect(projected, sourceWidth, sourceHeight);
  const left = Math.floor(Math.max(-padding, bounds.minX)), top = Math.floor(Math.max(-padding, bounds.minY));
  const right = Math.ceil(Math.min(sceneFrame.width + padding, bounds.maxX));
  const bottom = Math.ceil(Math.min(sceneFrame.height + padding, bounds.maxY));
  if (right <= left || bottom <= top) return;
  const display = output.getTransform();
  const density = Math.max(Math.hypot(display.a, display.b), Math.hypot(display.c, display.d));
  const targetResolution = world.get(Mode)?.value === 'realtime' ? Math.min(surface.resolution, Math.max(.05, density)) : surface.resolution;
  const resolution = Math.min(targetResolution, renderer.maximumSize / Math.max(sourceWidth, sourceHeight, right - left, bottom - top));
  const width = Math.max(1, Math.ceil(sourceWidth * resolution));
  const height = Math.max(1, Math.ceil(sourceHeight * resolution));
  // Retain source and texture capacity too; resizing either for each layer
  // forces GPU storage changes. UV scaling selects this layer's used area.
  if (renderer.source.width < width) renderer.source.width = Math.min(renderer.maximumSize, Math.ceil(width / 256) * 256);
  if (renderer.source.height < height) renderer.source.height = Math.min(renderer.maximumSize, Math.ceil(height / 256) * 256);
  const source = renderer.sourceContext;
  source.setTransform(1, 0, 0, 1, 0, 0);
  // Linear filtering also samples the neighboring texel at the used edge.
  source.clearRect(0, 0, width + 1, height + 1);
  source.setTransform(resolution, 0, 0, resolution, padding * resolution, padding * resolution);
  source.globalAlpha = 1;
  source.globalCompositeOperation = 'source-over';
  source.filter = 'none';
  world.set(RenderSurface, { canvas: renderer.source, ctx: source, resolution });
  try { draw(); } finally { world.set(RenderSurface, surface); }

  const outWidth = Math.max(1, Math.ceil((right - left) * resolution));
  const outHeight = Math.max(1, Math.ceil((bottom - top) * resolution));
  // Resizing a WebGL drawing buffer synchronizes the GPU. Retain capacity as
  // differently sized layers pass through this shared renderer.
  if (renderer.canvas.width < outWidth) renderer.canvas.width = Math.min(renderer.maximumSize, Math.ceil(outWidth / 256) * 256);
  if (renderer.canvas.height < outHeight) renderer.canvas.height = Math.min(renderer.maximumSize, Math.ceil(outHeight / 256) * 256);
  const matrix = multiply2D(
    multiply2D(scale2D(resolution, resolution), translate2D(-left, -top)),
    multiply2D(projected, scale2D(sourceWidth, sourceHeight)),
  );
  renderer.matrixValues.set([matrix.a, matrix.b, matrix.g ?? 0, matrix.c, matrix.d, matrix.h ?? 0, matrix.e, matrix.f, matrix.i ?? 1]);
  const gl = renderer.gl;
  gl.viewport(0, renderer.canvas.height - outHeight, outWidth, outHeight);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(renderer.program);
  gl.bindTexture(gl.TEXTURE_2D, renderer.texture);
  if (renderer.textureWidth !== renderer.source.width || renderer.textureHeight !== renderer.source.height) {
    renderer.textureWidth = renderer.source.width;
    renderer.textureHeight = renderer.source.height;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, renderer.textureWidth, renderer.textureHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, renderer.source);
  gl.uniformMatrix3fv(renderer.matrix, false, renderer.matrixValues);
  gl.uniform2f(renderer.size, outWidth, outHeight);
  gl.uniform2f(renderer.uvScale, width / renderer.textureWidth, height / renderer.textureHeight);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  output.drawImage(renderer.canvas, 0, 0, outWidth, outHeight, left, top, outWidth / resolution, outHeight / resolution);
}
