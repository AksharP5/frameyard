import { type Entity, type World } from 'koota';
import {
  Anchor, Cache, Computed, Culled, LocalTransform, UniformScale, KeyframeTrack,
  Scene, SceneCamera, Scene3D, Geometry, WorldBounds, WorldTransform,
} from '../traits';
import { GeometryType } from '../constants';
import { store } from '../world/store';
import { getParentEntity } from '../queries/hierarchy';
import { aabbFromTransformedRect, multiply2D, translate2D, type Mat2D } from '../math';
import { affine4, identity4, multiply4, projectPlane, rotation4, translation4, type Mat4, type PerspectiveCamera, scale4, projectPoint3D } from '../math/spatial';

type SpatialNode = { model: Mat4; scene: Entity; plane: Mat2D; world: Mat2D; distance: number; visible: boolean };
type SpatialState = { nodes: Map<Entity, SpatialNode>; scenes: Set<Entity> };
const states = new WeakMap<World, SpatialState>();

export function spatialNode(world: World, entity: Entity): SpatialNode | undefined {
  return states.get(world)?.nodes.get(entity);
}

export function hasSpatialCamera(world: World, entity: Entity): boolean {
  return states.get(world)?.scenes.has(entity) ?? false;
}

function affineWorld(world: World, entity: Entity): Mat2D {
  const values = store(world, WorldTransform), id = entity.id();
  return { a: values.a[id]!, b: values.b[id]!, c: values.c[id]!, d: values.d[id]!, e: values.e[id]!, f: values.f[id]! };
}

export function sceneCamera(scene: Entity): PerspectiveCamera {
  const computed = scene.get(Computed)!;
  return {
    x: computed.cameraX, y: computed.cameraY, z: computed.cameraZ,
    perspective: computed.perspective, zoom: computed.cameraZoom,
    rotationX: computed.cameraRotationX, rotationY: computed.cameraRotationY, rotation: computed.cameraRotation,
    width: computed.width, height: computed.height, offsetX: computed.cameraOffsetX, offsetY: computed.cameraOffsetY,
  };
}

/** A parent XY plane at fixed depth, used to move a grabbed point without changing its depth. */
export function projectParentPlane(world: World, entity: Entity, z: number): Mat2D {
  const node = spatialNode(world, entity);
  if (!node) throw new Error('Spatial interaction requires a projected layer');
  const parent = getParentEntity(entity);
  const model = parent ? spatialNode(world, parent)?.model : undefined;
  const plane = projectPlane(multiply4(model ?? identity4(), translation4(0, 0, z)), sceneCamera(node.scene));
  return multiply2D(affineWorld(world, node.scene), plane);
}

