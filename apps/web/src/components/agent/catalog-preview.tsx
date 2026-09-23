import { createEffect, createMemo, createResource, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { CatalogEntry, CatalogSource } from "@desktop/hyperframes-contracts";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { mainBridge } from "@/lib/ipc";
import { Button } from "@/components/ui/button";
import { catalogPreviewDocument } from "./catalog-preview-document";

export function CatalogPreview(props: { active: boolean; catalog: CatalogSource; item: CatalogEntry; interactive?: boolean }) {
  const [visible, setVisible] = createSignal(false);
  const [posterFailed, setPosterFailed] = createSignal(false);
  const [play, setPlay] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [fullscreen, setFullscreen] = createSignal(false);
  const [fullscreenError, setFullscreenError] = createSignal("");
  let container!: HTMLDivElement;
  let frame: HTMLIFrameElement | undefined;
  const poster = () => !posterFailed() && props.item.poster;
  const hasCompositionPreview = () => props.catalog === "hyperframes" && (props.item.type === "block" || props.item.type === "component");
  const needsPlayer = () => props.active && visible() && (!poster() || play()) && !props.item.video && hasCompositionPreview();
  const [preview] = createResource(() => needsPlayer() && props.item, async (item) => {
    if (item.type !== "block" && item.type !== "component") return;
    const result = await mainBridge.call(MAIN_CHANNELS.HYPERFRAMES_REQUEST, { action: "preview", name: item.name, type: item.type });
    if (result.action !== "preview") throw new Error("Unexpected preview response.");
    return result.html;
  });
  const document = createMemo(() => preview.error ? undefined : preview() ? catalogPreviewDocument(preview()!, play()) : undefined);

  onMount(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(container);
    onCleanup(() => observer.disconnect());
    const receive = (event: MessageEvent) => {
      if (!frame || event.source !== frame.contentWindow) return;
      if (event.data?.type === "catalog-preview-ready") setReady(true);
      if (event.data?.type === "catalog-preview-error") setFailed(true);
    };
    window.addEventListener("message", receive);
    onCleanup(() => window.removeEventListener("message", receive));
    const changed = () => setFullscreen(window.document.fullscreenElement === container);
    window.document.addEventListener("fullscreenchange", changed);
    onCleanup(() => window.document.removeEventListener("fullscreenchange", changed));
  });
  createEffect(() => { if (!props.active || !visible()) setPlay(false); });
  createEffect(() => {
    const loading = needsPlayer() && document();
    setReady(false);
    setFailed(false);
    if (!loading) return;
    const timeout = setTimeout(() => { if (!ready()) setFailed(true); }, 20_000);
    onCleanup(() => clearTimeout(timeout));
  });

  return <div ref={container} class="min-w-0 [&:fullscreen]:flex [&:fullscreen]:flex-col [&:fullscreen]:bg-black [&:fullscreen]:p-3 [&:fullscreen]:h-screen [&:fullscreen]:w-screen">
    <Show when={props.interactive && (props.item.video || hasCompositionPreview())}>
      <div class="mb-2 flex shrink-0 items-center justify-between gap-2">
        <Button variant="secondary" onClick={() => setPlay((current) => !current)}>{play() ? "Stop preview" : "Play preview"}</Button>
        <Button variant="ghost" onClick={() => {
          setFullscreenError("");
          void (fullscreen() ? window.document.exitFullscreen() : container.requestFullscreen()).catch((error: unknown) => setFullscreenError(error instanceof Error ? error.message : String(error)));
        }}>{fullscreen() ? "Exit full screen" : "Full screen"}</Button>
      </div>
    </Show>
    <div class="relative mx-auto w-full overflow-hidden rounded-md bg-secondary" classList={{ "flex-1 min-h-0": fullscreen() }} style={{
      "aspect-ratio": fullscreen() ? undefined : props.interactive && props.item.dimensions ? `${props.item.dimensions.width} / ${props.item.dimensions.height}` : props.item.type === "template" ? "9 / 16" : "16 / 9",
      "max-width": !fullscreen() && props.interactive && props.item.type === "template" ? "min(100%, 23.625vh)" : undefined,
    }}>
      <Show when={poster() && !play()} fallback={
        <Show when={props.active && visible() && props.item.video && !failed()} fallback={
          <Show when={needsPlayer() && document() && !failed() && !preview.error} fallback={
            <div class="absolute inset-0 flex items-center justify-center px-3 text-center text-xxs text-muted-foreground">
              {preview.loading ? "Loading preview…" : props.item.type === "example" && !props.item.poster && !props.item.video ? "No published preview" : "Preview unavailable"}
            </div>
          }>
            <iframe ref={frame} title={`${props.item.title} preview`} sandbox="allow-scripts" referrerPolicy="no-referrer" srcdoc={document()} class="absolute inset-0 h-full w-full border-0" classList={{ "pointer-events-none": !props.interactive || !play() }} />
            <Show when={!ready()}><span class="absolute inset-0 flex items-center justify-center bg-secondary text-xxs text-muted-foreground">Loading preview…</span></Show>
          </Show>
        }>
          <video src={props.item.video} muted playsinline preload="metadata" controls={props.interactive && play()} autoplay={play()} loop={play()} class="absolute inset-0 h-full w-full object-contain" onLoadedMetadata={(event) => { if (!play()) event.currentTarget.currentTime = Math.min(1, event.currentTarget.duration * 0.45); }} onError={() => setFailed(true)} />
        </Show>
      }>
        <img src={poster() || undefined} alt="" loading="lazy" class="absolute inset-0 h-full w-full object-contain" onError={() => setPosterFailed(true)} />
      </Show>
    </div>
    <Show when={fullscreenError()}><p role="alert" class="mt-2 text-destructive">{fullscreenError()}</p></Show>
  </div>;
}
