/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Entity } from 'koota';
import { GeometryType } from '../constants';
import { Computed, Geometry, PathData } from '../traits';
import type { PathProps } from '@diffusionstudio/jsx';

const PARAMETERS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const TOKEN = /[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g;

type PathTokens = { commands: string; numbers: number[]; parts: (string | number)[] };
const parsedPaths = new Map<string, PathTokens>();

/** Validate SVG commands once at the document boundary; retain command topology for morphs. */
export function parsePathData(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Path d must be an SVG path string');
  pathTokens(value);
  return value;
}

function pathTokens(d: string): PathTokens {
  const cached = parsedPaths.get(d);
  if (cached) return cached;
  const parts: PathTokens['parts'] = [];
  const numbers: number[] = [];
  let commands = '';
  let position = 0;
  let command = '';
  let count = 0;
  const finish = () => {
    const size = PARAMETERS[command.toUpperCase()];
    if (size === undefined || (size === 0 ? count !== 0 : count === 0 || count % size !== 0)) {
      throw new Error(`Invalid SVG path parameters for ${command || 'missing command'}`);
    }
  };
  for (const match of d.matchAll(TOKEN)) {
    if (!/^[\s,]*$/.test(d.slice(position, match.index))) throw new Error('Invalid SVG path data');
    position = match.index + match[0].length;
    const token = match[0];
    if (/^[a-zA-Z]$/.test(token)) {
      if (command) finish();
      if (!parts.length && token.toUpperCase() !== 'M') throw new Error('An SVG path must begin with M');
      if (!(token.toUpperCase() in PARAMETERS)) throw new Error(`Unsupported SVG path command ${token}`);
      command = token;
      count = 0;
      commands += token;
      parts.push(token);
      continue;
    }
    const number = Number(token);
    if (!command || !Number.isFinite(number)) throw new Error('Invalid SVG path coordinate');
    if (command.toUpperCase() === 'A') {
      const field = count % 7;
      if (field < 2 && number < 0) throw new Error('SVG arc radii must be nonnegative');
      if ((field === 3 || field === 4) && number !== 0 && number !== 1) throw new Error('SVG arc flags must be 0 or 1');
    }
    numbers.push(number);
    parts.push(number);
    count++;
  }
  if (!/^[\s,]*$/.test(d.slice(position))) throw new Error('Invalid SVG path data');
  if (command) finish();
  const parsed = { commands, numbers, parts };
  // Sampled paths change every frame; retain a bounded working set.
  if (parsedPaths.size >= 256) parsedPaths.delete(parsedPaths.keys().next().value!);
  parsedPaths.set(d, parsed);
  return parsed;
}

export function parsePathViewBox(value: unknown): PathProps['viewBox'] {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length !== 4 || !value.every((part) => typeof part === 'number' && Number.isFinite(part))) {
    throw new Error('Path viewBox must be [x, y, width, height]');
  }
  const [x, y, width, height] = value as [number, number, number, number];
  if (width <= 0 || height <= 0) throw new Error('Path viewBox width and height must be positive');
  return [x, y, width, height];
}

/** Compatible path topology morphs; other shapes hold until the next keyframe. */
export function interpolatePathData(from: string, to: string, progress: number): string {
  if (progress === 0 || from === to) return from;
  if (progress === 1) return to;
  const a = pathTokens(from);
  const b = pathTokens(to);
  if (a.commands !== b.commands || a.parts.length !== b.parts.length || a.parts.some((part, i) => typeof part !== typeof b.parts[i])) return from;
  // Arc flags are discrete, so arcs with changing flags do not morph.
  let command = '';
  let field = 0;
  for (let i = 0; i < a.parts.length; i++) {
    const part = a.parts[i]!;
    if (typeof part === 'string') { command = part; field = 0; continue; }
    if (command.toUpperCase() === 'A' && (field % 7 === 3 || field % 7 === 4) && part !== b.parts[i]) return from;
    field++;
  }
  let index = 0;
  return a.parts.map((part) => {
    if (typeof part === 'string') return part;
    const end = b.numbers[index++]!;
    return Number((part + (end - part) * progress).toFixed(6));
  }).join(' ');
}

const renderedPaths = new Map<string, Path2D>();

