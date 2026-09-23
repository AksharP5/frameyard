/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createEffect, createSignal, For, Show } from 'solid-js';
import { useTrait, useWorld } from '@diffusionstudio/koota-solid';
import { COLOR_CURVE_CHANNELS, COLOR_CURVE_LIMIT, ColorGrade, PaintType, colorGradeError, getIntrinsicPaint, isScene, parseColorGrade } from '@diffusionstudio/runtime';
import { Button } from '@/components/ui/button';
import { ControlRow } from '@/components/ui/control-group';
import { PanelSection } from '@/components/ui/panel-section';
import { SliderInput } from '@/components/ui/slider-input';
import { ControlledTextField } from '@/components/ui/text-field';
import { Select, SelectContent, SelectItem, SelectPortal, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useDerived, useEditor } from '@/engine/hooks';
import { ColorScopesView } from './color-scopes';
import type { ColorGradeSettings } from '@diffusionstudio/jsx';
import type { Entity } from 'koota';

const CHANNEL_NAMES = { master: 'Master', red: 'Red', green: 'Green', blue: 'Blue' };
const CHANNEL_COLORS = { master: '#d4d9e1', red: '#ff6868', green: '#67db91', blue: '#76a9ff' };
type CurveChannel = typeof COLOR_CURVE_CHANNELS[number];
type Points = [number, number][];
const DEFAULT_POINTS: Points = [[0, 0], [.25, .25], [.5, .5], [.75, .75], [1, 1]];
const clamp = (value: number) => Math.max(0, Math.min(1, value));

