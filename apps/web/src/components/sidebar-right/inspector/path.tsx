import { createSignal, Show } from "solid-js";
import { useTrait, useWorld } from "@diffusionstudio/koota-solid";
import { Computed, Geometry, GeometryType, PathData, parsePathData, parsePathViewBox } from "@diffusionstudio/runtime";
import { parsePath3D } from "@diffusionstudio/jsx";
import { useDerived, useEditor } from "@/engine/hooks";
import { syncKeyframe } from "@/engine/keyframes";
import { ControlRow } from "@/components/ui/control-group";
import { ControlledTextField } from "@/components/ui/text-field";
import { Keyframe } from "@/components/ui/keyframe";
import { PanelSection } from "@/components/ui/panel-section";
import type { Entity } from "koota";

export function PathSettings(props: { node: Entity }) {
  const world = useWorld();
  const editor = useEditor();
  const geometry = useTrait(() => props.node, PathData);
  const spatial = () => props.node.get(Geometry)?.value === GeometryType.PATH_3D;
  const d = useDerived(() => (spatial() ? props.node.get(Computed)?.path3d : props.node.get(Computed)?.pathData) ?? "");
  const [error, setError] = createSignal("");

  const updatePath = (raw: string) => {
    try {
      const value = (spatial() ? parsePath3D : parsePathData)(raw);
      editor.editProperty(props.node, "d", value);
      syncKeyframe(world, editor, props.node, "d", value);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const updateViewBox = (raw: string) => {
    try {
      const value = raw.trim() ? parsePathViewBox(raw.trim().split(/[\s,]+/).map(Number)) : undefined;
      editor.editProperty(props.node, "viewBox", value ?? false);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  return <PanelSection title={spatial() ? "3D path" : "Vector path"} actions={<Keyframe target={props.node} property="d" />}>
    <textarea aria-label={spatial() ? "3D path data" : "SVG path data"} class="motion-path-input min-h-24 w-full resize-y rounded-md border border-border-input bg-input p-2 font-mono text-xs leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-primary" value={d()} spellcheck={false} onChange={(event) => updatePath(event.currentTarget.value)} />
    <Show when={!spatial()}>
    <ControlRow label="View box">
      <ControlledTextField aria-label="Path view box" placeholder="Local coordinates" value={geometry()?.viewBox?.join(" ") ?? ""} onChange={(event) => updateViewBox(event.currentTarget.value)} />
    </ControlRow>
    </Show>
    <ControlRow label="Fill rule">
      <select aria-label="Path fill rule" class="h-8 w-full rounded-md border border-border-input bg-input px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-primary" value={geometry()?.fillRule ?? "nonzero"} onChange={(event) => editor.editProperty(props.node, "fillRule", event.currentTarget.value === "evenodd" ? "evenodd" : "nonzero")}>
        <option value="nonzero">Nonzero</option>
        <option value="evenodd">Even-odd</option>
      </select>
    </ControlRow>
    <Show when={error()}><p role="alert" class="text-xs text-destructive">{error()}</p></Show>
  </PanelSection>;
}