/** Local-space geometry for fill, stroke and clip. Null lets existing rect/text rendering continue. */
export function geometryPath(entity: Entity): Path2D | null {
  const type = entity.get(Geometry)?.value;
  if (type !== GeometryType.PATH && type !== GeometryType.ELLIPSE) return null;
  const computed = entity.get(Computed)!;
  const { width, height } = computed;
  const data = entity.get(PathData);
  const key = JSON.stringify([type, width, height, computed.pathData, data?.viewBox]);
  const cached = renderedPaths.get(key);
  if (cached) return cached;
  const path = new Path2D();
  if (type === GeometryType.ELLIPSE) {
    path.ellipse(width / 2, height / 2, Math.abs(width) / 2, Math.abs(height) / 2, 0, 0, Math.PI * 2);
  } else if (data?.viewBox) {
    const [x, y, sourceWidth, sourceHeight] = data.viewBox;
    const sx = width / sourceWidth;
    const sy = height / sourceHeight;
    path.addPath(new Path2D(computed.pathData), { a: sx, b: 0, c: 0, d: sy, e: -x * sx, f: -y * sy });
  } else {
    path.addPath(new Path2D(computed.pathData));
  }
  if (renderedPaths.size >= 256) renderedPaths.delete(renderedPaths.keys().next().value!);
  renderedPaths.set(key, path);
  return path;
}

type Point = { x: number; y: number };
type ProjectPoint = (x: number, y: number) => Point;

/** Curves are sampled after projection so the mask follows the rendered plane, including holes. */
export function projectedGeometryPath(entity: Entity, mapPoint: ProjectPoint, tolerance = 0.5): Path2D | null {
  const type = entity.get(Geometry)?.value;
  if (type !== GeometryType.PATH && type !== GeometryType.ELLIPSE) return null;
  const computed = entity.get(Computed)!;
  const { width, height } = computed;
  const result = new Path2D();
  const viewBox = entity.get(PathData)?.viewBox;
  const project: ProjectPoint = type === GeometryType.PATH && viewBox
    ? (x, y) => mapPoint((x - viewBox[0]) * width / viewBox[2], (y - viewBox[1]) * height / viewBox[3])
    : mapPoint;
  const move = (point: Point) => { const p = project(point.x, point.y); result.moveTo(p.x, p.y); };
  const line = (point: Point) => { const p = project(point.x, point.y); result.lineTo(p.x, p.y); };
  const curve = (at: (time: number) => Point) => {
    const sample = (time: number) => { const p = at(time); return project(p.x, p.y); };
    appendProjectedCurve(result, sample, Math.max(0.01, tolerance));
  };
  if (type === GeometryType.ELLIPSE) {
    move({ x: width, y: height / 2 });
    for (let quarter = 0; quarter < 4; quarter++) {
      curve((time) => {
        const angle = (quarter + time) * Math.PI / 2;
        return { x: width / 2 + Math.cos(angle) * width / 2, y: height / 2 + Math.sin(angle) * height / 2 };
      });
    }
    result.closePath();
    return result;
  }
  const parts = pathTokens(computed.pathData).parts;
  let current: Point = { x: 0, y: 0 };
  let start = current;
  let control = current;
  let previous = '';
  let command = '';
  let index = 0;
  while (index < parts.length) {
    const part = parts[index];
    if (typeof part === 'string') {
      command = part;
      index++;
    }
    const operation = command.toUpperCase();
    const relative = command !== operation;
    if (operation === 'Z') {
      result.closePath();
      current = start;
      previous = operation;
      continue;
    }
    const count = PARAMETERS[operation]!;
    const values = parts.slice(index, index + count) as number[];
    index += count;
    const point = (offset = 0): Point => ({ x: values[offset]! + (relative ? current.x : 0), y: values[offset + 1]! + (relative ? current.y : 0) });
    if (operation === 'M') {
      current = point();
      start = current;
      move(current);
      command = relative ? 'l' : 'L';
    } else if (operation === 'L' || operation === 'H' || operation === 'V') {
      current = operation === 'H'
        ? { x: values[0]! + (relative ? current.x : 0), y: current.y }
        : operation === 'V' ? { x: current.x, y: values[0]! + (relative ? current.y : 0) } : point();
      line(current);
    } else if (operation === 'C' || operation === 'S') {
      const from = current;
      const first = operation === 'C' ? point() : previous === 'C' || previous === 'S' ? { x: 2 * from.x - control.x, y: 2 * from.y - control.y } : from;
      const second = point(operation === 'C' ? 2 : 0);
      const end = point(operation === 'C' ? 4 : 2);
      curve((time) => {
        const inverse = 1 - time;
        return {
          x: inverse ** 3 * from.x + 3 * inverse ** 2 * time * first.x + 3 * inverse * time ** 2 * second.x + time ** 3 * end.x,
          y: inverse ** 3 * from.y + 3 * inverse ** 2 * time * first.y + 3 * inverse * time ** 2 * second.y + time ** 3 * end.y,
        };
      });
      current = end;
      control = second;
    } else if (operation === 'Q' || operation === 'T') {
      const from = current;
      const first = operation === 'Q' ? point() : previous === 'Q' || previous === 'T' ? { x: 2 * from.x - control.x, y: 2 * from.y - control.y } : from;
      const end = point(operation === 'Q' ? 2 : 0);
      curve((time) => ({
        x: (1 - time) ** 2 * from.x + 2 * (1 - time) * time * first.x + time ** 2 * end.x,
        y: (1 - time) ** 2 * from.y + 2 * (1 - time) * time * first.y + time ** 2 * end.y,
      }));
      current = end;
      control = first;
    } else if (operation === 'A') {
      const end = point(5);
      const arc = arcCurve(current, end, values[0]!, values[1]!, values[2]!, values[3]!, values[4]!);
      if (arc) curve(arc);
      else line(end);
      current = end;
    }
    previous = operation;
  }
  return result;
}

