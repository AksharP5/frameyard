import { ControlRow } from "@/components/ui/control-group";
import { PanelSection } from "@/components/ui/panel-section";
import { MotionField } from "./motion-field";
import type { Entity } from "koota";

export function SceneFinishSettings(props: { node: Entity }) {
  return <PanelSection title="Scene finish">
    <ControlRow label="Bloom"><MotionField node={props.node} property="bloom" label="Bloom" min={0} max={1} step={0.01} /></ControlRow>
    <ControlRow label="Vignette"><MotionField node={props.node} property="vignette" label="Vignette" min={0} max={1} step={0.01} /></ControlRow>
    <ControlRow label="Grain"><MotionField node={props.node} property="grain" label="Grain" min={0} max={1} step={0.01} /></ControlRow>
    <ControlRow label="Color split"><MotionField node={props.node} property="colorSplit" label="Color split" min={0} unit="px" step={0.1} /></ControlRow>
  </PanelSection>;
}

export function MaterialSettings(props: { node: Entity }) {
  return <PanelSection title="Material">
    <ControlRow label="Backdrop blur"><MotionField node={props.node} property="backdropBlur" label="Backdrop blur" min={0} unit="px" step={0.1} /></ControlRow>
    <ControlRow label="Refraction"><MotionField node={props.node} property="refraction" label="Refraction" min={0} max={1} step={0.01} /></ControlRow>
  </PanelSection>;
}
