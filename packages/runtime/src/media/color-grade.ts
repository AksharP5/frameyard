/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ColorGrade, Mode, Root, Stage } from '../traits';
import { COLOR_LUT_SIZE, colorBalance, colorCurveLut } from './color-grade-settings';
import type { ColorGradeSettings } from '@diffusionstudio/jsx';
import type { Entity, World } from 'koota';

export type ColorGradeFrame = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas;

const VERTEX = `#version 300 es
out vec2 uv;
void main() {
  vec2 point = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  uv = vec2(point.x, 1.0 - point.y);
  gl_Position = vec4(point * 2.0 - 1.0, 0.0, 1.0);
}`;
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
uniform sampler2D source;
uniform sampler2D curves;
uniform vec3 balance;
vec3 toLinear(vec3 value) {
  return mix(value / 12.92, pow((value + .055) / 1.055, vec3(2.4)), step(vec3(.04045), value));
}
vec3 toDisplay(vec3 value) {
  return mix(value * 12.92, 1.055 * pow(value, vec3(1.0 / 2.4)) - .055, step(vec3(.0031308), value));
}
void main() {
  vec4 pixel = texture(source, uv);
  vec3 rgb = clamp(toDisplay(toLinear(pixel.a > 0.0 ? pixel.rgb / pixel.a : vec3(0.0)) * balance), 0.0, 1.0);
  vec3 sampleAt = (rgb * ${COLOR_LUT_SIZE - 1}.0 + .5) / ${COLOR_LUT_SIZE}.0;
  rgb = vec3(texture(curves, vec2(sampleAt.r, .5)).r,
             texture(curves, vec2(sampleAt.g, .5)).g,
             texture(curves, vec2(sampleAt.b, .5)).b);
  color = vec4(rgb * pixel.a, pixel.a);
}`;

/** One GPU pass, shared by the world's clips and scene. Alpha remains premultiplied at output. */
export class ColorGradeProcessor {
  private canvas = new OffscreenCanvas(1, 1);
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private source: WebGLTexture;
  private curves: WebGLTexture;
  private balance: WebGLUniformLocation;
  private settings: ColorGradeSettings | undefined;
  private settingsCache = new WeakMap<ColorGradeSettings, { balance: [number, number, number]; lut: Uint8Array<ArrayBuffer> }>();
  private maximumSize: number;

  constructor() {
    const gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) throw new Error('Color grading requires WebGL 2. Enable GPU acceleration and reopen the project.');
    this.gl = gl;
    this.maximumSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const error = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`Color grading shader failed: ${error}`);
      }
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, VERTEX), fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram()!;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Color grading could not start: ${gl.getProgramInfoLog(program)}`);
    this.program = program;
    gl.useProgram(program);
    gl.disable(gl.DITHER);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.uniform1i(gl.getUniformLocation(program, 'source'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'curves'), 1);
    this.balance = gl.getUniformLocation(program, 'balance')!;
    const texture = (unit: number) => {
      const result = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, result);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return result;
    };
    this.source = texture(0);
    this.curves = texture(1);
  }

  render(source: ColorGradeFrame, settings: ColorGradeSettings): OffscreenCanvas {
    const gl = this.gl;
    if (gl.isContextLost()) throw new Error('Color grading lost its GPU context. Reopen the project before exporting.');
    const width = source.width, height = source.height;
    if (width > this.maximumSize || height > this.maximumSize) {
      throw new Error('This image exceeds the GPU size limit for color grading.');
    }
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
    if (settings !== this.settings) {
      let prepared = this.settingsCache.get(settings);
      if (!prepared) {
        prepared = { balance: colorBalance(settings), lut: colorCurveLut(settings) };
        this.settingsCache.set(settings, prepared);
      }
      gl.uniform3f(this.balance, ...prepared.balance);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.curves);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, COLOR_LUT_SIZE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, prepared.lut);
      this.settings = settings;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.source);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return this.canvas;
  }

  dispose() {
    this.gl.deleteTexture(this.source);
    this.gl.deleteTexture(this.curves);
    this.gl.deleteProgram(this.program);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.width = this.canvas.height = 1;
  }
}

type GradeState = { processor?: ColorGradeProcessor; unavailable?: string; errors: Map<Entity, string> };
const states = new WeakMap<World, GradeState>();

export function colorGradeError(world: World, entity: Entity): string | undefined {
  return entity.has(ColorGrade) ? states.get(world)?.errors.get(entity) : undefined;
}

/** Returns the original bitmap at neutral settings, with no texture upload or new canvas. */
export function gradeFrame(world: World, entity: Entity, frame: ColorGradeFrame): ColorGradeFrame {
  const settings = entity.get(ColorGrade)?.value;
  if (!settings || Object.keys(settings).length === 0) return frame;
  let state = states.get(world);
  if (!state) {
    state = { errors: new Map() };
    states.set(world, state);
    const root = world.get(Root);
    const release = world.onRemove(Stage, (entity) => {
      if (entity !== root) return;
      states.get(world)?.processor?.dispose();
      states.delete(world);
      release();
    });
  }
  try {
    if (state.unavailable) throw new Error(state.unavailable);
    state.processor ??= new ColorGradeProcessor();
    const output = state.processor.render(frame, settings);
    state.errors.delete(entity);
    return output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (state.errors.get(entity) !== message) console.error(message);
    state.errors.set(entity, message);
    if (!state.processor) state.unavailable = message;
    if (world.get(Mode)?.value !== 'realtime') throw error;
    return frame;
  }
}
