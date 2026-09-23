import {
  Computed, Group, KeepAspectRatio, UniformScale, entityLocalMat, entityWorldMat,
  findKeyframeTrackEntity, getParentEntity, getPropertyPaths, getSelection,
  invert2D, multiply2D, projectParentPlane, spatialNode, transformPoint,
} from '@diffusionstudio/runtime';
import { ANIMATABLE_PROPERTIES, type AnimatableProperty } from '@diffusionstudio/jsx';
import type { Entity, World } from 'koota';
import type { Point } from '@diffusionstudio/runtime';
import { getDocumentEditor } from '../editor';
import { syncKeyframe } from '../keyframes';
import { Keys, Pointer } from '../traits';
import { getSelectionMaskSnapshot } from './snapping';

function snapshotNode(world: World, entity: Entity) {
  const computed = { ...entity.get(Computed)! };
  const local = entityLocalMat(world, entity);
  const plane = entityWorldMat(world, entity);
  const pointer = world.get(Pointer)!;
  const grabbed = transformPoint(invert2D(plane), pointer.dragStartX, pointer.dragStartY);
  const pivot = { x: computed.anchorX * computed.width, y: computed.anchorY * computed.height };
  const rx = computed.rotationX * Math.PI / 180, ry = computed.rotationY * Math.PI / 180;
  const sinX = Math.sin(rx), cosX = Math.cos(rx), sinY = Math.sin(ry), cosY = Math.cos(ry);
  // The node's local linear transform, including tilt, roll, skew, scale and flips.
  const linear = (x: number, y: number) => {
    const a = local.a * x + local.c * y, b = local.b * x + local.d * y;
    return { x: cosY * a + sinY * sinX * b, y: cosX * b, z: -sinY * a + cosY * sinX * b };
  };
  const projected = spatialNode(world, entity);
  const parentPlane = projected ? projectParentPlane(world, entity, computed.positionZ) : entityWorldMat(world, getParentEntity(entity));
  const grabDepth = computed.positionZ + linear(grabbed.x - pivot.x, grabbed.y - pivot.y).z;
  const dragPlane = projected ? projectParentPlane(world, entity, grabDepth) : parentPlane;
  return {
    entity, computed, local, plane, pivot, linear, parentPlane, dragPlane,
    rotationPlane: multiply2D(plane, invert2D(local)),
    anchor: transformPoint(plane, pivot.x, pivot.y),
    group: entity.has(Group),
    uniform: entity.has(UniformScale) || findKeyframeTrackEntity(world, entity, 'scale') !== null,
    locked: entity.has(KeepAspectRatio),
    spatial: projected !== undefined,
  };
}

type Snapshot = ReturnType<typeof snapshotNode>;
let snapshots: Snapshot[] = [];

export function snapshotSpatialGesture(world: World): void {
  snapshots = getSelection(world).map(entity => snapshotNode(world, entity));
  if (!snapshots.some(snapshot => snapshot.spatial)) snapshots = [];
}

function write(world: World, snapshot: Snapshot, values: readonly (readonly [AnimatableProperty, number])[]): void {
  if (values.some(([, value]) => !Number.isFinite(value))) return;
  const editor = getDocumentEditor(world);
  const properties = getPropertyPaths(world);
  const changed = values.filter(([name, value]) => value !== properties[ANIMATABLE_PROPERTIES[name]].computed[snapshot.entity.id()]);
  for (const [name, value] of changed) syncKeyframe(world, editor, snapshot.entity, name, value);
  for (const [name, value] of values) editor.editProperty(snapshot.entity, name, value);
}

/** Drag intersects the pointer ray with the grabbed point's parent-depth plane. */
export function moveSpatialGesture(world: World): boolean {
  if (!snapshots.length) return false;
  const pointer = world.get(Pointer)!;
  for (const snapshot of snapshots) {
    const inverse = invert2D(snapshot.dragPlane);
    const before = transformPoint(inverse, pointer.dragStartX, pointer.dragStartY);
    const after = transformPoint(inverse, pointer.clientX, pointer.clientY);
    write(world, snapshot, [
      ['x', snapshot.computed.positionX + after.x - before.x],
      ['y', snapshot.computed.positionY + after.y - before.y],
    ]);
  }
  return true;
}

function sizeWrites(snapshot: Snapshot, sx: number, sy: number): readonly (readonly [AnimatableProperty, number])[] {
  if (!snapshot.group) return [['width', snapshot.computed.width * sx], ['height', snapshot.computed.height * sy]];
  if (snapshot.uniform) return [['scale', snapshot.computed.scaleX * sx]];
  return [['scaleX', snapshot.computed.scaleX * sx], ['scaleY', snapshot.computed.scaleY * sy]];
}

