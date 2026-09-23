/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { PresetOptions } from '@diffusionstudio/jsx';

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Canvas = HTMLCanvasElement | OffscreenCanvas;
type Buffer = { canvas: Canvas; ctx: Context };
const buffers = new WeakMap<Canvas, Buffer>();

function downscaleBuffer(source: Canvas, width: number, height: number): Buffer {
  let buffer = buffers.get(source);
  if (!buffer) {
    const canvas = typeof document === 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
    const ctx = canvas.getContext('2d') as Context | null;
    if (!ctx) throw new Error('Pixelation requires a 2D canvas');
    buffer = { canvas, ctx };
    buffers.set(source, buffer);
  }
  if (buffer.canvas.width !== width) buffer.canvas.width = width;
  if (buffer.canvas.height !== height) buffer.canvas.height = height;
  return buffer;
}

export function renderPresetEffect(ctx: Context, source: Canvas, options: PresetOptions, width: number, height: number): void {
  if (options.preset !== 'frameyard-pixelate') throw new Error(`No scene renderer for effect preset: ${options.preset}`);
  if (width <= 0 || height <= 0 || options.settings.amount === 1) return;

  const [x, y, w, h] = options.settings.region;
  const left = x * width;
  const top = y * height;
  const outputWidth = w * width;
  const outputHeight = h * height;
  const smallWidth = Math.max(1, Math.ceil(outputWidth / options.settings.amount));
  const smallHeight = Math.max(1, Math.ceil(outputHeight / options.settings.amount));
  const { canvas, ctx: small } = downscaleBuffer(source, smallWidth, smallHeight);
  small.setTransform(1, 0, 0, 1, 0, 0);
  small.clearRect(0, 0, smallWidth, smallHeight);
  small.imageSmoothingEnabled = false;
  small.drawImage(source, x * source.width, y * source.height, w * source.width, h * source.height, 0, 0, smallWidth, smallHeight);

  ctx.save();
  try {
    ctx.beginPath();
    ctx.rect(left, top, outputWidth, outputHeight);
    ctx.clip();
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(left, top, outputWidth, outputHeight);
    ctx.drawImage(canvas, left, top, outputWidth, outputHeight);
  } finally {
    ctx.restore();
  }
}
