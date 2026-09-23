import { Computed, Source, getActiveEntity, getEntityChildren, getEntityTree, getSceneAncestor, isSequence, FrameRate, setPlayhead } from '@diffusionstudio/runtime';
import { renderAuthored } from '@diffusionstudio/reconciler';
import { expandLinkedClips, isClipLocked } from './clip-links';
import { getDocumentEditor } from './editor';
import { getEditHistory } from './history';
import { insertAsset } from './insert-asset';
import { resolveSequentialOverlaps } from './overlap';
import { getTargetTrack, insertTimelineGap, timelineEditing } from './timeline-editing';
import type { Asset } from '@diffusionstudio/assets';
import type { World } from 'koota';
import type { SourceRange } from './project-config';

export function insertSourceRange(world: World, asset: Asset, range: SourceRange, mode: 'insert' | 'overwrite'): void {
  const scene = getActiveEntity(world);
  if (!scene?.has(Source)) throw new Error('Open a scene before inserting media');
  if (!('duration' in asset) || !Number.isFinite(range.in) || !Number.isFinite(range.out)
    || range.in < 0 || range.out <= range.in || range.out > asset.duration + 0.000001) throw new Error('The source range must be inside the clip');
  const fps = world.get(FrameRate)?.value ?? 30;
  const frame = Math.max(0, Math.round(scene.get(Computed)?.localTime ?? 0));
  const duration = Math.max(1, Math.round((range.out - range.in) * fps));
  if ((range.out - range.in) * fps < 1 - 0.000001) throw new Error('Select at least one project frame');
  const chosenTarget = timelineEditing(world).target();
  if (chosenTarget?.isAlive() && getSceneAncestor(chosenTarget) === scene && isClipLocked(chosenTarget)) {
    throw new Error('The destination track is locked');
  }
  let parent = getTargetTrack(world) ?? getEntityChildren(world, scene).find((child) => isSequence(child) && !isClipLocked(child));
  if (parent && mode === 'overwrite') {
    const covered = getEntityChildren(world, parent).filter((clip) => {
      const time = clip.get(Computed);
      return time && time.start < frame + duration && time.end > frame;
    });
    if (expandLinkedClips(world, covered).some((clip) => getEntityTree(world, clip).some(isClipLocked))) throw new Error('The destination overlaps a locked clip');
  }
  if (parent && frame < (parent.get(Computed)?.origin ?? 0)) throw new Error('The playhead is before the destination track');
  const history = getEditHistory(world);
  history.beginGesture();
  try {
    if (mode === 'insert' && !insertTimelineGap(world, scene, frame, duration, parent ? [parent] : undefined)) throw new Error('The insertion would move locked clips');
    if (!parent) [parent] = getDocumentEditor(world).insertElement(scene, () => renderAuthored({ tag: 'sequence', props: { name: asset.type === 'AUDIO' ? 'Audio track' : 'Video track' }, children: [] }));
    if (!parent) throw new Error('Could not create a destination track');
    const start = (frame - (parent.get(Computed)?.origin ?? 0)) / fps;
    if (start < 0) throw new Error('The playhead is before the destination track');
    const clip = insertAsset(world, asset, { parent, start, sourceIn: range.in, sourceOut: range.out, fit: 'contain' });
    if (!clip) throw new Error('Could not insert media into the selected track');
    if (mode === 'overwrite') resolveSequentialOverlaps(world, expandLinkedClips(world, [clip]));
    setPlayhead(world, scene, frame + duration);
  } finally { history.endGesture(); }
}
