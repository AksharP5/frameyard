import * as THREE from 'three';
import type { Entity } from 'koota';
import { validateCustomMeshGeometry } from '@diffusionstudio/jsx';
import { Computed, SpatialGeometry } from '../traits';

export type SpatialCurve = { points: THREE.Vector3[]; closed: boolean };

/** Sample each authored contour separately so disconnected curves never gain connecting strokes. */
export function sampleSpatialPath(path: string, segments = 16): SpatialCurve[] {
  const tokens = path.match(/[MLCQZ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) ?? [];
  const result: SpatialCurve[] = [];
  let current: SpatialCurve | undefined, command = '', i = 0;
  const point = () => new THREE.Vector3(Number(tokens[i++]), Number(tokens[i++]), Number(tokens[i++]));
  while (i < tokens.length) {
    if (/^[MLCQZ]$/.test(tokens[i]!)) command = tokens[i++]!;
    if (command === 'Z') { if (current) current.closed = true; command = ''; continue; }
    if (command === 'M') { current = { points: [point()], closed: false }; result.push(current); command = 'L'; continue; }
    if (!current || !command) throw new Error('Invalid 3D curve');
    if (command === 'L') { current.points.push(point()); continue; }
    const start = current.points.at(-1)!;
    const curve = command === 'C' ? new THREE.CubicBezierCurve3(start, point(), point(), point()) : new THREE.QuadraticBezierCurve3(start, point(), point());
    current.points.push(...curve.getPoints(segments).slice(1));
  }
  return result;
}

/** Triangulate planar contours on their dominant plane, retaining the authored XYZ vertices. */
export function spatialPathGeometry(contours: SpatialCurve[]): THREE.BufferGeometry {
  const vertices: number[] = [], indices: number[] = [];
  for (const contour of contours) {
    const points = [...contour.points];
    if (points.length > 1 && points[0]!.distanceToSquared(points.at(-1)!) < 1e-12) points.pop();
    if (points.length < 3) continue;
    const normal = new THREE.Vector3();
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!, b = points[(i + 1) % points.length]!;
      normal.x += (a.y - b.y) * (a.z + b.z); normal.y += (a.z - b.z) * (a.x + b.x); normal.z += (a.x - b.x) * (a.y + b.y);
    }
    const axis = Math.abs(normal.x) > Math.abs(normal.y) && Math.abs(normal.x) > Math.abs(normal.z) ? 'x' : Math.abs(normal.y) > Math.abs(normal.z) ? 'y' : 'z';
    const projected = points.map(p => axis === 'x' ? new THREE.Vector2(p.y, p.z) : axis === 'y' ? new THREE.Vector2(p.x, p.z) : new THREE.Vector2(p.x, p.y));
    const offset = vertices.length / 3;
    for (const p of points) vertices.push(p.x, p.y, p.z);
    for (const face of THREE.ShapeUtils.triangulateShape(projected, [])) indices.push(...face.map(index => index + offset));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

export function meshGeometry(entity: Entity): THREE.BufferGeometry {
  const c = entity.get(Computed)!, data = entity.get(SpatialGeometry)!;
  if (data.shape === 'custom') {
    validateCustomMeshGeometry({ vertices: c.vertices, indices: data.indices, normals: data.normals, uv: data.uv, vertexColors: c.vertexColors });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(c.vertices, 3));
    if (data.indices.length) geometry.setIndex(data.indices);
    if (data.normals.length) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(data.normals, 3));
    else geometry.computeVertexNormals();
    if (data.uv.length) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(data.uv, 2));
    if (c.vertexColors.length) geometry.setAttribute('color', new THREE.Float32BufferAttribute(c.vertexColors, 4));
    return geometry;
  }
  const w = Math.max(.001, c.width), h = Math.max(.001, c.height), d = Math.max(.001, c.depth);
  let geometry: THREE.BufferGeometry;
  switch (data.shape) {
    case 'sphere': geometry = new THREE.SphereGeometry(.5, 40, 24); geometry.scale(w, h, d); break;
    case 'plane': geometry = new THREE.PlaneGeometry(w, h); geometry.rotateX(Math.PI); break;
    case 'cylinder': geometry = new THREE.CylinderGeometry(.5, .5, 1, 40); geometry.scale(w, h, d); break;
    case 'cone': geometry = new THREE.ConeGeometry(.5, 1, 40); geometry.rotateZ(Math.PI); geometry.scale(w, h, d); break;
    case 'torus': geometry = new THREE.TorusGeometry(.35, .15, 16, 48); geometry.scale(w, h, d); break;
    default: geometry = new THREE.BoxGeometry(w, h, d);
  }
  geometry.translate(w / 2, h / 2, 0);
  return geometry;
}
