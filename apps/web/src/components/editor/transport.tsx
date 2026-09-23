/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMemo, Show } from "solid-js";
import { useTrait, useWorld } from "@diffusionstudio/koota-solid";
import {
  Computed,
  FrameRate,
  Playback,
  togglePlayback,
} from "@diffusionstudio/runtime";
import { useDerived, useTimelineIndex } from "@/engine/hooks";
import { seekTimelineFrames } from "@/engine/timeline-navigation";
import { useLayout } from "@/context/layout";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { PlaybackVolume } from "@/components/timeline/layers/playback-volume";
import { formatFrames } from "@/components/timeline/time-format";

export function Transport() {
  const world = useWorld();
  const index = useTimelineIndex();
  const scene = createMemo(() => index().root);
  const playback = useTrait(scene, Playback);
  const fps = useTrait(world, FrameRate);
  const { timeFormat } = useLayout();
  const now = useDerived(() => scene()?.get(Computed)?.localTime ?? 0);
  const duration = useDerived(() => scene()?.get(Computed)?.duration ?? 0);
  const clock = (frame: number) =>
    formatFrames(frame, fps()?.value ?? 30, timeFormat());
  const play = () => {
    const current = scene();
    if (!current) return;
    current.set(Playback, { speed: 1 });
    togglePlayback(world, current);
  };

  return (
    <div class="focus-transport" data-editor-transport data-timeline-controls>
      <div class="focus-transport-volume">
        <PlaybackVolume />
        <Show when={playback()?.buffering}>
          <span role="status">Preparing playback…</span>
        </Show>
      </div>
      <div class="focus-play-controls">
        <Button
          variant="ghost"
          size="icon-square"
          aria-label="Previous frame"
          title="Previous frame"
          disabled={!scene()}
          onClick={() => seekTimelineFrames(world, -1)}
        >
          <Icon name="chevron-left" />
        </Button>
        <Button
          class="focus-play"
          size="icon-square"
          aria-label={
            playback()?.buffering
              ? "Cancel preparing playback"
              : playback()?.playing
                ? "Pause"
                : "Play"
          }
          title="Play / pause (Space)"
          disabled={!scene()}
          onClick={play}
        >
          <Icon name={playback()?.playing ? "pause" : "play"} />
        </Button>
        <Button
          variant="ghost"
          size="icon-square"
          aria-label="Next frame"
          title="Next frame"
          disabled={!scene()}
          onClick={() => seekTimelineFrames(world, 1)}
        >
          <Icon name="chevron-right" />
        </Button>
      </div>
      <div class="focus-timecode" aria-label="Playback time">
        <span>{clock(now())}</span>
        <span> / {clock(duration())}</span>
      </div>
    </div>
  );
}
