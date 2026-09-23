/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Or, type Entity, type World } from 'koota';
import { Computed, Hidden, Highlight, Preset, LocalTransform, RenderSurface, ColorGrade, SceneEffects, LayerMaterial, Scene, Geometry, Group, Mode } from '../traits';
import { getParentNode } from '../queries/hierarchy';
import { store } from '../world/store';
import { gradeFrame } from '../media/color-grade';
import { motionEffectsFrame } from '../media/motion-effects';
import { colorScopesTarget, sampleColorScopes } from '../media/color-scopes';
import { isScene } from '../queries/predicates';

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Buffer = { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: Context };
type SceneBuffers = { scene: Buffer; source: Buffer };
type RenderState = { scenes: Map<Entity, SceneBuffers>; active: SceneBuffers | null };
const states = new WeakMap<World, RenderState>();

function makeBuffer(): Buffer {
  const canvas = typeof document === 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
  const ctx = canvas.getContext('2d') as Context | null;
  if (!ctx) throw new Error('Scene effects require a 2D canvas');
  return { canvas, ctx };
}

function resize(buffer: Buffer, width: number, height: number): void {
  if (buffer.canvas.width !== width) buffer.canvas.width = width;
  if (buffer.canvas.height !== height) buffer.canvas.height = height;
  buffer.ctx.setTransform(1, 0, 0, 1, 0, 0);
  buffer.ctx.clearRect(0, 0, width, height);
}

/** Retain two canvases per currently affected scene, scoped to this render world. */
export function prepareSceneEffects(world: World): void {
  let state = states.get(world);
  if (!state) {
    state = { scenes: new Map(), active: null };
    states.set(world, state);
  }
  const needed = new Set<Entity>();
  for (const scene of world.query(Scene)) {
    const values = scene.get(Computed)!;
    if (scene.has(Hidden) || values.visibility === 0) continue;
    if (scene.has(ColorGrade) || scene.has(SceneEffects) || values.bloom || values.vignette || values.grain || values.colorSplit) needed.add(scene);
  }
  const scopeTarget = colorScopesTarget(world);
  if (scopeTarget && isScene(scopeTarget) && !scopeTarget.has(Hidden) && scopeTarget.get(Computed)?.visibility !== 0) needed.add(scopeTarget);
  for (const highlight of world.query(Or(Geometry, Group))) {
    const values = highlight.get(Computed)!;
    if (!highlight.has(Highlight) && !highlight.has(Preset) && !highlight.has(LayerMaterial) && !values.backdropBlur && !values.refraction) continue;
    if (highlight.has(Hidden) || highlight.get(Computed)?.visibility === 0) continue;
    let root = highlight;
    let parent = getParentNode(root);
    let visible = true;
    while (parent) {
      if (parent.has(Hidden) || parent.get(Computed)?.visibility === 0) visible = false;
      root = parent;
      parent = getParentNode(root);
    }
    if (visible) needed.add(root);
  }
  for (const [scene, buffers] of state.scenes) {
    if (needed.has(scene)) continue;
    // Release the backing pixels now, even if the browser delays canvas GC.
    buffers.scene.canvas.width = buffers.source.canvas.width = 1;
    buffers.scene.canvas.height = buffers.source.canvas.height = 1;
    state.scenes.delete(scene);
  }
  for (const scene of needed) {
    if (!state.scenes.has(scene)) state.scenes.set(scene, { scene: makeBuffer(), source: makeBuffer() });
  }
}

/**
 * Draw the complete scene once at composition resolution. Its camera placement
 * happens only after effects have sampled it, including content off screen.
 */
export function renderWithSceneEffects(world: World, scene: Entity, render: () => void): void {
  const state = states.get(world);
  const buffers = state?.scenes.get(scene);
  if (!state || !buffers) return render();
  const surface = world.get(RenderSurface)!;
  const output = surface.ctx!;
  const bounds = scene.get(Computed)!;
  const local = store(world, LocalTransform);
  const id = scene.id();
  const matrix = new DOMMatrix([local.a[id]!, local.b[id]!, local.c[id]!, local.d[id]!, local.e[id]!, local.f[id]!]);
  const display = output.getTransform().multiply(matrix);
  const density = Math.max(Math.hypot(display.a, display.b), Math.hypot(display.c, display.d));
  const resolution = world.get(Mode)?.value === 'realtime'
    ? Math.min(surface.resolution, Math.max(.05, density))
    : surface.resolution;
  const width = Math.ceil(bounds.width * resolution);
  const height = Math.ceil(bounds.height * resolution);
  if (width <= 0 || height <= 0) return;

  resize(buffers.scene, width, height);
  resize(buffers.source, width, height);
  const inverse = matrix.inverse();
  const ctx = buffers.scene.ctx;
  ctx.setTransform(resolution, 0, 0, resolution, 0, 0);
  ctx.transform(inverse.a, inverse.b, inverse.c, inverse.d, inverse.e, inverse.f);

  const previous = state.active;
  state.active = buffers;
  world.set(RenderSurface, { canvas: buffers.scene.canvas, ctx, resolution });
  try {
    render();
  } finally {
    world.set(RenderSurface, surface);
    state.active = previous;
  }

  output.save();
  output.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
  const effected = motionEffectsFrame(world, scene, buffers.scene.canvas, resolution);
  const graded = gradeFrame(world, scene, effected);
  sampleColorScopes(world, scene, graded);
  output.drawImage(graded, 0, 0, bounds.width, bounds.height);
  output.restore();
}

/** Copy the underlay at the current layer boundary, never a previous frame. */
export function snapshotScene(world: World): Buffer | undefined {
  const buffers = states.get(world)?.active;
  if (!buffers) return;
  const source = buffers.source;
  source.ctx.clearRect(0, 0, source.canvas.width, source.canvas.height);
  source.ctx.drawImage(buffers.scene.canvas, 0, 0);
  return source;
}
