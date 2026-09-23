import { For, Show, createSignal } from 'solid-js';
import { useWorld } from '@diffusionstudio/koota-solid';
import { FRAME_RATE_PRESETS } from '@diffusionstudio/jsx';
import { Selected, findGeometryAsset } from '@diffusionstudio/runtime';
import { toast } from 'somoto';
import { useDerived } from '@/engine/hooks';
import { useProjectConfig } from '@/engine/project-config';
import { flushProjectEdits } from '@/projects/edits';

export function ProjectFrameRateControl() {
  const world = useWorld();
  const config = useProjectConfig();
  const [busy, setBusy] = createSignal(false);
  const sourceRate = useDerived(() => {
    for (const entity of world.query(Selected)) {
      const asset = findGeometryAsset(world, entity);
      if (asset?.type === 'VIDEO' || asset?.type === 'SEQUENCE') return asset.frameRate;
    }
    return undefined;
  });

  const change = async (value: string) => {
    const project = config();
    if (!project) return;
    const rate = value === 'source' ? sourceRate() : Number(value);
    if (rate === undefined) return;
    setBusy(true);
    try { await flushProjectEdits(world); await project.setFrameRate(rate); }
    catch (error) { toast.error('Could not change frame rate', { description: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(false); }
  };

  return <Show when={config()}>
    <select
      aria-label="Project frame rate"
      title="Project frame rate"
      class="max-w-20 bg-transparent text-xxs tabular-nums outline-none focus-visible:ring-1 focus-visible:ring-primary"
      value={config()?.frameRate()}
      disabled={busy()}
      onChange={(event) => void change(event.currentTarget.value)}
    >
      <For each={FRAME_RATE_PRESETS}>{(rate) => <option value={rate}>{Number(rate.toFixed(3))} fps</option>}</For>
      <Show when={!FRAME_RATE_PRESETS.some((rate) => rate === config()?.frameRate())}>
        <option value={config()?.frameRate()}>{Number(config()?.frameRate().toFixed(3))} fps</option>
      </Show>
      <Show when={sourceRate()}><option value="source">Match selected clip</option></Show>
    </select>
  </Show>;
}
