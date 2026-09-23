import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePhysicsWorld, parseRigidBody } from '../../../packages/jsx/src/physics.ts';
import type { PhysicsVector, RigidBodyOptions } from '../../../packages/jsx/src/physics.ts';
import { createPhysicsSimulation, initializePhysics, physicsReady } from '../../../packages/runtime/src/math/physics.ts';
import type { PhysicsBodyDefinition } from '../../../packages/runtime/src/math/physics.ts';
import { rotation4 } from '../../../packages/runtime/src/math/spatial.ts';

await initializePhysics();

function body(id: string, position: PhysicsVector, options: RigidBodyOptions = {}, size: PhysicsVector = [20, 20, 20]): PhysicsBodyDefinition {
  return { id, position, size, rotation: [0, 0, 0], options: parseRigidBody(options) };
}

function close(actual: number, expected: number, tolerance = 0.01) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected} by more than ${tolerance}`);
}

test('authored physics validates once and preserves independent default settings', () => {
  assert.equal(physicsReady(), true);
  const velocity = [20, 30, 40];
  const parsed = parseRigidBody({ velocity, spring: { anchor: [100, 200, 0] } });
  velocity[0] = 99;
  assert.equal(parsed.velocity[0], 20);
  assert.equal(parsed.spring?.stiffness, 100);
  assert.deepEqual(parsePhysicsWorld(true), { gravity: [0, 980, 0], step: 1 / 120 });
  assert.throws(() => parsePhysicsWorld({ gravity: [0, NaN, 0] }), /finite/);
  assert.throws(() => parsePhysicsWorld({ step: 0 }), /step/);
  assert.throws(() => parseRigidBody({ shape: { type: 'box', size: [10, 0, 10] } }), /size/);
  assert.throws(() => parseRigidBody({ mass: 0 }), /mass/);
  assert.throws(() => parseRigidBody({ type: 'kinematic' }), /type/);
  assert.throws(() => parseRigidBody({ restitution: 2 }), /restitution/);
  assert.throws(() => parseRigidBody({ spring: { stiffness: 10 } }), /anchor/);
  assert.throws(() => parseRigidBody({ gravty: 30 }), /Unknown/);
});

test('gravity integrates editable initial velocity in all three scene axes', t => {
  const simulation = createPhysicsSimulation(parsePhysicsWorld({ gravity: [0, 980, -200] }), [body('ball', [100, 50, 20], { velocity: [80, -40, 60] })]);
  t.after(() => simulation.dispose());
  const initial = simulation.sample(-1).get('ball')!;
  close(initial.x, 100);
  close(initial.y, 50);
  const pose = simulation.sample(0.5).get('ball')!;
  close(pose.x, 140);
  close(pose.y, 50 - 40 * 0.5 + 980 * 0.5 ** 2 / 2, 1.1);
  close(pose.z, 20 + 60 * 0.5 - 200 * 0.5 ** 2 / 2, 0.3);
  close(pose.velocity[1], 450, 0.05);
});

test('a dynamic body rebounds from a fixed floor and settles when restitution is zero', t => {
  const make = (restitution: number) => createPhysicsSimulation(parsePhysicsWorld(true), [
    body('ball', [0, 0, 0], { shape: { type: 'sphere', radius: 10 }, restitution }),
    body('floor', [0, 100, 0], { type: 'fixed', restitution }, [400, 10, 400]),
  ]);
  const bouncing = make(0.9);
  const settling = make(0);
  t.after(() => { bouncing.dispose(); settling.dispose(); });
  let upward = false;
  for (let frame = 0; frame < 120; frame++) {
    const pose = bouncing.sample(frame / 120).get('ball')!;
    assert.ok(pose.y < 85.5, 'the sphere cannot pass through the floor');
    if (pose.velocity[1] < -100) upward = true;
  }
  assert.ok(upward, 'restitution produces upward velocity after impact');
  close(settling.sample(3).get('ball')!.y, 85, 0.3);
  close(settling.sample(3).get('floor')!.y, 100);
});

test('dynamic collisions exchange momentum and continuous collision detection catches thin walls', t => {
  const simulation = createPhysicsSimulation(parsePhysicsWorld({ gravity: [0, 0, 0] }), [
    body('left', [-30, 0, 0], { shape: { type: 'sphere', radius: 10 }, velocity: [100, 0, 0], restitution: 1 }),
    body('right', [30, 0, 0], { shape: { type: 'sphere', radius: 10 }, velocity: [-100, 0, 0], restitution: 1 }),
  ]);
  const fast = createPhysicsSimulation(parsePhysicsWorld({ gravity: [0, 0, 0] }), [
    body('bullet', [-100, 0, 0], { shape: { type: 'sphere', radius: 2 }, velocity: [30000, 0, 0], restitution: 0 }),
    body('wall', [0, 0, 0], { type: 'fixed', restitution: 0 }, [2, 200, 200]),
  ]);
  t.after(() => { simulation.dispose(); fast.dispose(); });
  const poses = simulation.sample(0.5);
  assert.ok(poses.get('left')!.velocity[0] < -90);
  assert.ok(poses.get('right')!.velocity[0] > 90);
  close(poses.get('left')!.velocity[0] + poses.get('right')!.velocity[0], 0);
  assert.ok(fast.sample(0.5).get('bullet')!.x <= -2.8, 'CCD stops the body and resolves contact on the near side of the wall');
  close(fast.sample(0.5).get('bullet')!.velocity[0], 0);
});

test('friction slows contact motion without changing authored initial velocity', t => {
  const make = (friction: number) => createPhysicsSimulation(parsePhysicsWorld(true), [
    body('box', [0, 85, 0], { velocity: [150, 0, 0], restitution: 0, friction, lockRotation: true }),
    body('floor', [0, 100, 0], { type: 'fixed', restitution: 0, friction }, [1000, 10, 400]),
  ]);
  const smooth = make(0), rough = make(1);
  t.after(() => { smooth.dispose(); rough.dispose(); });
  assert.ok(smooth.sample(1).get('box')!.x > 140);
  assert.ok(rough.sample(1).get('box')!.x < 40);
  close(rough.sample(0).get('box')!.velocity[0], 150);
});

test('springs oscillate from their initial displacement and editable damping dissipates motion', t => {
  const make = (mass: number, damping: number) => createPhysicsSimulation(parsePhysicsWorld({ gravity: [0, 0, 0] }), [
    body('bob', [200, 0, 0], { mass, spring: { anchor: [100, 0, 0], stiffness: 25, damping, restLength: 0 } }),
  ]);
  const spring = make(1, 0), damped = make(1, 10), heavy = make(4, 0);
  t.after(() => { spring.dispose(); damped.dispose(); heavy.dispose(); });
  assert.ok(spring.sample(0.4).get('bob')!.x < 100, 'the undamped mass overshoots its anchor');
  assert.ok(heavy.sample(0.4).get('bob')!.x > 140, 'a heavier mass responds more slowly to the same spring');
  close(damped.sample(3).get('bob')!.x, 100, 0.5);
  assert.ok(Math.abs(damped.sample(3).get('bob')!.velocity[0]) < 0.1);
});

test('rotation preserves the native Euler convention and initial angular velocity remains editable', t => {
  const tilted = body('tilted', [0, 0, 0], { angularVelocity: [0, 0, 90] });
  tilted.rotation = [25, 35, 65];
  const spinner = body('spinner', [200, 0, 0], { angularVelocity: [0, 0, 90] });
  const locked = body('locked', [400, 0, 0], { angularVelocity: [0, 0, 90], lockRotation: true });
  const simulation = createPhysicsSimulation(parsePhysicsWorld({ gravity: [0, 0, 0] }), [tilted, spinner, locked]);
  t.after(() => simulation.dispose());
  const initial = simulation.sample(0).get('tilted')!;
  const expected = rotation4(...tilted.rotation);
  rotation4(initial.rotationX, initial.rotationY, initial.rotation).forEach((value, index) => close(value, expected[index]!, 1e-6));
  close(simulation.sample(0.5).get('spinner')!.rotation, 45, 0.01);
  close(simulation.sample(0.5).get('locked')!.rotation, 0);
});

test('seeks, fractional frames, checkpoint eviction and a fresh export produce identical poses', t => {
  const settings = parsePhysicsWorld(true);
  const definitions = [
    body('bob', [-40, 0, 0], { velocity: [80, 0, 20], spring: { anchor: [0, 0, 0], stiffness: 8, damping: 0.2, restLength: 50 } }),
    body('ball', [60, -100, 0], { shape: { type: 'sphere', radius: 12 }, restitution: 0.8 }),
    body('floor', [0, 160, 0], { type: 'fixed', restitution: 0.8 }, [800, 10, 800]),
  ];
  const preview = createPhysicsSimulation(settings, definitions);
  t.after(() => preview.dispose());
  for (const time of [3.14159, 10.237, 1.123, 40.2, 0.007, 0, 0.001, 0, 2.72, 15.333, 15.333]) {
    const capture = createPhysicsSimulation(settings, [...definitions].reverse());
    try {
      assert.deepEqual(preview.sample(time), capture.sample(time), `preview and export disagree at ${time}s`);
    } finally {
      capture.dispose();
    }
  }
});

test('recreating a simulation applies edited initial conditions and released simulations reject sampling', () => {
  const original = createPhysicsSimulation(parsePhysicsWorld(true), [body('ball', [0, 0, 0])]);
  const edited = createPhysicsSimulation(parsePhysicsWorld({ gravity: [0, 0, 0] }), [body('ball', [200, 0, 0], { velocity: [50, 0, 0] })]);
  assert.ok(original.sample(0.5).get('ball')!.y > 100);
  close(edited.sample(0.5).get('ball')!.y, 0);
  close(edited.sample(0.5).get('ball')!.x, 225);
  original.dispose();
  original.dispose();
  edited.dispose();
  assert.throws(() => original.sample(0), /disposed/);
});

test('delayed layers activate from their initial pose and stop colliding at their scene end', t => {
  const falling = { ...body('ball', [0, 0, 0], { velocity: [10, 0, 0], restitution: 0 }), start: 0.5 };
  const floor = { ...body('floor', [0, 100, 0], { type: 'fixed', restitution: 0 }, [400, 10, 400]), end: 1.5 };
  const simulation = createPhysicsSimulation(parsePhysicsWorld(true), [falling, floor]);
  t.after(() => simulation.dispose());
  close(simulation.sample(0.5).get('ball')!.y, 0);
  close(simulation.sample(0.5).get('ball')!.x, 0);
  close(simulation.sample(1).get('ball')!.y, 85, 0.5);
  assert.ok(simulation.sample(2).get('ball')!.y > 190, 'the expired floor no longer supports the ball');
  close(simulation.sample(0.25).get('ball')!.y, 0);
  close(simulation.sample(1).get('ball')!.y, 85, 0.5);
});
