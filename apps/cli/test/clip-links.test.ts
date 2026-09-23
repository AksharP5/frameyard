import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { build } from 'esbuild';

import type { VideoAsset } from '@diffusionstudio/assets';
import type { TimelineSurfaceState } from '../../web/src/engine/timeline/surface';

const built = await build({
  stdin: {
    contents: `
      export { createRuntimeWorld, Audio, ClipLink, ClipDragOrigin, Computed, FrameRate, Host, Library, Locked, Markers, Muted, Playback, Selected, Source, Workarea, getMaskSelection, getSelection, getSourceFrameAt, serializeEntity, deserializeEntity } from '@diffusionstudio/runtime';
      export { createRuntimeDocument, authoredTree, renderAuthored } from '@diffusionstudio/reconciler';
      export { SOURCE_ATTR } from '@diffusionstudio/jsx';
      export { getEditHistory } from './history';
      export { getDocumentEditor } from './editor';
      export { expandLinkedClips, isLinkedSelection, linkSelection, unlinkSelection, trimLinkedClips } from './clip-links';
      export { splitAtPlayhead } from './split';
      export { rippleDeleteSelection } from './clip-edits';
      export { deleteSelection, pasteSelection, shortcutSystem } from './input/shortcuts';
      export { Keys } from './traits';
      export { timelineEditing, getTargetTrack, insertTimelineGap, rippleTrim, rollOrSlide, slipClips, toggleSyncTrack, reparentTimelineClip } from './timeline-editing';
      export { addMarker, editMarker, markRange, seekBoundary, seekTimelineFrames, shuttle } from './timeline-navigation';
      export { beginClipDrag, applyClipDrag } from './timeline/drag';
      export { insertAsset, separateAudio, canSeparateAudio } from './insert-asset';
      export { resolveSequentialOverlaps } from './overlap';
      export { insertSourceRange } from './source-editing';
      export { ungroupSelection } from './group';
    `,
    resolveDir: fileURLToPath(new URL('../../web/src/engine/', import.meta.url)),
  },
  bundle: true, write: false, format: 'cjs', platform: 'node', conditions: ['browser'],
  jsx: 'transform', jsxFactory: 'clipJsx', logOverride: { 'empty-import-meta': 'silent' },
  plugins: [{ name: 'unused-ui-boundaries', setup(builder) {
    builder.onResolve({ filter: /^(\.\.\/group|\.\/interactions|\.\/input\/interactions|\.\/timeline)$/ }, ({ path, importer }) => {
      if (importer.endsWith('/input/shortcuts.ts') || importer.endsWith('/split.tsx') || importer.endsWith('/group.tsx')) return { path, namespace: 'ui-boundary' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'ui-boundary' }, () => ({ contents: `
      export const groupSelection=unused, ungroupSelection=unused, unwrapSequenceSelection=unused,
        wrapSelectionInScene=unused, wrapSelectionInSequence=unused, editTransform=unused;
      export function cloneFramesForSplit() {} export function clonePeaksForSplit() {}
      function unused() { throw new Error('Unexpected UI action'); }
    ` }));
  } }],
});

type API = Pick<typeof import('@diffusionstudio/runtime'), 'createRuntimeWorld' | 'Audio' | 'ClipLink' | 'ClipDragOrigin' | 'Computed' | 'FrameRate' | 'Host' | 'Library' | 'Locked' | 'Markers' | 'Muted' | 'Playback' | 'Selected' | 'Source' | 'Workarea' | 'getMaskSelection' | 'getSelection' | 'getSourceFrameAt' | 'serializeEntity' | 'deserializeEntity'>
  & Pick<typeof import('@diffusionstudio/reconciler'), 'createRuntimeDocument' | 'authoredTree' | 'renderAuthored'>
  & Pick<typeof import('@diffusionstudio/jsx'), 'SOURCE_ATTR'>
  & Pick<typeof import('../../web/src/engine/history'), 'getEditHistory'>
  & Pick<typeof import('../../web/src/engine/editor'), 'getDocumentEditor'>
  & Pick<typeof import('../../web/src/engine/clip-links'), 'expandLinkedClips' | 'isLinkedSelection' | 'linkSelection' | 'unlinkSelection' | 'trimLinkedClips'>
  & Pick<typeof import('../../web/src/engine/split'), 'splitAtPlayhead'>
  & Pick<typeof import('../../web/src/engine/clip-edits'), 'rippleDeleteSelection'>
  & Pick<typeof import('../../web/src/engine/input/shortcuts'), 'deleteSelection' | 'pasteSelection' | 'shortcutSystem'>
  & Pick<typeof import('../../web/src/engine/traits'), 'Keys'>
  & Pick<typeof import('../../web/src/engine/timeline-editing'), 'timelineEditing' | 'getTargetTrack' | 'insertTimelineGap' | 'rippleTrim' | 'rollOrSlide' | 'slipClips' | 'toggleSyncTrack' | 'reparentTimelineClip'>
  & Pick<typeof import('../../web/src/engine/timeline-navigation'), 'addMarker' | 'editMarker' | 'markRange' | 'seekBoundary' | 'seekTimelineFrames' | 'shuttle'>
  & Pick<typeof import('../../web/src/engine/timeline/drag'), 'beginClipDrag' | 'applyClipDrag'>
  & Pick<typeof import('../../web/src/engine/insert-asset'), 'insertAsset' | 'separateAudio' | 'canSeparateAudio'>
  & Pick<typeof import('../../web/src/engine/overlap'), 'resolveSequentialOverlaps'>
  & Pick<typeof import('../../web/src/engine/source-editing'), 'insertSourceRange'>
  & Pick<typeof import('../../web/src/engine/group'), 'ungroupSelection'>;

const module = { exports: {} as API };
class Element { width = 1280; height = 720; }
runInThisContext(`(function(module,exports,HTMLCanvasElement,HTMLElement,Element,clipJsx){"use strict";${built.outputFiles[0].text}\n})`)(
  module, module.exports, Element, Element, Element,
  (component: (props: object) => unknown, props: object) => component(props),
);
const api = module.exports;

const footage: VideoAsset = {
  type: 'VIDEO', id: 'footage', path: 'footage.mov', source: '/footage.mov', createdAt: '', mimeType: 'video/quicktime',
  width: 1920, height: 1080, duration: 10, frameRate: 60, bitRate: 1_000_000, channels: 2, sampleRate: 48000,
  handle: { getFile: async () => { throw new Error('No decoding needed for timeline edits'); } },
};

function fixture() {
  const world = api.createRuntimeWorld('clip-links');
  const document = api.createRuntimeDocument(world);
  let counter = 0;
  const add = (tag: string, props: Record<string, unknown>, parent = document.stage) => {
    const node = document.createElement(tag);
    document.setProperty(node, api.SOURCE_ATTR, `test.tsx:${++counter}`);
    for (const [key, value] of Object.entries(props)) document.setProperty(node, key, value);
    document.insertNode(parent, node);
    node.entity.set(api.Computed, { visibility: 1 });
    return node;
  };
  const scene = add('Scene', { active: true, end: 30 });
  const videoTrack = add('Sequence', {}, scene);
  const audioTrack = add('Sequence', {}, scene);
  const video = add('Video', { start: 2, end: 8, sourceIn: 1, link: 'pair', muted: true }, videoTrack);
  const audio = add('Audio', { start: 2, end: 8, sourceIn: 1, link: 'pair' }, audioTrack);
  const editor = api.getDocumentEditor(world);
  const history = api.getEditHistory(world);
  const selected = () => [...world.query(api.Selected)];
  const seek = (seconds: number) => scene.entity.set(api.Computed, { localTime: Math.round(seconds * 30) });
  const drag = (pixels: number) => ({ pointer: { position: { state: 'pressing', deltaX: pixels } } }) as TimelineSurfaceState;
  return { world, document, add, scene, videoTrack, audioTrack, video, audio, editor, history, selected, seek, drag };
}

test('normal selection follows links within the same scene; Alt-selection and unlink allow independent editing', () => {
  const f = fixture();
  const otherScene = f.add('Scene', { end: 20 });
  const outside = f.add('Video', { link: 'pair', end: 10 }, otherScene);
  f.editor.select(f.video.entity);
  assert.deepEqual(new Set(f.selected()), new Set([f.video.entity, f.audio.entity]));
  assert.equal(outside.entity.has(api.Selected), false);
  assert.equal(f.editor.primarySelection(), f.video.entity);
  assert.deepEqual(api.getMaskSelection(f.world), [f.video.entity]);
  assert.deepEqual(api.getSelection(f.world), [f.video.entity]);
  f.editor.select(f.audio.entity);
  assert.equal(f.editor.primarySelection(), f.audio.entity);
  f.editor.clearSelection();
  assert.equal(f.editor.primarySelection(), null);
  f.editor.select(f.video.entity, { linked: false });
  assert.deepEqual(f.selected(), [f.video.entity]);
  api.trimLinkedClips(f.world, f.video.entity, 'out', 6 * 30);
  assert.equal(f.video.props.end, 6);
  assert.equal(f.audio.props.end, 8);
  f.history.undo();
  api.unlinkSelection(f.world);
  assert.equal(f.video.entity.has(api.ClipLink), false);
  assert.equal(f.audio.entity.has(api.ClipLink), false);
  assert.equal(outside.entity.get(api.ClipLink)?.value, 'pair');
  f.history.undo();
  assert.equal(f.video.entity.get(api.ClipLink)?.value, 'pair');
  assert.equal(f.audio.entity.get(api.ClipLink)?.value, 'pair');
  f.world.destroy();
});

test('arbitrary linked clip types persist through serialization and authored-project remount', () => {
  const f = fixture();
  const title = f.add('Text', { start: 4, end: 6, text: 'Title' }, f.scene);
  f.editor.select([f.video.entity, title.entity]);
  api.linkSelection(f.world);
  const link = f.video.props.link;
  assert.equal(typeof link, 'string');
  assert.notEqual(link, 'pair');
  assert.equal(f.audio.props.link, link);
  assert.equal(title.props.link, link);
  const serialized = api.serializeEntity(title.entity);
  const restored = f.world.spawn();
  api.deserializeEntity(restored, serialized);
  assert.equal(restored.get(api.ClipLink)?.value, link);
  restored.destroy();
  const tree = api.authoredTree(f.world, f.scene.entity)!;
  f.history.undo();
  assert.equal(f.video.props.link, 'pair');
  assert.equal(title.entity.has(api.ClipLink), false);
  const second = api.createRuntimeWorld('reopened-project');
  const document = api.createRuntimeDocument(second);
  document.stage.entity.add(api.Source({ value: 'reopened.tsx:0' }));
  const editor = api.getDocumentEditor(second);
  editor.insertElement(document.stage.entity, () => api.renderAuthored(tree));
  const peers = second.query(api.ClipLink).filter((entity) => entity.get(api.ClipLink)?.value === link);
  assert.equal(peers.length, 3);
  editor.select(peers[0]!);
  assert.equal(second.query(api.Selected).length, 3);
  second.destroy(); f.world.destroy();
});

test('duplicate and each paste keep copies linked to each other without linking back to the originals', () => {
  const f = fixture();
  f.editor.select(f.video.entity);
  const copies = f.editor.duplicate(f.video.entity);
  assert.equal(copies.length, 2);
  const copiedLink = copies[0]!.get(api.ClipLink)?.value;
  assert.ok(copiedLink);
  assert.notEqual(copiedLink, 'pair');
  assert.equal(copies[1]!.get(api.ClipLink)?.value, copiedLink);
  assert.deepEqual(new Set(f.selected()), new Set(copies));
  f.editor.copy(f.video.entity);
  const firstPaste = f.editor.paste(f.scene.entity);
  const secondPaste = f.editor.paste(f.scene.entity);
  assert.equal(firstPaste.length, 2);
  assert.equal(secondPaste.length, 2);
  const firstLink = firstPaste[0]!.get(api.ClipLink)?.value;
  assert.notEqual(firstLink, 'pair');
  assert.notEqual(firstLink, copiedLink);
  assert.equal(firstPaste[1]!.get(api.ClipLink)?.value, firstLink);
  assert.notEqual(secondPaste[0]!.get(api.ClipLink)?.value, firstLink);
  assert.equal(secondPaste[1]!.get(api.ClipLink)?.value, secondPaste[0]!.get(api.ClipLink)?.value);
  f.world.destroy();
});

test('split produces linked heads and separately linked tails with one-step undo', () => {
  const f = fixture();
  f.editor.select(f.video.entity);
  f.seek(5);
  const tails = api.splitAtPlayhead(f.world);
  assert.equal(tails.length, 2);
  assert.equal(f.video.props.end, 5);
  assert.equal(f.audio.props.end, 5);
  assert.equal(f.video.props.link, 'pair');
  const tailLink = tails[0]!.get(api.ClipLink)?.value;
  assert.ok(tailLink);
  assert.notEqual(tailLink, 'pair');
  for (const tail of tails) {
    assert.equal(tail.get(api.ClipLink)?.value, tailLink);
    const props = tail.get(api.Host)!.props;
    assert.equal(props.start, 5);
    assert.equal(props.end, 8);
    assert.equal(props.sourceIn, 4);
  }
  assert.deepEqual(new Set(f.selected()), new Set(tails));
  f.history.undo();
  assert.equal(f.video.props.end, 8);
  assert.equal(f.audio.props.end, 8);
  assert.equal(f.videoTrack.children.length, 1);
  assert.equal(f.audioTrack.children.length, 1);
  f.world.destroy();
});

test('moving a linked selection clamps the whole group at zero and moves offscreen partners', () => {
  const f = fixture();
  f.editor.editProperty(f.audio.entity, 'start', 3);
  f.editor.editProperty(f.audio.entity, 'end', 9);
  f.history.reset();
  f.editor.select(f.video.entity);
  api.beginClipDrag(f.world, f.video.entity);
  api.applyClipDrag(f.world, f.drag(-1000), 1);
  assert.equal(f.video.props.start, false);
  assert.equal(f.audio.props.start, 1);
  assert.equal(f.video.props.end, 6);
  assert.equal(f.audio.props.end, 7);
  assert.equal(f.audio.props.sourceIn, 1);
  api.applyClipDrag(f.world, f.drag(90), 1);
  assert.equal(f.video.props.start, 5);
  assert.equal(f.audio.props.start, 6);
  f.history.undo();
  assert.equal(f.video.props.start, 2);
  assert.equal(f.audio.props.start, 3);
  f.world.destroy();
});

test('linked trim preserves intentional offsets and clamps all partners at timeline zero', () => {
  const f = fixture();
  f.editor.editProperty(f.audio.entity, 'start', 3);
  f.editor.editProperty(f.audio.entity, 'end', 9);
  f.history.reset();
  f.editor.select(f.video.entity);
  api.trimLinkedClips(f.world, f.video.entity, 'in', 4 * 30);
  assert.equal(f.video.props.start, 4);
  assert.equal(f.audio.props.start, 5);
  assert.equal(f.video.props.sourceIn, 3);
  assert.equal(f.audio.props.sourceIn, 3);
  assert.equal(f.video.props.end, 8);
  assert.equal(f.audio.props.end, 9);
  f.history.undo();
  api.trimLinkedClips(f.world, f.video.entity, 'in', -1000);
  assert.equal(f.video.props.start, false);
  assert.equal(f.audio.props.start, 1);
  f.world.destroy();
});

test('linked trim stops at the shortest available media handle', () => {
  const f = fixture();
  const short = { ...footage, id: 'short', path: 'short.mov', duration: 5 };
  const assets = [footage, short];
  f.world.set(api.Library, { get: (key: string) => assets.find((asset) => asset.id === key || asset.path === key) } as import('@diffusionstudio/assets').AssetLibrary);
  f.editor.editProperty(f.video.entity, 'src', footage.path);
  f.editor.editProperty(f.audio.entity, 'src', short.path);
  f.editor.editProperty(f.audio.entity, 'start', 3);
  f.editor.editProperty(f.audio.entity, 'end', 6);
  f.history.reset();
  f.editor.select(f.video.entity);
  api.trimLinkedClips(f.world, f.video.entity, 'out', 20 * 30);
  assert.equal(f.video.props.end, 9);
  assert.equal(f.audio.props.end, 7);
  f.history.undo();
  api.trimLinkedClips(f.world, f.video.entity, 'in', -1000);
  assert.equal(f.video.props.start, 1);
  assert.equal(f.audio.props.start, 2);
  assert.equal(f.video.props.sourceIn, false);
  assert.equal(f.audio.props.sourceIn, false);
  f.world.destroy();
});

test('moving a group carries linked child partners once without jumping by the child offset', () => {
  const f = fixture();
  const group = f.add('Group', { start: 3 }, f.scene);
  const clip = f.add('Video', { start: 2, end: 5, link: 'nested' }, group);
  const audio = f.add('Audio', { start: 6, end: 9, link: 'nested' }, f.scene);
  assert.equal(api.isLinkedSelection(f.world, [group.entity, audio.entity]), true);
  assert.equal(api.isLinkedSelection(f.world, [audio.entity, group.entity]), true);
  f.editor.select(group.entity);
  assert.deepEqual(new Set(f.selected()), new Set([group.entity, audio.entity]));
  api.beginClipDrag(f.world, group.entity);
  api.applyClipDrag(f.world, f.drag(60), 1);
  assert.equal(group.props.start, 5);
  assert.equal(clip.props.start, 2);
  assert.equal(clip.entity.get(api.Computed)?.start, 7 * 30);
  assert.equal(audio.props.start, 8);
  f.world.destroy();
});

test('overwrite trims linked video and audio together and keeps both remaining tails linked', () => {
  const f = fixture();
  const incoming = f.add('Video', { start: 4, end: 6 }, f.videoTrack);
  api.resolveSequentialOverlaps(f.world, [incoming.entity]);
  assert.equal(f.video.props.end, 4);
  assert.equal(f.audio.props.end, 4);
  const videoTail = f.videoTrack.children.find((node) => node.props.start === 6)!;
  const audioTail = f.audioTrack.children.find((node) => node.props.start === 6)!;
  assert.ok(videoTail); assert.ok(audioTail);
  assert.equal(videoTail.props.end, 8);
  assert.equal(audioTail.props.end, 8);
  assert.equal(videoTail.props.link, audioTail.props.link);
  assert.notEqual(videoTail.props.link, 'pair');
  f.history.undo();
  assert.equal(f.video.props.end, 8);
  assert.equal(f.audio.props.end, 8);
  f.world.destroy();
});

test('Separate audio preserves legacy video fill trim, speed, gain automation and one-step undo', () => {
  const f = fixture();
  f.world.set(api.Library, { get: (key: string) => key === footage.id || key === footage.path ? footage : undefined } as import('@diffusionstudio/assets').AssetLibrary);
  const clip = f.add('Rect', { start: 4, end: 7, sourceIn: 2, playbackRate: 2, volume: -6 }, f.videoTrack);
  f.add('VideoPaint', { src: footage.path }, clip);
  const volume = f.add('KeyframeTrack', { property: 'volume' }, clip);
  f.add('Keyframe', { time: 2, value: -6 }, volume);
  assert.equal(api.canSeparateAudio(f.world, clip.entity), true);
  const audio = api.separateAudio(f.world, clip.entity);
  assert.ok(audio);
  const node = audio.get(api.Host)!;
  assert.equal(node.props.src, footage.path);
  assert.equal(node.props.start, 4);
  assert.equal(node.props.end, 7);
  assert.equal(node.props.sourceIn, 2);
  assert.equal(node.props.playbackRate, 2);
  assert.equal(node.props.volume, -6);
  assert.equal(node.children[0]?.props.property, 'volume');
  assert.equal(clip.entity.has(api.Muted), true);
  assert.equal(clip.props.link, node.props.link);
  assert.equal(api.canSeparateAudio(f.world, clip.entity), false, 'an existing linked audio row is not duplicated');
  f.history.undo();
  assert.equal(audio.isAlive(), false);
  assert.equal(clip.entity.has(api.Muted), false);
  assert.equal(clip.entity.has(api.ClipLink), false);
  assert.equal(clip.props.sourceIn, 2);
  f.world.destroy();
});

test('delete and ripple delete act on linked clips and preserve later linked offsets', () => {
  const f = fixture();
  const laterVideo = f.add('Video', { start: 12, end: 18, link: 'later' }, f.videoTrack);
  const laterAudio = f.add('Audio', { start: 13, end: 19, link: 'later' }, f.audioTrack);
  const syncTrack = f.add('Sequence', {}, f.scene);
  const music = f.add('Audio', { start: 12, end: 20 }, syncTrack);
  api.toggleSyncTrack(f.world, syncTrack.entity);
  f.editor.select(f.video.entity);
  api.deleteSelection(f.world);
  assert.equal(f.video.entity.isAlive(), false);
  assert.equal(f.audio.entity.isAlive(), false);
  assert.equal(laterVideo.props.start, 12);
  f.history.undo();
  assert.equal(f.selected().length, 2);
  api.rippleDeleteSelection(f.world);
  assert.equal(laterVideo.props.start, 6);
  assert.equal(laterAudio.props.start, 7);
  assert.equal(music.props.start, 6);
  f.history.undo();
  assert.equal(laterVideo.props.start, 12);
  assert.equal(laterAudio.props.start, 13);
  f.editor.copy(f.selected());
  api.pasteSelection(f.world);
  assert.equal(f.selected().length, 2, 'paste uses the restored selection after undo replaces the original primary entity');
  assert.notEqual(f.selected()[0]?.get(api.ClipLink)?.value, 'pair');
  f.world.destroy();
});

test('video imports add separate linked audio below the video track and keep embedded audio muted', () => {
  const f = fixture();
  const video = api.insertAsset(f.world, footage, { parent: f.videoTrack.entity, start: 11 });
  assert.ok(video);
  assert.equal(video.get(api.Host)?.tag, 'video');
  assert.equal(video.has(api.Muted), true);
  const link = video.get(api.ClipLink)?.value;
  const [audio] = f.world.query(api.Audio, api.ClipLink).filter((entity) => entity.get(api.ClipLink)?.value === link);
  assert.ok(audio);
  assert.equal(audio.get(api.Host)?.parent, f.scene);
  assert.equal(audio.get(api.Host)?.props.src, footage.path);
  assert.equal(audio.get(api.Host)?.props.start, 11);
  assert.deepEqual(new Set(f.selected()), new Set([video, audio]));
  const source = video.get(api.Source)?.value;
  f.history.undo();
  assert.equal(f.world.query(api.Source).some((entity) => entity.get(api.Source)?.value === source), false);
  assert.equal(audio.isAlive(), false);
  const silent = api.insertAsset(f.world, { ...footage, channels: undefined });
  assert.ok(silent);
  assert.equal(silent.has(api.ClipLink), false);
  assert.equal(silent.has(api.Muted), false);
  f.world.destroy();
});

test('a locked track protects linked partners from delete, split, trim and move; Alt can edit the unlocked partner', () => {
  const f = fixture();
  f.editor.editProperty(f.audioTrack.entity, 'locked', true);
  f.history.reset();
  f.editor.select(f.video.entity);
  f.seek(5);
  assert.deepEqual(api.splitAtPlayhead(f.world), []);
  api.trimLinkedClips(f.world, f.video.entity, 'out', 6 * 30);
  api.beginClipDrag(f.world, f.video.entity);
  api.applyClipDrag(f.world, f.drag(30), 1);
  api.deleteSelection(f.world);
  assert.equal(f.video.entity.isAlive(), true);
  assert.equal(f.video.props.start, 2);
  assert.equal(f.video.props.end, 8);
  assert.equal(f.audio.props.start, 2);
  f.editor.select(f.video.entity, { linked: false });
  api.trimLinkedClips(f.world, f.video.entity, 'out', 6 * 30);
  assert.equal(f.video.props.end, 6);
  assert.equal(f.audio.props.end, 8);
  f.world.destroy();
});

test('ripple trims shift linked later clips and sync tracks; protected later material blocks the edit', () => {
  const f = fixture();
  const later = f.add('Video', { start: 8, end: 12, link: 'later' }, f.videoTrack);
  const sound = f.add('Audio', { start: 9, end: 13, link: 'later' }, f.audioTrack);
  const musicTrack = f.add('Sequence', {}, f.scene);
  const music = f.add('Audio', { start: 10, end: 14 }, musicTrack);
  api.toggleSyncTrack(f.world, musicTrack.entity);
  assert.equal(api.rippleTrim(f.world, f.video.entity, 'out', 30), 30);
  assert.equal(f.video.props.end, 9); assert.equal(f.audio.props.end, 9);
  assert.equal(later.props.start, 9); assert.equal(sound.props.start, 10); assert.equal(music.props.start, 11);
  f.history.undo();
  assert.equal(api.rippleTrim(f.world, f.video.entity, 'in', 30), 30);
  assert.equal(f.video.props.start, 2); assert.equal(f.video.props.end, 7); assert.equal(f.video.props.sourceIn, 2);
  assert.equal(later.props.start, 7); assert.equal(sound.props.start, 8); assert.equal(music.props.start, 9);
  f.history.undo();
  f.editor.editProperty(later.entity, 'locked', true);
  assert.equal(api.rippleTrim(f.world, f.video.entity, 'out', 30), 0);
  assert.equal(f.video.props.end, 8);
  f.world.destroy();
});

test('roll moves a shared cut; slide preserves the middle clip source and total sequence span', () => {
  const f = fixture();
  const left = f.add('Video', { end: 2 }, f.videoTrack);
  const leftAudio = f.add('Audio', { end: 2 }, f.audioTrack);
  const right = f.add('Video', { start: 8, end: 12, sourceIn: 2 }, f.videoTrack);
  const rightAudio = f.add('Audio', { start: 8, end: 12, sourceIn: 2 }, f.audioTrack);
  assert.equal(api.rollOrSlide(f.world, f.video.entity, 'roll', 'out', 30), 30);
  assert.equal(f.video.props.end, 9); assert.equal(f.audio.props.end, 9);
  assert.equal(right.props.start, 9); assert.equal(rightAudio.props.start, 9);
  assert.equal(right.props.sourceIn, 3); assert.equal(right.props.end, 12);
  f.history.undo();
  assert.equal(api.rollOrSlide(f.world, f.video.entity, 'slide', 'out', 30), 30);
  assert.equal(f.video.props.start, 3); assert.equal(f.video.props.end, 9); assert.equal(f.video.props.sourceIn, 1);
  assert.equal(left.props.end, 3); assert.equal(leftAudio.props.end, 3);
  assert.equal(right.props.start, 9); assert.equal(rightAudio.props.start, 9); assert.equal(right.props.end, 12);
  f.history.undo();
  f.editor.editProperty(rightAudio.entity, 'locked', true);
  assert.equal(api.rollOrSlide(f.world, f.video.entity, 'slide', 'out', 30), 0);
  assert.equal(f.video.props.start, 2);
  f.world.destroy();
});

test('slip preserves duration and bounds while moving linked source windows within media handles', () => {
  const f = fixture();
  f.world.set(api.Library, { get: () => footage } as unknown as import('@diffusionstudio/assets').AssetLibrary);
  for (const clip of [f.video, f.audio]) {
    f.editor.editProperty(clip.entity, 'src', footage.path);
    f.editor.editProperty(clip.entity, 'end', 5);
    f.editor.editProperty(clip.entity, 'playbackRate', 2);
    f.editor.editProperty(clip.entity, 'sourceOut', 7);
  }
  f.history.reset();
  assert.equal(api.slipClips(f.world, f.video.entity, 30), 30);
  for (const clip of [f.video, f.audio]) {
    assert.equal(clip.props.start, 2); assert.equal(clip.props.end, 5);
    assert.equal(clip.props.sourceIn, 3); assert.equal(clip.props.sourceOut, 9);
  }
  assert.equal(api.slipClips(f.world, f.video.entity, 300), 15);
  assert.equal(f.video.props.sourceOut, 10);
  assert.equal(f.video.props.end, 5);
  f.history.undo();
  assert.equal(f.video.props.sourceIn, 1);
  f.world.destroy();
});

test('targeted insert splits crossing linked clips, shifts their tails and leaves other tracks in place', () => {
  const f = fixture();
  const untouched = f.add('Text', { start: 6, end: 9 }, f.scene);
  api.timelineEditing(f.world).setTarget(f.videoTrack.entity);
  assert.equal(api.getTargetTrack(f.world), f.videoTrack.entity);
  assert.equal(api.insertTimelineGap(f.world, f.scene.entity, 5 * 30, 2 * 30), true);
  assert.equal(f.video.props.end, 5); assert.equal(f.audio.props.end, 5);
  const videoTail = f.videoTrack.children.find((node) => node.props.start === 7)!;
  const audioTail = f.audioTrack.children.find((node) => node.props.start === 7)!;
  assert.ok(videoTail); assert.ok(audioTail);
  assert.equal(videoTail.props.end, 10); assert.equal(audioTail.props.end, 10);
  assert.equal(videoTail.props.sourceIn, 4); assert.equal(videoTail.props.link, audioTail.props.link);
  assert.equal(untouched.props.start, 6);
  f.history.undo();
  f.editor.editProperty(f.audioTrack.entity, 'locked', true);
  assert.equal(api.insertTimelineGap(f.world, f.scene.entity, 5 * 30, 60), false);
  assert.equal(f.video.props.end, 8);
  f.world.destroy();
});

test('timeline transport steps frames and cuts, shuttles, and persists named markers and inclusive range marks', () => {
  const f = fixture();
  f.seek(4);
  api.timelineEditing(f.world).focused = true;
  f.world.add(api.Keys({ pressed: new Set(['arrowright']), held: new Set(['arrowright']) }));
  api.shortcutSystem(f.world);
  assert.equal(f.scene.entity.get(api.Computed)?.localTime, 121);
  api.timelineEditing(f.world).focused = false;
  f.world.set(api.Keys, { pressed: new Set(['j']), held: new Set(['j']) });
  api.shortcutSystem(f.world);
  assert.equal(f.scene.entity.get(api.Playback)?.playing, true, 'shuttle shortcuts remain available outside timeline focus');
  assert.equal(f.scene.entity.get(api.Playback)?.speed, -1);
  f.seek(4);
  api.seekTimelineFrames(f.world, 1);
  assert.equal(f.scene.entity.get(api.Computed)?.localTime, 121);
  api.seekBoundary(f.world, 1, 'cut');
  assert.equal(f.scene.entity.get(api.Computed)?.localTime, 240);
  api.seekBoundary(f.world, -1, 'cut');
  assert.equal(f.scene.entity.get(api.Computed)?.localTime, 60);
  api.addMarker(f.world);
  const marker = f.scene.entity.get(api.Markers)!.value[0]!;
  api.editMarker(f.world, f.scene.entity, marker.id, { name: 'Start here', time: 90 });
  assert.deepEqual(f.scene.props.markers, [{ id: marker.id, name: 'Start here', time: 3 }]);
  api.seekBoundary(f.world, 1, 'marker');
  assert.equal(f.scene.entity.get(api.Computed)?.localTime, 90);
  api.markRange(f.world, 'in');
  f.seek(6);
  api.markRange(f.world, 'out');
  assert.deepEqual(f.scene.entity.get(api.Workarea), { start: 90, end: 181 });
  api.shuttle(f.world, -1); api.shuttle(f.world, -1);
  assert.equal(f.scene.entity.get(api.Playback)?.speed, -2);
  api.shuttle(f.world, 0);
  assert.equal(f.scene.entity.get(api.Playback)?.playing, false);
  assert.equal(f.scene.entity.get(api.Playback)?.speed, 1);
  api.markRange(f.world, 'clear');
  assert.equal(f.scene.entity.has(api.Workarea), false);
  f.world.destroy();
});

test('source Insert and Overwrite preserve marked ranges, linked remnants and one-step undo', () => {
  for (const mode of ['insert', 'overwrite'] as const) {
    const f = fixture();
    f.editor.editProperty(f.scene.entity, 'end', false);
    f.world.set(api.Library, { get: () => footage } as unknown as import('@diffusionstudio/assets').AssetLibrary);
    for (const clip of [f.video, f.audio]) {
      f.editor.editProperty(clip.entity, 'start', 0); f.editor.editProperty(clip.entity, 'end', 10);
      f.editor.editProperty(clip.entity, 'sourceIn', 0);
      f.editor.editProperty(clip.entity, 'src', footage.path);
    }
    f.history.reset(); f.seek(3);
    api.timelineEditing(f.world).setTarget(f.videoTrack.entity);
    api.insertSourceRange(f.world, footage, { in: 2, out: 4 }, mode);
    assert.equal(f.video.props.end, 3); assert.equal(f.audio.props.end, 3);
    const incoming = f.videoTrack.children.find((clip) => clip.props.start === 3)!;
    assert.ok(incoming);
    assert.equal(incoming.props.end, 5); assert.equal(incoming.props.sourceIn, 2); assert.equal(api.getSourceFrameAt(incoming.entity, incoming.entity.get(api.Computed)!.end), 4 * 30);
    const tail = f.videoTrack.children.find((clip) => clip.props.start === 5)!;
    const tailAudio = f.audioTrack.children.find((clip) => clip.props.start === 5)!;
    assert.ok(tail); assert.ok(tailAudio);
    assert.equal(tail.props.end, mode === 'insert' ? 12 : 10);
    assert.equal(tail.props.sourceIn, mode === 'insert' ? 3 : 5);
    assert.equal(tail.props.link, tailAudio.props.link);
    f.history.undo();
    assert.equal(f.video.props.end, 10); assert.equal(f.audio.props.end, 10);
    assert.equal(f.videoTrack.children.length, 1); assert.equal(f.audioTrack.children.length, 1);
    assert.equal(f.videoTrack.entity.get(api.Computed)?.duration, 10 * 30);
    assert.equal(f.audioTrack.entity.get(api.Computed)?.duration, 10 * 30);
    assert.equal(f.scene.entity.get(api.Computed)?.duration, 10 * 30);
    f.world.destroy();
  }
});

test('source edits preflight locked partners and preserve a nested destination track origin', () => {
  const f = fixture();
  f.world.set(api.Library, { get: () => footage } as unknown as import('@diffusionstudio/assets').AssetLibrary);
  api.timelineEditing(f.world).setTarget(f.videoTrack.entity);
  f.editor.editProperty(f.audioTrack.entity, 'locked', true);
  f.history.reset(); f.seek(3);
  for (const mode of ['insert', 'overwrite'] as const) {
    assert.throws(() => api.insertSourceRange(f.world, footage, { in: 2, out: 4 }, mode), /locked/);
    assert.equal(f.video.props.end, 8); assert.equal(f.audio.props.end, 8);
    assert.equal(f.videoTrack.children.length, 1); assert.equal(f.audioTrack.children.length, 1);
  }
  f.editor.editProperty(f.audioTrack.entity, 'locked', false);
  f.editor.editProperty(f.videoTrack.entity, 'locked', true);
  for (const mode of ['insert', 'overwrite'] as const) assert.throws(() => api.insertSourceRange(f.world, footage, { in: 2, out: 4 }, mode), /track is locked/);
  assert.equal(f.audioTrack.children.length, 1, 'a locked explicit target must not fall back to another track');
  f.editor.editProperty(f.videoTrack.entity, 'locked', false);
  f.editor.editProperty(f.videoTrack.entity, 'start', 2);
  f.history.reset(); f.seek(5);
  api.insertSourceRange(f.world, footage, { in: 2, out: 4 }, 'overwrite');
  const inserted = f.videoTrack.children.find((clip) => clip.props.start === 3 && clip.props.sourceIn === 2)!;
  assert.ok(inserted);
  assert.equal(inserted.props.start, 3); assert.equal(inserted.props.end, 5);
  assert.equal(inserted.entity.get(api.Computed)?.start, 5 * 30);
  const linked = [...f.world.query(api.ClipLink)].filter((clip) => clip.get(api.ClipLink)?.value === inserted.props.link);
  assert.equal(linked.length, 2);
  assert.equal(linked.find((clip) => clip.has(api.Audio))?.get(api.Computed)?.start, 5 * 30);
  f.world.destroy();
});

test('locked authored clips reject inspector, paste, duplicate and structural edits while monitoring stays available', () => {
  const f = fixture();
  f.editor.copy(f.video.entity);
  f.editor.editProperty(f.videoTrack.entity, 'locked', true);
  f.history.reset();
  f.editor.editProperty(f.video.entity, 'end', 3);
  f.editor.editProperty(f.video.entity, 'src', 'other.mov');
  assert.equal(f.video.props.end, 8);
  assert.equal(f.video.props.src, undefined);
  assert.deepEqual(f.editor.paste(f.videoTrack.entity), []);
  assert.deepEqual(f.editor.duplicate(f.video.entity), []);
  assert.deepEqual(f.editor.remove(f.video.entity), []);
  assert.equal(f.editor.reparent(f.video.entity, f.scene.entity), false);
  assert.equal(f.editor.wrap(f.video.entity, () => api.renderAuthored({ tag: 'group', props: {}, children: [] })), null);
  assert.equal(f.video.entity.isAlive(), true);
  assert.equal(f.history.canUndo(), false, 'blocked edits must not create an undo step');
  f.editor.editProperty(f.videoTrack.entity, 'muted', true);
  assert.equal(f.videoTrack.entity.has(api.Muted), true);
  f.seek(3);
  api.addMarker(f.world);
  api.markRange(f.world, 'in');
  assert.equal(f.scene.entity.get(api.Markers)?.value[0]?.time, 90, 'a locked track does not lock scene markers');
  assert.equal(f.scene.entity.get(api.Workarea)?.start, 90);
  f.world.destroy();
});

test('undo and redo restore protected properties, moves and pasted locked clips', () => {
  const f = fixture();
  const destination = f.add('Sequence', {}, f.scene);
  f.editor.editProperty(f.video.entity, 'locked', true);
  f.history.reset();
  f.history.beginGesture();
  f.editor.editProperty(f.video.entity, 'locked', false);
  f.editor.editProperty(f.video.entity, 'end', 6);
  f.editor.reparent(f.video.entity, destination.entity);
  f.editor.editProperty(f.video.entity, 'locked', true);
  f.history.endGesture();
  f.history.undo();
  assert.equal(f.video.props.end, 8);
  assert.equal(f.video.parent, f.videoTrack);
  assert.equal(f.video.entity.has(api.Locked), true);
  f.history.redo();
  assert.equal(f.video.props.end, 6);
  assert.equal(f.video.parent, destination);
  assert.equal(f.video.entity.has(api.Locked), true);
  f.history.reset();
  f.editor.select(f.video.entity, { linked: false });
  f.editor.copy(f.video.entity);
  const [copy] = f.editor.paste(f.scene.entity);
  assert.ok(copy);
  assert.equal(copy.has(api.Locked), true);
  f.history.undo();
  assert.equal(copy.isAlive(), false);
  f.history.redo();
  assert.equal(f.scene.children.filter((node) => node.props.locked === true && node.props.end === 6).length, 1);
  f.world.destroy();
});

test('link commands preserve protected partners and ungroup cannot partially dismantle protected contents', () => {
  const f = fixture();
  const title = f.add('Text', { end: 8 }, f.scene);
  f.editor.editProperty(f.audioTrack.entity, 'locked', true);
  f.editor.select([f.video.entity, title.entity]);
  api.linkSelection(f.world);
  assert.equal(f.video.props.link, 'pair'); assert.equal(f.audio.props.link, 'pair');
  assert.equal(title.props.link, undefined);
  f.editor.select(f.video.entity, { linked: false });
  api.unlinkSelection(f.world);
  assert.equal(f.video.props.link, 'pair'); assert.equal(f.audio.props.link, 'pair');
  const group = f.add('Group', { start: 1 }, f.scene);
  const first = f.add('Text', { end: 3 }, group);
  const protectedChild = f.add('Text', { end: 3, locked: true }, group);
  f.editor.select(group.entity);
  api.ungroupSelection(f.world);
  assert.equal(group.entity.isAlive(), true);
  assert.equal(first.parent, group); assert.equal(protectedChild.parent, group);
  f.world.destroy();
});

test('row moves preserve scene time across track offsets and reject locked destination overlaps', () => {
  const f = fixture();
  const track = f.add('Sequence', { start: 1 }, f.scene);
  assert.equal(api.reparentTimelineClip(f.world, f.video.entity, track.entity), true);
  assert.equal(f.video.props.start, 1); assert.equal(f.video.props.end, 7);
  assert.equal(f.video.entity.get(api.Computed)?.start, 60);
  assert.equal(f.audio.entity.get(api.Computed)?.start, 60);
  f.history.undo();
  assert.equal(f.video.parent, f.videoTrack);
  assert.equal(f.video.props.start, 2); assert.equal(f.video.props.end, 8);
  f.add('Text', { start: 1, end: 7, locked: true }, track);
  assert.equal(api.reparentTimelineClip(f.world, f.video.entity, track.entity), false);
  assert.equal(f.video.parent, f.videoTrack);
  assert.equal(f.video.props.start, 2);
  f.world.destroy();
});
