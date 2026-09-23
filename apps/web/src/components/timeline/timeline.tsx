/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { onCleanup, onMount } from 'solid-js';
import { toast } from 'somoto';
import { useWorld } from '@diffusionstudio/koota-solid';
import { Computed, DEFAULT_DURATION_FRAMES, FrameRate, framesToSeconds, getActiveEntity, getEntityChildren, getEntityTree, getSceneAncestor } from '@diffusionstudio/runtime';
import { droppedFiles, importFiles } from '@/engine/asset-actions';
import { insertAsset } from '@/engine/insert-asset';
import { expandLinkedClips, isClipLocked } from '@/engine/clip-links';
import { getTargetTrack, timelineEditing } from '@/engine/timeline-editing';
import { resolveSequentialOverlaps } from '@/engine/overlap';
import { getEditHistory } from '@/engine/history';
import { insertAssetsInNewScene } from '@/engine/new-scene';
import { useLibrary } from '@/engine/library';
import { useTimeline } from '@/context/timeline';
import { ASSET_DRAG_TYPE } from '@/components/sidebar-left/folder-item';
import { PRESET_DRAG_TYPE, presetPlacement } from '@/engine/preset-placement';
import { addPreset } from '@/engine/presets';
import { HIGHLIGHT_DRAG_TYPE, highlightPlacement } from '@/engine/highlight-placement';
import { addHighlight } from '@/engine/highlight';

/**
 * The timeline's canvas. What is drawn on it is the timeline system's
 * business (see `@/engine/timeline`); this is the element it draws on and
 * what dropping an asset onto it means.
 */
export function Timeline() {
  const world = useWorld();
  const timeline = useTimeline();
  const library = useLibrary();

  onMount(() => timeline.attachCanvas());
  onCleanup(() => timeline.detachCanvas());

  /**
   * Assets dropped on the timeline start where they were dropped, unlike
   * ones dropped on the canvas, which start at the playhead: the whole point
   * of aiming at a place on the timeline is to say when.
   *
   * With no scene to drop into, they get one of their own rather than
   * landing loose at the root, sized to the last of them that has a size
   * (see `insertAssetsInNewScene`).
   */
  const handleDrop = async (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();

    const fps = world.get(FrameRate)?.value ?? 30;
    const start = framesToSeconds(Math.max(0, timeline.clientToFrame(event.clientX)), fps);

    const presetId = event.dataTransfer?.getData(PRESET_DRAG_TYPE);
    if (presetId) {
      try { await addPreset(presetPlacement(world, presetId, { start })); }
      catch (cause) { toast('Could not add effect', { description: cause instanceof Error ? cause.message : String(cause) }); }
      return;
    }
    if (event.dataTransfer?.getData(HIGHLIGHT_DRAG_TYPE) === 'highlight') {
      try { await addHighlight(highlightPlacement(world, { start })); }
      catch (cause) { toast('Could not add highlight', { description: cause instanceof Error ? cause.message : String(cause) }); }
      return;
    }

    const lib = library();
    if (!lib) return;

    // Read the transfer before the first await: it is gone by the time an
    // import resolves.
    const ids = event.dataTransfer?.getData(ASSET_DRAG_TYPE)?.split(',').filter(Boolean) ?? [];
    const files = droppedFiles(event);

    const assets = ids.map((id) => lib.get(id)).filter((asset) => asset != null);
    if (files.length) assets.push(...await importFiles(lib, files, ''));
    if (!assets.length) return;

    if (!getActiveEntity(world)) {
      if (!insertAssetsInNewScene(world, assets, { start })) {
        toast("Nothing to insert into", { description: "Open a project first." });
      }
      return;
    }

    const chosen = timelineEditing(world).target();
    const scene = getActiveEntity(world);
    if (chosen?.isAlive() && getSceneAncestor(chosen) === scene && isClipLocked(chosen)) {
      toast('The destination track is locked');
      return;
    }
    const parent = getTargetTrack(world);
    let frame = Math.round(start * fps);
    const origin = parent?.get(Computed)?.origin ?? 0;
    if (parent && frame < origin) { toast('Drop after the destination track starts'); return; }
    if (parent) {
      const duration = assets.reduce((total, asset) => total + ('duration' in asset ? Math.round(asset.duration * fps) : DEFAULT_DURATION_FRAMES), 0);
      const covered = getEntityChildren(world, parent).filter((clip) => {
        const time = clip.get(Computed);
        return time && time.start < frame + duration && time.end > frame;
      });
      if (expandLinkedClips(world, covered).some((clip) => getEntityTree(world, clip).some(isClipLocked))) {
        toast('The destination overlaps a locked clip');
        return;
      }
    }
    const history = getEditHistory(world);
    history.beginGesture();
    try {
      for (const asset of assets) {
        const inserted = insertAsset(world, asset, { start: framesToSeconds(frame - origin, fps), ...(parent ? { parent } : {}) });
        if (!inserted) { toast('Nothing to insert into', { description: 'Open a scene first.' }); continue; }
        if (parent) {
          resolveSequentialOverlaps(world, expandLinkedClips(world, [inserted]));
          frame = inserted.get(Computed)?.end ?? frame;
        }
      }
    } finally { history.endGesture(); }
  };

  const handleDragOver = (event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer!.dropEffect = 'copy';
  };

  return (
    <div class="relative size-full min-w-0 min-h-0 overflow-hidden" data-timeline-viewport>
      <canvas
        class="absolute inset-0 outline-none"
        id="timeline-canvas"
        on:drop={handleDrop}
        on:dragover={handleDragOver}
      />
    </div>
  );
}
