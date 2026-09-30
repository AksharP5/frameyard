import { expect, it, vi } from 'vitest';
import { createWorld } from 'koota';
import { FrameRate } from '@diffusionstudio/runtime';
import { promptObjectMask } from './tracking';

import type { ObjectMaskModelLoad, ObjectTrack } from './store';

const state = vi.hoisted(() => ({
	track: null as ObjectTrack | null,
	load: null as ObjectMaskModelLoad | null,
	asset: { id: 'first', type: 'VIDEO', width: 1920, height: 1080, frameRate: 24 },
	video: { getFirstTimestamp: async () => 0 },
	holds: [] as { track: unknown; timestamp: number }[],
	model: {
		holding: false,
		model: { repo: 'test', imageSize: 512 },
		reset: vi.fn(),
		seedHeld: async () => ({ logits: new Float32Array([1]), size: 1, score: 1, iou: 1 }),
	},
}));

vi.mock('@diffusionstudio/runtime', async (original) => ({
	...await original<typeof import('@diffusionstudio/runtime')>(),
	getVideoTrack: async () => state.video,
}));
vi.mock('@diffusionstudio/sam2', () => ({
	loadSam2: async () => state.model,
	holdFrame: async (model: typeof state.model, request: { track: unknown; timestamp: number }) => {
		state.holds.push(request);
		model.holding = true;
	},
}));
vi.mock('./media', async (original) => ({
	...await original<typeof import('./media')>(),
	currentSourceFrame: () => 1,
	getVideoRect: () => ({ asset: state.asset }),
}));
vi.mock('./store', () => ({
	getObjectTrack: () => state.track,
	setObjectTrack: (track: ObjectTrack) => {
		state.track?.controller.abort();
		state.track = track;
	},
	setObjectHover: vi.fn(),
	objectMaskModel: () => 'tiny',
	objectMaskModelLoad: () => state.load,
	setObjectMaskModelLoad: (load: ObjectMaskModelLoad) => { state.load = load; },
}));
vi.mock('./commit', () => ({ commitObjectMask: vi.fn(), encodeObjectMask: vi.fn() }));
vi.mock('../editor', () => ({ getDocumentEditor: vi.fn() }));
vi.mock('somoto', () => ({ toast: { error: vi.fn() } }));

it('reuses the encoded picture only while its video and source timestamp stay the same', async () => {
	const world = createWorld();
	world.add(FrameRate({ value: 30 }));
	const clip = world.spawn();
	const point = { x: 0.5, y: 0.5, label: 1 } as const;

	try {
		promptObjectMask(world, clip, point);
		await vi.waitFor(() => expect(state.track?.status).toBe('seeded'));
		expect(state.holds).toHaveLength(1);
		expect(state.holds[0]?.timestamp).toBe(1 / 30);

		promptObjectMask(world, clip, point);
		await vi.waitFor(() => expect(state.track?.status).toBe('seeded'));
		expect(state.holds).toHaveLength(1);

		state.asset.id = 'second';
		state.video = { getFirstTimestamp: async () => 0 };
		promptObjectMask(world, clip, point);
		await vi.waitFor(() => expect(state.track?.status).toBe('seeded'));
		expect(state.holds).toHaveLength(2);
		expect(state.holds[1]?.track).toBe(state.video);

		world.set(FrameRate, { value: 60 });
		promptObjectMask(world, clip, point);
		await vi.waitFor(() => expect(state.track?.status).toBe('seeded'));
		expect(state.holds).toHaveLength(3);
		expect(state.holds[2]?.timestamp).toBe(1 / 60);
	} finally {
		state.track?.controller.abort();
		world.destroy();
	}
});
