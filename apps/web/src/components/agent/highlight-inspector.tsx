import { For, Show, createSignal, onCleanup } from "solid-js";
import { useTrait, useWorld } from "@diffusionstudio/koota-solid";
import { HIGHLIGHT_DEFAULTS } from "@diffusionstudio/jsx";
import { Computed, FrameRate, Highlight, Size, Source, getParentNode } from "@diffusionstudio/runtime";
import { useDerived } from "@/engine/hooks";
import { updateHighlight } from "@/engine/highlight";
import { editorSession } from "@/dapi/session";
import { Button } from "@/components/ui/button";
import { AreaAnnotation, captureAnnotationFrame } from "./area-annotation";
import type { Entity } from "koota";
import type { UpdateHighlightInput } from "@desktop/highlight-contracts";

function NumberField(props: { label: string; value: number; min: number; max?: number; step?: number; disabled?: boolean; onChange: (value: number) => void }) {
  return <label class="block min-w-0 space-y-1.5 text-xs">
    <span class="text-muted-foreground">{props.label}</span>
    <input type="number" aria-label={props.label} value={Number(props.value.toFixed(4))} min={props.min} max={props.max} step={props.step ?? 0.1} disabled={props.disabled}
      class="block w-full min-w-0 rounded-sm border border-border-input bg-secondary px-2 py-1.5 outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:opacity-50"
      onChange={(event) => { if (Number.isFinite(event.currentTarget.valueAsNumber)) props.onChange(event.currentTarget.valueAsNumber); else event.currentTarget.reportValidity(); }} />
  </label>;
}

