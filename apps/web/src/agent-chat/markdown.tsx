/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Assistant text as markdown: marked for the parse, DOMPurify for the
// sanitising, no syntax highlighting. Links open in the shell, not the app.

import { createMemo } from "solid-js";
import { toast } from "somoto";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { mainBridge } from "@/lib/ipc";
import { renderChatMarkdown } from "@/components/agent/chat-markdown";

const handleClick = (event: MouseEvent) => {
  const anchor = event.target instanceof Element ? event.target.closest("a") : null;
  if (!anchor) return;
  event.preventDefault();
  if (!/^https?:\/\//i.test(anchor.href)) return;
  if (!window.desktop) {
    window.open(anchor.href, "_blank", "noopener,noreferrer");
    return;
  }
  void mainBridge.call(MAIN_CHANNELS.APP_OPEN_EXTERNAL, { url: anchor.href }).catch((error: Error) => toast.error("Could not open link", { description: error.message }));
};

/** The classes that give the rendered HTML its 12 px, muted-chrome look. */
const MARKDOWN_CLASS = [
  "text-[12px] leading-5 text-foreground break-words min-w-0 max-w-full",
  "[&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
  "[&_h1]:text-[13px] [&_h2]:text-[13px] [&_h3]:text-[12px] [&_h1]:font-450 [&_h2]:font-450 [&_h3]:font-450 [&_h1]:mt-3 [&_h2]:mt-3 [&_h3]:mt-2 [&_h1]:mb-1 [&_h2]:mb-1 [&_h3]:mb-1",
  "[&_strong]:font-450 [&_b]:font-450",
  "[&_ul]:my-1.5 [&_ol]:my-1.5 [&_ul]:pl-4 [&_ol]:pl-4 [&_ul]:list-disc [&_ol]:list-decimal [&_li]:my-0.5",
  "[&_code]:rounded [&_code]:bg-input [&_code]:px-1 [&_code]:py-px [&_code]:text-[11px] [&_code]:font-mono",
  "[&_pre]:my-1.5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-input [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
  "[&_blockquote]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2 [&_blockquote]:text-muted-foreground",
  "[&_hr]:my-2 [&_hr]:border-border",
  "[&_table]:my-1.5 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_td]:border [&_th]:border-border [&_td]:border-border [&_th]:px-1.5 [&_td]:px-1.5 [&_th]:py-0.5 [&_td]:py-0.5 [&_th]:text-left",
  "[&_img]:max-w-full [&_img]:rounded-md",
].join(" ");

export function Markdown(props: { text: string }) {
  const html = createMemo(() => renderChatMarkdown(props.text));
  return <div class={MARKDOWN_CLASS} innerHTML={html()} onClick={handleClick} />;
}
