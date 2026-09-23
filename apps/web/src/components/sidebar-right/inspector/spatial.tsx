import { For, Show, createSignal } from "solid-js";
import { useTrait, useWorld } from "@diffusionstudio/koota-solid";
import { LIGHT_TYPES, MESH_SHAPES, type SpatialParameter } from "@diffusionstudio/jsx";
import { Computed, Geometry, GeometryType, LightSource, Scene3D, SpatialGeometry, SpatialMaterial, colorToHex, parseColor } from "@diffusionstudio/runtime";
import { useDerived, useEditor } from "@/engine/hooks";
import { syncKeyframe } from "@/engine/keyframes";
import { ColorOpacityPicker } from "@/components/ui/color-opacity-picker";
import { ColorOpacityRow } from "@/components/ui/color-opacity-row";
import { FloatingInspector, FloatingInspectorContent, FloatingInspectorHeader, FloatingInspectorTitle } from "@/components/ui/floating-inspector";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Keyframe } from "@/components/ui/keyframe";
import { ControlRow } from "@/components/ui/control-group";
import { PanelSection } from "@/components/ui/panel-section";
import { Switch, SwitchControl, SwitchInput, SwitchThumb } from "@/components/ui/switch";
import { MotionField } from "./motion-field";
import type { Entity } from "koota";

const selectClass = "h-8 w-full rounded-md border border-border-input bg-input px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-primary";

function SpatialFields(props: { node: Entity; fields: readonly (readonly [SpatialParameter, string, number?, string?])[] }) {
  return <For each={props.fields}>{([property, label, step, unit]) => <ControlRow label={label}>
    <MotionField node={props.node} property={property} label={label} step={step ?? 0.01} unit={unit} />
  </ControlRow>}</For>;
}

function MaterialFlag(props: { node: Entity; property: "lit" | "wireframe" | "castShadow" | "receiveShadow" | "depthTest"; label: string }) {
  const editor = useEditor();
  const material = useTrait(() => props.node, SpatialMaterial);
  return <ControlRow label={props.label} labelClass="w-24" contentClass="flex justify-end">
    <Switch checked={material()?.[props.property] ?? false} onChange={(value) => editor.editProperty(props.node, props.property, value)}>
      <SwitchInput aria-label={props.label} /><SwitchControl variant="compact"><SwitchThumb variant="compact" /></SwitchControl>
    </Switch>
  </ControlRow>;
}

function SpatialColor(props: { node: Entity; property: "color" | "emissive" | "fogColor"; label: string }) {
  const editor = useEditor();
  const world = useWorld();
  const material = useTrait(() => props.node, SpatialMaterial);
  const color = useDerived(() => props.property === "color" ? props.node.get(Computed)?.color ?? 0xffffff : parseColor(material()?.[props.property] ?? "#ffffff") ?? 0xffffff);
  const [open, setOpen] = createSignal(false);
  let anchor: HTMLDivElement | undefined;
  const assignColor = (value: number) => {
    const hex = colorToHex(value);
    editor.editProperty(props.node, props.property, hex);
    if (props.property === "color") syncKeyframe(world, editor, props.node, "color", hex);
  };
  return <ControlRow label={props.label} ref={anchor}>
    <ColorOpacityRow color={color()} onChangeColor={assignColor} onClick={() => setOpen(true)} keyframe={<Show when={props.property === "color"}><Keyframe target={props.node} property="color" /></Show>} />
    <FloatingInspector open={open} anchorRef={anchor}>
      <FloatingInspectorHeader>
        <FloatingInspectorTitle>{props.label}</FloatingInspectorTitle>
        <Button class="ml-auto" variant="ghost" size="icon" aria-label={`Close ${props.label.toLowerCase()} picker`} onClick={() => setOpen(false)}><Icon name="close-remove" /></Button>
      </FloatingInspectorHeader>
      <FloatingInspectorContent class="p-0">
        <ColorOpacityPicker color={color()} opacity={1} withoutOpacity keyframeTarget={props.property === "color" ? props.node : undefined} onColorChange={assignColor} />
      </FloatingInspectorContent>
    </FloatingInspector>
  </ControlRow>;
}

