/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Scene coordinates in pixels. Y points down; Z points toward the camera. */
export type PhysicsVector = readonly [number, number, number];

export type PhysicsShape =
  | { type: 'box'; size: PhysicsVector }
  | { type: 'sphere'; radius: number };

export const PHYSICS_WORLD_DEFAULTS = {
  gravity: [0, 980, 0] as PhysicsVector,
  /** Fixed simulation step in seconds, independent of preview/export FPS. */
  step: 1 / 120,
};
export type PhysicsWorldSettings = typeof PHYSICS_WORLD_DEFAULTS;
export type PhysicsWorldOptions = Partial<PhysicsWorldSettings>;

export const PHYSICS_SPRING_DEFAULTS = {
  anchor: [0, 0, 0] as PhysicsVector,
  stiffness: 100,
  damping: 10,
  restLength: 0,
};
export type PhysicsSpringSettings = typeof PHYSICS_SPRING_DEFAULTS;
export type PhysicsSpringOptions = Pick<PhysicsSpringSettings, 'anchor'> & Partial<Omit<PhysicsSpringSettings, 'anchor'>>;

export const RIGID_BODY_DEFAULTS = {
  type: 'dynamic' as 'dynamic' | 'fixed',
  /** Omit to use a box matching the layer's initial dimensions. */
  shape: undefined as PhysicsShape | undefined,
  mass: 1,
  restitution: 0.4,
  friction: 0.5,
  /** Pixels per second. */
  velocity: [0, 0, 0] as PhysicsVector,
  /** Degrees per second about X, Y and Z. */
  angularVelocity: [0, 0, 0] as PhysicsVector,
  linearDamping: 0,
  angularDamping: 0,
  lockRotation: false,
  /** A physical spring connecting the body center to a fixed scene point. */
  spring: undefined as PhysicsSpringSettings | undefined,
};
export type RigidBodySettings = typeof RIGID_BODY_DEFAULTS;
export type RigidBodyOptions = Partial<Omit<RigidBodySettings, 'spring'>> & { spring?: PhysicsSpringOptions };

function object(input: unknown, label: string, defaults: object): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown ${label} setting: ${key}`);
  }
  return input as Record<string, unknown>;
}

function number(input: unknown, label: string, minimum = -1e9, maximum = 1e9): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < minimum || input > maximum) {
    throw new Error(`${label} must be a finite number between ${minimum} and ${maximum}`);
  }
  return input;
}

function vector(input: unknown, label: string, minimum = -1e9): PhysicsVector {
  if (!Array.isArray(input) || input.length !== 3) throw new Error(`${label} requires three coordinates`);
  return [number(input[0], label, minimum), number(input[1], label, minimum), number(input[2], label, minimum)];
}

function shape(input: unknown): PhysicsShape | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || !('type' in input)) throw new Error('Rigid body shape must be a box or sphere');
  if (input.type === 'box') {
    const props = object(input, 'rigid body box', { type: '', size: [] });
    return { type: 'box', size: vector(props.size, 'Rigid body box size', 0.001) };
  }
  if (input.type === 'sphere') {
    const props = object(input, 'rigid body sphere', { type: '', radius: 0 });
    return { type: 'sphere', radius: number(props.radius, 'Rigid body sphere radius', 0.001) };
  }
  throw new Error('Rigid body shape must be a box or sphere');
}

function spring(input: unknown): PhysicsSpringSettings | undefined {
  if (input === undefined) return undefined;
  const props = object(input, 'physics spring', PHYSICS_SPRING_DEFAULTS);
  return {
    anchor: vector(props.anchor, 'Physics spring anchor'),
    stiffness: number(props.stiffness ?? PHYSICS_SPRING_DEFAULTS.stiffness, 'Physics spring stiffness', 0, 1e6),
    damping: number(props.damping ?? PHYSICS_SPRING_DEFAULTS.damping, 'Physics spring damping', 0, 1e6),
    restLength: number(props.restLength ?? PHYSICS_SPRING_DEFAULTS.restLength, 'Physics spring rest length', 0),
  };
}

/** Validate authored settings once, before creating a simulation. */
export function parsePhysicsWorld(input: unknown): PhysicsWorldSettings {
  const props = object(input === true || input === undefined ? {} : input, 'physics world', PHYSICS_WORLD_DEFAULTS);
  return {
    gravity: vector(props.gravity ?? PHYSICS_WORLD_DEFAULTS.gravity, 'Physics gravity'),
    step: number(props.step ?? PHYSICS_WORLD_DEFAULTS.step, 'Physics step', 1 / 1000, 1 / 15),
  };
}

/** Initial position, size and rotation come from the layer's authored transform. */
export function parseRigidBody(input: unknown): RigidBodySettings {
  const props = object(input === true || input === undefined ? {} : input, 'rigid body', RIGID_BODY_DEFAULTS);
  const type = props.type ?? RIGID_BODY_DEFAULTS.type;
  if (type !== 'dynamic' && type !== 'fixed') throw new Error('Rigid body type must be dynamic or fixed');
  const lockRotation = props.lockRotation ?? RIGID_BODY_DEFAULTS.lockRotation;
  if (typeof lockRotation !== 'boolean') throw new Error('Rigid body lockRotation must be a boolean');
  return {
    type,
    shape: shape(props.shape),
    mass: number(props.mass ?? RIGID_BODY_DEFAULTS.mass, 'Rigid body mass', 0.000001, 1e6),
    restitution: number(props.restitution ?? RIGID_BODY_DEFAULTS.restitution, 'Rigid body restitution', 0, 1),
    friction: number(props.friction ?? RIGID_BODY_DEFAULTS.friction, 'Rigid body friction', 0, 10),
    velocity: vector(props.velocity ?? RIGID_BODY_DEFAULTS.velocity, 'Rigid body velocity'),
    angularVelocity: vector(props.angularVelocity ?? RIGID_BODY_DEFAULTS.angularVelocity, 'Rigid body angular velocity'),
    linearDamping: number(props.linearDamping ?? RIGID_BODY_DEFAULTS.linearDamping, 'Rigid body linear damping', 0, 1000),
    angularDamping: number(props.angularDamping ?? RIGID_BODY_DEFAULTS.angularDamping, 'Rigid body angular damping', 0, 1000),
    lockRotation,
    spring: spring(props.spring),
  };
}
