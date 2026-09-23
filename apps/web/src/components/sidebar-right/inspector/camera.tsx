import { ControlRow } from "@/components/ui/control-group";
import { PanelSection } from "@/components/ui/panel-section";
import { MotionField } from "./motion-field";
import { Show } from "solid-js";
import { Scene3D } from "@diffusionstudio/runtime";
import type { Entity } from "koota";

export function CameraSettings(props: { selection: Entity[] }) {
  const node = () => props.selection[0]!;
  return <PanelSection title="Camera">
    <ControlRow label="Position" contentClass="grid grid-cols-2 gap-2">
      <MotionField node={node()} property="cameraX" label="Camera X" axis="X" />
      <MotionField node={node()} property="cameraY" label="Camera Y" axis="Y" />
    </ControlRow>
    <ControlRow label="Distance">
      <MotionField node={node()} property="cameraZ" label="Camera distance" axis="Z" />
    </ControlRow>
    <ControlRow label="Tilt" contentClass="grid grid-cols-2 gap-2">
      <MotionField node={node()} property="cameraRotationX" label="Camera tilt X" axis="X" unit="°" step={0.1} />
      <MotionField node={node()} property="cameraRotationY" label="Camera tilt Y" axis="Y" unit="°" step={0.1} />
    </ControlRow>
    <ControlRow label="Roll">
      <MotionField node={node()} property="cameraRotation" label="Camera roll" unit="°" step={0.1} />
    </ControlRow>
    <ControlRow label="Zoom">
      <MotionField node={node()} property="cameraZoom" label="Camera zoom" unit="×" min={0.01} step={0.01} />
    </ControlRow>
    <ControlRow label="Perspective">
      <MotionField node={node()} property="perspective" label="Camera perspective" min={1} />
    </ControlRow>
    <Show when={node().has(Scene3D)}>
      <ControlRow label="Lens offset" contentClass="grid grid-cols-2 gap-2">
        <MotionField node={node()} property="cameraOffsetX" label="Camera lens offset X" axis="X" />
        <MotionField node={node()} property="cameraOffsetY" label="Camera lens offset Y" axis="Y" />
      </ControlRow>
    </Show>
    <ControlRow label="Focus distance">
      <MotionField node={node()} property="focusDistance" label="Focus distance" min={1} unit="px" />
    </ControlRow>
    <ControlRow label="Aperture">
      <MotionField node={node()} property="aperture" label="Aperture" min={0} unit="px" step={0.1} />
    </ControlRow>
  </PanelSection>;
}
