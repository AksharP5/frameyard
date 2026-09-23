import { trait } from 'koota';
import { SPATIAL_DEFAULTS, type MeshShape, type LightType, type PhysicsWorldSettings, type RigidBodySettings } from '@diffusionstudio/jsx';

export const Scene3D = trait();
export const SpatialParameters = trait({ ...SPATIAL_DEFAULTS });
export const SpatialGeometry = trait({
  shape: 'box' as MeshShape,
  path: '',
  points: () => [] as number[],
  pointColors: () => [] as number[],
  vertices: () => [] as number[],
  indices: () => [] as number[],
  normals: () => [] as number[],
  uv: () => [] as number[],
  vertexColors: () => [] as number[],
});
export const SpatialMaterial = trait({
  lit: true,
  wireframe: false,
  castShadow: true,
  receiveShadow: true,
  depthTest: true,
  emissive: '#000000',
  fogColor: '#ffffff',
});
export const LightSource = trait({ type: 'point' as LightType });
export const GradientSpace = trait({ value: 'local' as 'local' | 'screen' });
export const StrokeDash = trait({ value: () => [] as number[] });
export const PhysicsWorld = trait({ settings: () => null as PhysicsWorldSettings | null });
export const RigidBody = trait({ settings: () => null as RigidBodySettings | null });
