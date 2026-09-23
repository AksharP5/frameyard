/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { useTrait, useWorld } from '@diffusionstudio/koota-solid';
import { AUDIO_COMPRESSOR_DEFAULTS, AssetId, AudioBusHandle, AudioDecoderHandle, AudioProcessing, AudioStream, getAsset, isScene, parseAudioProcessing } from '@diffusionstudio/runtime';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import { ControlRow } from '@/components/ui/control-group';
import { Button } from '@/components/ui/button';
import { ControlledTextField } from '@/components/ui/text-field';
import { SliderInput } from '@/components/ui/slider-input';
import { Select, SelectContent, SelectItem, SelectPortal, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch, SwitchControl, SwitchInput, SwitchThumb } from '@/components/ui/switch';
import { useDerived, useEditor } from '@/engine/hooks';
import { normalizeSceneAudio } from '@/engine/audio-normalization';
import { editorSession } from '@/dapi/session';
import { mainBridge } from '@/lib/ipc';
import { isDesktop } from '@/projects';
import type { AudioProcessingSettings } from '@diffusionstudio/jsx';
import type { Entity } from 'koota';
import type { MainRequestMap } from '@desktop/main-channels';

export function AudioProcessingControls(props: { entity: Entity }) {
  const world = useWorld();
  const editor = useEditor();
  const processing = useTrait(() => props.entity, AudioProcessing);
  const audioBus = useTrait(() => props.entity, AudioBusHandle);
  const decoder = useTrait(() => props.entity, AudioDecoderHandle);
  const error = useDerived(() => audioBus()?.error ?? decoder()?.error);
  const settings = () => processing()?.value ?? {};
  const write = (next: AudioProcessingSettings) => {
    const parsed = parseAudioProcessing(next);
    editor.editProperty(props.entity, 'audioProcessing', Object.keys(parsed).length ? parsed : false);
  };
  const updateCompressor = (key: keyof typeof AUDIO_COMPRESSOR_DEFAULTS, value: number | undefined) => {
    if (value === undefined) return;
    write({ ...settings(), compressor: { ...settings().compressor, [key]: value } });
  };
  const toggle = (key: 'compressor' | 'limiter', enabled: boolean) => {
    const next = { ...settings() };
    if (!enabled) delete next[key];
    else if (key === 'compressor') next.compressor = {};
    else next.limiter = -1;
    write(next);
  };
  const [target, setTarget] = createSignal(-16);
  const [progress, setProgress] = createSignal('');
  const [result, setResult] = createSignal('');
  const [failed, setFailed] = createSignal(false);
  let normalization: AbortController | undefined;
  const normalize = async () => {
    const controller = new AbortController();
    normalization = controller;
    setResult('');
    setFailed(false);
    try {
      const adjusted = await normalizeSceneAudio(props.entity, target(), controller.signal, setProgress);
      setResult(`${adjusted.gain >= 0 ? '+' : ''}${adjusted.gain.toFixed(1)} dB applied. Estimated ${adjusted.estimatedLufs.toFixed(1)} LUFS${adjusted.peakLimited ? ', capped at −1 dBTP' : ''}.`);
    } catch (error) {
      if (controller.signal.aborted) setResult('Normalization canceled.');
      else {
        setFailed(true);
        setResult(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setProgress('');
      normalization = undefined;
    }
  };
  createEffect(() => {
    void props.entity;
    setResult('');
    onCleanup(() => normalization?.abort());
  });

  const assetId = useTrait(() => props.entity, AssetId);
  const stream = useTrait(() => props.entity, AudioStream);
  type AudioStreams = MainRequestMap[typeof MAIN_CHANNELS.MEDIA_LIST_STREAMS]['response'];
  const [streams, setStreams] = createSignal<AudioStreams>([]);
  const [streamError, setStreamError] = createSignal('');
  createEffect(() => {
    const asset = getAsset(world, assetId()?.value ?? '');
    const dir = editorSession()?.project.dir();
    setStreams([]);
    setStreamError('');
    if (!isDesktop() || !dir || !asset || (asset.type !== 'VIDEO' && asset.type !== 'AUDIO')) return;
    let current = true;
    onCleanup(() => { current = false; });
    void mainBridge.call(MAIN_CHANNELS.MEDIA_LIST_STREAMS, { dir, source: asset.source }).then((list) => {
      if (current) setStreams(list);
    }).catch((error: unknown) => {
      if (current) setStreamError(error instanceof Error ? error.message : String(error));
    });
  });
  const streamLabel = (index: number) => {
    const item = streams().find((entry) => entry.index === index);
    return item ? `${index + 1}: ${item.title || item.language || item.codec} · ${item.channels} ch` : `Stream ${index + 1}`;
  };

  return (
    <div class="space-y-2 mt-3">
      <Show when={streams().length > 1}>
        <ControlRow label="Stream">
          <Select value={stream()?.value ?? 0} options={streams().map((item) => item.index)}
            onChange={(value) => value !== null && editor.editProperty(props.entity, 'audioStream', value === 0 ? false : value)}
            itemComponent={(item) => <SelectItem item={item.item}>{streamLabel(item.item.rawValue)}</SelectItem>}>
            <SelectTrigger><SelectValue>{streamLabel(stream()?.value ?? 0)}</SelectValue></SelectTrigger>
            <SelectPortal><SelectContent /></SelectPortal>
          </Select>
        </ControlRow>
      </Show>
      <Show when={streamError()}><p class="text-xs text-destructive">{streamError()}</p></Show>
      <ControlRow label="Pan">
        <SliderInput value={settings().pan ?? 0} min={-1} max={1} step={0.01}
          format={(value) => value === 0 ? 'Center' : `${Math.round(Math.abs(value) * 100)}% ${value < 0 ? 'L' : 'R'}`}
          onChange={(pan) => write({ ...settings(), pan })} />
      </ControlRow>
      <For each={['Low EQ', 'Mid EQ', 'High EQ']}>
        {(label, index) => <ControlRow label={label}>
          <ControlledTextField value={settings().eq?.[index()] ?? 0} min={-24} max={24} step={0.5} unit="dB" showSign
            onNumber={(value) => {
              if (value === undefined) return;
              const eq: [number, number, number] = [...settings().eq ?? [0, 0, 0]];
              eq[index()] = value;
              write({ ...settings(), eq });
            }} />
        </ControlRow>}
      </For>
      <ControlRow label="Compress">
        <Switch checked={settings().compressor !== undefined} onChange={(value) => toggle('compressor', value)}>
          <SwitchInput aria-label="Compressor" /><SwitchControl variant="compact"><SwitchThumb variant="compact" /></SwitchControl>
        </Switch>
      </ControlRow>
      <Show when={settings().compressor !== undefined}>
        <ControlRow label="Threshold"><ControlledTextField value={settings().compressor?.threshold ?? AUDIO_COMPRESSOR_DEFAULTS.threshold}
          min={-100} max={0} unit="dB" onNumber={(value) => updateCompressor('threshold', value)} /></ControlRow>
        <ControlRow label="Ratio"><ControlledTextField value={settings().compressor?.ratio ?? AUDIO_COMPRESSOR_DEFAULTS.ratio}
          min={1} max={20} step={0.1} unit=":1" onNumber={(value) => updateCompressor('ratio', value)} /></ControlRow>
        <ControlRow label="Attack"><ControlledTextField value={(settings().compressor?.attack ?? AUDIO_COMPRESSOR_DEFAULTS.attack) * 1000}
          min={0} max={1000} unit="ms" onNumber={(value) => updateCompressor('attack', value === undefined ? undefined : value / 1000)} /></ControlRow>
        <ControlRow label="Release"><ControlledTextField value={(settings().compressor?.release ?? AUDIO_COMPRESSOR_DEFAULTS.release) * 1000}
          min={5} max={1000} unit="ms" onNumber={(value) => updateCompressor('release', value === undefined ? undefined : value / 1000)} /></ControlRow>
      </Show>
      <ControlRow label="Limiter">
        <Switch checked={settings().limiter !== undefined} onChange={(value) => toggle('limiter', value)}>
          <SwitchInput aria-label="Sample peak limiter" /><SwitchControl variant="compact"><SwitchThumb variant="compact" /></SwitchControl>
        </Switch>
      </ControlRow>
      <Show when={settings().limiter !== undefined}>
        <ControlRow label="Ceiling"><ControlledTextField value={settings().limiter ?? -1} min={-24} max={0} step={0.1} unit="dBFS"
          onNumber={(limiter) => limiter !== undefined && write({ ...settings(), limiter })} /></ControlRow>
      </Show>
      <Show when={error()}><p class="text-xs text-destructive">{error()}</p></Show>
      <Show when={isDesktop() && isScene(props.entity)}>
        <ControlRow label="Loudness"><ControlledTextField value={target()} min={-36} max={-9} step={1} unit="LUFS"
          disabled={!!progress()} onNumber={(value) => value !== undefined && setTarget(value)} /></ControlRow>
        <Button class="w-full" variant="secondary" disabled={!!progress()} onClick={normalize}>Normalize scene loudness</Button>
        <Show when={progress()}>
          <div class="flex items-center justify-between gap-2 text-xs">
            <span>{progress()}</span><Button size="small" variant="ghost" onClick={() => normalization?.abort()}>Cancel</Button>
          </div>
        </Show>
        <Show when={result()}><p class="text-xs" classList={{ 'text-destructive': failed() }}>{result()}</p></Show>
      </Show>
    </div>
  );
}
