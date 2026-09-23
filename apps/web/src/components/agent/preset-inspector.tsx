import { For, Show, createSignal, onCleanup } from "solid-js";
import { useTrait, useWorld } from "@diffusionstudio/koota-solid";
import { PRESET_LIMITS, getPresetDefinition, type PresetSettings } from "@diffusionstudio/jsx";
import { Computed, FrameRate, Preset, Size, Source, SourceError, getParentNode } from "@diffusionstudio/runtime";
import { useDerived } from "@/engine/hooks";
import { updatePreset } from "@/engine/presets";
import { editorSession } from "@/dapi/session";
import { Button } from "@/components/ui/button";
import { AreaAnnotation, captureAnnotationFrame } from "./area-annotation";
import type { Entity } from "koota";

const fieldClass = "block w-full min-w-0 rounded-sm border border-border-input bg-secondary px-2 py-1.5 outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:opacity-50";

function NumberField(props: { label: string; value: number; min: number; max?: number; step?: number; disabled?: boolean; onChange: (value: number) => void }) {
  return <label class="block min-w-0 space-y-1.5 text-xs"><span class="text-muted-foreground">{props.label}</span>
    <input type="number" aria-label={props.label} value={Number(props.value.toFixed(4))} min={props.min} max={props.max} step={props.step ?? "any"} disabled={props.disabled} class={fieldClass}
      onChange={(event) => { if (event.currentTarget.checkValidity() && Number.isFinite(event.currentTarget.valueAsNumber)) props.onChange(event.currentTarget.valueAsNumber); else event.currentTarget.reportValidity(); }} />
  </label>;
}

export function PresetInspector(props: { entity: Entity }) {
  const world = useWorld();
  const initial = props.entity.get(Preset)!;
  const options = useTrait(() => props.entity, Preset);
  const sourceError = useTrait(() => props.entity, SourceError);
  const definition = () => getPresetDefinition(options()?.preset ?? initial.preset);
  const settings = () => options()?.settings ?? initial.settings;
  const fps = () => world.get(FrameRate)?.value ?? 30;
  const start = useDerived(() => (props.entity.get(Computed)?.start ?? 0) / fps());
  const end = useDerived(() => (props.entity.get(Computed)?.end ?? 0) / fps());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [pending, setPending] = createSignal<Awaited<ReturnType<typeof captureAnnotationFrame>>>();
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const fail = (cause: unknown) => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); };

  const edit = async (changes: { settings?: Partial<PresetSettings>; start?: number; end?: number }) => {
    if (busy()) return;
    setBusy(true); setError("");
    try {
      if (editorSession()?.world !== world) throw new Error("The project changed. Select the effect again.");
      const id = props.entity.get(Source)?.value;
      if (!id) throw new Error("This effect has no editable source");
      await updatePreset({ id, ...changes });
    } catch (cause) { fail(cause); }
    finally { if (!disposed) setBusy(false); }
  };

  const chooseArea = async () => {
    setBusy(true); setError("");
    try {
      const sceneId = getParentNode(props.entity)?.get(Source)?.value;
      const id = props.entity.get(Source)?.value;
      if (!sceneId || !id) throw new Error("Select an effect inside a scene");
      const snapshot = await captureAnnotationFrame({ sceneId, exclude: [id] });
      if (getParentNode(props.entity)?.get(Source)?.value !== sceneId) throw new Error("The effect moved to another scene. Choose the area again.");
      if (!disposed && editorSession()?.world === world) setPending(snapshot);
    } catch (cause) { fail(cause); }
    finally { if (!disposed) setBusy(false); }
  };

  return <section class="p-4 space-y-4" aria-label={`${definition().title} settings`}>
    <h3 class="text-sm font-medium">{definition().title} settings</h3>
    <div class="grid grid-cols-2 gap-3">
      <NumberField label="Effect start (s)" value={start()} min={0} step={1 / fps()} disabled={busy()} onChange={(value) => void edit({ start: value })} />
      <NumberField label="Effect end (s)" value={end()} min={0} step={1 / fps()} disabled={busy()} onChange={(value) => void edit({ end: value })} />
      <NumberField label="Pixel size" value={settings().amount} min={PRESET_LIMITS.amount[0]} max={PRESET_LIMITS.amount[1]} disabled={busy()} onChange={(amount) => void edit({ settings: { amount } })} />
      <div class="col-span-2 space-y-2">
        <Button variant="secondary" disabled={busy()} onClick={() => void chooseArea()}>Choose area</Button>
        <details class="text-xs"><summary class="cursor-pointer text-muted-foreground">Area coordinates</summary><div class="grid grid-cols-2 gap-3 pt-3">
          <For each={["Left", "Top", "Width", "Height"]}>{(name, index) => <NumberField label={`${name} (%)`} value={settings().region[index()]! * 100} min={0} max={100} disabled={busy()} onChange={(value) => {
            const region = [...settings().region] as PresetSettings["region"];
            region[index()] = value / 100;
            void edit({ settings: { region } });
          }} />}</For>
        </div></details>
      </div>
    </div>
    <Show when={error() || sourceError()?.value}>{(message) => <p role="alert" class="text-xs text-destructive">{message()}</p>}</Show>
    <Show when={pending()}>{(snapshot) => <AreaAnnotation snapshot={snapshot()} initial={{ ...snapshot(), region: { x: settings().region[0], y: settings().region[1], width: settings().region[2], height: settings().region[3] }, note: "" }} title={`Choose ${definition().title} area`} actionLabel="Use area" hideNote onClose={() => setPending(undefined)} onAttach={(attachment) => {
      const scene = getParentNode(props.entity);
      const size = scene?.get(Size);
      setPending(undefined);
      if (scene?.get(Source)?.value !== attachment.annotation.sceneId) { setError("The effect moved to another scene. Choose the area again."); return; }
      if (size?.width !== attachment.annotation.sceneSize.width || size?.height !== attachment.annotation.sceneSize.height) { setError("The scene size changed. Choose the area again."); return; }
      const { x, y, width, height } = attachment.annotation.region;
      void edit({ settings: { region: [x, y, width, height] } });
    }} />}</Show>
  </section>;
}
