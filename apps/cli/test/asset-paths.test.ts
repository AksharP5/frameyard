import assert from 'node:assert/strict';
import { test } from 'node:test';
import { basename } from '../../../packages/assets/src/types.ts';

test('asset names handle trailing separators and Windows source paths', () => {
	for (const path of ['folder/clip.mp4', 'folder/clip.mp4/', 'C:\\footage\\clip.mp4', 'C:\\footage\\clip.mp4\\']) {
		assert.equal(basename(path), 'clip.mp4');
	}
	assert.equal(basename('clip.mp4'), 'clip.mp4');
	assert.equal(basename('/'), '');
});
