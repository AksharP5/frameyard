import { For, Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js";
import { Popover, PopoverContent, PopoverPortal } from "@/components/ui/popover";
import { Icon } from "@/components/ui/icon";
import type { CodexSkill } from "@desktop/codex-capabilities";
import type { SkillCatalog } from "@/components/agent/use-codex-capabilities";
import { findSkillMentions, insertSkillMention, retainSkillMentions, skillMentionAt } from "./skill-mentions";

export type PromptInputProps = {
  text: string;
  onText(text: string): void;
  label: string;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  maxHeight?: number;
  class?: string;
  inputRef?(element: HTMLTextAreaElement): void;
  onKeyDown?(event: KeyboardEvent): void;
  catalog?: SkillCatalog;
  skills?: CodexSkill[];
  onSkills?(skills: CodexSkill[]): void;
};

/** One textarea for Home and the editor, with suggestions that keep typing focus. */
export function PromptInput(props: PromptInputProps) {
  let textarea: HTMLTextAreaElement | undefined;
  const id = createUniqueId();
  const [focused, setFocused] = createSignal(false);
  const [selection, setSelection] = createSignal({ start: 0, end: 0 });
  const [dismissed, setDismissed] = createSignal<string>();
  const [active, setActive] = createSignal(0);
  const trigger = createMemo(() => skillMentionAt(props.text, selection().start, selection().end));
  const triggerKey = () => `${trigger()?.start}:${trigger()?.query}`;
  const open = () => focused() && !props.disabled && !!props.catalog?.enabled() && !!trigger() && dismissed() !== triggerKey();
  const suggestions = createMemo(() => findSkillMentions(props.catalog?.result()?.skills ?? [], trigger()?.query ?? ""));
  const activeId = () => open() && suggestions()[active()] ? `${id}-skill-${active()}` : undefined;

  const resize = () => {
    if (!textarea?.clientWidth) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, props.maxHeight ?? 160)}px`;
  };
  createEffect(() => { void props.text; resize(); });
  createEffect(() => { triggerKey(); suggestions(); setActive(0); });
  createEffect(() => { if (open()) void props.catalog?.load(); });
  createEffect(() => {
    const selected = activeId();
    if (selected) queueMicrotask(() => document.getElementById(selected)?.scrollIntoView({ block: "nearest" }));
  });
  onMount(() => {
    const element = textarea;
    if (!element) return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      resize();
    });
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });

  const readSelection = () => {
    if (textarea) setSelection({ start: textarea.selectionStart, end: textarea.selectionEnd });
  };
  const choose = (skill: CodexSkill) => {
    const range = trigger();
    if (!range) return;
    const next = insertSkillMention(props.text, skill, range);
    const retained = retainSkillMentions(props.text, next.text, props.skills ?? []);
    props.onSkills?.([...retained.filter((entry) => entry.path !== skill.path && entry.name !== skill.name), skill]);
    props.onText(next.text);
    setDismissed(triggerKey());
    queueMicrotask(() => {
      textarea?.focus();
      textarea?.setSelectionRange(next.caret, next.caret);
      readSelection();
    });
  };
  const keyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229) return;
    if (open() && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(triggerKey());
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const count = suggestions().length;
        if (count) setActive((index) => (index + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && suggestions()[active()]) {
        event.preventDefault();
        choose(suggestions()[active()]);
        return;
      }
      if (event.key === "Enter" && props.catalog?.loading()) {
        event.preventDefault();
        return;
      }
    }
    props.onKeyDown?.(event);
  };

  return <>
    <textarea
      ref={(element) => { textarea = element; props.inputRef?.(element); }}
      value={props.text}
      onInput={(event) => {
        const next = event.currentTarget.value;
        const retained = retainSkillMentions(props.text, next, props.skills ?? []);
        if (retained.length !== props.skills?.length && props.skills) props.onSkills?.(retained);
        props.onText(next);
        readSelection();
      }}
      onSelect={readSelection}
      onClick={readSelection}
      onFocus={() => { setFocused(true); setDismissed(undefined); readSelection(); void props.catalog?.load(); }}
      onBlur={() => setFocused(false)}
      onKeyDown={keyDown}
      onKeyUp={(event) => { event.stopPropagation(); readSelection(); }}
      aria-label={props.label}
      role={props.catalog?.enabled() ? "combobox" : undefined}
      aria-haspopup={props.catalog?.enabled() ? "listbox" : undefined}
      aria-autocomplete={props.catalog?.enabled() ? "list" : undefined}
      aria-controls={open() ? `${id}-skills` : undefined}
      aria-expanded={props.catalog?.enabled() ? open() : undefined}
      aria-activedescendant={activeId()}
      placeholder={props.placeholder}
      disabled={props.disabled}
      rows={props.rows ?? 1}
      style={{ "max-height": `${props.maxHeight ?? 160}px` }}
      class={`min-h-7 w-full shrink-0 resize-none overflow-auto bg-transparent p-1 text-[12px] leading-5 text-foreground outline-none placeholder:text-muted-foreground selection:bg-selection selection:text-selection-foreground disabled:cursor-default ${props.class ?? ""}`}
    />
    <Popover open={open()} onOpenChange={(value) => { if (!value) setDismissed(triggerKey()); }} anchorRef={() => textarea} placement="top-start" modal={false}>
      <PopoverPortal>
        <PopoverContent
          role="presentation"
          class="w-[min(360px,calc(100vw-2rem))] max-h-[min(360px,60vh)] overflow-y-auto p-1 data-[expanded]:animate-none data-[closed]:animate-none"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => { if (event.target === textarea) event.preventDefault(); }}
        >
          <div class="flex items-center justify-between gap-2 px-2 py-1.5 text-[11px] text-muted-foreground"><span>Skills</span><span aria-hidden="true">↑↓ navigate · Tab select</span></div>
          <div id={`${id}-skills`} role="listbox" aria-label="Skills">
            <For each={suggestions()}>{(skill, index) => <button
              id={`${id}-skill-${index()}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={active() === index()}
              class="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left focus:outline-none"
              classList={{ "bg-accent": active() === index() }}
              title={`${skill.description}\n${skill.path}`}
              onPointerDown={(event) => event.preventDefault()}
              onPointerMove={() => setActive(index())}
              onClick={() => choose(skill)}
            ><span class="mt-0.5 font-mono text-xs text-muted-foreground">$</span><span class="min-w-0 flex-1"><span class="block truncate text-xs text-foreground">{skill.name}</span><span class="mt-0.5 line-clamp-1 text-[11px] leading-4 text-muted-foreground">{skill.description}</span></span><Show when={props.skills?.some((entry) => entry.path === skill.path)}><Icon name="confirm-check" class="size-4 text-muted-foreground" /></Show></button>}</For>
          </div>
          <Show when={!suggestions().length}>
            <p role="status" class="px-2 py-3 text-xs text-muted-foreground">{!props.catalog?.directory() ? "Choose a project to browse its skills." : props.catalog?.loading() ? "Loading skills…" : props.catalog?.error() || props.catalog?.result()?.errors[0] || "No matching skills."}</p>
          </Show>
          <Show when={props.catalog?.error() || props.catalog?.result()?.errors.length}><button type="button" class="px-2 pb-2 text-xs text-primary hover:underline" onPointerDown={(event) => event.preventDefault()} onClick={() => void props.catalog?.load(true)}>Refresh skills</button></Show>
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  </>;
}
