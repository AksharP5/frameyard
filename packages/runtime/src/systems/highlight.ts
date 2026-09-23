/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { highlightProgress } from '@diffusionstudio/jsx';
import { Computed, FrameRate, Highlight, RenderSurface } from '../traits';
import { getLocalWindow } from '../utils/time';
import { snapshotScene } from './scene-effects';
import type { Entity, World } from 'koota';

export function renderHighlight(world: World, entity: Entity): void {
  const options = entity.get(Highlight)!;
  const computed = entity.get(Computed)!;
  const fps = world.get(FrameRate)?.value ?? 30;
  const window = getLocalWindow(entity);
  const progress = highlightProgress((computed.localTime - window.in) / fps, (window.out - window.in) / fps, options.enter, options.exit);
  if (progress === 0) return;

  const ctx = world.get(RenderSurface)!.ctx!;
  const source = snapshotScene(world);
  if (!source) return;

  const width = computed.width;
  const height = computed.height;
  const [rx, ry, rw, rh] = options.region;
  const x = rx * width;
  const y = ry * height;
  const cropWidth = rw * width;
  const cropHeight = rh * height;
  const centerX = x + cropWidth / 2;
  const centerY = y + cropHeight / 2;
  const scale = 1 + (options.magnification - 1) * progress;
  const dx = options.mode === 'center' ? (options.destination[0] * width - centerX) * progress : 0;
  const dy = options.mode === 'center' ? (options.destination[1] * height - centerY) * progress : 0;
  const matrix = ctx.getTransform();
  const inverse = matrix.inverse();
  const density = Math.hypot(matrix.a, matrix.b);
  const radius = Math.min(options.radius * progress, cropWidth * scale / 2, cropHeight * scale / 2);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  // Replace the underlay from a separate snapshot so neither blur nor another
  // seek can feed the previous effect result back into itself.
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = options.blur > 0 ? `blur(${options.blur * progress * density}px)` : 'none';
  ctx.drawImage(source.canvas, 0, 0);
  ctx.restore();
  ctx.filter = 'none';
  ctx.fillStyle = `rgba(0,0,0,${options.dim * progress})`;
  ctx.fillRect(0, 0, width, height);

  ctx.translate(centerX + dx, centerY + dy);
  ctx.scale(scale, scale);
  ctx.translate(-centerX, -centerY);
  ctx.beginPath();
  ctx.roundRect(x, y, cropWidth, cropHeight, radius / scale);
  ctx.save();
  ctx.shadowColor = `rgba(0,0,0,${options.shadow * progress})`;
  ctx.shadowBlur = 24 * density * progress;
  ctx.shadowOffsetY = 8 * density * progress;
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.restore();
  ctx.clip();
  ctx.transform(inverse.a, inverse.b, inverse.c, inverse.d, inverse.e, inverse.f);
  ctx.drawImage(source.canvas, 0, 0);
  ctx.restore();
}
