import { Show, createEffect, createSignal, untrack } from 'solid-js';
import { useWorld } from '@diffusionstudio/koota-solid';
import { AudioPlayback, Computed, Culled, Geometry, Hidden, Playback, VideoBuffer, VideoDecoderHandle, getActiveEntity, getParentNode } from '@diffusionstudio/runtime';
import { useEngineContext } from '@/engine';
import { useProjectConfig } from '@/engine/project-config';
import { toast } from 'somoto';
import { Button } from '@/components/ui/button';
import { zoomToFit } from '@/engine/camera';

export function PreviewControls() {
  const world = useWorld();
  const engine = useEngineContext();
  const config = useProjectConfig();
  const [busy, setBusy] = createSignal(false);
  const [stats, setStats] = createSignal<{ fps: number; skipped: number; late: boolean }>();
  let started = 0, presented = 0, skipped = 0, previous = -1;
  let sceneId: number | undefined;
  let contextOffset: number | undefined, timelineOffset: number | undefined;
  createEffect(() => {
    engine.frame();
    untrack(() => {
      const scene = getActiveEntity(world);
      const playback = scene?.get(Playback);
      if (!scene || !playback?.playing || playback.buffering || playback.speed !== 1) {
        started = 0; previous = -1; presented = 0; skipped = 0;
        setStats(undefined);
        return;
      }
      const now = performance.now();
      const frame = scene.get(Computed)?.localTime ?? 0;
      const clock = scene.get(AudioPlayback);
      if (!started || sceneId !== scene.id() || frame < previous
        || contextOffset !== clock?.contextOffsetInSeconds || timelineOffset !== clock?.timelineOffsetInSeconds) {
        started = now; presented = 0; skipped = 0; previous = frame; sceneId = scene.id();
        contextOffset = clock?.contextOffsetInSeconds; timelineOffset = clock?.timelineOffsetInSeconds;
        setStats(undefined);
      }
      if (frame !== previous) {
        presented++;
        skipped += Math.max(0, Math.abs(frame - previous) - 1);
        previous = frame;
      }
      if (now - started < 500) return;
      const late = world.query(VideoDecoderHandle).some((entity) => {
        const decoder = entity.get(VideoDecoderHandle);
        if (!(decoder instanceof VideoBuffer) || entity.has(Hidden)) return false;
        let node = entity.has(Geometry) ? entity : getParentNode(entity);
        if (node?.get(Computed)?.visibility !== 1) return false;
        while (node && !node.has(Hidden) && !node.has(Culled) && node.get(Computed)?.visibility !== 0) {
          if (node === scene) return decoder.cache.findCovering(decoder.pendingFrame) !== decoder.renderedFrame
            && Math.abs(decoder.pendingFrame - decoder.renderedFrame) > 1;
          node = getParentNode(node);
        }
        return false;
      });
      setStats({ fps: presented * 1000 / (now - started), skipped, late });
      started = now; presented = 0;
    });
  });
  const change = async (value: string) => {
    const scale = Number(value);
    if (scale !== 1 && scale !== 0.5 && scale !== 0.25) return;
    setBusy(true);
    try { await config()?.setPreviewScale(scale); }
    catch (error) { toast.error('Could not change preview quality', { description: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(false); }
  };
  return <div class="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xxs text-muted-foreground">
    <Button variant="ghost" aria-label="Fit canvas" title="Fit all content in view (Z)" onClick={() => zoomToFit(world)}>Fit</Button>
    <Show when={config()}><select aria-label="Preview quality" title="Preview quality. Exports use original media." class="bg-background/90 rounded px-1 py-1" value={config()?.previewScale()} disabled={busy()} onChange={event => void change(event.currentTarget.value)}>
      <option value="1">Source</option><option value="0.5">Half preview</option><option value="0.25">Quarter preview</option>
    </select></Show>
    <Show when={stats()}>{value => <span class="tabular-nums" title="Timeline frames presented per second and skipped frames during uninterrupted 1x playback. Late means visible video decoding has not reached the playhead.">
      {value().fps.toFixed(1)} fps · {value().skipped} skipped{value().late ? ' · decoding late' : ''}
    </span>}</Show>
  </div>;
}
