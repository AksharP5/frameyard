import { createMemo, createSignal, type Accessor, type Signal } from "solid-js";
import type { Item } from "@diffusionstudio/agent-chat";

/** Keep each row mounted while immutable streamed items replace its contents. */
export function createTranscriptRows(items: Accessor<Item[]>, chatKey: Accessor<string>) {
  let currentChat: string | undefined;
  let rows = new Map<string, Signal<Item>>();

  return createMemo(() => {
    const nextChat = chatKey();
    if (nextChat !== currentChat) rows.clear();
    currentChat = nextChat;
    const next = new Map<string, Signal<Item>>();
    const result = items().map((item) => {
      const row = rows.get(item.id) ?? createSignal(item);
      row[1](item);
      next.set(item.id, row);
      return row[0];
    });
    rows = next;
    return result;
  });
}
