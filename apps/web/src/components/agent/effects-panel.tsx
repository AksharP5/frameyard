import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { useWorld } from "@diffusionstudio/koota-solid";
import { PRESET_CATALOG, getPresetDefinition, type PresetDefinition, type PresetSettings } from "@diffusionstudio/jsx";
import { Preset } from "@diffusionstudio/runtime";
import { useSelection } from "@/engine/hooks";
import { addPreset } from "@/engine/presets";
import { PRESET_DRAG_TYPE, presetPlacement } from "@/engine/preset-placement";
import { editorSession } from "@/dapi/session";
import { Button } from "@/components/ui/button";
import { AreaAnnotation, captureAnnotationFrame } from "./area-annotation";
import { PresetInspector } from "./preset-inspector";
import { PresetPreview } from "./preset-preview";

export function EffectsPanel(props: { disabled?: boolean; onReference: (definition: PresetDefinition, settings?: PresetSettings) => void }) {
  const world = useWorld();
  const selection = useSelection();
  const [detail, setDetail] = createSignal<PresetDefinition>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [pending, setPending] = createSignal<{
    definition: PresetDefinition;
    snapshot: Awaited<ReturnType<typeof captureAnnotationFrame>>;
    input: ReturnType<typeof presetPlacement>;
  }>();
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const selected = createMemo(() => {
    const entity = selection.first();
    return entity?.has(Preset) ? entity : undefined;
  });
  const selectedId = () => selected()?.get(Preset)?.preset;
  const editing = () => selectedId() === detail()?.id ? selected() : undefined;
  const regional = (definition: PresetDefinition) => definition.controls.includes("region");
  createEffect(() => {
    const id = selectedId();
    if (id) setDetail(getPresetDefinition(id));
  });
  const fail = (cause: unknown) => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); };
  const drag = (event: DragEvent, definition: PresetDefinition) => {
    event.dataTransfer?.setData(PRESET_DRAG_TYPE, definition.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
  };
  const add = async (definition: PresetDefinition, mark = false) => {
    if (busy() || props.disabled) return;
    setBusy(true); setError("");
    try {
      const input = presetPlacement(world, definition.id);
      if (mark) {
        const snapshot = await captureAnnotationFrame({ sceneId: input.sceneId });
        if (editorSession()?.world !== world) throw new Error("The project changed. Choose the area again.");
        if (!disposed) setPending({ definition, input, snapshot });
      } else await addPreset(input);
    } catch (cause) { fail(cause); }
    finally { if (!disposed) setBusy(false); }
  };

  return <div class="h-full overflow-y-auto" aria-label="Effects library">
    <Show when={error()}><p role="alert" class="p-4 text-xs text-destructive">{error()}</p></Show>
    <Show when={detail()} fallback={<>
      <div class="grid grid-cols-2 gap-x-3 gap-y-5 p-4"><For each={PRESET_CATALOG}>{(definition) => <button type="button" draggable={!props.disabled && !busy()} aria-label={`View ${definition.title} effect`} class="min-w-0 text-left focus-visible:ring-1 focus-visible:ring-primary rounded-sm cursor-grab active:cursor-grabbing" onDragStart={(event) => drag(event, definition)} onClick={() => { setError(""); setDetail(definition); }}>
        <PresetPreview definition={definition} />
        <span class="mt-2 block truncate text-xs font-medium" title={definition.title}>{definition.title}</span>
        <span class="mt-0.5 block truncate text-xxs text-muted-foreground">{definition.collection}</span>
      </button>}</For></div>
    </>}>
      {(definition) => <>
        <div class="p-4 space-y-3" classList={{ "p-3! space-y-2!": !!editing() }}>
          <Button variant="ghost" size={editing() ? "small" : "default"} class="-ml-1 text-muted-foreground" onClick={() => { setDetail(undefined); setError(""); }}>All effects</Button>
          <div class={editing() ? "grid grid-cols-[96px_1fr] items-center gap-3" : "space-y-3"}>
            <div draggable={!props.disabled && !busy()} onDragStart={(event) => drag(event, definition())} class="cursor-grab active:cursor-grabbing" aria-label={`Drag ${definition().title} effect`}>
              <PresetPreview large={!editing()} definition={definition()} />
            </div>
            <div class="min-w-0"><h3 class="text-sm font-medium">{definition().title}</h3><p class="mt-1 text-xs text-muted-foreground" classList={{ "line-clamp-2": !!editing() }}>{definition().description}</p></div>
          </div>
          <Show when={definition().notes && !editing()}><p class="text-xs text-muted-foreground">{definition().notes}</p></Show>
          <div class="flex flex-wrap gap-2">
            <Button disabled={props.disabled || busy()} onClick={() => void add(definition(), !!editing() && regional(definition()))}>{busy() ? "Preparing…" : editing() ? "Add another" : "Add effect"}</Button>
            <Show when={regional(definition()) && !editing()}><Button variant="secondary" disabled={props.disabled || busy()} onClick={() => void add(definition(), true)}>Choose area</Button></Show>
            <Button variant="secondary" disabled={busy()} onClick={() => props.onReference(definition(), editing()?.get(Preset)?.settings)}>Use with agent</Button>
          </div>
          <Show when={!editing()}><p class="text-xs text-muted-foreground">Drag onto the video or timeline. Uses the marked range or up to 3 seconds at the playhead.</p></Show>
        </div>
        <Show when={editing()} keyed>{(entity) => <div class="border-t border-border"><PresetInspector entity={entity} /></div>}</Show>
        <Show when={editing() && definition().notes}><details class="px-4 pb-4 text-xs text-muted-foreground"><summary class="cursor-pointer">Notes</summary><p class="mt-2">{definition().notes}</p></details></Show>
      </>}
    </Show>
    <Show when={pending()}>{(value) => <AreaAnnotation snapshot={value().snapshot} title={`Choose ${value().definition.title} area`} actionLabel="Add effect" hideNote onClose={() => setPending(undefined)} onAttach={(attachment) => {
      const input = value().input;
      setPending(undefined);
      setBusy(true);
      if (editorSession()?.world !== world) { setError("The project changed. Choose the area again."); setBusy(false); return; }
      const { x, y, width, height } = attachment.annotation.region;
      void addPreset({ ...input, settings: { ...input.settings, region: [x, y, width, height] } }).catch(fail).finally(() => { if (!disposed) setBusy(false); });
    }} />}</Show>
  </div>;
}
