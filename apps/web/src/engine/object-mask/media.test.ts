import { expect, it } from 'vitest';
import { sourceSeconds } from './media';

it('segments the picture covering the project timestamp when footage has a different frame rate', () => {
	const videoFps = 24;
	const projectFps = 30;
	const pictureAt = (timestamp: number) => Math.floor(timestamp * videoFps);

	// Project frame 1 is still covered by the first video picture, not the next one at 1/24s.
	expect(pictureAt(sourceSeconds(1, projectFps, 0))).toBe(0);
	expect(pictureAt(sourceSeconds(2, projectFps, 0))).toBe(1);
	expect(sourceSeconds(1, projectFps, 0)).toBe(1 / projectFps);
});

it('preserves a positive source offset and clamps edit-list head trims like the renderer', () => {
	expect(sourceSeconds(30, 30, 2)).toBe(3);
	expect(sourceSeconds(30, 30, -1 / 24)).toBe(1);
	expect(sourceSeconds(-1, 30, 2)).toBe(2);
});
