/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
import { For } from 'solid-js';
import { useWorld } from '@diffusionstudio/koota-solid';
import { EDIT_MODES, timelineEditing } from '@/engine/timeline-editing';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuPortal, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const descriptions = {
  trim: 'Trim edges; drag clips to move',
  ripple: 'Trim an edge and shift later clips',
  roll: 'Drag a cut between touching clips',
  slip: 'Drag a clip to change its source window',
  slide: 'Drag a clip between touching neighbours',
} as const;

export function TimelineEditTools() {
  const state = timelineEditing(useWorld());
  return (
    <DropdownMenu>
      <DropdownMenuTrigger as={Button} variant="ghost" class="h-7 px-1.5 text-xs capitalize" title={descriptions[state.mode()]}>
        {state.mode()}
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent data-timeline-controls class="w-64">
          <DropdownMenuRadioGroup value={state.mode()} onChange={(value) => {
            const mode = EDIT_MODES.find((mode) => mode === value);
            if (mode) state.setMode(mode);
          }}>
            <For each={EDIT_MODES}>{(mode) => (
              <DropdownMenuRadioItem value={mode} class="flex flex-col items-start gap-0.5">
                <span class="capitalize">{mode}</span>
                <span class="text-xxs text-muted-foreground">{descriptions[mode]}</span>
              </DropdownMenuRadioItem>
            )}</For>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenu>
  );
}
