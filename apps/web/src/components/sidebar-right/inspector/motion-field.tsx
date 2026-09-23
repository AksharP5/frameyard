import { useWorld } from "@diffusionstudio/koota-solid";
import { trackPropertyPath } from "@diffusionstudio/reconciler";
import { getPropertyPaths } from "@diffusionstudio/runtime";
import { useDerived, useEditor } from "@/engine/hooks";
import { syncKeyframe } from "@/engine/keyframes";
import { ControlledTextField } from "@/components/ui/text-field";
import { Keyframe } from "@/components/ui/keyframe";
import { SPATIAL_PARAMETERS, type AnimatableProperty, type SpatialArray, type SpatialParameter } from "@diffusionstudio/jsx";
import type { Entity } from "koota";

/** A numeric motion control reads the same sampled property as its keyframe track. */
export function MotionField(props: {
  node: Entity;
  property: Exclude<AnimatableProperty, "d" | "color" | SpatialArray>;
  label: string;
  axis?: string;
  unit?: string;
  step?: number;
  min?: number;
  max?: number;
}) {
  const world = useWorld();
  const editor = useEditor();
  const paths = getPropertyPaths(world);
  const bounds = () => Object.hasOwn(SPATIAL_PARAMETERS, props.property) ? SPATIAL_PARAMETERS[props.property as SpatialParameter] : undefined;
  const value = useDerived(() => {
    const path = trackPropertyPath(props.node, props.property);
    const current = path && paths[path]?.computed[props.node.id()];
    return typeof current === "number" ? Math.round(current * 100) / 100 : bounds()?.[0] ?? 0;
  });

  return <ControlledTextField
    aria-label={props.label}
    title={props.label}
    icon={props.axis ? <span class="text-xxs">{props.axis}</span> : undefined}
    value={value()}
    unit={props.unit}
    step={props.step ?? 1}
    min={props.min ?? (Number.isFinite(bounds()?.[1]) ? bounds()![1] : undefined)}
    max={props.max ?? (Number.isFinite(bounds()?.[2]) ? bounds()![2] : undefined)}
    autoSelect
    sliderEnabled
    limitEvents
    skipEmpty
    onNumber={(next) => {
      if (!Number.isFinite(next)) return;
      editor.editProperty(props.node, props.property, next);
      syncKeyframe(world, editor, props.node, props.property, next);
    }}
    keyframe={<Keyframe target={props.node} property={props.property} />}
  />;
}
