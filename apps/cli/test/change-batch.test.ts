import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { batchProjectChanges } from '../../web/src/projects/change-batch.ts';

test('source edits survive media and cache events in the same debounce batch', async () => {
  const batches: string[][] = [];
  const changes = batchProjectChanges((paths) => batches.push(paths), 10);
  changes.add('index.tsx');
  changes.add('assets/title.mp4');
  changes.add('index.tsx');
  changes.add('cache/thumbnails/title.webp');
  await setTimeout(40);
  assert.deepEqual(batches, [['index.tsx', 'assets/title.mp4', 'cache/thumbnails/title.webp']]);
  changes.add('package.json');
  changes.dispose();
  await setTimeout(30);
  assert.equal(batches.length, 1);
});

test('continuous render writes cannot postpone source refresh indefinitely', async () => {
  const batches: string[][] = [];
  const changes = batchProjectChanges((paths) => batches.push(paths), 40, 80);
  changes.add('index.tsx');
  const rendering = setInterval(() => changes.add('cache/render-frame.png'), 10);
  try {
    await setTimeout(130);
    assert.ok(batches.some((paths) => paths.includes('index.tsx')), 'source reload happens while rendering is still producing files');
  } finally {
    clearInterval(rendering);
    changes.dispose();
  }
});
