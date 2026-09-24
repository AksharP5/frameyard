/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMemo, Show } from 'solid-js';
import { useTag, useTrait, useWorld } from '@diffusionstudio/koota-solid';
import { trackProperty } from '@diffusionstudio/reconciler';
import {
  Cache,
  Computed,
  Hovering,
  Keyframe as KeyframeTrait,
  KeyframeTrack,
  findClosestParentGeometry,
  getActiveEntity,
  setPlayhead,
  store,
} from '@diffusionstudio/runtime';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Keyframe } from '@/components/ui/keyframe';
import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from '@/components/ui/tooltip';
import { useDerived } from '@/engine/hooks';
import { KEYFRAME_TRACK_HEIGHT } from '@/engine/timeline';
import { NESTED_INDENT_PX } from './config';
import { setRowHover } from './hover';

import type { Entity } from 'koota';
import type { PropertyPath } from '@diffusionstudio/runtime';
import type { LayerRowProps } from './layer';

const EMPTY_FRAMES: number[] = [];

/**
 * A row for one animated property, with a way to step between its keyframes
 * and to put one where the playhead is.
 */
export function KeyframeLayer(props: LayerRowProps) {
  const world = useWorld();
  const cache = store(world, Cache);
  const keyframe = store(world, KeyframeTrait);
  const computed = store(world, Computed);

  const entity = () => props.layer.entity;

  const track = useTrait(entity, KeyframeTrack);
  const path = () => (track()?.property ?? '') as PropertyPath;
  const property = () => trackProperty(path());
  const target = () => track()?.target ?? null;

  const hovering = useTag(entity, Hovering);
  const selected = props.selected;

  /**
   * The track's keyframes as scene frames, in order. They are authored in the
   * clip's own time — which is what makes them move with it, and run at its
   * speed — so each is put back on the scene's the way `getNodeLocalFrame`
   * takes them off it.
   */
  let lastKeyframes: Entity[] | undefined;
  let lastOrigin = 0;
  let lastRate = 1;
  let projectedFrames: number[] = [];
  const frames = useDerived(() => {
    const clip = findClosestParentGeometry(entity());
    if (!clip?.has(Computed)) return EMPTY_FRAMES;

    const clipId = clip.id();
    const origin = computed.origin[clipId] ?? 0;
    const rate = computed.playbackRate[clipId] || 1;
    const keyframes = cache.keyframes[entity().id()];
    if (keyframes === lastKeyframes && origin === lastOrigin && rate === lastRate) return projectedFrames;

    lastKeyframes = keyframes;
    lastOrigin = origin;
    lastRate = rate;
    projectedFrames = (keyframes ?? [])
      .map((item) => origin + (keyframe.time[item.id()] ?? 0) / rate)
      .sort((a, b) => a - b);
    return projectedFrames;
  });

  const neighbors = createMemo(() => {
    const current = props.now();
    let previous: number | undefined;
    let next: number | undefined;
    for (const frame of frames()) {
      if (frame < current) previous = frame;
      else if (frame > current) { next = frame; break; }
    }
    return { previous, next };
  });

  const goTo = (frame: number | undefined) => {
    const scene = getActiveEntity(world);
    if (scene === null || frame === undefined) return;
    setPlayhead(world, scene, frame);
  };

  return (
    <div
      class="w-full flex items-center text-muted-foreground justify-between pl-0.5 pr-2"
      classList={{
        'bg-accent': selected(),
        'bg-accent/70': !selected() && hovering(),
        'bg-accent/40': !selected() && !hovering() && props.ancestorSelected,
      }}
      onPointerEnter={() => setRowHover(world, entity())}
      onPointerLeave={() => setRowHover(world, null)}
      style={{ height: KEYFRAME_TRACK_HEIGHT + 'px' }}
    >
      <div data-layer-label class="flex-1 min-w-0 overflow-hidden">
        <div
          class="flex items-center gap-0.5 w-max"
          style={{
            'padding-left': `${props.depth * NESTED_INDENT_PX}px`,
            transform: 'translateX(calc(var(--layer-x, 0px) * -1))',
          }}
        >
          <div class="size-4 shrink-0" />
          <div class="size-4 shrink-0 mr-0.5 flex items-center justify-center overflow-clip">
            <Icon name="keyframe-indicator-default" class="size-6" />
          </div>
          <span class="text-xs px-0.5 shrink-0 whitespace-nowrap text-muted-foreground">
            {formatProperty(path())}
          </span>
        </div>
      </div>
      <div class="flex items-center gap-0.5 shrink-0">
        <Tooltip placement="top">
          <TooltipTrigger
            as={Button}
            variant="ghost"
            size="icon"
            aria-label="Previous keyframe"
            disabled={neighbors().previous === undefined}
            onClick={() => goTo(neighbors().previous)}
          >
            <Icon name="caret-left" class="size-6" />
          </TooltipTrigger>
          <TooltipPortal>
            <TooltipContent>Previous keyframe</TooltipContent>
          </TooltipPortal>
        </Tooltip>
        <Show when={property() && target()}>
          {(holder) => <Keyframe property={property()!} target={holder() as Entity} />}
        </Show>
        <Tooltip placement="top">
          <TooltipTrigger
            as={Button}
            variant="ghost"
            size="icon"
            aria-label="Next keyframe"
            disabled={neighbors().next === undefined}
            onClick={() => goTo(neighbors().next)}
          >
            <Icon name="caret-right" class="size-6" />
          </TooltipTrigger>
          <TooltipPortal>
            <TooltipContent>Next keyframe</TooltipContent>
          </TooltipPortal>
        </Tooltip>
      </div>
    </div>
  )
}

