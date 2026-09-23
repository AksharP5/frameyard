/** Defaults and bounds shared by authoring, keyframes and the native inspector. */
export const SPATIAL_PARAMETERS = {
  depth: [100, 0, Infinity],
  scaleZ: [1, -Infinity, Infinity],
  roughness: [0.5, 0, 1],
  metalness: [0, 0, 1],
  transmission: [0, 0, 1],
  ior: [1.5, 1, 2.5],
  emissiveIntensity: [0, 0, Infinity],
  ambientIntensity: [0.4, 0, Infinity],
  intensity: [1, 0, Infinity],
  distance: [0, 0, Infinity],
  decay: [2, 0, Infinity],
  coneAngle: [30, 0.01, 90],
  penumbra: [0.3, 0, 1],
  targetX: [0, -Infinity, Infinity],
  targetY: [0, -Infinity, Infinity],
  targetZ: [0, -Infinity, Infinity],
  pointSize: [4, 0, Infinity],
  density: [0.7, 0, 10],
  noiseScale: [3, 0.01, 100],
  flowSpeed: [0.2, -100, 100],
  scatter: [0.5, 0, 1],
  fogDensity: [0, 0, 1],
  renderOrder: [0, -Infinity, Infinity],
  cameraOffsetX: [0, -Infinity, Infinity],
  cameraOffsetY: [0, -Infinity, Infinity],
  x1: [0, -Infinity, Infinity],
  y1: [0.5, -Infinity, Infinity],
  x2: [1, -Infinity, Infinity],
  y2: [0.5, -Infinity, Infinity],
  centerX: [0.5, -Infinity, Infinity],
  centerY: [0.5, -Infinity, Infinity],
  radiusX: [0.5, Number.MIN_VALUE, Infinity],
  radiusY: [0.5, Number.MIN_VALUE, Infinity],
  focalX: [0.5, -Infinity, Infinity],
  focalY: [0.5, -Infinity, Infinity],
  dashOffset: [0, -Infinity, Infinity],
} as const;

export type SpatialParameter = keyof typeof SPATIAL_PARAMETERS;
export const SPATIAL_DEFAULTS = Object.fromEntries(
  Object.entries(SPATIAL_PARAMETERS).map(([name, [value]]) => [name, value]),
) as Record<SpatialParameter, number>;
export const SPATIAL_PROPERTY_PATHS = Object.fromEntries(
  Object.keys(SPATIAL_PARAMETERS).map(name => [name, `spatial.${name}`]),
) as { [K in SpatialParameter]: `spatial.${K}` };

export const SPATIAL_ARRAYS = ['points', 'pointColors', 'vertices', 'vertexColors'] as const;
export type SpatialArray = typeof SPATIAL_ARRAYS[number];
export const SPATIAL_ARRAY_PATHS = Object.fromEntries(
  SPATIAL_ARRAYS.map(name => [name, `spatial.${name}`]),
) as { [K in SpatialArray]: `spatial.${K}` };

export const MESH_SHAPES = ['box', 'sphere', 'plane', 'cylinder', 'cone', 'torus', 'custom'] as const;
export type MeshShape = typeof MESH_SHAPES[number];
export const LIGHT_TYPES = ['ambient', 'directional', 'point', 'spot'] as const;
export type LightType = typeof LIGHT_TYPES[number];

export function parseSpatialParameter(name: SpatialParameter, value: unknown): number {
  const [fallback, minimum, maximum] = SPATIAL_PARAMETERS[name];
  if (value === false || value == null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a finite number between ${minimum} and ${maximum}`);
  }
  return value;
}

export function parseNumberArray(value: unknown, name: string, stride = 1): number[] {
  if (value === false || value == null) return [];
  if (!Array.isArray(value) || value.length % stride || !value.every(item => typeof item === 'number' && Number.isFinite(item))) {
    throw new Error(`${name} must contain finite numbers in groups of ${stride}`);
  }
  return [...value];
}

export function validateCustomMeshGeometry(data: {
  vertices: readonly number[];
  indices: readonly number[];
  normals: readonly number[];
  uv: readonly number[];
  vertexColors: readonly number[];
}): void {
  const count = data.vertices.length / 3;
  if (!Number.isInteger(count)) throw new Error('Custom mesh vertices must contain XYZ groups');
  if (data.indices.length % 3) throw new Error('Custom mesh indices must contain triangles in groups of 3');
  for (const index of data.indices) {
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw new Error(`Custom mesh index ${index} is outside its ${count} vertices`);
    }
  }
  if (data.normals.length && data.normals.length !== count * 3) throw new Error('Custom mesh normals must have one XYZ group per vertex');
  if (data.uv.length && data.uv.length !== count * 2) throw new Error('Custom mesh uv must have one UV pair per vertex');
  if (data.vertexColors.length && data.vertexColors.length !== count * 4) throw new Error('Custom mesh vertexColors must have one RGBA group per vertex');
}

export function validatePointCloudGeometry(data: { points: readonly number[]; pointColors: readonly number[] }): void {
  if (data.points.length % 3) throw new Error('Point cloud points must contain XYZ groups');
  if (data.pointColors.length && data.pointColors.length !== data.points.length / 3 * 4) {
    throw new Error('Point cloud pointColors must have one RGBA group per point');
  }
}

/** Absolute 3D curves: each point contains x, y and z in local pixels. */
export function parsePath3D(value: unknown): string {
  if (typeof value !== 'string') throw new Error('3D path d must be a string');
  const sizes = { M: 3, L: 3, C: 9, Q: 6, Z: 0 } as const;
  let command: keyof typeof sizes | undefined;
  let count = 0, end = 0;
  const finish = () => {
    if (!command || (sizes[command] ? count === 0 || count % sizes[command] : count !== 0)) throw new Error('Invalid 3D path coordinates');
  };
  for (const token of value.matchAll(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g)) {
    if (!/^[\s,]*$/.test(value.slice(end, token.index))) throw new Error('Invalid 3D path data');
    const part = token[0]; end = token.index + part.length;
    if (/^[A-Za-z]$/.test(part)) {
      if (command) finish();
      else if (part !== 'M') throw new Error('A 3D path must start with M');
      if (!Object.hasOwn(sizes, part)) throw new Error('3D paths support absolute M, L, C, Q and Z');
      command = part as keyof typeof sizes; count = 0;
    } else {
      if (!command || !Number.isFinite(Number(part))) throw new Error('Invalid 3D path coordinate');
      count++;
    }
  }
  if (command) finish();
  if (!/^[\s,]*$/.test(value.slice(end))) throw new Error('Invalid 3D path data');
  return value;
}

export function interpolatePath3D(from: string, to: string, progress: number): string {
  if (progress <= 0 || from === to) return from;
  if (progress >= 1) return to;
  const pattern = /[MLCQZ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g;
  const a = from.match(pattern) ?? [], b = to.match(pattern) ?? [];
  if (a.length !== b.length || a.some((value, i) => (/^[MLCQZ]$/.test(value) || /^[MLCQZ]$/.test(b[i]!)) && value !== b[i])) return from;
  return a.map((value, i) => /^[MLCQZ]$/.test(value) ? value : String(Number((Number(value) + (Number(b[i]) - Number(value)) * progress).toFixed(6)))).join(' ');
}
