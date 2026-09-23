import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import type { CatalogEntry, CatalogItem, CatalogRequest, CatalogResponse, CatalogSource } from "@desktop/hyperframes-contracts";
import { mainBridge } from "@/lib/ipc";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { SearchInput } from "@/components/ui/search-input";
import { CatalogPreview } from "./catalog-preview";

export type CatalogReference = { catalog: CatalogSource; item: CatalogItem };

export function HyperframesCatalog(props: {
  active: boolean;
  catalog?: CatalogSource;
  templates?: boolean;
  onReference: (reference: CatalogReference) => void;
}) {
  const source = () => props.catalog ?? "hyperframes";
  const isHyfrme = () => source() === "hyfrme";
  const title = () => isHyfrme() ? "Hyfrme" : props.templates ? "HyperFrames templates" : "HyperFrames catalog";
  const request = (input: CatalogRequest) => mainBridge.call(isHyfrme() ? MAIN_CHANNELS.HYFRME_REQUEST : MAIN_CHANNELS.HYPERFRAMES_REQUEST, input);
  const category = (item: CatalogEntry) => {
    if (!isHyfrme()) return item.type;
    if (item.tags.includes("icon")) return "icons";
    if (item.name.startsWith("shader-")) return "shaders";
    if (item.tags.includes("primitive") || item.tags.includes("ui")) return "primitives";
    return "components";
  };
  const [query, setQuery] = createSignal("");
  const [filter, setFilter] = createSignal(props.templates ? "template" : "all");
  const [selected, setSelected] = createSignal<CatalogEntry>();
  let results!: HTMLDivElement;
  let returnFocus: HTMLButtonElement | undefined;
  let scrollTop = 0;
  const back = () => {
    setSelected(undefined);
    queueMicrotask(() => {
      results.scrollTop = scrollTop;
      returnFocus?.focus({ preventScroll: true });
    });
  };
  const search = (value: string) => {
    setQuery(value);
    setSelected(undefined);
    results.scrollTop = 0;
  };
  const [catalog, { refetch }] = createResource(() => props.active && source(), async (_source, info): Promise<Extract<CatalogResponse, { action: "list" }>> => {
    const result = await request({ action: "list", refresh: info.refetching === true });
    if (result.action !== "list") throw new Error("Unexpected catalog response.");
    return result;
  });
  const [detail, { refetch: retryDetail }] = createResource(selected, async (entry) => {
    const result = await request({ action: "detail", name: entry.name, type: entry.type });
    if (result.action !== "detail") throw new Error("Unexpected catalog detail.");
    return result.item;
  });
  const readyDetail = () => detail.loading || detail.error ? undefined : detail();
  const metadata = () => {
    const item = readyDetail();
    const dimensions = item?.dimensions;
    return [dimensions && `${dimensions.width} × ${dimensions.height}`, item?.duration && `${item.duration}s`].filter(Boolean).join(" · ");
  };
  const items = createMemo(() => {
    const words = query().toLowerCase().trim().split(/\s+/).filter(Boolean);
    return (catalog.error ? [] : catalog()?.items ?? []).filter((item) => {
      if (!isHyfrme() && (item.type === "example" || item.type === "template") !== !!props.templates) return false;
      if (filter() !== "all" && category(item) !== filter()) return false;
      const text = `${item.title} ${item.description} ${item.tags.join(" ")}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  });

  return (
    <section class="flex h-full min-h-0 flex-col text-xs" aria-label={title()} onKeyDown={(event) => {
      if (event.key !== "Escape" || !selected() || document.fullscreenElement || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      event.preventDefault();
      event.stopPropagation();
      back();
    }}>
      <SearchInput placeholder={isHyfrme() ? "Search Hyfrme components" : props.templates ? "Search HyperFrames templates" : "Search scenes and effects"} value={query()} onValue={search} />
      <div class="flex items-center justify-between gap-2 px-3 py-2">
        <Show when={!props.templates} fallback={
          <select aria-label="Template collection" class="bg-background text-foreground outline-none" value={filter()} onChange={(event) => { setFilter(event.currentTarget.value); setSelected(undefined); results.scrollTop = 0; }}>
            <option value="template">Website videos</option>
            <option value="example">Starter examples</option>
          </select>
        }>
          <select aria-label="Catalog type" class="bg-background text-foreground outline-none" value={filter()} onChange={(event) => { setFilter(event.currentTarget.value); setSelected(undefined); results.scrollTop = 0; }}>
            <option value="all">All</option>
            <Show when={isHyfrme()} fallback={<><option value="block">Scenes</option><option value="component">Effects</option></>}>
              <option value="components">Components</option><option value="primitives">Primitives</option><option value="shaders">Shaders</option><option value="icons">Icons</option>
            </Show>
          </select>
        </Show>
        <div class="flex items-center gap-2">
          <span class="text-muted-foreground">{items().length} items</span>
          <Button variant="ghost" aria-label={`Refresh ${title()}`} disabled={catalog.loading} onClick={() => void refetch()}>Refresh</Button>
        </div>
      </div>
      <Show when={catalog.loading}><p class="px-3 py-2 text-muted-foreground">Loading catalog…</p></Show>
      <Show when={catalog.error}><div class="px-3 py-2"><p role="alert">{String(catalog.error)}</p><Button variant="link" onClick={() => void refetch()}>Retry</Button></div></Show>
        <div ref={results} role="region" aria-label="Catalog results" class="min-h-0 flex-1 overflow-y-auto px-3 pb-3" classList={{ hidden: !!selected() }}>
          <div class="grid grid-cols-2 gap-x-3 gap-y-4" classList={{ "@[560px]:grid-cols-3": props.templates }}>
            <For each={items()}>{(item) => (
              <button aria-label={item.title} title={item.title} class="min-w-0 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar" onClick={(event) => {
                scrollTop = results.scrollTop;
                returnFocus = event.currentTarget;
                setSelected(item);
              }}>
                <CatalogPreview active={props.active && !selected()} catalog={source()} item={item} />
                <span class="block mt-2 line-clamp-2 leading-snug">{item.title}</span>
                <span class="text-muted-foreground">{isHyfrme() ? "Motion block" : item.type === "template" ? "Video template" : item.type === "example" ? "Starter example" : item.type === "block" ? "Scene" : "Effect"}</span>
              </button>
            )}</For>
          </div>
          <Show when={!catalog.loading && !catalog.error && items().length === 0}><div class="py-8 text-center"><p class="text-muted-foreground">No matches{query().trim() ? ` for "${query().trim()}"` : ""}.</p><Show when={query()}><Button variant="link" class="mt-2" onClick={() => search("")}>Clear search</Button></Show></div></Show>
        </div>
      <Show when={selected()} keyed>
        {(entry) => (
          <div class="flex min-h-0 flex-1 flex-col">
            <div class="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-3">
            <Button variant="link" class="gap-1.5" onClick={back}><Icon name="arrow-right" class="size-3.5 rotate-180" />Back to {props.templates ? "templates" : "catalog"}</Button>
            <div>
              <h3 class="text-sm font-medium">{entry.title}</h3>
              <Show when={metadata()}><p class="mt-1 text-muted-foreground tabular-nums">{metadata()}</p></Show>
            </div>
            <Show when={detail.loading}><p class="text-muted-foreground">Loading details…</p></Show>
            <Show when={detail.error}><p role="alert">{String(detail.error)}</p><Button variant="link" onClick={() => void retryDetail()}>Retry</Button></Show>
            <Show when={readyDetail()}>{(item) => (
              <>
                <CatalogPreview active={props.active} catalog={source()} item={{ ...item(), poster: item().preview?.poster ?? entry.poster, video: item().preview?.video ?? entry.video }} interactive />
                <p class="text-muted-foreground leading-relaxed">{item().description}</p>
                <Show when={item().type === "template"}><p class="text-muted-foreground">From hyperframes.dev. Includes editable source and assets.</p></Show>
                <Show when={item().deprecated}><p>{item().deprecated}</p></Show>
              </>
            )}</Show>
            </div>
            <Show when={readyDetail()}>{(item) => <div class="shrink-0 border-t border-border p-3"><Button class="w-full" onClick={() => props.onReference({ catalog: source(), item: item() })}>{item().type === "template" ? "Remix with agent" : "Add to chat"}</Button></div>}</Show>
          </div>
        )}
      </Show>
    </section>
  );
}