/**
 * What the row calls each property it can hold a track for — the name the
 * inspector puts on the same control, so the two agree.
 */
const PROPERTY_NAMES: Partial<Record<PropertyPath, string>> = {
  'position.x': 'Position X',
  'position.y': 'Position Y',
  'position.z': 'Depth',
  'offset.x': 'Offset X',
  'offset.y': 'Offset Y',
  'scale': 'Scale',
  'scale.x': 'Scale X',
  'scale.y': 'Scale Y',
  'skew.x': 'Skew X',
  'skew.y': 'Skew Y',
  'rotation': 'Rotation',
  'rotation.x': '3D tilt X',
  'rotation.y': '3D tilt Y',
  'anchor.x': 'Anchor X',
  'anchor.y': 'Anchor Y',
  'path.d': 'Vector path',
  'perspective': 'Perspective',
  'cameraX': 'Camera X',
  'cameraY': 'Camera Y',
  'cameraZ': 'Camera distance',
  'cameraZoom': 'Camera zoom',
  'cameraRotationX': 'Camera tilt X',
  'cameraRotationY': 'Camera tilt Y',
  'cameraRotation': 'Camera roll',
  'width': 'Width',
  'height': 'Height',
  'opacity': 'Opacity',
  'color': 'Color',
  'blur': 'Blur',
  'volume': 'Volume',
  'stroke.width': 'Stroke Width',
  'vertexRadius': 'Radius',
  'mixedVertexRadius.topLeft': 'Radius TL',
  'mixedVertexRadius.topRight': 'Radius TR',
  'mixedVertexRadius.bottomRight': 'Radius BR',
  'mixedVertexRadius.bottomLeft': 'Radius BL',
  'stop.offset': 'Offset',
  'effect.value': 'Value',
  'chars': 'Text',
};

/**
 * A property's name as the row shows it. Tracks hold the runtime's paths, so
 * a path with no name of its own falls back to its last segment as words —
 * a label rather than the path itself.
 */
export function formatProperty(path: string): string {
  if (!path) return '';

  return PROPERTY_NAMES[path as PropertyPath] ?? path
    .split('.')
    .pop()!
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (first) => first.toUpperCase())
    .trim();
}
