/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Entity, World } from 'koota';
import type { ColorGradeFrame } from './color-grade';

export const SCOPE_WIDTH = 256;
export const SCOPE_HEIGHT = 128;
export type ColorScopes = ReturnType<typeof analyzeColorScopes>;

/** SDR Rec.709 luma/chroma distributions. Fully transparent pixels do not enter scopes. */
export function analyzeColorScopes(image: Pick<ImageData, 'data' | 'width' | 'height'>) {
  const histogram = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const waveform = new Uint32Array(SCOPE_WIDTH * SCOPE_HEIGHT);
  const vectorscope = new Uint32Array(SCOPE_HEIGHT * SCOPE_HEIGHT);
  let samples = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const index = (y * image.width + x) * 4;
      if (image.data[index + 3] === 0) continue;
      const r = image.data[index]!, g = image.data[index + 1]!, b = image.data[index + 2]!;
      histogram[0]![r]++; histogram[1]![g]++; histogram[2]![b]++;
      const luma = (.2126 * r + .7152 * g + .0722 * b) / 255;
      const waveX = Math.min(SCOPE_WIDTH - 1, Math.floor(x / image.width * SCOPE_WIDTH));
      const waveY = Math.round((1 - luma) * (SCOPE_HEIGHT - 1));
      waveform[waveY * SCOPE_WIDTH + waveX]++;
      const cb = (b / 255 - luma) / 1.8556;
      const cr = (r / 255 - luma) / 1.5748;
      const vx = Math.max(0, Math.min(SCOPE_HEIGHT - 1, Math.round((cb + .5) * (SCOPE_HEIGHT - 1))));
      const vy = Math.max(0, Math.min(SCOPE_HEIGHT - 1, Math.round((.5 - cr) * (SCOPE_HEIGHT - 1))));
      vectorscope[vy * SCOPE_HEIGHT + vx]++;
      samples++;
    }
  }
  return { histogram, waveform, vectorscope, samples };
}

type ScopeSubscription = {
  entity: Entity;
  listener: (scopes: ColorScopes) => void;
  onError: (message: string) => void;
  seen: boolean;
  available: boolean;
  failed: boolean;
  canvas: OffscreenCanvas;
  context: OffscreenCanvasRenderingContext2D;
  lastSample: number;
};
const subscriptions = new WeakMap<World, ScopeSubscription>();

/** The inspector owns one visible scope view. Unsubscribing releases its readback canvas. */
export function watchColorScopes(world: World, entity: Entity, listener: ScopeSubscription['listener'], onError: ScopeSubscription['onError']): () => void {
  const canvas = new OffscreenCanvas(1, 1);
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  const subscription = { entity, listener, onError, canvas, context, lastSample: -Infinity, seen: false, available: true, failed: false };
  subscriptions.set(world, subscription);
  return () => {
    if (subscriptions.get(world) === subscription) subscriptions.delete(world);
    canvas.width = canvas.height = 1;
  };
}

export function colorScopesTarget(world: World): Entity | undefined {
  return subscriptions.get(world)?.entity;
}

export function beginColorScopeFrame(world: World): void {
  const subscription = subscriptions.get(world);
  if (subscription) subscription.seen = false;
}

export function finishColorScopeFrame(world: World): void {
  const subscription = subscriptions.get(world);
  if (!subscription || subscription.seen || !subscription.available) return;
  subscription.available = false;
  subscription.listener(analyzeColorScopes({ data: new Uint8ClampedArray(), width: 0, height: 0 }));
}

/** Called with the actual drawn media/composite, before any stage background is involved. */
export function sampleColorScopes(world: World, entity: Entity, source: ColorGradeFrame): void {
  const target = subscriptions.get(world);
  if (!target || target.entity !== entity || target.failed) return;
  target.seen = true;
  if (target.available && performance.now() - target.lastSample < 250) return;
  target.available = true;
  if (source.width < 1 || source.height < 1) return;
  target.lastSample = performance.now();
  const scale = Math.min(1, 320 / source.width, 180 / source.height);
  const width = Math.max(1, Math.round(source.width * scale)), height = Math.max(1, Math.round(source.height * scale));
  if (target.canvas.width !== width) target.canvas.width = width;
  if (target.canvas.height !== height) target.canvas.height = height;
  try {
    target.context.clearRect(0, 0, width, height);
    target.context.drawImage(source, 0, 0, width, height);
    target.listener(analyzeColorScopes(target.context.getImageData(0, 0, width, height)));
  } catch (error) {
    target.failed = true;
    target.onError(`Scopes could not sample this source: ${error instanceof Error ? error.message : String(error)}`);
  }
}
