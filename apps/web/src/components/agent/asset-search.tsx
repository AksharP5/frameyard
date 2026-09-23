import { For, Show, createSignal } from "solid-js";
import { mainBridge } from "@/lib/ipc";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import type { AssetCandidate } from "@desktop/agent-asset-contracts";
import { useProject } from "@/context/project";
import { useLibrary } from "@/engine/library";
import { addAgentAsset } from "@/dapi/agent";
import { Button } from "@/components/ui/button";

export function AssetSearch(props: { onAsk: (prompt: string) => void }) {
  const project = useProject();
  const library = useLibrary();
  const [query, setQuery] = createSignal("");
  const [kind, setKind] = createSignal<"logo" | "image">("logo");
  const [assets, setAssets] = createSignal<AssetCandidate[]>([]);
  const [added, setAdded] = createSignal<Record<string, string>>({});
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const fail = (error: unknown) => setMessage(error instanceof Error ? error.message : String(error));

  const search = async () => {
    if (!query().trim() || busy()) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await mainBridge.call(MAIN_CHANNELS.ASSETS_SEARCH, { query: query(), kind: kind() });
      setAssets(result.assets);
      setMessage(result.warnings.join(" ") || (result.assets.length ? "" : "No results. Ask Codex to find an image."));
    } catch (error) { fail(error); }
    finally { setBusy(false); }
  };

  const add = async (asset: AssetCandidate) => {
    setBusy(true);
    setMessage("");
    try {
      const result = await mainBridge.call(MAIN_CHANNELS.ASSETS_IMPORT, {
        dir: project.dir(), url: asset.url, title: asset.title,
        sourcePageUrl: asset.sourcePageUrl, attribution: asset.attribution, query: query(),
      });
      await library()?.load();
      setAdded((current) => ({ ...current, [asset.id]: result.libraryPath }));
      setMessage(`Added ${asset.title} to Assets`);
    } catch (error) { fail(error); }
    finally { setBusy(false); }
  };

  return <div class="flex flex-col min-h-0 h-full">
    <form class="flex gap-2 p-3" onSubmit={(event) => { event.preventDefault(); void search(); }}>
      <input class="min-w-0 flex-1 bg-background border border-border-input rounded px-2 py-1.5 text-xs" aria-label="Search assets" placeholder="Search assets…" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} />
      <select class="bg-background border border-border-input rounded text-xs" aria-label="Asset type" value={kind()} onChange={(event) => setKind(event.currentTarget.value as "logo" | "image")}><option value="logo">Logos</option><option value="image">Images</option></select>
      <Button type="submit" disabled={busy() || !query().trim()}>Find</Button>
    </form>
    <div class="flex gap-3 px-3 pb-3 text-xs">
      <Button variant="link" disabled={!query().trim()} onClick={() => props.onAsk(`Find an image of ${query()} and add it to this project's assets. Keep its source URL.`)}>Ask Codex to find</Button>
      <Button variant="link" disabled={!query().trim()} onClick={() => props.onAsk(`Generate an image: ${query()}. Save it to this project's assets.`)}>Generate image</Button>
    </div>
    <Show when={message()}><p class="px-3 pb-3 text-xs text-muted-foreground" role="status">{message()}</p></Show>
    <div class="overflow-y-auto flex-1 px-3 pb-3 grid grid-cols-2 gap-3 content-start">
      <For each={assets()}>{(asset) => <div class="min-w-0">
        <div class="aspect-video bg-background flex items-center justify-center rounded overflow-hidden"><img src={asset.previewUrl} alt={asset.title} loading="lazy" class="max-w-full max-h-full object-contain p-2" /></div>
        <p class="text-xs mt-1 truncate" title={asset.title}>{asset.title}</p>
        <button class="block text-xxs text-muted-foreground hover:text-foreground" onClick={() => void mainBridge.call(MAIN_CHANNELS.APP_OPEN_EXTERNAL, { url: asset.sourcePageUrl })}>{asset.provider}</button>
        <Show when={added()[asset.id]} fallback={<Button class="mt-1 w-full" variant="secondary" disabled={busy()} onClick={() => void add(asset)}>Add to assets</Button>}>
          <Button class="mt-1 w-full" variant="secondary" onClick={() => void addAgentAsset(added()[asset.id]).catch(fail)}>Add to timeline</Button>
        </Show>
      </div>}</For>
    </div>
  </div>;
}
