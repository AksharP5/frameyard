import { createMemo, createSignal, Show } from 'solid-js';
import { useWorld } from '@diffusionstudio/koota-solid';
import { FrameRate, formatTimestamp } from '@diffusionstudio/runtime';
import { parseTime } from '@diffusionstudio/jsx';
import { Button } from '@/components/ui/button';
import { ControlledTextField } from '@/components/ui/text-field';
import { useProjectConfig } from '@/engine/project-config';
import { insertSourceRange } from '@/engine/source-editing';
import { toast } from 'somoto';
import type { Asset } from '@diffusionstudio/assets';

export function SourceRangeControls(props: { asset: Asset; time: number; seek: (time: number) => void; onMarkKeys?: (handler: (event: KeyboardEvent) => void) => void }) {
  const world = useWorld();
  const config = useProjectConfig();
  const [busy, setBusy] = createSignal(false);
  const duration = () => 'duration' in props.asset ? props.asset.duration : 0;
  const fps = () => props.asset.type === 'VIDEO' || props.asset.type === 'SEQUENCE' ? props.asset.frameRate : world.get(FrameRate)?.value ?? 30;
  const range = createMemo(() => config()?.sourceRangeOf(props.asset) ?? { in: 0, out: duration() });
  const fail = (error: unknown) => toast.error('Could not edit source range', { description: error instanceof Error ? error.message : String(error) });
  const mark = async (edge: 'in' | 'out', time: number) => {
    const frame = Math.round(time * fps()) / fps();
    setBusy(true);
    try { await config()?.setSourceRange(props.asset, { ...range(), [edge]: Math.min(duration(), Math.max(0, frame)) }); }
    catch (error) { fail(error); }
    finally { setBusy(false); }
  };
  const insert = (mode: 'insert' | 'overwrite') => {
    try { insertSourceRange(world, props.asset, range(), mode); }
    catch (error) { fail(error); }
  };
  props.onMarkKeys?.((event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || busy()) return;
    const key = event.key.toLowerCase();
    if (key !== 'i' && key !== 'o') return;
    event.preventDefault(); event.stopPropagation();
    const edge = key === 'i' ? 'in' : 'out';
    if (event.shiftKey) props.seek(range()[edge]);
    else void mark(edge, props.time + (edge === 'out' ? 1 / fps() : 0));
  });
  return <Show when={duration() > 0}>
    <div class="grid grid-cols-2 gap-2">
      <div class="space-y-1"><Button class="w-full" variant="secondary" disabled={busy()} onClick={() => void mark('in', props.time)}>Mark In · I</Button>
        <ControlledTextField aria-label="Source In" value={formatTimestamp(range().in, fps())} autoSelect onChange={event => { const time = parseTime(event.currentTarget.value, fps()); if (time !== undefined) void mark('in', time); }} /></div>
      <div class="space-y-1"><Button class="w-full" variant="secondary" disabled={busy()} onClick={() => void mark('out', props.time + 1 / fps())}>Mark Out · O</Button>
        <ControlledTextField aria-label="Source Out" value={formatTimestamp(range().out, fps())} autoSelect onChange={event => { const time = parseTime(event.currentTarget.value, fps()); if (time !== undefined) void mark('out', time); }} /></div>
      <Button disabled={busy()} onClick={() => insert('insert')}>Insert range</Button>
      <Button variant="secondary" disabled={busy()} onClick={() => insert('overwrite')}>Overwrite range</Button>
    </div>
    <p class="text-xxs text-muted-foreground tabular-nums">{formatTimestamp(range().out - range().in, fps())} selected</p>
  </Show>;
}
