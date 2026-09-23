/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { createMemo, For, Show } from 'solid-js';
import { useTrait, useWorld } from '@diffusionstudio/koota-solid';
import { FrameRate, Markers } from '@diffusionstudio/runtime';
import { useTimelineIndex } from '@/engine/hooks';
import { addMarker, editMarker, markRange, seekTimeline } from '@/engine/timeline-navigation';
import { Button } from '@/components/ui/button';
import { formatFrames } from './time-format';

export function TimelineMarkerControls() {
  const world = useWorld();
  const index = useTimelineIndex();
  const scene = createMemo(() => index().root);
  const markers = useTrait(scene, Markers);
  const fps = useTrait(world, FrameRate);
  return (
    <div class="w-80 p-2" onKeyDown={(event) => event.stopPropagation()}>
          <div class="flex items-center gap-1 pb-2 border-b border-border">
            <Button variant="ghost" class="text-xs px-2" onClick={() => addMarker(world)}>Add marker</Button>
            <Button variant="ghost" class="text-xs px-2" title="Mark in (I)" onClick={() => markRange(world, 'in')}>In</Button>
            <Button variant="ghost" class="text-xs px-2" title="Mark out (O)" onClick={() => markRange(world, 'out')}>Out</Button>
            <Button variant="ghost" class="text-xs px-2" onClick={() => markRange(world, 'clear')}>Clear range</Button>
          </div>
          <div class="max-h-64 overflow-y-auto pt-1">
            <Show when={markers()?.value.length} fallback={<p class="text-xs text-muted-foreground p-2">Press M over the timeline to add a marker.</p>}>
              <For each={markers()?.value}>{(marker) => (
                <div class="flex items-center gap-1 py-1">
                  <button class="text-xxs font-mono px-1 text-muted-foreground hover:text-foreground" title="Go to marker" onClick={() => seekTimeline(world, marker.time)}>
                    {formatFrames(marker.time, fps()?.value ?? 30, 'standard')}
                  </button>
                  <input class="min-w-0 flex-1 bg-transparent text-xs border-b border-transparent focus:border-primary outline-none" aria-label="Marker name"
                    value={marker.name} onChange={(event) => { const target = scene(); if (target) editMarker(world, target, marker.id, { name: event.currentTarget.value }); }} />
                  <button class="text-xs px-1 text-muted-foreground hover:text-foreground" aria-label={`Delete ${marker.name}`}
                    onClick={() => { const target = scene(); if (target) editMarker(world, target, marker.id, null); }}>×</button>
                </div>
              )}</For>
            </Show>
          </div>
    </div>
  );
}