function GradeControls(props: { entity: Entity }) {
  const world = useWorld();
  const editor = useEditor();
  const grade = useTrait(() => props.entity, ColorGrade);
  const settings = () => grade()?.value ?? {};
  const error = useDerived(() => colorGradeError(world, props.entity));
  const [channel, setChannel] = createSignal<CurveChannel>('master');
  const [points, setPoints] = createSignal<Points>(DEFAULT_POINTS);
  const [selected, setSelected] = createSignal(2);
  const [dragging, setDragging] = createSignal(false);
  const write = (settings: ColorGradeSettings) => {
    const parsed = parseColorGrade(settings);
    editor.editProperty(props.entity, 'colorGrade', Object.keys(parsed).length ? parsed : false);
  };
  const writePoints = (next: Points) => {
    setPoints(next);
    write({ ...settings(), curves: { ...settings().curves, [channel()]: next } });
  };
  createEffect(() => {
    const next = settings().curves?.[channel()] ?? DEFAULT_POINTS;
    if (dragging()) return;
    setPoints(next);
    setSelected((index) => Math.min(index, next.length - 1));
  });
  const movePoint = (index: number, x: number, y: number) => {
    const curve = points();
    const nextX = index === 0 ? 0 : index === curve.length - 1 ? 1 : Math.max(curve[index - 1]![0] + .001, Math.min(curve[index + 1]![0] - .001, x));
    writePoints(curve.map((point, at): [number, number] => at === index ? [nextX, clamp(y)] : point));
  };
  const position = (event: PointerEvent) => {
    const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
    return [clamp((event.clientX - rect.left) / rect.width), clamp(1 - (event.clientY - rect.top) / rect.height)] as const;
  };
  const removePoint = () => {
    const index = selected();
    if (index === 0 || index === points().length - 1) return;
    writePoints(points().filter((_, at) => at !== index));
    setSelected(index - 1);
  };
  return (
    <PanelSection title="Color" actions={<Button size="small" variant="ghost" onClick={() => write({})}>Reset</Button>}>
      <ControlRow label="Warmth"><SliderInput value={(settings().temperature ?? 0) * 100} min={-100} max={100} step={1}
        onChange={(temperature) => write({ ...settings(), temperature: temperature / 100 })} /></ControlRow>
      <ControlRow label="Tint"><SliderInput value={(settings().tint ?? 0) * 100} min={-100} max={100} step={1}
        onChange={(tint) => write({ ...settings(), tint: tint / 100 })} /></ControlRow>
      <ControlRow label="Curve">
        <Select value={channel()} options={[...COLOR_CURVE_CHANNELS]} onChange={(value) => value && setChannel(value)}
          itemComponent={(item) => <SelectItem item={item.item}>{CHANNEL_NAMES[item.item.rawValue]}</SelectItem>}>
          <SelectTrigger><SelectValue>{CHANNEL_NAMES[channel()]}</SelectValue></SelectTrigger><SelectPortal><SelectContent /></SelectPortal>
        </Select>
      </ControlRow>
      <svg viewBox="0 0 256 160" preserveAspectRatio="none" class="w-full h-40 bg-[#101215] touch-none select-none overflow-visible"
        role="group" aria-label={`${CHANNEL_NAMES[channel()]} tone curve. Click to add a point, drag to adjust.`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const target = event.target as SVGElement;
          let index = Number(target.getAttribute('data-point') ?? NaN);
          if (!Number.isFinite(index)) {
            if (points().length >= COLOR_CURVE_LIMIT) return;
            const [x, y] = position(event);
            if (points().some(([pointX]) => Math.abs(pointX - x) < .01)) return;
            const next = [...points(), [x, y] as [number, number]].sort(([a], [b]) => a - b);
            index = next.findIndex(([pointX]) => pointX === x);
            setDragging(true);
            writePoints(next);
          }
          setSelected(index);
          setDragging(true);
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => { if (dragging()) movePoint(selected(), ...position(event)); }}
        onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setDragging(false); }}
        onPointerCancel={() => setDragging(false)}>
        <For each={[.25, .5, .75]}>{(value) => <path d={`M ${value * 256} 0 V 160 M 0 ${value * 160} H 256`} stroke="#343940" stroke-width="1" />}</For>
        <path d="M 0 160 L 256 0" stroke="#525962" stroke-width="1" stroke-dasharray="3 4" />
        <polyline points={points().map(([x, y]) => `${x * 256},${(1 - y) * 160}`).join(' ')} fill="none" stroke={CHANNEL_COLORS[channel()]} stroke-width="2" />
        <For each={points()}>{([x, y], index) => <circle cx={x * 256} cy={(1 - y) * 160} r={selected() === index() ? 5 : 4}
          data-point={index()} fill={CHANNEL_COLORS[channel()]} stroke="#101215" stroke-width="1"
          role="button" tabindex="0" aria-label={`Curve point ${index() + 1}: input ${Math.round(x * 100)}, output ${Math.round(y * 100)}`}
          onFocus={() => setSelected(index())}
          onKeyDown={(event) => {
            const amount = event.shiftKey ? .05 : .01;
            if (event.key === 'ArrowUp') movePoint(index(), x, y + amount);
            else if (event.key === 'ArrowDown') movePoint(index(), x, y - amount);
            else if (event.key === 'ArrowLeft') movePoint(index(), x - amount, y);
            else if (event.key === 'ArrowRight') movePoint(index(), x + amount, y);
            else if (event.key === 'Delete' || event.key === 'Backspace') removePoint();
            else return;
            event.preventDefault();
            const svg = event.currentTarget.ownerSVGElement;
            const pointIndex = selected();
            queueMicrotask(() => svg?.querySelector<SVGElement>(`[data-point="${pointIndex}"]`)?.focus());
          }} />}</For>
      </svg>
      <ControlRow label="Point" contentClass="flex gap-2">
        <ControlledTextField value={Math.round((points()[selected()]?.[0] ?? 0) * 100)} min={0} max={100} unit="In" aria-label="Curve input percent"
          disabled={selected() === 0 || selected() === points().length - 1} onNumber={(value) => value !== undefined && movePoint(selected(), value / 100, points()[selected()]![1])} />
        <ControlledTextField value={Math.round((points()[selected()]?.[1] ?? 0) * 100)} min={0} max={100} unit="Out" aria-label="Curve output percent"
          onNumber={(value) => value !== undefined && movePoint(selected(), points()[selected()]![0], value / 100)} />
      </ControlRow>
      <div class="flex justify-between">
        <Button size="small" variant="ghost" disabled={selected() === 0 || selected() === points().length - 1} onClick={removePoint}>Remove point</Button>
        <Button size="small" variant="ghost" onClick={() => { const curves = { ...settings().curves }; delete curves[channel()]; write({ ...settings(), curves }); }}>Reset curve</Button>
      </div>
      <Show when={error()}><p class="text-xs text-destructive">{error()}</p></Show>
      <ColorScopesView entity={props.entity} />
    </PanelSection>
  );
}

export function ColorGradingSettings(props: { selection: Entity[] }) {
  const entity = () => props.selection[0];
  const supported = () => {
    const target = entity();
    if (!target || props.selection.length !== 1) return false;
    const paint = getIntrinsicPaint(target);
    return isScene(target) || paint === PaintType.IMAGE || paint === PaintType.VIDEO;
  };
  return <Show when={supported()}><GradeControls entity={entity()!} /></Show>;
}
