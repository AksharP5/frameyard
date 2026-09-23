/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { PhysicsVector, PhysicsWorldSettings, RigidBodySettings } from '@diffusionstudio/jsx';
import type { Rotation, Vector } from '@dimforge/rapier3d-compat';

type PhysicsEngine = typeof import('@dimforge/rapier3d-compat');
let engine: PhysicsEngine | undefined;
let initialization: Promise<void> | undefined;

/** Preview and capture share this readiness promise. No clock advances during loading. */
export function initializePhysics(): Promise<void> {
  initialization ??= import('@dimforge/rapier3d-compat').then(async module => {
    await module.init();
    engine = module;
  }).catch(error => {
    initialization = undefined;
    throw error;
  });
  return initialization;
}

export function physicsReady(): boolean {
  return engine !== undefined;
}

export type PhysicsBodyDefinition = {
  id: string;
  /** Collider center in scene pixels. */
  position: PhysicsVector;
  /** Initial XYZ Euler angles in degrees, composed as Rz * Ry * Rx. */
  rotation: PhysicsVector;
  /** Initial layer dimensions, used when no collider shape is authored. */
  size: PhysicsVector;
  options: RigidBodySettings;
  /** Scene seconds. The body stays at its initial pose until this time. */
  start?: number;
  /** Scene seconds. The body stops participating in collisions at this time. */
  end?: number;
  /** Ordinary 2D scenes constrain translation to XY and rotation to Z. */
  planar?: boolean;
};

export type PhysicsPose = {
  x: number; y: number; z: number;
  rotationX: number; rotationY: number; rotation: number;
  velocity: PhysicsVector;
  angularVelocity: PhysicsVector;
};

const PIXELS_PER_METER = 100;
const DEGREES = 180 / Math.PI;
const MAX_CHECKPOINTS = 32;
const MAX_CHECKPOINT_BYTES = 32 * 1024 * 1024;

type BodyState = { position: Vector; rotation: Rotation; velocity: Vector; angularVelocity: Vector };
type Frame = ReadonlyMap<string, BodyState>;

function initialRotation([x, y, z]: PhysicsVector): Rotation {
  const sx = Math.sin(x / DEGREES / 2), cx = Math.cos(x / DEGREES / 2);
  const sy = Math.sin(y / DEGREES / 2), cy = Math.cos(y / DEGREES / 2);
  const sz = Math.sin(z / DEGREES / 2), cz = Math.cos(z / DEGREES / 2);
  return {
    x: sx * cy * cz - cx * sy * sz,
    y: cx * sy * cz + sx * cy * sz,
    z: cx * cy * sz - sx * sy * cz,
    w: cx * cy * cz + sx * sy * sz,
  };
}

function euler({ x, y, z, w }: Rotation): Pick<PhysicsPose, 'rotationX' | 'rotationY' | 'rotation'> {
  const sinY = Math.max(-1, Math.min(1, 2 * (w * y - z * x)));
  return {
    rotationX: Math.abs(sinY) < 0.9999999 ? Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * DEGREES : 0,
    rotationY: Math.asin(sinY) * DEGREES,
    rotation: (Math.abs(sinY) < 0.9999999
      ? Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
      : Math.atan2(2 * (w * z - x * y), 1 - 2 * (x * x + z * z))) * DEGREES,
  };
}

function interpolateRotation(a: Rotation, b: Rotation, t: number): Rotation {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const sign = dot < 0 ? -1 : 1;
  const angle = Math.acos(Math.min(1, Math.abs(dot)));
  const denominator = Math.sin(angle);
  const left = denominator < 0.001 ? 1 - t : Math.sin((1 - t) * angle) / denominator;
  const right = (denominator < 0.001 ? t : Math.sin(t * angle) / denominator) * sign;
  const result = { x: a.x * left + b.x * right, y: a.y * left + b.y * right, z: a.z * left + b.z * right, w: a.w * left + b.w * right };
  const length = Math.hypot(result.x, result.y, result.z, result.w);
  return { x: result.x / length, y: result.y / length, z: result.z / length, w: result.w / length };
}

