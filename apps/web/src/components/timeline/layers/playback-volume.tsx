/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createEffect } from 'solid-js';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Popover, PopoverContent, PopoverPortal, PopoverTrigger } from '@/components/ui/popover';
import { useEngineContext } from '@/engine';
import { store } from '@/init';
import { createStoredSignal } from '@/lib/store';

export function PlaybackVolume() {
  const engine = useEngineContext();
  const [volume, setVolume] = createStoredSignal(store.define('playback.volume', 1, (value: unknown) => (
    typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1 ? value : 1
  )));
  const [muted, setMuted] = createStoredSignal(store.define('playback.muted', false, (value: unknown) => value === true));
  const level = () => muted() ? 0 : Math.round(volume() * 100);

  createEffect(() => engine.setPlaybackVolume(muted() ? 0 : volume()));

  const changeVolume = (value: number) => {
    if (value > 0) setVolume(value / 100);
    setMuted(value === 0);
  };

  return (
    <Popover placement="top-start">
      <PopoverTrigger<typeof Button>
        as={(props) => (
          <Button
            {...props}
            variant="ghost"
            size="icon"
            aria-label={`Playback volume: ${muted() ? 'muted' : `${level()}%`}`}
            title="Playback volume"
            onKeyDown={(event: KeyboardEvent) => event.stopPropagation()}
          >
            <Icon name={muted() ? 'audio-off' : 'audio-on'} class="size-5" />
          </Button>
        )}
      />
      <PopoverPortal>
        <PopoverContent class="w-56 p-3" onKeyDown={(event) => event.stopPropagation()}>
          <div class="flex items-center justify-between text-xs">
            <span>Playback volume</span>
            <span class="tabular-nums text-muted-foreground">{level()}%</span>
          </div>
          <div class="mt-3 flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              aria-label={muted() ? 'Unmute playback' : 'Mute playback'}
              aria-pressed={muted()}
              title={muted() ? 'Unmute playback' : 'Mute playback'}
              onClick={() => setMuted(!muted())}
            >
              <Icon name={muted() ? 'audio-off' : 'audio-on'} class="size-5" />
            </Button>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={level()}
              onInput={(event) => changeVolume(event.currentTarget.valueAsNumber)}
              aria-label="Playback volume"
              aria-valuetext={`${level()}%`}
              class="h-1 w-full cursor-pointer accent-foreground"
            />
          </div>
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}
