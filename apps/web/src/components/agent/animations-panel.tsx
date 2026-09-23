import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import type { Animation } from "@desktop/animation-contracts";
import { mainBridge } from "@/lib/ipc";
import { SequencePreview } from "./sequence-preview";
import { useLibrary } from "@/engine/library";
import { useActiveScene } from "@/engine/hooks/use-active-scene";
import { isScene } from "@diffusionstudio/runtime";
import { createProjectFS } from "@/projects/fs";
import { useProject } from "@/context/project";
import { addAgentAsset } from "@/dapi/agent";
import { editorSession, requireEditorSession } from "@/dapi/session";
import { insertMotionTree } from "@/engine/motion-library";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export function AnimationsPanel(props: {
  active: boolean;
  revision: number;
  onAsk: (prompt: string) => void;
  onBrowse: () => void;
  onReference: (animation: Animation) => void;
}) {
  const project = useProject();
  const library = useLibrary();
  const scene = useActiveScene();
  const hasScene = () => { const current = scene(); return !!current && isScene(current); };
  const [selected, setSelected] = createSignal<string>();
  const [operation, setOperation] = createSignal<{ type: "render" | "export" | "add" | "editable"; id: string }>();
  const [cancelling, setCancelling] = createSignal(false);
  const [exported, setExported] = createSignal<{ id: string; path: string }>();
  const busy = () => !!operation();
  const [message, setMessage] = createSignal("");
  const [error, setError] = createSignal("");
  const [partialId, setPartialId] = createSignal<string>();
  let video: HTMLVideoElement | undefined;
  let preview: HTMLDivElement | undefined;
  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  const [catalog, { refetch, mutate }] = createResource(
    () => props.active && { dir: project.dir(), revision: props.revision },
    async ({ dir }) => {
      const result = await mainBridge.call(MAIN_CHANNELS.ANIMATION_REQUEST, { action: "list", dir });
      if (!("items" in result)) throw new Error("Unexpected animation list response.");
      return result.items;
    },
  );
  const items = () => catalog.error ? [] : catalog.latest ?? [];
  const animation = createMemo(() => items().find((entry): entry is Animation => entry.id === selected() && "engine" in entry));
  createEffect(() => {
    if (catalog.loading) return;
    if (!items().some((entry) => entry.id === selected())) setSelected(items()[0]?.id);
  });
  // A list refresh must keep playback intact when the rendered file is unchanged.
  const previewSource = createMemo(() => {
    const item = animation();
    return item?.renderedAt && !item.previewError ? { item, dir: project.dir() } : undefined;
  }, undefined, { equals: (previous, next) => previous?.dir === next?.dir && previous?.item.id === next?.item.id
    && previous?.item.renderedAt === next?.item.renderedAt && previous?.item.output === next?.item.output
    && previous?.item.transparent === next?.item.transparent && previous?.item.libraryPath === next?.item.libraryPath });
  const [file, { refetch: retryFile }] = createResource(
    previewSource,
    async ({ item, dir }) => {
      if (!item.transparent) return { type: "video", file: await createProjectFS(dir).file(item.output) } as const;
      const current = library();
      if (!current) throw new Error("Asset library is not ready");
      await current.load();
      const asset = await current.resolve(item.libraryPath ?? item.output);
      if (asset.type !== "SEQUENCE") throw new Error("The transparent animation must contain numbered PNG frames.");
      return { type: "sequence", asset } as const;
    },
  );
  const url = createMemo(() => {
    const current = file.error ? undefined : file();
    if (current?.type !== "video") return undefined;
    const url = URL.createObjectURL(current.file);
    onCleanup(() => URL.revokeObjectURL(url));
    return url;
  });
  const sequence = () => { const current = file(); return current?.type === "sequence" ? current.asset : undefined; };
  createEffect(() => { if (!props.active) video?.pause(); });

  const render = async (item: Animation) => {
    if (busy()) return;
    setOperation({ type: "render", id: item.id }); setError(""); setMessage("Rendering preview…");
    try {
      const result = await mainBridge.call(MAIN_CHANNELS.ANIMATION_REQUEST, { action: "render", dir: project.dir(), id: item.id });
      if (!("items" in result)) throw new Error("Unexpected animation render response.");
      mutate(result.items);
      setMessage("Preview ready");
    } catch (cause) {
      if (cause instanceof Error && /cancelled/i.test(cause.message)) setMessage("Render cancelled");
      else { fail(cause); setMessage(""); }
    } finally { setOperation(undefined); setCancelling(false); }
  };

  const cancel = async () => {
    const current = operation();
    if (!current || current.type === "add" || cancelling()) return;
    setCancelling(true);
    try {
      const result = await mainBridge.call(MAIN_CHANNELS.ANIMATION_REQUEST, { action: "cancel", dir: project.dir(), id: current.id });
      if (!("cancelled" in result)) throw new Error("Unexpected animation cancellation response.");
      if (operation() === current && result.cancelled) setMessage("Cancelling…");
    } catch (cause) { fail(cause); }
    finally { setCancelling(false); }
  };

  const exportAnimation = async (item: Animation) => {
    if (busy()) return;
    setOperation({ type: "export", id: item.id }); setError(""); setMessage("Exporting animation…");
    try {
      const result = await mainBridge.call(MAIN_CHANNELS.ANIMATION_REQUEST, { action: "export", dir: project.dir(), id: item.id });
      if (!("path" in result)) throw new Error("Unexpected animation export response.");
      if (result.path) {
        setExported({ id: item.id, path: result.path });
        setMessage("Animation exported");
      } else setMessage("");
    } catch (cause) {
      if (cause instanceof Error && /cancelled/i.test(cause.message)) setMessage("Export cancelled");
      else { fail(cause); setMessage(""); }
    } finally { setOperation(undefined); setCancelling(false); }
  };

  const reveal = (path: string) => { void mainBridge.call(MAIN_CHANNELS.APP_SHOW_IN_FOLDER, { path }).catch(fail); };

  const add = async (item: Animation) => {
    if (busy() || !item.libraryPath || !hasScene()) return;
    setOperation({ type: "add", id: item.id }); setError(""); setMessage("");
    try { await addAgentAsset(item.libraryPath, undefined, "contain"); setMessage("Added at playhead"); }
    catch (cause) { fail(cause); }
    finally { setOperation(undefined); }
  };

  const addEditable = async (item: Animation, allowPartial = false) => {
    if (busy()) return;
    setOperation({ type: "editable", id: item.id }); setError(""); setPartialId(undefined); setMessage("Converting to editable layers…");
    try {
      const session = requireEditorSession();
      const dir = project.dir();
      const result = await mainBridge.call(MAIN_CHANNELS.ANIMATION_REQUEST, { action: "editable", dir, id: item.id, allowPartial });
      if (!("tree" in result)) throw new Error("Unexpected editable conversion response.");
      if (editorSession() !== session || project.dir() !== dir) throw new Error("The project changed. Add the editable animation again.");
      await insertMotionTree(result.tree, { name: item.id, width: result.width, height: result.height, duration: result.duration });
      setMessage(`${result.layerCount} editable layers added at playhead${result.issues.length ? `. ${result.issues.length} unsupported features omitted.` : "."}`);
      if (result.issues.length) setError(result.issues.map((issue) => `${issue.layer}: ${issue.feature}`).join("\n"));
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      if (/cancelled/i.test(detail)) setMessage("Conversion cancelled");
      else {
        if (detail.includes("Editable conversion needs unsupported features:")) setPartialId(item.id);
        setError(detail.replace("Use --allow-partial only to create an incomplete editable study.", "Convert supported layers to create an incomplete editable version."));
        setMessage("");
      }
    } finally { setOperation(undefined); setCancelling(false); }
  };

  return <section class="h-full min-h-0 overflow-y-auto text-xs" aria-label="Saved animations">
    <div class="flex items-center justify-between gap-2 px-3 py-3 border-b border-border">
      <DropdownMenu>
        <DropdownMenuTrigger as={Button} class="gap-1.5"><Icon name="plus-add-small" class="size-4" />New animation<Icon name="chevron-down" class="size-4" /></DropdownMenuTrigger>
        <DropdownMenuPortal><DropdownMenuContent>
          <DropdownMenuItem onSelect={() => props.onAsk("Create a small HyperFrames animation using editable text, shapes, images and vector paths. Save the source in this project, render a preview, and convert it to native timeline layers and keyframes. Report unsupported features instead of flattening them.")}>HyperFrames animation</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => props.onAsk("Create a Manim animation using vector geometry. Save the Python source in this project, render a preview, and convert it to native editable paths and keyframes on the timeline. Report unsupported features instead of flattening them.")}>Manim animation</DropdownMenuItem>
          <DropdownMenuItem onSelect={props.onBrowse}>Browse catalog</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenuPortal>
      </DropdownMenu>
      <Button variant="ghost" disabled={catalog.loading || busy()} onClick={() => {
        setError(""); setMessage("");
        void refetch();
        if (file.error || video?.error) void retryFile();
      }}>Refresh</Button>
    </div>
    <Show when={catalog.loading}><p class="p-3 text-muted-foreground">Loading animations…</p></Show>
    <Show when={catalog.error}><p role="alert" class="p-3 text-destructive">{String(catalog.error)}</p></Show>
    <Show when={!catalog.loading && !catalog.error && !items().length}>
      <div class="px-4 py-8 space-y-3"><h3 class="text-sm font-medium">Make your first animation</h3><p class="text-muted-foreground leading-relaxed">Describe it in chat or start with a catalog item. Your saved animations appear here for preview, revision, and export.</p><Button variant="secondary" onClick={props.onBrowse}>Browse catalog</Button></div>
    </Show>
    <Show when={items().length}>
      <div class="border-b border-border px-3 py-2">
        <select aria-label="Saved animation" class="w-full rounded bg-secondary px-2 py-2 text-foreground outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:opacity-50" value={selected()} disabled={busy()} onChange={(event) => { setSelected(event.currentTarget.value); setMessage(""); setError(""); setPartialId(undefined); }}>
          <For each={items()}>{(item) => <option value={item.id}>{item.id}{"engine" in item ? item.previewError || !item.renderedAt ? " · Render needed" : "" : " · Needs attention"}</option>}</For>
        </select>
      </div>
    </Show>
    <Show when={items().find((item) => item.id === selected())?.error}>{(error) => <p role="alert" class="px-3 text-destructive">{error()}</p>}</Show>
    <Show when={animation()}>{(item) => <div class="p-3 space-y-3">
      <div class="flex items-center justify-between gap-2">
        <p class="min-w-0 truncate text-muted-foreground">{item().engine === "manim" ? "Manim" : "HyperFrames"} · {item().transparent ? "Transparent overlay" : "Video"}</p>
        <Button variant="ghost" disabled={!item().renderedAt || !!item().previewError || file.loading || !!file.error} onClick={() => void preview?.requestFullscreen().catch(fail)}>Full screen</Button>
      </div>
      <div ref={preview} class="aspect-video bg-black flex items-center justify-center overflow-hidden rounded-md [&:fullscreen]:aspect-auto [&:fullscreen]:h-screen [&:fullscreen]:w-screen" style={item().transparent ? { "background-image": "conic-gradient(#292929 25%, #191919 0 50%, #292929 0 75%, #191919 0)", "background-size": "20px 20px" } : undefined}>
        <Show when={item().renderedAt && !item().previewError && !file.loading && !file.error && file()} fallback={<p class="px-4 text-center text-muted-foreground">{file.loading ? "Loading preview…" : item().previewError || item().renderedAt ? "Preview unavailable. Render again to replace it." : "Render to preview this animation"}</p>}>
          <Show when={sequence()} keyed fallback={<video ref={video} aria-label={`${item().id} preview`} class="w-full h-full object-contain" src={url()} controls preload="metadata" onError={() => setError("The preview could not be played. Try rendering it again.")} />}>{(asset) => <SequencePreview asset={asset} active={props.active} onError={fail} />}</Show>
        </Show>
      </div>
      <Show when={item().previewError}>{(error) => <p role="alert" class="text-destructive">{error()}</p>}</Show>
      <Show when={file.error}><p role="alert" class="text-destructive">{String(file.error)}</p></Show>
      <div class="flex flex-wrap gap-2">
        <Button disabled={busy() || !item().renderedAt || !!item().previewError} onClick={() => void exportAnimation(item())}>Export animation</Button>
        <Button variant="secondary" disabled={busy()} onClick={() => void render(item())}>{item().renderedAt || item().previewError ? "Render again" : "Render preview"}</Button>
        <Show when={operation()?.type === "render" || operation()?.type === "export" || operation()?.type === "editable"}><Button variant="secondary" disabled={cancelling()} onClick={() => void cancel()}>{cancelling() ? "Cancelling…" : "Cancel"}</Button></Show>
      </div>
      <p class="text-muted-foreground">{item().transparent ? "ProRes 4444 MOV with alpha for Resolve." : "MP4 video for Resolve or your launch edit."}</p>
      <div class="flex flex-wrap gap-2">
        <Button disabled={busy()} onClick={() => void addEditable(item())}>{operation()?.type === "editable" ? "Converting…" : "Add editable layers"}</Button>
        <Show when={partialId() === item().id}><Button variant="secondary" disabled={busy()} onClick={() => void addEditable(item(), true)}>Convert supported layers</Button></Show>
        <Button variant="secondary" onClick={() => props.onReference(item())}>Revise in chat</Button>
        <Button variant="secondary" disabled={busy() || !hasScene() || !item().renderedAt || !item().libraryPath || file.loading || !!file.error || !!item().previewError} onClick={() => void add(item())}>Add rendered clip</Button>
        <DropdownMenu>
          <DropdownMenuTrigger as={Button} variant="ghost" class="gap-1 text-muted-foreground">Files<Icon name="chevron-down" class="size-4" /></DropdownMenuTrigger>
          <DropdownMenuPortal><DropdownMenuContent>
            <DropdownMenuItem onSelect={() => reveal(item().source)}>Show source</DropdownMenuItem>
            <DropdownMenuItem disabled={!item().renderedAt} onSelect={() => reveal(item().output)}>Show preview file</DropdownMenuItem>
          </DropdownMenuContent></DropdownMenuPortal>
        </DropdownMenu>
      </div>
      <p class="text-muted-foreground">Editable conversion creates layers and keyframes. Unsupported features are reported before anything is added.</p>
      <Show when={exported()?.id === item().id ? exported() : undefined}>{(result) => <div class="flex min-w-0 items-center gap-2"><span class="min-w-0 flex-1 truncate text-muted-foreground" title={result().path}>{result().path}</span><Button variant="link" onClick={() => reveal(result().path)}>Show export</Button></div>}</Show>
    </div>}</Show>
    <Show when={message()}><p role="status" class="px-3 pb-3 text-muted-foreground">{message()}</p></Show>
    <Show when={error()}><p role="alert" class="px-3 pb-3 text-destructive whitespace-pre-wrap">{error()}</p></Show>
  </section>;
}
