import { trait } from 'koota';
import { SPATIAL_DEFAULTS, type MeshShape, type LightType, type PhysicsWorldSettings, type RigidBodySettings, type NumericArray } from '@diffusionstudio/jsx';

export const Scene3D = trait();
export const SpatialParameters = trait({ ...SPATIAL_DEFAULTS });
export const SpatialGeometry = trait({
  shape: 'box' as MeshShape,
  path: '',
  points: () => [] as NumericArray,
  pointColors: () => [] as NumericArray,
  vertices: () => [] as NumericArray,
  indices: () => [] as NumericArray,
  normals: () => [] as NumericArray,
  uv: () => [] as NumericArray,
  vertexColors: () => [] as NumericArray,
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
