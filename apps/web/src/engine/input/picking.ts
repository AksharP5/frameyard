import { Geometry, Group, AdjustmentLayer, Selected, getEntityTree, isPointerInEntity, pointInQuad } from '@diffusionstudio/runtime';
import type { CanvasPointerEvent, HitRegion } from '@diffusionstudio/runtime';
import type { Entity, World } from 'koota';

/** Alt-click reaches overlapping children without changing ordinary paint-order picking. */
export function pickCanvasRegion(world: World, regions: readonly HitRegion[], event: CanvasPointerEvent, cycle: boolean): HitRegion | null {
	const candidates: HitRegion[] = [];
	const seen = new Set<Entity>();
	const point = { x: event.clientX, y: event.clientY };
	for (let index = regions.length - 1; index >= 0; index--) {
		const region = regions[index]!;
		if (region.target.kind === 'hud') {
			if (!pointInQuad(point.x, point.y, region.target.quad)) continue;
			if (!cycle || (!candidates.length && region.target.id !== 'selection' && region.target.id !== 'canvas')) return region;
			continue;
		}
		const entity = region.target.id;
		if (!entity.isAlive() || !isPointerInEntity(world, entity, point)) continue;
		const targets = cycle ? [entity, ...getEntityTree(world, entity).filter((child) => child !== entity).reverse()] : [entity];
		for (const target of targets) {
			if (seen.has(target) || !(target.has(Geometry) || target.has(Group) || target.has(AdjustmentLayer)) || !isPointerInEntity(world, target, point)) continue;
			if (!cycle) return region;
			seen.add(target);
			candidates.push({ target: { kind: 'entity', id: target } });
		}
	}
	if (!candidates.length) return null;
	const selected = candidates.findIndex((region) => region.target.kind === 'entity' && region.target.id.has(Selected));
	return candidates[(selected + 1) % candidates.length]!;
}
