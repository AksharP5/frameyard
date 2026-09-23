import { For, type JSX } from "solid-js";
import { Tabs } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { agentTabs, catalogTabs, type ChatDraft } from "./chat-draft";

const panels = [
  "Editor",
  "Chat",
  ...agentTabs.filter((tab) => tab !== "Editor" && tab !== "Chat"),
] as const;
const label = (tab: ChatDraft["tab"]) =>
  tab === "Editor"
    ? "Properties"
    : tab === "Chat"
      ? "Assistant"
      : tab === "Assets"
        ? "Find assets"
        : tab;

export function WorkspaceTabs(props: {
  tab: ChatDraft["tab"];
  onChange: (tab: ChatDraft["tab"]) => void;
  open: boolean;
  children: JSX.Element;
}) {
  const section = () =>
    props.tab === "Chat" || props.tab === "Animations"
      ? props.tab
      : catalogTabs.some((tab) => tab === props.tab)
        ? "Catalog"
        : "Tools";

  return (
    <Tabs
      as="aside"
      value={section()}
      class="@container min-w-0 min-h-0 h-full gap-0 overflow-hidden bg-sidebar relative z-30"
      classList={{ hidden: !props.open }}
      aria-label="Editor workspace"
      style="-webkit-app-region: no-drag;"
    >
      <nav
        aria-label="Workspace panels"
        class="grid grid-cols-4 shrink-0 gap-x-1 gap-y-0.5 border-b border-border p-2"
      >
        <For each={panels}>
          {(tab) => (
            <Button
              variant="ghost"
              aria-pressed={props.tab === tab}
              class="h-8 min-w-0 rounded px-1 text-[11px] text-muted-foreground aria-pressed:bg-secondary aria-pressed:text-foreground"
              onClick={() => props.onChange(tab)}
            >
              {label(tab)}
            </Button>
          )}
        </For>
      </nav>
      {props.children}
    </Tabs>
  );
}
