import { Popover, PopoverContent, PopoverPortal, PopoverTrigger } from "@/components/ui/popover";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { CodexSkill } from "@desktop/codex-capabilities";
import { Button } from "@/components/ui/button";
import type { SkillCatalog } from "./use-codex-capabilities";

const statusLabels: Record<string, string> = {
  notStarted: "Not started", starting: "Starting", connected: "Connected", authenticationRequired: "Sign in required",
  failed: "Failed", cancelled: "Cancelled", disabled: "Disabled", configured: "Configured",
};

export function CodexCapabilitiesPicker(props: {
  onSkill: (skill: CodexSkill) => void;
  disabled: boolean;
  catalog: SkillCatalog;
}) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const capabilities = () => props.catalog.result();
  createEffect(() => { props.catalog.directory(); setOpen(false); });
  const matches = (text: string) => text.toLowerCase().includes(query().trim().toLowerCase());
  const skills = createMemo(() => capabilities()?.skills.filter((skill) => matches(`${skill.name} ${skill.description}`)) ?? []);
  const servers = createMemo(() => capabilities()?.mcpServers.filter((server) => matches(server.name)) ?? []);

  return <Popover open={open()} onOpenChange={(value) => { setOpen(value); if (value) void props.catalog.load(true); }} placement="top-start">
    <PopoverTrigger as={Button} type="button" variant="ghost" class="text-muted-foreground" disabled={props.disabled} >Skills and MCPs</PopoverTrigger>
    <PopoverPortal>
      <PopoverContent aria-label="Skills and MCP servers" class="w-80 max-w-[calc(100vw-2rem)] p-0">
        <div class="flex items-center gap-2 p-2">
          <input autofocus aria-label="Search skills and MCP servers" class="min-w-0 flex-1 rounded border border-border-input bg-background px-2 py-1.5 text-xs" placeholder="Search skills and MCPs" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} />
          <Button type="button" variant="ghost" aria-label="Close skills and MCPs" onClick={() => setOpen(false)}>Close</Button>
        </div>
        <div class="max-h-80 overflow-y-auto px-2 pb-2 text-xs">
          <Show when={props.catalog.loading()}><p class="p-2 text-muted-foreground" role="status">Loading…</p></Show>
          <Show when={props.catalog.error()}><p class="p-2 text-destructive" role="alert">{props.catalog.error()}</p></Show>
          <For each={capabilities()?.errors}>{(message) => <p class="p-2 text-destructive" role="alert">{message}</p>}</For>
          <Show when={capabilities()}>
            <h3 class="px-2 py-1 font-medium">Skills</h3>
            <For each={skills()} fallback={<p class="p-2 text-muted-foreground">No matching skills.</p>}>{(skill) => <button type="button" class="block w-full rounded px-2 py-2 text-left hover:bg-secondary focus-visible:outline focus-visible:outline-1" title={skill.path} onClick={() => { props.onSkill(skill); setOpen(false); }}>
              <span class="block font-medium">{skill.name}</span>
              <span class="mt-0.5 block line-clamp-2 text-muted-foreground">{skill.description}</span>
            </button>}</For>
            <h3 class="px-2 pb-1 pt-3 font-medium">MCP servers</h3>
            <p class="px-2 pb-2 text-muted-foreground">Ask for a tool in your message.</p>
            <For each={servers()} fallback={<p class="p-2 text-muted-foreground">No matching MCP servers.</p>}>{(server) => <div class="px-2 py-1.5">
              <span class="font-medium">{server.name}</span>
              <span class="block text-muted-foreground">{statusLabels[server.status] ?? server.status} · {server.toolCount} tools</span>
            </div>}</For>
          </Show>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </Popover>;
}
