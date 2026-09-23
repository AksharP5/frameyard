/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { useWorld } from '@diffusionstudio/koota-solid';
import { isScene, watchColorScopes, SCOPE_WIDTH, SCOPE_HEIGHT } from '@diffusionstudio/runtime';
import { Select, SelectContent, SelectItem, SelectPortal, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ColorScopes } from '@diffusionstudio/runtime';
import type { Entity } from 'koota';

const MODES = ['Waveform', 'Histogram', 'Vectorscope'] as const;
type ScopeMode = typeof MODES[number];

function drawScopes(canvas: HTMLCanvasElement, scopes: ColorScopes, mode: ScopeMode) {
  const ctx = canvas.getContext('2d')!;
  const width = mode === 'Vectorscope' ? SCOPE_HEIGHT : SCOPE_WIDTH;
  canvas.width = width;
  canvas.height = SCOPE_HEIGHT;
  ctx.fillStyle = '#101215';
  ctx.fillRect(0, 0, width, SCOPE_HEIGHT);
  ctx.strokeStyle = '#343940';
  ctx.lineWidth = 1;
  if (mode === 'Vectorscope') {
    ctx.beginPath();ctx.arc(width / 2, SCOPE_HEIGHT / 2, SCOPE_HEIGHT / 2 - 1, 0, Math.PI * 2);ctx.stroke();
    ctx.beginPath();ctx.moveTo(width / 2, 0);ctx.lineTo(width / 2, SCOPE_HEIGHT);ctx.moveTo(0, SCOPE_HEIGHT / 2);ctx.lineTo(width, SCOPE_HEIGHT / 2);ctx.stroke();
  } else {
    for (let step = 1; step < 4; step++) {
      ctx.beginPath();ctx.moveTo(0, step * SCOPE_HEIGHT / 4);ctx.lineTo(width, step * SCOPE_HEIGHT / 4);ctx.stroke();
    }
  }
  if (mode === 'Histogram') {
    const maximum = Math.max(1, ...scopes.histogram.flatMap((channel) => [...channel]));
    scopes.histogram.forEach((channel, index) => {
      ctx.strokeStyle = ['#ff6868', '#67db91', '#76a9ff'][index]!;
      ctx.beginPath();
      channel.forEach((count, bin) => {
        const y = SCOPE_HEIGHT - 1 - Math.log1p(count) / Math.log1p(maximum) * (SCOPE_HEIGHT - 2);
        if (bin === 0) ctx.moveTo(bin, y); else ctx.lineTo(bin, y);
      });
      ctx.stroke();
    });
    return;
  }
  const density = mode === 'Waveform' ? scopes.waveform : scopes.vectorscope;
  const image = ctx.getImageData(0, 0, width, SCOPE_HEIGHT);
  const maximum = Math.max(1, ...density);
  density.forEach((count, index) => {
    if (!count) return;
    const strength = .35 + .65 * Math.log1p(count) / Math.log1p(maximum);
    image.data[index * 4] = Math.round((mode === 'Waveform' ? 135 : 218) * strength);
    image.data[index * 4 + 1] = Math.round(240 * strength);
    image.data[index * 4 + 2] = Math.round(225 * strength);
  });
  ctx.putImageData(image, 0, 0);
}

export function ColorScopesView(props: { entity: Entity }) {
  const world = useWorld();
  const [mode, setMode] = createSignal<ScopeMode>('Waveform');
  const [scopes, setScopes] = createSignal<ColorScopes>();
  const [error, setError] = createSignal('');
  const [visible, setVisible] = createSignal(false);
  const [awake, setAwake] = createSignal(!document.hidden);
  let root!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  onMount(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false));
    observer.observe(root);
    const visibility = () => setAwake(!document.hidden);
    document.addEventListener('visibilitychange', visibility);
    onCleanup(() => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', visibility);
    });
  });
  createEffect(() => {
    const entity = props.entity;
    setScopes(undefined);
    setError('');
    if (!visible() || !awake()) return;
    onCleanup(watchColorScopes(world, entity, setScopes, setError));
  });
  createEffect(() => {
    const current = scopes();
    if (current) drawScopes(canvas, current, mode());
  });
  return (
    <div ref={root} class="space-y-2 mt-2">
      <div class="flex items-center gap-2">
        <span class="w-16 shrink-0 text-xs text-muted-foreground">{isScene(props.entity) ? 'Scene scopes' : 'Source scopes'}</span>
        <Select value={mode()} options={[...MODES]} onChange={(value) => value && setMode(value)}
          itemComponent={(item) => <SelectItem item={item.item}>{item.item.rawValue}</SelectItem>}>
          <SelectTrigger><SelectValue>{mode()}</SelectValue></SelectTrigger><SelectPortal><SelectContent /></SelectPortal>
        </Select>
      </div>
      <canvas ref={canvas} width={256} height={128} class="w-full h-32 object-contain bg-[#101215]" aria-label={`${mode()} of the selected ${isScene(props.entity) ? 'scene' : 'source'}`} />
      <div class="flex justify-between text-[10px] text-muted-foreground">
        <Show when={mode() === 'Waveform'}><span>0–100% luma</span><span>Left to right</span></Show>
        <Show when={mode() === 'Histogram'}><span>0–255 RGB</span><span>Log count</span></Show>
        <Show when={mode() === 'Vectorscope'}><span>Cb horizontal</span><span>Cr vertical</span></Show>
      </div>
      <Show when={error()}><p class="text-xs text-destructive">{error()}</p></Show>
      <Show when={scopes()?.samples === 0}><p class="text-xs text-muted-foreground">No visible pixels at this frame.</p></Show>
    </div>
  );
}
