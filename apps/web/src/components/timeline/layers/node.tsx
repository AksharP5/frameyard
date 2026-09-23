/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMemo, createSignal, onCleanup, Show } from 'solid-js';
import { useTag, useTrait, useWorld } from '@diffusionstudio/koota-solid';
import {
  Audio,
  ClipHeight,
  ClipLink,
  Expanded,
  Hidden,
  Hovering,
  Locked,
  Muted,
  Name,
  Selected,
  Soloed,
  findGeometryAsset,
  getEntityChildren,
  getParentEntity,
  isAdjustmentLayer,
  isCaption,
  isGroup,
  isMask,
  isScene,
  isSequence,
  isText,
} from '@diffusionstudio/runtime';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from '@/components/ui/tooltip';
import { useEditor } from '@/engine/hooks';
import { isClipLocked, linkableSelection, linkSelection, selectedClips, unlinkSelection } from '@/engine/clip-links';
import { canSeparateAudio, separateAudio } from '@/engine/insert-asset';
import { timelineEditing, toggleSyncTrack } from '@/engine/timeline-editing';
import { DEFAULT_CLIP_HEIGHT, MAX_CLIP_HEIGHT, MIN_CLIP_HEIGHT, getClipFallbackName } from '@/engine/timeline';
import { NESTED_INDENT_PX } from './config';
import { useLayerContext } from './context';
import { setRowHover } from './hover';

import type { Entity, World } from 'koota';
import type { TimelineNode } from '@diffusionstudio/runtime';
import type { LayerRowProps } from './layer';

