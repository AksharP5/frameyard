/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The prompt box, docked at the bottom of the panel in every state. Looks
// like the dashboard composer, sized to the chat sidebar, and never moves:
// no centred start, no animated height, a static placeholder.

import { For, Show, type JSX } from "solid-js";

import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverPortal, PopoverTrigger } from "@/components/ui/popover";
import type { CodexSkill } from "@desktop/codex-capabilities";
import type { SkillCatalog } from "@/components/agent/use-codex-capabilities";

import type { HarnessId, ModelRef } from "@diffusionstudio/agent-chat";

import { AttachmentTile, DropOverlay, createDropZone, mergeAttachments, type Attachment } from "./attachments";
import { ModelPicker } from "./model-picker";
import { PromptInput } from "./prompt-input";
import { removeSkillMention } from "./skill-mentions";

type ComposerProps = {
  text: string;
  attachments: Attachment[];
  onText(text: string): void;
  onAttachments(attachments: Attachment[]): void;
  /** Whether a turn runs or waits: the send button becomes Stop. */
  running: boolean;
  /** A question is pending: sending is disabled, Stop still works. */
  waiting: boolean;
  /** Why nothing can be sent, or null. Shown as the placeholder while the box is disabled. */
  blocked: string | null;
  model: ModelRef | null;
  onModel(ref: ModelRef): void;
  onSend(): void;
  onStop(): void;
  harness?: HarnessId;
  /** Native Codex accepts another message while its current turn runs. */
  steering?: boolean;
  sendDisabled?: boolean;
  hasContent?: boolean;
  placeholder?: string;
  label?: string;
  onFiles?(files: File[]): void;
  inputRef?(element: HTMLTextAreaElement): void;
  context?: JSX.Element;
  controls?: JSX.Element;
  modelControl?: JSX.Element;
  variant?: "home" | "panel";
  catalog?: SkillCatalog;
  skills?: CodexSkill[];
  onSkills?(skills: CodexSkill[]): void;
};

export function Composer(props: ComposerProps) {
  const drop = createDropZone((dropped) => props.onAttachments(mergeAttachments(props.attachments, dropped)));

  const canSend = () => (!props.running || props.steering) && !props.waiting && !props.blocked && !props.sendDisabled && props.model !== null && (props.hasContent ?? (props.text.trim().length > 0 || props.attachments.length > 0));

  // Enter sends, shift+enter breaks the line — and the editor's shortcuts
  // have no business reading what is typed here. Only native Codex can
  // receive another message while a turn is running.
  const handleKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (canSend()) props.onSend();
  };

  const sendTitle = () => (props.waiting ? "Waiting for your answer" : props.blocked ?? "Send");

  return (
    <div
      class={`relative flex min-h-0 shrink-0 flex-col gap-2 border border-border bg-accent p-2 focus-within:border-border-input ${props.variant === "home" ? "z-10 w-full rounded-[20px]" : "mx-3 mb-3 max-h-[60%] rounded-2xl"}`}
      onDragOver={drop.onDragOver}
      onDragEnter={(event) => props.onFiles ? event.preventDefault() : drop.onDragEnter(event)}
      onDragLeave={drop.onDragLeave}
      onDrop={(event) => {
        if (!props.onFiles) return drop.onDrop(event);
        event.preventDefault();
        event.stopPropagation();
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length) props.onFiles(files);
      }}
    >
      <div class="flex min-h-0 flex-col gap-2 overflow-y-auto">
        <Show when={props.attachments.length > 0}>
          {/* The remove buttons overhang the tiles' corners, and a scrolling
              row clips at its edge — so the row pads for them and pulls itself
              back up by the same amount. */}
          <div class="-mt-2.5 flex w-full items-start gap-1.5 overflow-x-auto pt-2.5 pr-2.5">
            <For each={props.attachments}>
              {(entry) => (
                <AttachmentTile
                  attachment={entry}
                  class="size-9 [&>div]:rounded-md"
                  onRemove={() => props.onAttachments(props.attachments.filter((item) => item.key !== entry.key))}
                />
              )}
            </For>
          </div>
        </Show>

        {props.context}

        <Show when={props.skills?.length}>
          <div class="flex flex-wrap gap-1 px-1" aria-label="Attached skills">
            <For each={props.skills}>{(skill) => <span class="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-background/50 pl-2 text-[11px]">
              <span class="truncate" title={skill.path}>${skill.name}</span>
              <button type="button" aria-label={`Remove ${skill.name} skill`} class="grid size-6 shrink-0 place-items-center rounded-r-md text-muted-foreground hover:text-foreground focus-ring" onClick={() => {
                props.onSkills?.(props.skills?.filter((entry) => entry.path !== skill.path) ?? []);
                props.onText(removeSkillMention(props.text, skill.name));
              }}><Icon name="close-remove-small" class="size-3.5" /></button>
            </span>}</For>
          </div>
        </Show>

        <PromptInput
          inputRef={props.inputRef}
          text={props.text}
          onText={props.onText}
          onKeyDown={handleKeyDown}
          label={props.label ?? "Message the agent"}
          placeholder={props.blocked ?? props.placeholder ?? "Describe an edit…"}
          disabled={props.blocked !== null}
          rows={2}
          maxHeight={props.variant === "home" ? 200 : 160}
          class="min-h-12"
          catalog={props.catalog}
          skills={props.skills}
          onSkills={props.onSkills}
        />
      </div>
      <div class="flex min-h-7 shrink-0 items-center justify-between gap-1">
        <Show when={props.controls}>
          <Popover placement="top-start">
            <PopoverTrigger as="button" type="button" aria-label="Add context" title="Add context" class="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-ring">
              <Icon name="plus-add" class="size-4" />
            </PopoverTrigger>
            <PopoverPortal><PopoverContent aria-label="Add context" class="w-72 max-w-[calc(100vw-2rem)] p-1">{props.controls}</PopoverContent></PopoverPortal>
          </Popover>
        </Show>
        <Show when={props.modelControl} fallback={<ModelPicker value={props.model} onSelect={props.onModel} class="min-w-0" harness={props.harness} />}>
          {props.modelControl}
        </Show>
        <div class="ml-auto flex items-center gap-1">
          <Show when={!props.running || props.steering}>
            <button
              type="button"
              onClick={() => canSend() && props.onSend()}
              disabled={!canSend()}
              aria-label={props.running ? "Steer Codex" : "Send"}
              title={props.running ? "Send direction to the current turn" : sendTitle()}
              class="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-opacity hover:bg-primary-hover disabled:pointer-events-none disabled:opacity-40 focus-ring"
            >
              <Icon name="arrow-top" />
            </button>
          </Show>
          <Show when={props.running}>
            <button
              type="button"
              onClick={props.onStop}
              aria-label="Stop"
              title="Stop"
              class="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground hover:bg-primary-hover focus-ring"
            >
              <Icon name="stop" />
            </button>
          </Show>
        </div>
      </div>

      <Show when={drop.dragging()}>
        <DropOverlay radius="rounded-xl" />
      </Show>
    </div>
  );
}