/** A single layer grows in its plane; several grow in their own planes around screen-space anchors. */
export function resizeSpatialGesture(world: World, factor: Point): boolean {
  const mask = getSelectionMaskSnapshot();
  if (!snapshots.length || !mask || !mask.width || !mask.height) return false;
  const pointer = world.get(Pointer)!;
  const inverse = invert2D(mask.mat);
  const before = transformPoint(inverse, pointer.dragStartX, pointer.dragStartY);
  const after = transformPoint(inverse, pointer.clientX, pointer.clientY);
  const keys = world.get(Keys)!.held;
  const centered = keys.has('alt');
  const locked = keys.has('shift') || snapshots.every(snapshot => snapshot.locked) || snapshots.some(snapshot => snapshot.group && snapshot.uniform);
  const multiplier = centered ? 2 : 1;
  const dx = (after.x - before.x) * multiplier, dy = (after.y - before.y) * multiplier;
  let dw = dx * factor.x, dh = dy * factor.y;
  if (locked) {
    const ratio = factor.x && factor.y
      ? (dw * mask.width + dh * mask.height) / (mask.width ** 2 + mask.height ** 2)
      : factor.x ? dw / mask.width : dh / mask.height;
    dw = mask.width * ratio;
    dh = mask.height * ratio;
  }
  const sx = Math.max(1, mask.width + dw) / mask.width;
  const sy = Math.max(1, mask.height + dh) / mask.height;
  const opposite = { x: centered ? 0.5 : (1 - factor.x) / 2, y: centered ? 0.5 : (1 - factor.y) / 2 };
  if (snapshots.length === 1) {
    const snapshot = snapshots[0]!;
    const c = snapshot.computed;
    const deltaWidth = c.width * (sx - 1), deltaHeight = c.height * (sy - 1);
    const fixed = { x: c.originX + opposite.x * c.width, y: c.originY + opposite.y * c.height };
    const change = snapshot.linear((snapshot.pivot.x - fixed.x) * (sx - 1), (snapshot.pivot.y - fixed.y) * (sy - 1));
    write(world, snapshot, [
      ...sizeWrites(snapshot, sx, sy),
      ['x', c.positionX + change.x - (snapshot.group ? 0 : c.anchorX * deltaWidth)],
      ['y', c.positionY + change.y - (snapshot.group ? 0 : c.anchorY * deltaHeight)],
      ['z', c.positionZ + change.z],
    ]);
    return true;
  }
  const pivot = { x: mask.width * opposite.x, y: mask.height * opposite.y };
  for (const snapshot of snapshots) {
    const oldAnchor = transformPoint(inverse, snapshot.anchor.x, snapshot.anchor.y);
    const target = transformPoint(mask.mat, pivot.x + (oldAnchor.x - pivot.x) * sx, pivot.y + (oldAnchor.y - pivot.y) * sy);
    const placed = transformPoint(invert2D(snapshot.parentPlane), target.x, target.y);
    const c = snapshot.computed;
    write(world, snapshot, [
      ...sizeWrites(snapshot, sx, sy),
      ['x', placed.x - c.offsetX - snapshot.pivot.x * (snapshot.group ? 1 : sx)],
      ['y', placed.y - c.offsetY - snapshot.pivot.y * (snapshot.group ? 1 : sy)],
    ]);
  }
  return true;
}

/** Roll stays in each layer's own plane; multi-selection anchors turn around the shared screen pivot. */
export function rotateSpatialGesture(world: World): boolean {
  const mask = getSelectionMaskSnapshot();
  if (!snapshots.length || !mask) return false;
  const pointer = world.get(Pointer)!;
  const snap = world.get(Keys)!.held.has('shift');
  if (snapshots.length === 1) {
    const snapshot = snapshots[0]!;
    const inverse = invert2D(snapshot.rotationPlane);
    const before = transformPoint(inverse, pointer.dragStartX, pointer.dragStartY);
    const after = transformPoint(inverse, pointer.clientX, pointer.clientY);
    const c = snapshot.computed;
    const px = c.positionX + c.offsetX + snapshot.pivot.x, py = c.positionY + c.offsetY + snapshot.pivot.y;
    const delta = Math.atan2(after.y - py, after.x - px) - Math.atan2(before.y - py, before.x - px);
    const rotation = c.rotation + delta * 180 / Math.PI;
    write(world, snapshot, [['rotation', snap ? Math.round(rotation / 15) * 15 : rotation]]);
    return true;
  }
  const center = transformPoint(mask.mat, mask.width / 2, mask.height / 2);
  let delta = Math.atan2(pointer.clientY - center.y, pointer.clientX - center.x) - Math.atan2(pointer.dragStartY - center.y, pointer.dragStartX - center.x);
  if (snap) delta = Math.round(delta * 180 / Math.PI / 15) * 15 * Math.PI / 180;
  for (const snapshot of snapshots) {
    const dx = snapshot.anchor.x - center.x, dy = snapshot.anchor.y - center.y;
    const target = { x: center.x + Math.cos(delta) * dx - Math.sin(delta) * dy, y: center.y + Math.sin(delta) * dx + Math.cos(delta) * dy };
    const placed = transformPoint(invert2D(snapshot.parentPlane), target.x, target.y);
    const c = snapshot.computed;
    write(world, snapshot, [
      ['x', placed.x - c.offsetX - snapshot.pivot.x],
      ['y', placed.y - c.offsetY - snapshot.pivot.y],
      ['rotation', c.rotation + delta * 180 / Math.PI],
    ]);
  }
  return true;
}