export function NodeLayer(props: LayerRowProps) {
  const world = useWorld();
  const editor = useEditor();
  const editingState = timelineEditing(world);

  const entity = () => props.layer.entity;

  const clipHeight = useTrait(entity, ClipHeight);
  const height = () => clipHeight()?.value ?? DEFAULT_CLIP_HEIGHT;

  const muted = useTag(entity, Muted);
  const soloed = useTag(entity, Soloed);
  const hidden = useTag(entity, Hidden);
  const hovering = useTag(entity, Hovering);
  const selected = useTag(entity, Selected);
  const clipLink = useTrait(entity, ClipLink);
  const linked = () => !!clipLink()?.value;
  const locked = useTag(entity, Locked);
  const [focused, setFocused] = createSignal(false);
  const controlsVisible = createMemo(() => hovering() || focused() || muted() || soloed() || hidden());

  const { resized: resizedSignal, drag } = useLayerContext();
  const [resized, setResized] = resizedSignal;

  const [editing, setEditing] = createSignal(false);
  let originalName = '';

  const nameTrait = useTrait(entity, Name);
  const name = createMemo(() => nameTrait()?.value || getClipFallbackName(world, entity()));
  const icon = createMemo(() => getLayerIcon(world, props.layer));

  const toggleMuted = (e?: Event) => {
    e?.stopPropagation();
    editor.editProperty(entity(), 'muted', !muted());
  };

  const toggleLocked = () => editor.editProperty(entity(), 'locked', !locked());

  const toggleHidden = (e?: Event) => {
    e?.stopPropagation();
    editor.editProperty(entity(), 'hidden', !hidden());
  };

  const toggleExpanded = (e?: Event) => {
    e?.stopPropagation();
    editor.editProperty(entity(), 'expanded', !entity().has(Expanded));
  };

  /**
   * Solo is monitoring rather than composition — it says what you want to
   * hear right now, which the file has nothing to say about — so it is
   * written to the trait and only one node holds it.
   */
  const toggleSoloed = (e?: Event) => {
    e?.stopPropagation();

    const wasSoloed = soloed();
    for (const other of world.query(Soloed)) other.remove(Soloed);
    if (!wasSoloed) entity().add(Soloed);
  };

  /**
   * A press on a row selects it, shift-clicking to extend the selection. A
   * plain press also arms a drag: moving far enough turns the press into
   * dragging the layer to a new place in the tree.
   */
  const handleRowPointerDown = (e: PointerEvent) => {
    if ((e.button !== 0 && e.button !== 2) || resized() !== null) return;
    if ((e.target as HTMLElement | null)?.closest('button')) return;

    if (!selected() || e.shiftKey || e.altKey || !editor.linkedSelection) editor.select(entity(), { extend: e.shiftKey, linked: !e.altKey });
    if (e.button === 0 && !e.shiftKey && !isClipLocked(entity())) drag.begin(e, entity());
  };

  let resizeStartY = 0;
  let resizeStartHeight = 0;
  let resizeEntity: Entity | null = null;

  const handleResizeMove = (e: PointerEvent) => {
    if (!resizeEntity?.isAlive()) { handleResizeEnd(); return; }
    const next = Math.max(MIN_CLIP_HEIGHT, Math.min(MAX_CLIP_HEIGHT, resizeStartHeight + e.clientY - resizeStartY));
    if (next === (resizeEntity.get(ClipHeight)?.value ?? DEFAULT_CLIP_HEIGHT)) return;
    editor.editProperty(resizeEntity, 'clipHeight', next);
  };

  const handleResizeEnd = () => {
    if (!resizeEntity) return;
    resizeEntity = null;
    setResized(null);
    document.removeEventListener('pointermove', handleResizeMove);
    document.removeEventListener('pointerup', handleResizeEnd);
    document.removeEventListener('pointercancel', handleResizeEnd);
  };

  const handleResizeStart = (e: PointerEvent) => {
    if (e.button !== 0 || resized() !== null) return;
    e.preventDefault();
    e.stopPropagation();
    resizeEntity = entity();
    resizeStartY = e.clientY;
    resizeStartHeight = height();
    setResized(resizeEntity);

    document.addEventListener('pointermove', handleResizeMove);
    document.addEventListener('pointerup', handleResizeEnd);
    document.addEventListener('pointercancel', handleResizeEnd);
  };
  onCleanup(handleResizeEnd);

  const handleRemove = () => editor.remove(selectedClips(world));

  /**
   * The column reads top-down while the file reads bottom-up: the last child
   * of an element is the one drawn on top, so "front" is the end of the file
   * and "back" is the beginning.
   */
  const handleReorder = (target: 'front' | 'back') => {
    if (isClipLocked(entity())) return;
    const parent = getParentEntity(entity());
    if (!parent) return;

    const siblings = getEntityChildren(world, parent).filter((sibling) => sibling !== entity());
    editor.reparent(entity(), parent, target === 'back' ? siblings[0] : undefined);
  };

  const startEditing = () => {
    if (isClipLocked(entity())) return;
    originalName = name();
    setEditing(true);
  };

  const finishEditing = (input: HTMLInputElement) => {
    if (!editing()) return;
    setEditing(false);
    if (input.value.trim() && input.value !== originalName) editor.editProperty(entity(), 'name', input.value);
  };

  const handleNameKeyDown = (e: KeyboardEvent) => {
    // The canvas is listening for keys; a name being typed is not a shortcut.
    e.stopPropagation();
    if (e.isComposing) return;
    const input = e.currentTarget as HTMLInputElement;

    if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(false);
      input.blur();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    }
  };

  const mountNameInput = (input: HTMLInputElement) => {
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger
        as="div"
        data-layer-row
        class="w-full text-muted-foreground group relative select-none"
        onPointerEnter={() => setRowHover(world, entity())}
        onPointerLeave={() => setRowHover(world, null)}
        onPointerDown={handleRowPointerDown}
        onFocusIn={() => setFocused(true)}
        onFocusOut={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocused(false);
        }}
        classList={{
          'bg-accent': selected(),
          'bg-accent/70': !selected() && hovering() && resized() === null && drag.dragging() === null,
          'bg-accent/40': !selected() && !(hovering() && resized() === null) && props.ancestorSelected,
          'opacity-60': drag.dragging() === entity(),
        }}
        style={{ height: height() + 'px' }}
      >
        <div class="w-full pl-0.5 pr-2 flex items-center justify-between h-full">
          <div
            data-layer-label
            class="flex-1 min-w-0 overflow-hidden"
            style={{
              'mask-image': controlsVisible() && !editing() ? 'linear-gradient(to right, #000 calc(100% - 1.25rem), transparent)' : undefined,
              '-webkit-mask-image': controlsVisible() && !editing() ? 'linear-gradient(to right, #000 calc(100% - 1.25rem), transparent)' : undefined,
            }}
          >
            <div
              class="flex items-center gap-0.5 w-max"
              style={{
                'padding-left': `${props.depth * NESTED_INDENT_PX}px`,
                transform: editing() ? 'none' : 'translateX(calc(var(--layer-x, 0px) * -1))',
              }}
            >
              <button
                disabled={!props.layer.expandable}
                onClick={toggleExpanded}
                class="size-4 shrink-0 flex items-center justify-center overflow-clip invisible group-hover/layers:visible focus-ring rounded-sm"
              >
                <Show when={props.layer.expandable}>
                  <Icon name={props.expanded ? "chevron-down" : "chevron-right"} class="size-6 hover:text-foreground" />
                </Show>
              </button>
              <div class="size-4 shrink-0 flex items-center justify-center overflow-clip mr-0.5">
                <Icon name={icon()} class="size-6" />
              </div>
              <Show when={isSequence(entity()) && editingState.target() === entity()}>
                <span class="text-[10px] text-primary px-0.5" title="Target for source edits">T</span>
              </Show>
              <Show when={isSequence(entity()) && editingState.syncTracks().has(entity())}>
                <span class="text-[10px] text-primary px-0.5" title="Follows ripple edits">S</span>
              </Show>
              <Show when={linked()}>
                <span class="size-3 shrink-0 mr-0.5" title="Linked clips">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-label="Linked">
                    <path d="m6.5 9.5 3-3M6 11l-1 1a2.8 2.8 0 0 1-4-4l3-3a2.8 2.8 0 0 1 4 0m0 6a2.8 2.8 0 0 0 4 0l3-3a2.8 2.8 0 0 0-4-4l-1 1" />
                  </svg>
                </span>
              </Show>
              <Show when={locked()}>
                <span class="size-3 shrink-0 mr-0.5" title="Locked">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-label="Locked">
                    <rect x="3" y="7" width="10" height="7" rx="1" />
                    <path d="M5 7V5a3 3 0 0 1 6 0v2" />
                  </svg>
                </span>
              </Show>
              <Show
                when={editing()}
                fallback={
                  <span class="text-xs px-0.5 shrink-0 whitespace-nowrap text-foreground" onDblClick={startEditing}>
                    {name()}
                  </span>
                }
              >
                <input
                  ref={mountNameInput}
                  type="text"
                  aria-label="Layer name"
                  class="text-xs bg-input border border-primary rounded-sm outline-none px-0.5 w-32 text-foreground"
                  value={originalName}
                  onKeyDown={handleNameKeyDown}
                  onBlur={(e) => finishEditing(e.currentTarget)}
                  onPointerDown={(e) => e.stopPropagation()}
                  onDblClick={(e) => e.stopPropagation()}
                />
              </Show>
            </div>
          </div>

          <Show when={controlsVisible()}>
            <div
              class="items-center flex gap-0.5 shrink-0 overflow-hidden group-hover:w-auto group-focus-within:w-auto"
              classList={{
                'hidden': resized() !== null,
                'w-0': !(muted() || soloed() || hidden()),
                'w-auto': muted() || soloed() || hidden(),
              }}
            >
              <Tooltip placement="bottom">
                <TooltipTrigger
                  as={Button}
                  variant={muted() ? "on" : "ghost"}
                  size="icon"
                  class="invisible group-hover:visible group-focus-within:visible"
                  style={{ visibility: muted() ? 'visible' : undefined }}
                  onClick={toggleMuted}
                >
                  <Icon name="mute" class="size-6" />
                </TooltipTrigger>
                <TooltipPortal>
                  <TooltipContent>{muted() ? "Unmute" : "Mute"}</TooltipContent>
                </TooltipPortal>
              </Tooltip>
              <Tooltip placement="bottom">
                <TooltipTrigger
                  as={Button}
                  variant={soloed() ? "on" : "ghost"}
                  size="icon"
                  class="invisible group-hover:visible group-focus-within:visible"
                  style={{ visibility: soloed() ? 'visible' : undefined }}
                  onClick={toggleSoloed}
                >
                  <Icon name="solo" class="size-6" />
                </TooltipTrigger>
                <TooltipPortal>
                  <TooltipContent>{soloed() ? "Unsolo" : "Solo"}</TooltipContent>
                </TooltipPortal>
              </Tooltip>
              <Tooltip placement="bottom">
                <TooltipTrigger
                  as={Button}
                  variant="ghost"
                  size="icon"
                  class="invisible group-hover:visible group-focus-within:visible"
                  onClick={toggleHidden}
                  style={{ visibility: hidden() ? 'visible' : undefined }}
                >
                  <Show when={!hidden()} fallback={<Icon name="eye-off" class="size-6" />}>
                    <Icon name="eye-on" class="size-6" />
                  </Show>
                </TooltipTrigger>
                <TooltipPortal>
                  <TooltipContent>{hidden() ? "Show" : "Hide"}</TooltipContent>
                </TooltipPortal>
              </Tooltip>
            </div>
          </Show>
        </div>

        {/* Drag the bottom edge to make the row taller. */}
        <div
          class="absolute bottom-0 left-0 right-0 h-[3px] cursor-ns-resize translate-y-0.5 z-20 group/resize"
          onPointerDown={handleResizeStart}
        >
          <div
            class="absolute left-0 right-0 top-px h-px transition-colors group-hover/resize:bg-primary"
            classList={{ 'bg-primary': resized() === entity() }}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuPortal>
        <ContextMenuContent data-timeline-controls class="w-[160px]" onCloseAutoFocus={(event) => { if (editing()) event.preventDefault(); }}>
          <Show when={isSequence(entity())}>
            <ContextMenuItem disabled={isClipLocked(entity())} onSelect={() => editingState.setTarget(editingState.target() === entity() ? null : entity())}>
              {editingState.target() === entity() ? 'Clear target track' : 'Target track'}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => toggleSyncTrack(world, entity())}>
              {editingState.syncTracks().has(entity()) ? 'Disable sync lock' : 'Sync lock'}
            </ContextMenuItem>
            <ContextMenuSeparator />
          </Show>
          <ContextMenuItem disabled={isClipLocked(entity())} onSelect={startEditing}>Rename</ContextMenuItem>
          <ContextMenuItem onSelect={toggleLocked}>{locked() ? 'Unlock' : 'Lock'}</ContextMenuItem>
          <Show when={canSeparateAudio(world, entity())}>
            <ContextMenuItem onSelect={() => separateAudio(world, entity())}>Separate audio</ContextMenuItem>
            <ContextMenuSeparator />
          </Show>
          <ContextMenuItem disabled={linkableSelection(world).length < 2} onSelect={() => linkSelection(world)}>
            Link clips<ContextMenuShortcut>Ctrl+L</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem disabled={!linked()} onSelect={() => unlinkSelection(world)}>
            Unlink clips<ContextMenuShortcut>Ctrl+Shift+L</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={toggleMuted}>{muted() ? 'Unmute' : 'Mute'}</ContextMenuItem>
          <ContextMenuItem onSelect={toggleSoloed}>{soloed() ? 'Unsolo' : 'Solo'}</ContextMenuItem>
          <ContextMenuItem onSelect={toggleHidden}>{hidden() ? 'Unhide' : 'Hide'}</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => handleReorder('front')}>
            Bring to front
            <ContextMenuShortcut>]</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleReorder('back')}>
            Send to back
            <ContextMenuShortcut>[</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={handleRemove}>Remove</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenuPortal>
    </ContextMenu>
  )
}

function getLayerIcon(world: World, layer: TimelineNode) {
  const entity = layer.entity;

  if (isMask(entity)) return "mask-small";
  if (isAdjustmentLayer(entity)) return "adjustment-layer";
  if (isScene(entity)) return "scene-frame-small";
  if (isSequence(entity)) return "timeline-sequence-small";
  if (isGroup(entity)) return "group";
  if (isCaption(entity)) return "captions-small";
  if (isText(entity)) return "text-small";
  if (entity.has(Audio)) return "audio-small";

  switch (findGeometryAsset(world, entity)?.type) {
    case 'IMAGE':
      return "image-small";
    case 'VIDEO':
    case 'SEQUENCE':
      return "video-small";
    case 'AUDIO':
      return "audio-small";
    default:
      return "rectangle-small";
  }
}
