import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import * as runtime from '@diffusionstudio/runtime';
import { createRuntimeDocument } from '@diffusionstudio/reconciler';

beforeAll(() => {
	vi.stubGlobal('HTMLCanvasElement', class {});
	vi.stubGlobal('HTMLElement', class {});
	vi.stubGlobal('HTMLImageElement', class {});
	vi.stubGlobal('HTMLVideoElement', class {});
	vi.stubGlobal('Element', class {});
});
afterAll(() => vi.unstubAllGlobals());

function fixture() {
	const world = runtime.createRuntimeWorld('upstream-shapes');
	const document = createRuntimeDocument(world);
	const add = (tag: string, props: Record<string, unknown>, parent = document.stage) => {
		const node = document.createElement(tag);
		for (const [name, value] of Object.entries(props)) document.setProperty(node, name, value);
		document.insertNode(parent, node);
		return node;
	};
	const scene = add('Scene', { width: 400, height: 300, end: 2 });
	return { world, document, add, scene, dispose: () => { document.dispose(); world.destroy(); } };
}

describe('upstream shape authoring with Frameyard compatibility', () => {
	it('applies path trim in source coordinates and accepts string and tuple view boxes', () => {
		const f = fixture();
		try {
			const path = f.add('Path', { d: 'M0 0 L100 0', width: 200, height: 100, viewBox: [0, 0, 100, 50], trimStart: 0.25, trimEnd: 0.75 }, f.scene);
			expect(runtime.pathBounds(runtime.getDrawnPath(f.world, path.entity)!)).toEqual({ minX: 25, minY: 0, maxX: 75, maxY: 0 });
			expect(runtime.getPathTransform(f.world, path.entity)).toEqual({ sx: 2, sy: 2, tx: -0, ty: -0 });
			f.document.setProperty(path, 'viewBox', '10 20 100 50');
			expect(path.entity.get(runtime.ViewBox)).toEqual({ x: 10, y: 20, width: 100, height: 50 });
			f.document.setProperty(path, 'viewBox', false);
			expect(path.entity.has(runtime.ViewBox)).toBe(false);
			expect(path.entity.get(runtime.PathData)?.viewBox).toBeUndefined();
		} finally { f.dispose(); }
	});

	it('keys new gradient positions and scalar dash patterns without dropping legacy arrays', () => {
		const f = fixture();
		try {
			const rect = f.add('Rect', { width: 200, height: 100 }, f.scene);
			const paint = f.add('LinearGradientPaint', { x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.9 }, rect);
			const track = f.add('KeyframeTrack', { property: 'x1' }, paint);
			f.add('Keyframe', { time: 0, value: 0.1 }, track);
			f.add('Keyframe', { time: 1, value: 0.5 }, track);
			rect.entity.set(runtime.Computed, { localTime: 15 });
			runtime.motionSystem(f.world);
			expect(runtime.getLinearGradientLine(f.world, paint.entity, 200, 100).start.x).toBeCloseTo(60);
			const stroke = f.add('Stroke', { dash: 8, dashGap: 4, dashOffset: 2 }, rect);
			expect(stroke.entity.get(runtime.StrokeDash)).toMatchObject({ dash: 8, gap: 4, offset: 2 });
			f.document.setProperty(stroke, 'dash', [2, 3, 4, 5]);
			expect(stroke.entity.get(runtime.StrokeDash)?.value).toEqual([2, 3, 4, 5]);
			f.document.setProperty(stroke, 'dashOffset', 6);
			expect(stroke.entity.get(runtime.StrokeDash)?.value).toEqual([2, 3, 4, 5]);
			expect(stroke.entity.get(runtime.StrokeDash)?.offset).toBe(6);
		} finally { f.dispose(); }
	});

	it('keeps explicit group pivots fixed as children move and clamps polygon counts', () => {
		const f = fixture();
		try {
			const group = f.add('Group', { x: 30, y: 40, pivotX: 10, pivotY: 20, rotation: 45 }, f.scene);
			const polygon = f.add('Polygon', { x: 0, y: 0, width: 80, height: 60, pointCount: 2 }, group);
			runtime.transformSystem(f.world);
			const before = runtime.entityLocalMat(f.world, group.entity);
			expect(polygon.entity.get(runtime.PointCount)?.value).toBe(3);
			f.document.setProperty(polygon, 'x', 120);
			runtime.transformSystem(f.world);
			expect(runtime.entityLocalMat(f.world, group.entity)).toEqual(before);
			expect(runtime.entityPivot(f.world, group.entity)).toEqual({ x: 10, y: 20 });
		} finally { f.dispose(); }
	});
	it('seeks dense path tracks without walking preceding keyframes', () => {
		const world = runtime.createRuntimeWorld('dense-path-track');
		try {
			const node = world.spawn(runtime.Geometry, runtime.Computed({ visibility: 1, localTime: 8001 }), runtime.Cache);
			const keyframes = Array.from({ length: 4096 }, (_, i) => world.spawn(runtime.Keyframe({ time: i * 2, path: runtime.parsePath(`M${i} 0 L${i + 10} 0`).geometry })));
			let reads = 0;
			const keys = new Proxy(keyframes, {
				get(target, property, receiver) {
					if (typeof property === 'string' && /^\d+$/.test(property)) reads++;
					return Reflect.get(target, property, receiver);
				},
			});
			const track = world.spawn(runtime.KeyframeTrack({ property: 'path', target: node }), runtime.Cache({ keyframes: keys }));
			node.set(runtime.Cache, { keyframeTracks: [track] });
			runtime.motionSystem(world);
			expect(runtime.pathBounds(runtime.getPathGeometry(world, node)!)?.minX).toBeCloseTo(4000.5);
			expect(reads).toBeLessThan(40);
			node.set(runtime.Computed, { localTime: 1 });
			runtime.motionSystem(world);
			expect(runtime.pathBounds(runtime.getPathGeometry(world, node)!)?.minX).toBeCloseTo(0.5);
		} finally { world.destroy(); }
	});

	it('projects trimmed paths and polygon masks with their visible silhouettes', () => {
		class RecordedPath {
			commands: [string, ...number[]][] = [];
			moveTo(x: number, y: number) { this.commands.push(['M', x, y]); }
			lineTo(x: number, y: number) { this.commands.push(['L', x, y]); }
			closePath() { this.commands.push(['Z']); }
		}
		vi.stubGlobal('Path2D', RecordedPath);
		const f = fixture();
		try {
			const path = f.add('Path', { d: 'M0 0 L100 0', width: 100, height: 100, trimStart: 0.25, trimEnd: 0.75 }, f.scene);
			const projected = runtime.projectedGeometryPath(path.entity, (x, y) => ({ x: x * 2, y: y * 2 })) as unknown as RecordedPath;
			expect(projected.commands).toEqual([['M', 50, 0], ['L', 150, 0]]);
			const polygon = f.add('Polygon', { width: 80, height: 60, pointCount: 3 }, f.scene);
			const projectedPolygon = runtime.projectedGeometryPath(polygon.entity, (x, y) => ({ x, y })) as unknown as RecordedPath;
			expect(projectedPolygon).not.toBeNull();
			expect(projectedPolygon.commands).toHaveLength(4);
			expect(projectedPolygon.commands.at(-1)).toEqual(['Z']);
		} finally { f.dispose(); }
	});

});
