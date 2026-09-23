import { type Entity, type World } from 'koota';
import { Computed, Root, Stage } from '../traits';
import { invert2D, type Mat2D } from '../math';

type Frame = HTMLCanvasElement | OffscreenCanvas;
const VERTEX = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  uv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
uniform sampler2D image;
uniform vec2 size;
uniform vec4 effects;
uniform vec4 material;
uniform vec2 layerSize;
uniform mat3 local;
uniform float frame;
uniform int mode;
vec4 blurred(vec2 point, float radius) {
  vec2 stepSize = radius / size;
  vec4 value = texture(image, point) * .2;
  for (int n = 0; n < 8; n++) {
    float angle = float(n) * .7853981634;
    value += texture(image, point + vec2(cos(angle), sin(angle)) * stepSize) * .1;
  }
  return value;
}
void main() {
  if (mode == 1) {
    vec3 mapped = local * vec3(uv * size, 1.0);
    vec2 p = mapped.xy / mapped.z - layerSize * .5;
    float radius = min(material.z, min(layerSize.x, layerSize.y) * .5);
    vec2 q = abs(p) - layerSize * .5 + radius;
    float distance = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
    vec2 normal = normalize(max(q, vec2(.001))) * sign(p);
    if (q.x < 0.0 && q.y < 0.0) normal = q.x > q.y ? vec2(sign(p.x), 0.0) : vec2(0.0, sign(p.y));
    float edge = 1.0 - smoothstep(0.0, max(4.0, radius + 12.0), -distance);
    vec2 shift = (normal * edge * edge * 22.0 + p * .018) * material.x;
    color = blurred(uv + shift / size, material.y);
    float rim = (1.0 - smoothstep(0.0, 2.0, abs(distance))) * material.x;
    float light = .2 + .8 * max(0.0, dot(normal, normalize(vec2(-.5, -1.0))));
    color.rgb = mix(color.rgb, vec3(color.a), rim * light * .5);
    return;
  }
  vec4 base = texture(image, uv);
  vec2 split = vec2(effects.w / size.x, 0.0);
  vec4 red = texture(image, uv + split), blue = texture(image, uv - split);
  base = vec4(red.r, base.g, blue.b, max(base.a, max(red.a, blue.a)));
  vec4 glow = vec4(0.0);
  if (effects.x > 0.0) {
    for (int n = 0; n < 3; n++) {
      vec4 sampleColor = blurred(uv, 5.0 + float(n) * 9.0);
      float bright = smoothstep(.45, .95, max(sampleColor.r, max(sampleColor.g, sampleColor.b)));
      glow += sampleColor * bright / 3.0;
    }
  }
  base.rgb += glow.rgb * effects.x;
  base.a = max(base.a, glow.a * effects.x);
  vec2 p = uv * 2.0 - 1.0;
  base.rgb *= 1.0 - effects.y * smoothstep(.25, 1.5, dot(p, p));
  float noise = fract(sin(dot(floor(uv * size), vec2(12.9898, 78.233)) + frame * .7123) * 43758.5453) - .5;
  base.rgb += noise * effects.z * .13 * base.a;
  color = vec4(clamp(base.rgb, vec3(0.0), vec3(base.a)), base.a);
}`;

class MotionEffects {
  readonly canvas = new OffscreenCanvas(1, 1);
  readonly gl: WebGL2RenderingContext;
  readonly program: WebGLProgram;
  readonly texture: WebGLTexture;
  readonly uniforms: Record<'size' | 'effects' | 'material' | 'layerSize' | 'local' | 'frame' | 'mode', WebGLUniformLocation>;
  private readonly matrix = new Float32Array(9);
  private readonly maximumSize: number;

  constructor() {
    const gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, depth: false, stencil: false, antialias: false });
    if (!gl) throw new Error('Motion effects require WebGL 2');
    this.gl = gl;
    this.maximumSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.program = gl.createProgram()!;
    for (const [type, code] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, code); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Motion effects: ${gl.getShaderInfoLog(shader)}`);
      gl.attachShader(this.program, shader); gl.deleteShader(shader);
    }
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(`Motion effects: ${gl.getProgramInfoLog(this.program)}`);
    gl.useProgram(this.program);
    this.uniforms = {
      size: gl.getUniformLocation(this.program, 'size')!, effects: gl.getUniformLocation(this.program, 'effects')!,
      material: gl.getUniformLocation(this.program, 'material')!, layerSize: gl.getUniformLocation(this.program, 'layerSize')!,
      local: gl.getUniformLocation(this.program, 'local')!, frame: gl.getUniformLocation(this.program, 'frame')!, mode: gl.getUniformLocation(this.program, 'mode')!,
    };
    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.uniform1i(gl.getUniformLocation(this.program, 'image'), 0);
  }

  render(source: Frame, entity: Entity, resolution: number, plane?: Mat2D): Frame {
    const gl = this.gl, c = entity.get(Computed)!;
    if (gl.isContextLost()) throw new Error('Motion effects lost their GPU context. Reopen the project.');
    if (source.width > this.maximumSize || source.height > this.maximumSize) throw new Error('Motion effects exceed the GPU texture size limit');
    if (this.canvas.width !== source.width) this.canvas.width = source.width;
    if (this.canvas.height !== source.height) this.canvas.height = source.height;
    gl.viewport(0, 0, source.width, source.height);
    gl.useProgram(this.program);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.uniform2f(this.uniforms.size, source.width, source.height);
    gl.uniform1i(this.uniforms.mode, plane ? 1 : 0);
    if (plane) {
      const inverse = invert2D(plane);
      this.matrix.set([inverse.a, inverse.b, inverse.g ?? 0, inverse.c, inverse.d, inverse.h ?? 0, inverse.e, inverse.f, inverse.i ?? 1]);
      gl.uniformMatrix3fv(this.uniforms.local, false, this.matrix);
      gl.uniform2f(this.uniforms.layerSize, c.width, c.height);
      gl.uniform4f(this.uniforms.material, c.refraction, c.backdropBlur * resolution, c.cornerRadius, 0);
    } else {
      gl.uniform4f(this.uniforms.effects, c.bloom, c.vignette, c.grain, c.colorSplit * resolution);
      gl.uniform1f(this.uniforms.frame, Math.floor(c.localTime));
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return this.canvas;
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
    this.gl.deleteProgram(this.program);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.width = this.canvas.height = 1;
  }
}

const states = new WeakMap<World, MotionEffects>();

/** Neutral settings do no work; effects sample the current composition, never a previous playback frame. */
export function motionEffectsFrame(world: World, entity: Entity, source: Frame, resolution: number, plane?: Mat2D): Frame {
  const c = entity.get(Computed)!;
  if (plane ? !c.backdropBlur && !c.refraction : !c.bloom && !c.vignette && !c.grain && !c.colorSplit) return source;
  let effects = states.get(world);
  if (!effects) {
    effects = new MotionEffects();
    states.set(world, effects);
    const root = world.get(Root);
    const release = world.onRemove(Stage, entity => {
      if (entity !== root) return;
      states.get(world)?.dispose(); states.delete(world); release();
    });
  }
  return effects.render(source, entity, resolution, plane);
}
