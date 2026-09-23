/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Computed, Preset, RenderSurface } from '../traits';
import { snapshotScene } from './scene-effects';
import { renderPresetEffect } from './preset-effects';
import type { Entity, World } from 'koota';

export function renderPreset(world: World, entity: Entity): void {
  const options = entity.get(Preset)!;
  const bounds = entity.get(Computed)!;
  const ctx = world.get(RenderSurface)!.ctx!;
  const source = snapshotScene(world)?.canvas;
  if (source) renderPresetEffect(ctx, source, options, bounds.width, bounds.height);
}
