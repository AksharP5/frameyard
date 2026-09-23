import { For, Show } from "solid-js";
import { useTrait } from "@diffusionstudio/koota-solid";
import { PHYSICS_WORLD_DEFAULTS, RIGID_BODY_DEFAULTS, isPropValue, parsePhysicsWorld, parseRigidBody } from "@diffusionstudio/jsx";
import { authoredElement } from "@diffusionstudio/reconciler";
import { PhysicsWorld, RigidBody } from "@diffusionstudio/runtime";
import { useEditor } from "@/engine/hooks";
import { ControlRow } from "@/components/ui/control-group";
import { ControlledTextField } from "@/components/ui/text-field";
import { PanelSection } from "@/components/ui/panel-section";
import { Switch, SwitchControl, SwitchInput, SwitchThumb } from "@/components/ui/switch";
import type { Entity } from "koota";

export function PhysicsSettings(props: { node: Entity; world?: boolean }) {
  const editor = useEditor();
  const world = useTrait(() => props.node, PhysicsWorld);
  const body = useTrait(() => props.node, RigidBody);
  const worldSettings = () => world()?.settings ?? PHYSICS_WORLD_DEFAULTS;
  const bodySettings = () => body()?.settings ?? RIGID_BODY_DEFAULTS;
  const edit = (property: "physics" | "rigidBody", change: Record<string, unknown>) => {
    const current = authoredElement(props.node)?.props[property];
    const value = { ...(current && typeof current === "object" ? current : {}), ...change };
    (property === "physics" ? parsePhysicsWorld : parseRigidBody)(value);
    if (!isPropValue(value)) throw new Error("Physics settings must be serializable source values");
    editor.editProperty(props.node, property, value);
  };
  return <PanelSection title={props.world ? "Physics" : "Rigid body"}>
    <Show when={props.world} fallback={<>
      <ControlRow label="Body"><select aria-label="Rigid body type" class="h-8 w-full rounded-md border border-border-input bg-input px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-primary"
        value={body()?.settings?.type ?? "off"} onChange={(event) => event.currentTarget.value === "off" ? editor.editProperty(props.node, "rigidBody", false) : edit("rigidBody", { type: event.currentTarget.value })}>
        <option value="off">Off</option><option value="dynamic">Dynamic</option><option value="fixed">Fixed</option>
      </select></ControlRow>
      <Show when={body()?.settings}>
        <For each={[["mass", "Mass", 0.000001, 1e6], ["restitution", "Bounce", 0, 1], ["friction", "Friction", 0, 10]] as const}>{([property, label, min, max]) => <ControlRow label={label}>
          <ControlledTextField aria-label={`Body ${label.toLowerCase()}`} value={bodySettings()[property]} min={min} max={max} step={0.01} autoSelect sliderEnabled limitEvents onNumber={(value) => edit("rigidBody", { [property]: value })} />
        </ControlRow>}</For>
        <Show when={bodySettings().type === "dynamic"}>
          <ControlRow label="Velocity" contentClass="grid grid-cols-3 gap-1">
            <For each={["X", "Y", "Z"]}>{(axis, index) => <ControlledTextField aria-label={`Body velocity ${axis}`} icon={<span class="text-xxs">{axis}</span>} value={bodySettings().velocity[index()]} step={1} autoSelect sliderEnabled limitEvents
              onNumber={(value) => edit("rigidBody", { velocity: bodySettings().velocity.map((current, i) => i === index() ? value : current) })} />}</For>
          </ControlRow>
          <ControlRow label="Lock rotation" labelClass="w-24" contentClass="flex justify-end">
            <Switch checked={bodySettings().lockRotation} onChange={(value) => edit("rigidBody", { lockRotation: value })}>
              <SwitchInput aria-label="Lock body rotation" /><SwitchControl variant="compact"><SwitchThumb variant="compact" /></SwitchControl>
            </Switch>
          </ControlRow>
        </Show>
      </Show>
    </>}>
      <ControlRow label="Simulation" contentClass="flex justify-end">
        <Switch checked={Boolean(world()?.settings)} onChange={(value) => editor.editProperty(props.node, "physics", value)}>
          <SwitchInput aria-label="Physics simulation" /><SwitchControl variant="compact"><SwitchThumb variant="compact" /></SwitchControl>
        </Switch>
      </ControlRow>
      <Show when={world()?.settings}>
        <ControlRow label="Gravity" contentClass="grid grid-cols-3 gap-1">
          <For each={["X", "Y", "Z"]}>{(axis, index) => <ControlledTextField aria-label={`Gravity ${axis}`} icon={<span class="text-xxs">{axis}</span>} value={worldSettings().gravity[index()]} step={1} autoSelect sliderEnabled limitEvents
            onNumber={(value) => edit("physics", { gravity: worldSettings().gravity.map((current, i) => i === index() ? value : current) })} />}</For>
        </ControlRow>
      </Show>
    </Show>
  </PanelSection>;
}