export function HighlightInspector(props: { entity: Entity }) {
  const world = useWorld();
  const options = useTrait(() => props.entity, Highlight);
  const value = () => options() ?? HIGHLIGHT_DEFAULTS;
  const fps = () => world.get(FrameRate)?.value ?? 30;
  const start = useDerived(() => (props.entity.get(Computed)?.start ?? 0) / fps());
  const end = useDerived(() => (props.entity.get(Computed)?.end ?? 0) / fps());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [snapshot, setSnapshot] = createSignal<Awaited<ReturnType<typeof captureAnnotationFrame>>>();
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const fail = (cause: unknown) => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); };
  const edit = async (changes: UpdateHighlightInput["props"]) => {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      if (editorSession()?.world !== world) throw new Error("The project changed. Select the highlight again.");
      const id = props.entity.get(Source)?.value;
      if (!id) throw new Error("This highlight has no editable source");
      await updateHighlight({ id, props: changes });
    } catch (cause) { fail(cause); }
    finally { if (!disposed) setBusy(false); }
  };
  const chooseArea = async () => {
    setBusy(true);
    setError("");
    try {
      const sceneId = getParentNode(props.entity)?.get(Source)?.value;
      const id = props.entity.get(Source)?.value;
      if (!sceneId || !id) throw new Error("Select a highlight inside a scene");
      const frame = await captureAnnotationFrame({ sceneId, exclude: [id] });
      if (!disposed && editorSession()?.world === world) setSnapshot(frame);
    } catch (cause) { fail(cause); }
    finally { if (!disposed) setBusy(false); }
  };
  const centered = () => value().destination[0] === 0.5 && value().destination[1] === 0.5;

  return <section class="p-4 space-y-4" aria-label="Highlight settings">
    <div class="flex items-center justify-between gap-2">
      <h3 class="text-sm font-medium">Highlight settings</h3>
      <Button variant="secondary" disabled={busy()} onClick={() => void chooseArea()}>Choose area</Button>
    </div>
    <div class="grid grid-cols-2 gap-3">
      <NumberField label="Highlight start (s)" value={start()} min={0} step={1 / fps()} disabled={busy()} onChange={(start) => void edit({ start })} />
      <NumberField label="Highlight end (s)" value={end()} min={0} step={1 / fps()} disabled={busy()} onChange={(end) => void edit({ end })} />
      <NumberField label="Enlargement" value={value().magnification} min={1} max={8} disabled={busy()} onChange={(magnification) => void edit({ magnification })} />
      <label class="min-w-0 space-y-1.5 text-xs"><span class="text-muted-foreground">Position</span><select aria-label="Highlight position" class="block w-full min-w-0 rounded-sm border border-border-input bg-secondary p-1.5 outline-none focus-visible:ring-1 focus-visible:ring-primary" disabled={busy()} value={value().mode} onChange={(event) => void edit({ mode: event.currentTarget.value === "in-place" ? "in-place" : "center" })}>
        <option value="center">{centered() ? "Move to center" : "Move to position"}</option><option value="in-place">Enlarge in place</option>
      </select></label>
      <NumberField label="Background dim (%)" value={value().dim * 100} min={0} max={100} step={1} disabled={busy()} onChange={(dim) => void edit({ dim: dim / 100 })} />
      <NumberField label="Background blur (px)" value={value().blur} min={0} max={100} step={1} disabled={busy()} onChange={(blur) => void edit({ blur })} />
    </div>
    <details class="text-xs">
      <summary class="cursor-pointer py-1 text-muted-foreground">Area and motion</summary>
      <div class="grid grid-cols-2 gap-3 pt-3">
        <For each={["Area left (%)", "Area top (%)", "Area width (%)", "Area height (%)"]}>{(label, index) => <NumberField label={label} value={value().region[index()]! * 100} min={index() < 2 ? 0 : 0.1} max={100} disabled={busy()} onChange={(next) => {
          const region = [...value().region];
          region[index()] = next / 100;
          void edit({ region: { x: region[0]!, y: region[1]!, width: region[2]!, height: region[3]! } });
        }} />}</For>
        <NumberField label="Animate in (s)" value={value().enter} min={0} max={10} step={0.05} disabled={busy()} onChange={(enter) => void edit({ enter })} />
        <NumberField label="Animate out (s)" value={value().exit} min={0} max={10} step={0.05} disabled={busy()} onChange={(exit) => void edit({ exit })} />
        <NumberField label="Corner radius (px)" value={value().radius} min={0} max={500} step={1} disabled={busy()} onChange={(radius) => void edit({ radius })} />
        <NumberField label="Shadow (%)" value={value().shadow * 100} min={0} max={100} step={1} disabled={busy()} onChange={(shadow) => void edit({ shadow: shadow / 100 })} />
        <Show when={value().mode === "center"}>
          <NumberField label="Destination X (%)" value={value().destination[0] * 100} min={0} max={100} disabled={busy()} onChange={(x) => void edit({ destination: [x / 100, value().destination[1]] })} />
          <NumberField label="Destination Y (%)" value={value().destination[1] * 100} min={0} max={100} disabled={busy()} onChange={(y) => void edit({ destination: [value().destination[0], y / 100] })} />
          <Show when={!centered()}><Button variant="secondary" disabled={busy()} onClick={() => void edit({ destination: [0.5, 0.5] })}>Reset to center</Button></Show>
        </Show>
      </div>
    </details>
    <Show when={error()}><p role="alert" class="text-xs text-destructive">{error()}</p></Show>
    <Show when={snapshot()}>{(frame) => <AreaAnnotation snapshot={frame()} initial={{ ...frame(), region: { x: value().region[0], y: value().region[1], width: value().region[2], height: value().region[3] }, note: "" }} title="Choose highlight area" actionLabel="Use area" hideNote onClose={() => setSnapshot(undefined)} onAttach={(attachment) => {
      const size = getParentNode(props.entity)?.get(Size);
      setSnapshot(undefined);
      if (size?.width !== attachment.annotation.sceneSize.width || size?.height !== attachment.annotation.sceneSize.height) { setError("The scene size changed. Choose the area again."); return; }
      void edit({ region: attachment.annotation.region });
    }} />}</Show>
  </section>;
}