function appendProjectedCurve(path: Path2D, at: (time: number) => Point, tolerance: number): void {
  const subdivide = (from: number, to: number, a: Point, b: Point, depth: number): void => {
    const middle = (from + to) / 2;
    const center = at(middle);
    const near = at((from + middle) / 2);
    const far = at((middle + to) / 2);
    const error = (point: Point, ratio: number) => Math.hypot(point.x - a.x - (b.x - a.x) * ratio, point.y - a.y - (b.y - a.y) * ratio);
    if (depth >= 12 || Math.max(error(center, 0.5), error(near, 0.25), error(far, 0.75)) <= tolerance) {
      path.lineTo(b.x, b.y);
      return;
    }
    subdivide(from, middle, a, center, depth + 1);
    subdivide(middle, to, center, b, depth + 1);
  };
  subdivide(0, 1, at(0), at(1), 0);
}

/** SVG endpoint-to-center arc conversion. */
function arcCurve(from: Point, to: Point, rx: number, ry: number, degrees: number, large: number, sweep: number): ((time: number) => Point) | null {
  if (!rx || !ry || (from.x === to.x && from.y === to.y)) return null;
  const angle = degrees * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const x = cos * (from.x - to.x) / 2 + sin * (from.y - to.y) / 2;
  const y = -sin * (from.x - to.x) / 2 + cos * (from.y - to.y) / 2;
  const expansion = Math.max(1, Math.hypot(x / rx, y / ry));
  rx *= expansion;
  ry *= expansion;
  const denominator = rx ** 2 * y ** 2 + ry ** 2 * x ** 2;
  const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (rx ** 2 * ry ** 2 - denominator) / denominator));
  const cx = factor * rx * y / ry, cy = -factor * ry * x / rx;
  const centerX = cos * cx - sin * cy + (from.x + to.x) / 2;
  const centerY = sin * cx + cos * cy + (from.y + to.y) / 2;
  const start = Math.atan2((y - cy) / ry, (x - cx) / rx);
  let span = Math.atan2((-y - cy) / ry, (-x - cx) / rx) - start;
  if (sweep && span < 0) span += Math.PI * 2;
  if (!sweep && span > 0) span -= Math.PI * 2;
  return (time) => {
    if (time === 0) return from;
    if (time === 1) return to;
    const theta = start + span * time;
    return { x: centerX + cos * rx * Math.cos(theta) - sin * ry * Math.sin(theta), y: centerY + sin * rx * Math.cos(theta) + cos * ry * Math.sin(theta) };
  };
}

/** Fill and clip share the authored SVG winding rule. */
export function geometryFillRule(entity: Entity): CanvasFillRule {
  return entity.get(PathData)?.fillRule ?? 'nonzero';
}
