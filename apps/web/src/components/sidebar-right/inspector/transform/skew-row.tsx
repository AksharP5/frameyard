/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMemo } from "solid-js";
import { ControlRow } from "@/components/ui/control-group";
import { Icon } from "@/components/ui/icon";
import { ControlledTextField } from "@/components/ui/text-field";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { Computed } from "@diffusionstudio/runtime";
import { useWorld } from "@diffusionstudio/koota-solid";
import { useDerived, useEditor } from "@/engine/hooks";
import { syncKeyframe } from "@/engine/keyframes";
import { Keyframe } from "@/components/ui/keyframe";

import type { Entity } from "koota";

export type SkewRowProps = {
  node: Entity;
  onRemoveAddon(): void;
};

export function SkewRow(props: SkewRowProps) {
  const world = useWorld();
  const editor = useEditor();
  const skewX = useDerived(() => props.node.get(Computed)?.skewX ?? 0);
  const skewY = useDerived(() => props.node.get(Computed)?.skewY ?? 0);

  const isDefault = createMemo(() => skewX() === 0 && skewY() === 0);

  const updateSkew = (axis: 'x' | 'y', value: number) => {
    const property = axis === 'x' ? 'skewX' : 'skewY';
    editor.editProperty(props.node, property, value);
    syncKeyframe(world, editor, props.node, property, value);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger<typeof ControlRow>
        as={ControlRow}
        label="Skew"
        contentClass="grid grid-cols-2 gap-2"
      >
        <ControlledTextField
          aria-label="Skew X"
          icon={<Icon name="prop-x-position" />}
          value={skewX()}
          onNumber={(value) => updateSkew('x', value)}
          step={1}
          unit="°"
          autoSelect
          sliderEnabled
          limitEvents
          keyframe={<Keyframe target={props.node} property="skewX" />}
        />
        <ControlledTextField
          aria-label="Skew Y"
          icon={<Icon name="prop-y-position" />}
          value={skewY()}
          onNumber={(value) => updateSkew('y', value)}
          step={1}
          unit="°"
          autoSelect
          sliderEnabled
          limitEvents
          keyframe={<Keyframe target={props.node} property="skewY" />}
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          disabled={isDefault()}
          onSelect={() => {
            updateSkew('x', 0);
            updateSkew('y', 0);
          }}
        >
          Reset to Default
        </ContextMenuItem>
        <ContextMenuItem onSelect={props.onRemoveAddon}>
          Remove row
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
