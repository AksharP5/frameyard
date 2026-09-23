/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The messages, top-anchored like a document and pinned to the bottom once
// they overflow: the end of the streaming text stays right above the
// composer, a wheel-up lets go, scrolling back near the bottom pins again.

import { For, Show, createEffect, createSignal, on } from "solid-js";

import type { Item } from "@diffusionstudio/agent-chat";

import { ChatItem } from "./items";
import { RunningIndicator } from "./running-indicator";
import { createStickToBottom } from "./stick-to-bottom";
import { createTranscriptRows } from "./transcript-rows";

type TranscriptProps = {
  items: Item[];
  /** Bumped by the panel after every send, to pin the view to the end. */
  sendCount: number;
  /** Changes with the chat, so a newly opened one starts at its end. */
  chatKey: string;
  /** A turn is running: the last item is where the agent is right now. */
  running: boolean;
  /** The turn is paused on a question: the card below is the affordance, not a loader. */
  waiting: boolean;
  active?: boolean;
  onLoadEarlier?(): void;
};

const toolInFlight = (item: Item | undefined) => item?.kind === "tool" && item.status === "running";

export function Transcript(props: TranscriptProps) {
  const rows = createTranscriptRows(() => props.items, () => props.chatKey);
  const [scrollEl, setScrollEl] = createSignal<HTMLDivElement>();
  const stick = createStickToBottom(scrollEl, { initial: "instant", follow: () => props.active !== false });
  const last = () => props.items[props.items.length - 1];

  const pin = () => {
    // A chat opens at its end, with no scroll to watch
    const element = scrollEl();
    if (!element || props.active === false) return;
    element.scrollTop = element.scrollHeight;
    stick.scrollToBottom({ animation: "instant" });
  };

  createEffect(on(() => props.sendCount, (count) => count > 0 && stick.scrollToBottom(), { defer: true }));
  createEffect(on([() => props.chatKey, () => props.items.length > 0, () => props.active], pin));

  return (
    <div ref={setScrollEl} class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden" aria-label="Conversation" aria-busy={props.running}>
      <div class="flex flex-col gap-2 px-4 pb-2 pt-4">
        <Show when={props.onLoadEarlier}>
          <button type="button" class="self-start text-xs text-primary hover:underline" onClick={() => {
            const element = scrollEl();
            if (!element) return;
            const height = element.scrollHeight;
            const top = element.scrollTop;
            stick.stopScroll();
            props.onLoadEarlier?.();
            requestAnimationFrame(() => { element.scrollTop = top + element.scrollHeight - height; });
          }}>Load earlier messages</button>
        </Show>
        <For each={rows()}>
          {(item) => <ChatItem item={item()} />}
        </For>
        <Show when={!stick.isAtBottom() && props.items.length > 0}>
          <button type="button" class="sticky bottom-2 self-end rounded-md border border-border bg-background px-2 py-1 text-xs" onClick={() => void stick.scrollToBottom({ animation: "instant", ignoreEscapes: true })}>Jump to latest</button>
        </Show>
        {/* A tool in flight spins on its own row; the indicator covers everything else the turn does. */}
        <Show when={props.running && !props.waiting && !toolInFlight(last())}>
          <RunningIndicator last={last()} />
        </Show>
      </div>
    </div>
  );
}
