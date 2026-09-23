import type { Entity, World } from 'koota';
import type { PhysicsVector } from '@diffusionstudio/jsx';
import {
  Anchor, Animation, Cache, Computed, Flip, FramePromises, FrameRate, Group, Hidden, Host, KeyframeTrack,
  Offset, PhysicsWorld, Position, RigidBody, Root, Rotation, Scale, Scene, Scene3D, Size, Skew,
  SpatialGeometry, SpatialParameters, Stage, UniformScale,
} from '../traits';
import { AnimationType } from '../constants';
import { getParentEntity } from '../queries/hierarchy';
import { store } from '../world/store';
import { createPhysicsSimulation, initializePhysics, physicsReady, type PhysicsBodyDefinition, type PhysicsSimulation } from '../math/physics';
import { identity4, multiply4, rotation4, scale4, transformPoint3D, translation4, type Mat4 } from '../math/spatial';

export { initializePhysics, physicsReady } from '../math/physics';

type Binding = { entity: Entity; parent: Mat4; width: number; height: number; pivotX: number; pivotY: number; scale: PhysicsVector };
type Simulation = { signature: string; simulation: PhysicsSimulation; bindings: Binding[] };
type PhysicsState = { simulations: Map<Entity, Simulation>; pending?: Promise<void>; error?: unknown };
const states = new WeakMap<World, PhysicsState>();
const degrees = 180 / Math.PI;
const transformProperties = new Set(['position.x', 'position.y', 'position.z', 'offset.x', 'offset.y', 'rotation', 'rotation.x', 'rotation.y', 'width', 'height', 'scale', 'scale.x', 'scale.y', 'spatial.scaleZ', 'spatial.depth', 'anchor.x', 'anchor.y', 'skew.x', 'skew.y']);
const transformAnimations = new Set([AnimationType.GROW, AnimationType.SHRINK, AnimationType.SLIDE_LEFT, AnimationType.SLIDE_RIGHT, AnimationType.SLIDE_UP, AnimationType.SLIDE_DOWN, AnimationType.SPIN, AnimationType.TWIST]);

function restoreAuthored(world: World, entity: Entity) {
  if (!entity.isAlive()) return;
  const position = entity.get(Position), rotation = entity.get(Rotation), computed = store(world, Computed), id = entity.id();
  computed.positionX[id] = position?.x ?? 0; computed.positionY[id] = position?.y ?? 0; computed.positionZ[id] = position?.z ?? 0;
  computed.rotationX[id] = rotation?.x ?? 0; computed.rotationY[id] = rotation?.y ?? 0; computed.rotation[id] = rotation?.value ?? 0;
}

function stateFor(world: World): PhysicsState {
  const existing = states.get(world);
  if (existing) return existing;
  const state: PhysicsState = { simulations: new Map() };
  states.set(world, state);
  const releaseScene = (scene: Entity) => {
    const entry = state.simulations.get(scene);
    if (!entry) return;
    entry.simulation.dispose();
    for (const binding of entry.bindings) restoreAuthored(world, binding.entity);
    state.simulations.delete(scene);
  };
  const removePhysics = world.onRemove(PhysicsWorld, releaseScene);
  const removeBody = world.onRemove(RigidBody, entity => restoreAuthored(world, entity));
  const stage = world.get(Root);
  const removeStage = world.onRemove(Stage, removed => {
    if (removed !== stage) return;
    for (const entry of state.simulations.values()) entry.simulation.dispose();
    state.simulations.clear(); states.delete(world);
    removePhysics(); removeBody(); removeStage();
  });
  return state;
}

/** Called before the encoder drains FramePromises, so its first frame includes physics. */
export function preparePhysics(world: World): boolean {
  if (!world.query(PhysicsWorld).length || !world.query(RigidBody).length) return true;
  const state = stateFor(world);
  if (state.error) throw state.error;
  if (physicsReady()) return true;
  if (!state.pending) {
    state.pending = initializePhysics();
    void state.pending.catch(error => { state.error = error; });
  }
  world.get(FramePromises)?.list?.push(state.pending);
  return false;
}

function layerRotation(entity: Entity): Mat4 {
  const r = entity.get(Rotation);
  return multiply4(rotation4(r?.x ?? 0, r?.y ?? 0), rotation4(0, 0, r?.value ?? 0));
}

function angles(matrix: Mat4, order: 'layer' | 'simulation'): PhysicsVector {
  if (order === 'layer') {
    const sinX = Math.max(-1, Math.min(1, -matrix[9]));
    return [Math.asin(sinX) * degrees,
      (Math.abs(sinX) < .9999999 ? Math.atan2(matrix[8], matrix[10]) : Math.atan2(-matrix[2], matrix[0])) * degrees,
      Math.abs(sinX) < .9999999 ? Math.atan2(matrix[1], matrix[5]) * degrees : 0];
  }
  const sinY = Math.max(-1, Math.min(1, -matrix[2]));
  return [Math.abs(sinY) < .9999999 ? Math.atan2(matrix[6], matrix[10]) * degrees : 0,
    Math.asin(sinY) * degrees,
    (Math.abs(sinY) < .9999999 ? Math.atan2(matrix[1], matrix[0]) : Math.atan2(-matrix[4], matrix[5])) * degrees];
}

