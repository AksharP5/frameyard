import { For, Show, createSignal } from "solid-js";
import { useWorld } from "@diffusionstudio/koota-solid";
import { Cache, ChildOf, Computed, FrameRate, Keyframe as KeyframeTrait, KeyframeTrack, colorToHex, getActiveEntity, getParentEntity, parseColor, parsePathData, setPlayhead } from "@diffusionstudio/runtime";
import { trackProperty } from "@diffusionstudio/reconciler";
import { SPATIAL_ARRAYS, SPATIAL_ARRAY_PATHS, parseNumberArray, parsePath3D } from "@diffusionstudio/jsx";
import { useDerived, useEditor } from "@/engine/hooks";
import { formatProperty } from "@/components/timeline/layers/keyframe";
import { Button } from "@/components/ui/button";
import { ControlRow } from "@/components/ui/control-group";
import { Icon } from "@/components/ui/icon";
import { Keyframe } from "@/components/ui/keyframe";
import { ControlledTextField } from "@/components/ui/text-field";
import { PanelSection } from "@/components/ui/panel-section";
import type { Entity, World } from "koota";

function seekKeyframe(world: World, target: Entity, keyframe: Entity) {
  const scene = getActiveEntity(world);
  const bounds = target.get(Computed);
  if (!scene || !bounds) return;
  const frame = keyframe.get(KeyframeTrait)?.time ?? 0;
  setPlayhead(world, scene, bounds.origin + frame / (bounds.playbackRate || 1));
}

export function LayerKeyframes(props: { node: Entity }) {
  const world = useWorld();
  const editor = useEditor();
  const tracks = useDerived(() => [...world.query(KeyframeTrack, ChildOf(props.node))],
    (a, b) => a.length === b.length && a.every((item, index) => item === b[index]));

  return <PanelSection title="Keyframes" actions={<Button variant="ghost" size="small" onClick={() => editor.editProperty(props.node, "expanded", true)}>Show tracks</Button>}>
    <Show when={tracks().length} fallback={<p class="text-xs text-muted-foreground leading-relaxed">Use the diamond beside a property to animate it at the playhead.</p>}>
      <For each={tracks()}>{(track) => {
        const property = () => trackProperty(track.get(KeyframeTrack)?.property ?? "");
        const frames = useDerived(() => track.get(Cache)?.keyframes ?? [],
          (a, b) => a.length === b.length && a.every((item, index) => item === b[index]));
        return <div class="flex min-w-0 items-center gap-1.5">
          <button type="button" class="flex-1 min-w-0 truncate text-left text-xs hover:text-primary focus-visible:outline-1 focus-visible:outline-primary" onClick={() => {
            const first = frames()[0];
            if (!first) return;
            seekKeyframe(world, props.node, first);
            editor.select(first);
          }}>{formatProperty(track.get(KeyframeTrack)?.property ?? "")}</button>
          <span class="text-xxs text-muted-foreground tabular-nums" title={`${frames().length} keyframes`}>{frames().length}</span>
          <Show when={property()}>{(name) => <Keyframe target={props.node} property={name()} />}</Show>
          <Button variant="ghost" size="icon" aria-label={`Delete ${formatProperty(track.get(KeyframeTrack)?.property ?? "")} keyframes`} onClick={() => editor.remove(track)}><Icon name="close-remove-small" /></Button>
        </div>;
      }}</For>
    </Show>
  </PanelSection>;
}

/** Time and value belong to the keyframe; easing remains in the existing curve editor. */
export function KeyframeSettings(props: { selection: Entity[] }) {
  const world = useWorld();
  const editor = useEditor();
  const first = () => props.selection[0]!;
  const data = useDerived(() => first().get(KeyframeTrait));
  const path = () => getParentEntity(first())?.get(KeyframeTrack)?.property ?? "";
  const fps = () => world.get(FrameRate)?.value ?? 30;
  const [error, setError] = createSignal("");
  const pathValue = () => path() === "path.d" || path() === "spatial.path3d";
  const arrayProperty = () => SPATIAL_ARRAYS.find(property => SPATIAL_ARRAY_PATHS[property] === path());
  const stringValue = () => pathValue() ? data()?.stringValue ?? "" : arrayProperty() ? JSON.stringify(data()?.arrayValue ?? []) : colorToHex(data()?.value ?? 0);

  const setValue = (raw: string | number) => {
    try {
      let value: string | number | number[] = raw;
      if (pathValue()) value = (path() === "spatial.path3d" ? parsePath3D : parsePathData)(raw);
      const array = arrayProperty();
      if (array) value = parseNumberArray(JSON.parse(String(raw)), array, array.endsWith("Colors") ? 4 : 3);
      if (path() === "color" && parseColor(value) === null) throw new Error("Enter a valid color");
      for (const node of props.selection) {
        const nodePath = getParentEntity(node)?.get(KeyframeTrack)?.property;
        if (nodePath !== path()) continue;
        editor.editProperty(node, "value", value);
      }
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  return <PanelSection title={formatProperty(path()) || "Keyframe"}>
    <ControlRow label="Time">
      <ControlledTextField aria-label="Keyframe time" value={Math.round((data()?.time ?? 0) / fps() * 1000) / 1000} unit="s" step={1 / fps()} min={0} autoSelect limitEvents onNumber={(time) => {
        editor.editProperty(first(), "time", time);
        const target = getParentEntity(first())?.get(KeyframeTrack)?.target;
        if (target) seekKeyframe(world, target, first());
      }} />
    </ControlRow>
    <Show when={pathValue() || arrayProperty()} fallback={<ControlRow label="Value">
      <Show when={path() === "color"} fallback={<ControlledTextField aria-label="Keyframe value" value={data()?.value ?? 0} step={0.01} autoSelect limitEvents onNumber={setValue} />}>
        <ControlledTextField aria-label="Keyframe color" value={stringValue()} onChange={(event) => setValue(event.currentTarget.value)} />
      </Show>
    </ControlRow>}>
      <textarea aria-label={arrayProperty() ? "Keyframe coordinates or colors" : "Keyframe path data"} class="motion-path-input min-h-24 w-full resize-y rounded-md border border-border-input bg-input p-2 font-mono text-xs leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-primary" value={stringValue()} spellcheck={false} onChange={(event) => setValue(event.currentTarget.value)} />
    </Show>
    <Show when={error()}><p role="alert" class="text-xs text-destructive">{error()}</p></Show>
  </PanelSection>;
}