export function SpatialSettings(props: { node: Entity }) {
  const editor = useEditor();
  const geometry = useTrait(() => props.node, SpatialGeometry);
  const light = useTrait(() => props.node, LightSource);
  const kind = () => props.node.get(Geometry)?.value;
  return <>
    <Show when={props.node.has(Scene3D)}>
      <PanelSection title="Environment">
        <SpatialFields node={props.node} fields={[["ambientIntensity", "Ambient"], ["fogDensity", "Fog density", 0.001]]} />
        <SpatialColor node={props.node} property="fogColor" label="Fog color" />
      </PanelSection>
    </Show>
    <Show when={kind() === GeometryType.MESH}>
      <PanelSection title="Mesh">
        <ControlRow label="Shape"><select aria-label="Mesh shape" class={selectClass} value={geometry()?.shape ?? "box"} onChange={(event) => editor.editProperty(props.node, "shape", event.currentTarget.value)}>
          <For each={MESH_SHAPES}>{shape => <option value={shape}>{shape[0].toUpperCase() + shape.slice(1)}</option>}</For>
        </select></ControlRow>
        <SpatialFields node={props.node} fields={[["depth", "Depth", 1, "px"], ["scaleZ", "Scale Z", 0.01, "×"]]} />
      </PanelSection>
      <PanelSection title="3D material">
        <SpatialFields node={props.node} fields={[["roughness", "Roughness"], ["metalness", "Metalness"], ["transmission", "Transmission"], ["ior", "IOR"], ["emissiveIntensity", "Emission"]]} />
        <SpatialColor node={props.node} property="emissive" label="Emissive" />
        <MaterialFlag node={props.node} property="lit" label="Lighting" />
        <MaterialFlag node={props.node} property="wireframe" label="Wireframe" />
        <MaterialFlag node={props.node} property="castShadow" label="Cast shadow" />
        <MaterialFlag node={props.node} property="receiveShadow" label="Receive shadow" />
        <MaterialFlag node={props.node} property="depthTest" label="Depth test" />
      </PanelSection>
    </Show>
    <Show when={kind() === GeometryType.PATH_3D}>
      <PanelSection title="3D material">
        <MaterialFlag node={props.node} property="lit" label="Lighting" />
        <MaterialFlag node={props.node} property="depthTest" label="Depth test" />
      </PanelSection>
    </Show>
    <Show when={kind() === GeometryType.POINT_CLOUD}>
      <PanelSection title="Point cloud"><SpatialFields node={props.node} fields={[["pointSize", "Point size", 0.1, "px"]]} /></PanelSection>
    </Show>
    <Show when={kind() === GeometryType.LIGHT}>
      <PanelSection title="Light">
        <ControlRow label="Type"><select aria-label="Light type" class={selectClass} value={light()?.type ?? "point"} onChange={(event) => editor.editProperty(props.node, "type", event.currentTarget.value)}>
          <For each={LIGHT_TYPES}>{type => <option value={type}>{type[0].toUpperCase() + type.slice(1)}</option>}</For>
        </select></ControlRow>
        <SpatialColor node={props.node} property="color" label="Color" />
        <SpatialFields node={props.node} fields={[["intensity", "Intensity"]]} />
        <Show when={light()?.type === "directional" || light()?.type === "spot"}>
          <ControlRow label="Target" contentClass="grid grid-cols-3 gap-1">
            <For each={[["targetX", "X"], ["targetY", "Y"], ["targetZ", "Z"]] as const}>{([property, axis]) => <MotionField node={props.node} property={property} axis={axis} label={`Light target ${axis}`} />}</For>
          </ControlRow>
        </Show>
        <Show when={light()?.type !== "ambient"}><MaterialFlag node={props.node} property="castShadow" label="Cast shadow" /></Show>
        <Show when={light()?.type === "point" || light()?.type === "spot"}>
          <SpatialFields node={props.node} fields={[["distance", "Distance", 1, "px"], ["decay", "Decay"]]} />
        </Show>
        <Show when={light()?.type === "spot"}>
          <SpatialFields node={props.node} fields={[["coneAngle", "Cone angle", 0.1, "°"], ["penumbra", "Penumbra"]]} />
        </Show>
      </PanelSection>
    </Show>
    <Show when={kind() === GeometryType.VOLUME}>
      <PanelSection title="Volume">
        <SpatialColor node={props.node} property="color" label="Color" />
        <SpatialFields node={props.node} fields={[["depth", "Depth", 1, "px"], ["density", "Density"], ["noiseScale", "Noise scale"], ["flowSpeed", "Flow speed"], ["scatter", "Scatter"]]} />
      </PanelSection>
    </Show>
  </>;
}