/** Parents are rigid transforms; their inverse is a transpose plus inverse translation. */
function inverseParent(m: Mat4): Mat4 {
  return [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0,
    -(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]),
    -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]),
    -(m[8] * m[12] + m[9] * m[13] + m[10] * m[14]), 1];
}

function assertStaticTransform(entity: Entity) {
  for (const track of entity.get(Cache)?.keyframeTracks ?? []) {
    const definition = track.get(KeyframeTrack);
    if (definition?.target === entity && transformProperties.has(definition.property)) throw new Error('Physics uses initial transforms; remove transform keyframes from rigid bodies and their parent groups');
  }
  for (const animation of entity.get(Cache)?.animations ?? []) {
    if (transformAnimations.has(animation.get(Animation)!.type)) throw new Error('Physics uses initial transforms; remove transform animations from rigid bodies and their parent groups');
  }
  const skew = entity.get(Skew);
  if (skew?.x || skew?.y) throw new Error('Physics colliders do not support skewed layers or parent groups');
}

function scaleOf(entity: Entity, spatial: boolean): PhysicsVector {
  const uniform = entity.get(UniformScale)?.value;
  const scale = entity.get(Scale);
  const flip = entity.get(Flip);
  return [(uniform ?? scale?.x ?? 1) * (flip?.x ?? 1), (uniform ?? scale?.y ?? 1) * (flip?.y ?? 1), (entity.get(SpatialParameters)?.scaleZ ?? 1) * (spatial ? uniform ?? 1 : 1)];
}

function authoredModel(entity: Entity, rotation: Mat4, scale: PhysicsVector, width: number, height: number): Mat4 {
  const p = entity.get(Position), offset = entity.get(Offset), anchor = entity.get(Anchor);
  const px = (anchor?.x ?? .5) * width, py = (anchor?.y ?? .5) * height;
  return multiply4(translation4((p?.x ?? 0) + (offset?.x ?? 0) + px, (p?.y ?? 0) + (offset?.y ?? 0) + py, p?.z ?? 0),
    multiply4(rotation, multiply4(scale4(...scale), translation4(-px, -py, 0))));
}

function definitionsFor(world: World, scene: Entity, bodies: Entity[]) {
  const definitions: PhysicsBodyDefinition[] = [], bindings: Binding[] = [];
  let enclosing: Entity | null = scene;
  while (enclosing !== null && !enclosing.has(Scene) && !enclosing.has(Scene3D)) enclosing = getParentEntity(enclosing);
  const spatial = enclosing?.has(Scene3D) ?? false;
  const fps = world.get(FrameRate)!.value, clock = scene.get(Computed)!;
  for (const entity of bodies) {
    const ancestors: Entity[] = [];
    for (let parent = getParentEntity(entity); parent !== null && parent !== scene; parent = getParentEntity(parent)) ancestors.unshift(parent);
    if (entity.has(Hidden) || ancestors.some(parent => parent.has(Hidden))) continue;
    assertStaticTransform(entity);
    let parentModel = identity4();
    let start = entity.get(Computed)!.start, end = entity.get(Computed)!.end;
    for (const parent of ancestors) {
      if (parent.has(RigidBody)) throw new Error('A rigid body cannot be nested inside another rigid body');
      assertStaticTransform(parent);
      if (scaleOf(parent, spatial).some(value => value !== 1)) throw new Error('Physics parent groups may translate and rotate, but must have scale 1');
      const size = parent.get(Size), rotation = layerRotation(parent);
      if (!size && rotation.some((value, index) => value !== identity4()[index])) throw new Error('Rotated physics parent groups require explicit width and height');
      parentModel = multiply4(parentModel, authoredModel(parent, rotation, [1, 1, 1], size?.width ?? 0, size?.height ?? 0));
      start = Math.max(start, parent.get(Computed)!.start); end = Math.min(end, parent.get(Computed)!.end);
    }
    const size = entity.get(Size);
    if (!size || size.width <= 0 || size.height <= 0) throw new Error('Rigid bodies require explicit positive width and height');
    const scale = scaleOf(entity, spatial);
    if (scale.some(value => value === 0)) throw new Error('Rigid bodies require nonzero scale');
    const orientation = layerRotation(entity);
    const model = multiply4(parentModel, authoredModel(entity, orientation, scale, size.width, size.height));
    const center = transformPoint3D(model, size.width / 2, size.height / 2, 0);
    const dimensions: PhysicsVector = [size.width * Math.abs(scale[0]), size.height * Math.abs(scale[1]), Math.max(.001, spatial ? entity.get(SpatialParameters)?.depth ?? 100 : 1) * Math.abs(scale[2])];
    let options = entity.get(RigidBody)!.settings!;
    if (options.shape) {
      if (options.shape.type === 'sphere') {
        if (Math.abs(Math.abs(scale[0]) - Math.abs(scale[1])) > 1e-8 || spatial && Math.abs(Math.abs(scale[1]) - Math.abs(scale[2])) > 1e-8) throw new Error('Sphere colliders require uniform scale');
        options = { ...options, shape: { type: 'sphere', radius: options.shape.radius * Math.abs(scale[0]) } };
      } else options = { ...options, shape: { type: 'box', size: [options.shape.size[0] * Math.abs(scale[0]), options.shape.size[1] * Math.abs(scale[1]), options.shape.size[2] * Math.abs(scale[2])] } };
    } else if (entity.get(SpatialGeometry)?.shape === 'sphere' && Math.abs(dimensions[0] - dimensions[1]) < 1e-8 && Math.abs(dimensions[1] - dimensions[2]) < 1e-8) {
      options = { ...options, shape: { type: 'sphere', radius: dimensions[0] / 2 } };
    }
    const id = String(entity.id());
    definitions.push({ id, position: [center.x, center.y, center.z], rotation: angles(multiply4(parentModel, orientation), 'simulation'), size: dimensions, options, planar: !spatial,
      start: Math.max(0, (start - clock.origin) * clock.playbackRate / fps), end: Math.max(0, (Math.max(start, end) - clock.origin) * clock.playbackRate / fps) });
    const anchor = entity.get(Anchor);
    bindings.push({ entity, parent: inverseParent(parentModel), width: size.width, height: size.height, pivotX: (anchor?.x ?? .5) * size.width, pivotY: (anchor?.y ?? .5) * size.height, scale });
  }
  return { definitions, bindings };
}

