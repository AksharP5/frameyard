/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createEncoder } from '@diffusionstudio/encoder';
import { AudioProcessing, ChildOf, KeyframeTrack, Source, Volume, Workarea, isScene, loudnessGain } from '@diffusionstudio/runtime';
import { MAIN_CHANNELS } from '@desktop/main-channels';
import { editorLoadState, editorSession, requireEditorSession } from '@/dapi/session';
import { ElectronWritableFileHandle } from '@/lib/electron-file-writable';
import { mainBridge } from '@/lib/ipc';
import { flushProjectEdits } from '@/projects/edits';
import { createProjectFS } from '@/projects/fs';
import { createCapture } from './capture';
import { getDocumentEditor } from './editor';
import type { Entity } from 'koota';

export async function normalizeSceneAudio(scene: Entity, target: number, signal: AbortSignal, onProgress: (value: string) => void) {
  const { world, project } = requireEditorSession();
  const dir = project.dir();
  const loadState = editorLoadState();
  const stamp = scene.get(Source)?.value;
  if (!isScene(scene) || !stamp || loadState?.world !== world || loadState.status !== 'ready') {
    throw new Error('Open a loaded scene before normalizing its audio.');
  }
  if (world.query(ChildOf(scene), KeyframeTrack).some((track) => track.get(KeyframeTrack)?.property === 'volume')) {
    throw new Error('Remove master volume keyframes before normalizing. Clip volume keyframes can remain.');
  }
  const volume = scene.get(Volume)?.value ?? 0;
  if (!Number.isFinite(volume)) throw new Error('Raise the master volume above silence before normalizing.');
  let edited = false;
  const editor = getDocumentEditor(world);
  const stopListening = editor.onEdit(() => { edited = true; });
  const checkCurrent = () => {
    signal.throwIfAborted();
    if (edited || editorLoadState() !== loadState || editorSession()?.world !== world || editorSession()?.project.dir() !== dir || !scene.isAlive() || scene.get(Source)?.value !== stamp) {
      throw new Error('The scene changed during analysis. Run normalization again.');
    }
  };
  const fs = createProjectFS(dir);
  const source = `.cache/audio-analysis/${crypto.randomUUID()}.mov`;
  const handle = new ElectronWritableFileHandle(fs.absolute!(source));
  let capture: Awaited<ReturnType<typeof createCapture>> | undefined;
  let stopEncoder: (() => void) | undefined;
  try {
    onProgress('Preparing audio');
    await flushProjectEdits(world);
    checkCurrent();
    capture = await createCapture(world, scene, { mode: 'offline-audio', dir });
    checkCurrent();
    capture.node.remove(Workarea);
    // Measure before the final limiter so a constant fader adjustment remains linear.
    const processing = { ...capture.node.get(AudioProcessing)?.value };
    delete processing.limiter;
    capture.node.add(AudioProcessing);
    capture.node.set(AudioProcessing, { value: processing });
    const encoder = await createEncoder(capture.world, {
      format: 'mov', video: { enabled: false },
      audio: { enabled: true, codec: 'pcm-f32', sampleRate: 48000 }, target: handle,
      onProgress: ({ progress, total }) => onProgress(`Rendering audio ${Math.round(progress / Math.max(1, total) * 100)}%`),
    });
    stopEncoder = encoder.cancel;
    signal.addEventListener('abort', stopEncoder, { once: true });
    if (signal.aborted) encoder.cancel();
    const result = await encoder.render();
    checkCurrent();
    if (result.type === 'error') throw result.error;
    if (result.type !== 'success') throw new Error('Audio normalization canceled.');
    onProgress('Measuring loudness');
    const measured = await mainBridge.call(MAIN_CHANNELS.AUDIO_ANALYZE_LOUDNESS, { dir, source });
    checkCurrent();
    const adjustment = loudnessGain(measured.integratedLufs, measured.truePeakDbtp, volume, target);
    editor.editProperty(scene, 'volume', adjustment.volume === 0 ? false : adjustment.volume);
    return adjustment;
  } finally {
    stopListening();
    if (stopEncoder) signal.removeEventListener('abort', stopEncoder);
    capture?.dispose();
    await handle.dispose();
    if (await fs.stat(source)) await fs.remove(source);
  }
}