function interpolateVector(a: Vector, b: Vector, t: number, scale: number): PhysicsVector {
  return [(a.x + (b.x - a.x) * t) * scale, (a.y + (b.y - a.y) * t) * scale, (a.z + (b.z - a.z) * t) * scale];
}

/**
 * One simulation owns its world and bounded checkpoints. Recreate it when authored
 * settings or initial transforms change, and dispose it when its scene is removed.
 */
export function createPhysicsSimulation(settings: PhysicsWorldSettings, definitions: readonly PhysicsBodyDefinition[]) {
  if (!engine) throw new Error('Physics is not ready; await initializePhysics() before creating a simulation');
  const rapier = engine;
  const ordered = [...definitions].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const ids = new Set<string>();
  for (const definition of ordered) {
    if (!definition.id || ids.has(definition.id)) throw new Error(`Physics body ids must be unique: ${definition.id}`);
    ids.add(definition.id);
    if ([...definition.position, ...definition.rotation, ...definition.size].some(value => !Number.isFinite(value)) || definition.size.some(value => value <= 0)) {
      throw new Error(`Physics body ${definition.id} requires finite transforms and positive dimensions`);
    }
    const start = definition.start ?? 0, end = definition.end ?? Infinity;
    if (!Number.isFinite(start) || start < 0 || Number.isNaN(end) || end < start) throw new Error(`Physics body ${definition.id} requires a valid activation interval`);
  }

  const [gx, gy, gz] = settings.gravity;
  const timestep = settings.step;
  let world = new rapier.World({ x: gx / PIXELS_PER_METER, y: gy / PIXELS_PER_METER, z: gz / PIXELS_PER_METER });
  world.timestep = timestep;
  const handles = new Map<string, number>();
  const activations: { handle: number; start: number; end: number }[] = [];
  for (const definition of ordered) {
    const { options } = definition;
    const start = Math.ceil((definition.start ?? 0) / timestep - 1e-7);
    const end = Math.ceil((definition.end ?? Infinity) / timestep - 1e-7);
    const descriptor = options.type === 'fixed' ? rapier.RigidBodyDesc.fixed() : rapier.RigidBodyDesc.dynamic();
    descriptor.setEnabled(start <= 0 && end > 0);
    descriptor.setTranslation(definition.position[0] / PIXELS_PER_METER, definition.position[1] / PIXELS_PER_METER, definition.position[2] / PIXELS_PER_METER);
    descriptor.setRotation(initialRotation(definition.rotation));
    descriptor.setLinvel(options.velocity[0] / PIXELS_PER_METER, options.velocity[1] / PIXELS_PER_METER, options.velocity[2] / PIXELS_PER_METER);
    if (!options.lockRotation) descriptor.setAngvel({ x: definition.planar ? 0 : options.angularVelocity[0] / DEGREES, y: definition.planar ? 0 : options.angularVelocity[1] / DEGREES, z: options.angularVelocity[2] / DEGREES });
    descriptor.setLinearDamping(options.linearDamping).setAngularDamping(options.angularDamping).setCcdEnabled(true);
    if (definition.planar) descriptor.enabledTranslations(true, true, false).enabledRotations(false, false, !options.lockRotation);
    if (options.lockRotation) descriptor.lockRotations();
    const body = world.createRigidBody(descriptor);
    handles.set(definition.id, body.handle);
    if (start > 0 || end < Infinity) activations.push({ handle: body.handle, start, end });
    const shape = options.shape ?? { type: 'box', size: definition.size };
    const collider = shape.type === 'sphere'
      ? rapier.ColliderDesc.ball(shape.radius / PIXELS_PER_METER)
      : rapier.ColliderDesc.cuboid(shape.size[0] / PIXELS_PER_METER / 2, shape.size[1] / PIXELS_PER_METER / 2, shape.size[2] / PIXELS_PER_METER / 2);
    collider.setMass(options.mass).setRestitution(options.restitution).setFriction(options.friction);
    world.createCollider(collider, body);
    if (options.spring) {
      const spring = options.spring;
      const anchor = world.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(spring.anchor[0] / PIXELS_PER_METER, spring.anchor[1] / PIXELS_PER_METER, spring.anchor[2] / PIXELS_PER_METER));
      const joint = rapier.JointData.spring(spring.restLength / PIXELS_PER_METER, spring.stiffness, spring.damping, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
      world.createImpulseJoint(joint, anchor, body, true);
    }
  }

  const initial = world.takeSnapshot();
  const checkpoints = new Map<number, Uint8Array>([[0, initial]]);
  const checkpointInterval = Math.max(1, Math.round(1 / timestep));
  let checkpointBytes = initial.byteLength;
  let currentStep = 0;
  let disposed = false;
  let window: { step: number; lower: Frame; upper?: Frame } | undefined;
  let lastSample: { seconds: number; poses: ReadonlyMap<string, PhysicsPose> } | undefined;

  function step() {
    for (const activation of activations) {
      const body = world.getRigidBody(activation.handle);
      const enabled = currentStep >= activation.start && currentStep < activation.end;
      if (body.isEnabled() !== enabled) body.setEnabled(enabled);
    }
    world.step();
    currentStep++;
    if (currentStep % checkpointInterval !== 0 || checkpoints.has(currentStep)) return;
    const snapshot = world.takeSnapshot();
    // The initial state is always retained; one oversized state must not double the budget.
    if (snapshot.byteLength + initial.byteLength > MAX_CHECKPOINT_BYTES) return;
    checkpoints.set(currentStep, snapshot);
    checkpointBytes += snapshot.byteLength;
    for (const [index, checkpoint] of checkpoints) {
      if (checkpoints.size <= MAX_CHECKPOINTS && checkpointBytes <= MAX_CHECKPOINT_BYTES) break;
      if (index === 0) continue;
      checkpoints.delete(index);
      checkpointBytes -= checkpoint.byteLength;
    }
  }

  function read(): Frame {
    const frame = new Map<string, BodyState>();
    for (const [id, handle] of handles) {
      const body = world.getRigidBody(handle);
      frame.set(id, { position: body.translation(), rotation: body.rotation(), velocity: body.linvel(), angularVelocity: body.angvel() });
    }
    return frame;
  }

  function sample(seconds: number): ReadonlyMap<string, PhysicsPose> {
    if (disposed) throw new Error('Physics simulation has been disposed');
    if (!Number.isFinite(seconds)) throw new Error('Physics sample time must be finite');
    seconds = Math.max(0, seconds);
    if (lastSample?.seconds === seconds) return lastSample.poses;
    const position = seconds / timestep;
    // Decimal frame times may land a few ulps either side of an exact integration step.
    const nearest = Math.round(position);
    const exact = Math.abs(position - nearest) < 1e-7;
    const lowerStep = exact ? nearest : Math.floor(position);
    if (!Number.isSafeInteger(lowerStep)) throw new Error('Physics sample time exceeds the supported range');
    const alpha = exact ? 0 : position - lowerStep;
    if (window?.step !== lowerStep) {
      if (currentStep > lowerStep) {
        let checkpointStep = 0;
        for (const index of checkpoints.keys()) if (index <= lowerStep && index > checkpointStep) checkpointStep = index;
        const restored = rapier.World.restoreSnapshot(checkpoints.get(checkpointStep)!);
        world.free();
        world = restored;
        currentStep = checkpointStep;
      }
      while (currentStep < lowerStep) step();
      window = { step: lowerStep, lower: read() };
    }
    if (alpha && !window.upper) {
      step();
      window.upper = read();
    }
    const poses = new Map<string, PhysicsPose>();
    for (const [id, a] of window.lower) {
      const b = window.upper?.get(id) ?? a;
      const [x, y, z] = interpolateVector(a.position, b.position, alpha, PIXELS_PER_METER);
      poses.set(id, {
        x, y, z,
        ...euler(alpha ? interpolateRotation(a.rotation, b.rotation, alpha) : a.rotation),
        velocity: interpolateVector(a.velocity, b.velocity, alpha, PIXELS_PER_METER),
        angularVelocity: interpolateVector(a.angularVelocity, b.angularVelocity, alpha, DEGREES),
      });
    }
    lastSample = { seconds, poses };
    return poses;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    world.free();
    checkpoints.clear();
    window = undefined;
    lastSample = undefined;
  }

  return { sample, dispose };
}

export type PhysicsSimulation = ReturnType<typeof createPhysicsSimulation>;