/** Applies simulation to Computed only. Source transforms remain the editable initial state. */
export function physicsSystem(world: World): void {
  if (!preparePhysics(world)) return;
  const state = states.get(world);
  if (!state && !world.query(PhysicsWorld).length && !world.query(RigidBody).length) return;
  const current = state ?? stateFor(world);
  const roots = new Map<Entity, Entity[]>();
  for (const scene of world.query(PhysicsWorld)) {
    if (!scene.has(Scene) && !scene.has(Scene3D) && !scene.has(Group)) throw new Error('Physics worlds must belong to a Scene, Scene3d or Group');
    if (scene.get(PhysicsWorld)?.settings) roots.set(scene, []);
  }
  for (const entity of world.query(RigidBody)) {
    if (!entity.get(RigidBody)?.settings) continue;
    let parent = getParentEntity(entity);
    while (parent !== null && !roots.has(parent)) {
      if (parent.get(Host)?.props.physics === false) break;
      if (parent.has(Scene) || parent.has(Scene3D)) break;
      parent = getParentEntity(parent);
    }
    if (parent?.get(Host)?.props.physics === false) {
      continue;
    }
    const owner = parent ? roots.get(parent) : undefined;
    if (!owner) throw new Error('Rigid body requires physics={true} on its containing Scene, Scene3d or Group; add a physics world or disable the rigid body');
    owner.push(entity);
  }
  for (const [scene, entry] of current.simulations) {
    if (roots.has(scene)) continue;
    entry.simulation.dispose();
    for (const binding of entry.bindings) restoreAuthored(world, binding.entity);
    current.simulations.delete(scene);
  }
  for (const [scene, bodies] of roots) {
    const settings = scene.get(PhysicsWorld)!.settings!;
    const { definitions, bindings } = definitionsFor(world, scene, bodies);
    const signature = JSON.stringify([settings, definitions]);
    const existing = current.simulations.get(scene);
    if (!definitions.length) {
      if (existing) {
        existing.simulation.dispose();
        for (const binding of existing.bindings) restoreAuthored(world, binding.entity);
        current.simulations.delete(scene);
      }
      continue;
    }
    if (existing?.signature === signature) continue;
    if (existing) {
      existing.simulation.dispose();
      for (const binding of existing.bindings) restoreAuthored(world, binding.entity);
    }
    current.simulations.set(scene, { signature, bindings, simulation: createPhysicsSimulation(settings, definitions) });
  }
  const computed = store(world, Computed), fps = world.get(FrameRate)!.value;
  for (const [scene, entry] of current.simulations) {
    const poses = entry.simulation.sample(computed.localTime[scene.id()]! / fps);
    for (const binding of entry.bindings) {
      const { entity, parent, scale } = binding, pose = poses.get(String(entity.id()))!;
      const center = transformPoint3D(parent, pose.x, pose.y, pose.z);
      const rotation = multiply4(parent, rotation4(pose.rotationX, pose.rotationY, pose.rotation));
      const [rx, ry, rz] = angles(rotation, 'layer');
      const offset = entity.get(Offset), id = entity.id();
      const dx = (binding.width / 2 - binding.pivotX) * scale[0], dy = (binding.height / 2 - binding.pivotY) * scale[1];
      computed.positionX[id] = center.x - binding.pivotX - (rotation[0] * dx + rotation[4] * dy) - (offset?.x ?? 0);
      computed.positionY[id] = center.y - binding.pivotY - (rotation[1] * dx + rotation[5] * dy) - (offset?.y ?? 0);
      computed.positionZ[id] = center.z - (rotation[2] * dx + rotation[6] * dy);
      computed.rotationX[id] = rx; computed.rotationY[id] = ry; computed.rotation[id] = rz;
    }
  }
}
