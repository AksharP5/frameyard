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
import { useWorld } from "@diffusionstudio/koota-solid";
import { Computed } from "@diffusionstudio/runtime";
import { useDerived, useEditor } from "@/engine/hooks";
import { syncKeyframe } from "@/engine/keyframes";
import { Keyframe } from "@/components/ui/keyframe";
import { AnchorPointPicker } from "./anchor-picker";

import type { Entity } from "koota";

export type AnchorRowProps = {
  node: Entity;
  onRemoveAddon(): void;
};

/**
 * The pivot rotation, scale and skew turn about, as a fraction of the box.
 * Both axes are written together so choosing a preset also updates their tracks.
 */
export function AnchorRow(props: AnchorRowProps) {
  const world = useWorld();
  const editor = useEditor();
  const anchorX = useDerived(() => props.node.get(Computed)?.anchorX ?? 0.5);
  const anchorY = useDerived(() => props.node.get(Computed)?.anchorY ?? 0.5);

  const isDefault = createMemo(() => anchorX() === 0.5 && anchorY() === 0.5);

  const assignAnchor = (x: number, y: number) => {
    editor.editProperty(props.node, 'anchorX', x);
    editor.editProperty(props.node, 'anchorY', y);
    syncKeyframe(world, editor, props.node, 'anchorX', x);
    syncKeyframe(world, editor, props.node, 'anchorY', y);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger<typeof ControlRow>
        as={ControlRow}
        label="Anchor"
        class="items-start"
        labelClass="pt-1.5"
        contentClass="flex gap-2 items-center"
      >
        <div class="flex flex-col gap-2 flex-1 min-w-0">
          <ControlledTextField
            aria-label="Anchor X"
            icon={<Icon name="prop-x-position" />}
            value={Math.round(anchorX() * 100)}
            onNumber={(value) => assignAnchor(value / 100, anchorY())}
            step={1}
            unit="%"
            autoSelect
            sliderEnabled
            keyframe={<Keyframe target={props.node} property="anchorX" />}
          />
          <ControlledTextField
            aria-label="Anchor Y"
            icon={<Icon name="prop-y-position" />}
            value={Math.round(anchorY() * 100)}
            onNumber={(value) => assignAnchor(anchorX(), value / 100)}
            step={1}
            unit="%"
            autoSelect
            sliderEnabled
            keyframe={<Keyframe target={props.node} property="anchorY" />}
          />
        </div>
        <AnchorPointPicker x={anchorX()} y={anchorY()} onPick={assignAnchor} />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={isDefault()} onSelect={() => assignAnchor(0.5, 0.5)}>
          Reset to Default
        </ContextMenuItem>
        <ContextMenuItem onSelect={props.onRemoveAddon}>
          Remove row
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