/** The ordinary affine tree is untouched. Spatial scenes add projected geometry for rendering and picking. */
export function computeSpatialTransforms(world: World): void {
  const nodes = new Map<Entity, SpatialNode>();
  const scenes = new Set<Entity>();
  const computed = store(world, Computed);
  const children = store(world, Cache).children;
  const masks = store(world, Cache).masks;
  const local = store(world, LocalTransform);
  const usesDepth = (node: Entity): boolean => {
    const id = node.id();
    return Boolean(computed.positionZ[id] || computed.rotationX[id] || computed.rotationY[id])
      || (children[id] ?? []).some(child => !child.has(Scene) && !child.has(Scene3D) && usesDepth(child))
      || (masks[id] ?? []).some(usesDepth);
  };

  for (const scene of [...world.query(Scene), ...world.query(Scene3D)]) {
    const sid = scene.id();
    const cameraAnimated = computed.cameraZoom[sid] !== 1 || computed.perspective[sid] !== 1000
      || computed.cameraZ[sid] !== 1000 || computed.cameraRotationX[sid] || computed.cameraRotationY[sid]
      || computed.cameraRotation[sid] || computed.cameraX[sid] !== computed.width[sid] / 2
      || computed.cameraY[sid] !== computed.height[sid] / 2;
    if (!scene.has(Scene3D) && !scene.has(SceneCamera) && !cameraAnimated && !usesDepth(scene)) continue;
    scenes.add(scene);
    const camera = sceneCamera(scene);
    const sceneWorld = nodes.get(scene)?.world ?? affineWorld(world, scene);
    const walk = (entity: Entity, parentModel: Mat4, parentVisible = true): void => {
      const id = entity.id();
      const x = computed.positionX[id] + computed.offsetX[id];
      const y = computed.positionY[id] + computed.offsetY[id];
      const anchor = entity.get(Anchor);
      const pivotX = (computed.anchorX[id] ?? anchor?.x ?? .5) * computed.width[id];
      const pivotY = (computed.anchorY[id] ?? anchor?.y ?? .5) * computed.height[id];
      const affine = { a: local.a[id]!, b: local.b[id]!, c: local.c[id]!, d: local.d[id]!, e: local.e[id]!, f: local.f[id]! };
      // Keep the existing affine transform, inserting tilt around the same anchor.
      const tilt = multiply4(
        translation4(x + pivotX, y + pivotY, computed.positionZ[id] ?? 0),
        multiply4(rotation4(computed.rotationX[id] ?? 0, computed.rotationY[id] ?? 0), translation4(-x - pivotX, -y - pivotY, 0)),
      );
      const uniformScale = scene.has(Scene3D) && (entity.has(UniformScale) || (entity.get(Cache)?.keyframeTracks ?? []).some(track => {
        const settings = track.get(KeyframeTrack); return settings?.target === entity && settings.property === 'scale';
      })) ? computed.scaleX[id] ?? 1 : 1;
      const model = multiply4(parentModel, multiply4(tilt, multiply4(affine4(affine), scale4(1, 1, (computed.scaleZ[id] ?? 1) * uniformScale))));
      const plane = projectPlane(model, camera);
      const worldPlane = multiply2D(sceneWorld, plane);
      const w = computed.width[id] ?? 0, h = computed.height[id] ?? 0;
      const ox = computed.originX[id] ?? 0, oy = computed.originY[id] ?? 0;
      const denominator = (px: number, py: number) => (plane.g ?? 0) * px + (plane.h ?? 0) * py + (plane.i ?? 1);
      let visible = parentVisible && Math.min(denominator(ox, oy), denominator(ox + w, oy), denominator(ox, oy + h), denominator(ox + w, oy + h)) > .01;
      const type = entity.get(Geometry)?.value;
      let bounds = aabbFromTransformedRect(multiply2D(worldPlane, translate2D(ox, oy)), w, h);
      if (scene.has(Scene3D) && type !== undefined && type >= GeometryType.MESH) {
        let minX = ox, minY = oy, minZ = -(computed.depth[id] ?? 100) / 2;
        let maxX = ox + w, maxY = oy + h, maxZ = -minZ;
        const coordinates = type === GeometryType.POINT_CLOUD ? computed.points[id]
          : type === GeometryType.MESH ? computed.vertices[id]
          : type === GeometryType.PATH_3D ? (computed.path3d[id]?.match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) ?? []).map(Number) : [];
        if (coordinates?.length) {
          minX = minY = minZ = Infinity; maxX = maxY = maxZ = -Infinity;
          for (let i = 0; i < coordinates.length; i += 3) {
            minX = Math.min(minX, coordinates[i]!); maxX = Math.max(maxX, coordinates[i]!);
            minY = Math.min(minY, coordinates[i + 1]!); maxY = Math.max(maxY, coordinates[i + 1]!);
            minZ = Math.min(minZ, coordinates[i + 2]!); maxZ = Math.max(maxZ, coordinates[i + 2]!);
          }
        }
        const points = [minX, maxX].flatMap(x => [minY, maxY].flatMap(y => [minZ, maxZ].map(z => projectPoint3D(model, camera, x, y, z)))).filter(p => p.depth > .01);
        visible = parentVisible && points.length > 0;
        const worldPoints = points.map(p => ({ x: (sceneWorld.a * p.x + sceneWorld.c * p.y + sceneWorld.e) / ((sceneWorld.g ?? 0) * p.x + (sceneWorld.h ?? 0) * p.y + (sceneWorld.i ?? 1)), y: (sceneWorld.b * p.x + sceneWorld.d * p.y + sceneWorld.f) / ((sceneWorld.g ?? 0) * p.x + (sceneWorld.h ?? 0) * p.y + (sceneWorld.i ?? 1)) }));
        bounds = { minX: Math.min(...worldPoints.map(p => p.x)), minY: Math.min(...worldPoints.map(p => p.y)), maxX: Math.max(...worldPoints.map(p => p.x)), maxY: Math.max(...worldPoints.map(p => p.y)) };
      }
      nodes.set(entity, { model, plane, world: worldPlane, scene, distance: denominator(ox + w / 2, oy + h / 2), visible });
      if (visible) {
        const target = store(world, WorldBounds);
        target.minX[id] = bounds.minX; target.minY[id] = bounds.minY;
        target.maxX[id] = bounds.maxX; target.maxY[id] = bounds.maxY;
        // Affine culling cannot predict a tilted plane; its containing scene owns culling.
        if (!scene.has(Culled)) entity.remove(Culled);
      }
      if (entity.has(Scene3D)) return;
      for (const child of children[id] ?? []) walk(child, model, visible);
      for (const mask of masks[id] ?? []) walk(mask, model, visible);
    };
    for (const child of children[sid] ?? []) walk(child, identity4());
    for (const mask of masks[sid] ?? []) walk(mask, identity4());
  }
  if (!scenes.size) { states.delete(world); return; }
  states.set(world, { nodes, scenes });
}
