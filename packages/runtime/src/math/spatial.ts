import type { Mat2D } from './matrix2d';

/** Column-major, matching WebGL. Positive Z moves a layer toward the camera. */
export type Mat4 = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

export function identity4(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function multiply4(a: Mat4, b: Mat4): Mat4 {
  const out: [...Mat4] = [...identity4()];
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      out[column * 4 + row] = a[row]! * b[column * 4]!
        + a[row + 4]! * b[column * 4 + 1]!
        + a[row + 8]! * b[column * 4 + 2]!
        + a[row + 12]! * b[column * 4 + 3]!;
    }
  }
  return out;
}

export function affine4(m: Mat2D): Mat4 {
  return [m.a, m.b, 0, 0, m.c, m.d, 0, 0, 0, 0, 1, 0, m.e, m.f, 0, 1];
}

export function translation4(x: number, y: number, z: number): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

export function rotation4(x: number, y: number, z = 0): Mat4 {
  const factor = Math.PI / 180;
  const sx = Math.sin(x * factor), cx = Math.cos(x * factor);
  const sy = Math.sin(y * factor), cy = Math.cos(y * factor);
  const sz = Math.sin(z * factor), cz = Math.cos(z * factor);
  // Rz * Ry * Rx, so roll remains in the layer's parent plane.
  return [
    cz * cy, sz * cy, -sy, 0,
    cz * sy * sx - sz * cx, sz * sy * sx + cz * cx, cy * sx, 0,
    cz * sy * cx + sz * sx, sz * sy * cx - cz * sx, cy * cx, 0,
    0, 0, 0, 1,
  ];
}

export type PerspectiveCamera = {
  x: number; y: number; z: number;
  rotationX: number; rotationY: number; rotation: number;
  perspective: number; zoom: number;
  width: number; height: number;
  offsetX?: number; offsetY?: number;
};

/** Project an object's local XY plane into scene pixels, retaining its denominator. */
export function projectPlane(model: Mat4, camera: PerspectiveCamera): Mat2D {
  const inverseRotation = multiply4(
    rotation4(-camera.rotationX, 0),
    multiply4(rotation4(0, -camera.rotationY), rotation4(0, 0, -camera.rotation)),
  );
  const view = multiply4(inverseRotation, translation4(-camera.x, -camera.y, -camera.z));
  const m = multiply4(view, model);
  const focal = camera.perspective * camera.zoom;
  const cx = camera.width / 2 + (camera.offsetX ?? 0), cy = camera.height / 2 + (camera.offsetY ?? 0);
  return {
    a: focal * m[0] - cx * m[2], b: focal * m[1] - cy * m[2],
    c: focal * m[4] - cx * m[6], d: focal * m[5] - cy * m[6],
    e: focal * m[12] - cx * m[14], f: focal * m[13] - cy * m[14],
    g: -m[2], h: -m[6], i: -m[14],
  };
}

export function scale4(x: number, y: number, z: number): Mat4 {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

export function transformPoint3D(m: Mat4, x: number, y: number, z: number): { x: number; y: number; z: number } {
  return { x: m[0] * x + m[4] * y + m[8] * z + m[12], y: m[1] * x + m[5] * y + m[9] * z + m[13], z: m[2] * x + m[6] * y + m[10] * z + m[14] };
}

export function projectPoint3D(model: Mat4, camera: PerspectiveCamera, x: number, y: number, z: number): { x: number; y: number; depth: number } {
  const plane = projectPlane(multiply4(model, translation4(x, y, z)), camera);
  const depth = plane.i ?? 1;
  return { x: plane.e / depth, y: plane.f / depth, depth };
}
