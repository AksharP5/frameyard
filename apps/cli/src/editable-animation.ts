import type { AuthoredTree } from "@diffusionstudio/jsx";
import { ANIMATABLE_PROPERTIES } from "../../../packages/jsx/src/types.ts";
import { SPATIAL_PARAMETERS, parsePath3D, parseSpatialParameter, type SpatialParameter } from "../../../packages/jsx/src/spatial.ts";

const propertyTypes = {
  ...Object.fromEntries(Object.keys(SPATIAL_PARAMETERS).map(name => [name, "number"])) as { [K in SpatialParameter]: "number" },
  x: "number", y: "number", width: "number", height: "number", rotation: "number",
  scaleX: "number", scaleY: "number", opacity: "number", cornerRadius: "number",
  anchorX: "number", anchorY: "number", skewX: "number", fillRule: "string",
  cornerRadiusTopLeft: "number", cornerRadiusTopRight: "number", cornerRadiusBottomLeft: "number", cornerRadiusBottomRight: "number",
  d: "string", viewBox: "box", src: "string", text: "string", fontFamily: "string",
  fontSize: "number", fontWeight: "number", fontStyle: "string", letterSpacing: "number",
  leading: "number", textBaseline: "string", textAlign: "string", mask: "boolean",
  fill: "string", fillOpacity: "number", stroke: "string", strokeWidth: "number", strokeOpacity: "number",
  strokeCap: "string", strokeJoin: "string", strokeMiterLimit: "number",
  strokeDash: "array", strokeDashOffset: "number",
  color: "string", offset: "number", blur: "number", offsetX: "number", offsetY: "number",
  type: "string", value: "number", cap: "string", join: "string", miterLimit: "number",
  z: "number", rotationX: "number", rotationY: "number", skewY: "number", scale: "number",
  perspective: "number", cameraX: "number", cameraY: "number", cameraZ: "number", cameraZoom: "number",
  cameraRotationX: "number", cameraRotationY: "number", cameraRotation: "number",
  depthSort: "string", depthTest: "boolean", gradientSpace: "string",
  points: "array", pointColors: "array", vertices: "array", indices: "array", normals: "array", uv: "array", vertexColors: "array", dash: "array",
  shape: "string", emissive: "string", fogColor: "string", lit: "boolean", wireframe: "boolean", castShadow: "boolean", receiveShadow: "boolean",
} as const;
const layerKinds = ["group", "rect", "ellipse", "text", "image", "path", "scene3d", "path3d", "pointCloud", "mesh", "light", "volume", "solidPaint", "linearGradientPaint", "radialGradientPaint", "colorStop", "stroke", "effect", "shadow"] as const;
const styleKinds = new Set<string>(["solidPaint", "linearGradientPaint", "radialGradientPaint", "colorStop", "stroke", "effect", "shadow"]);
const arrayWidths = { points: 3, pointColors: 4, vertices: 3, normals: 3, vertexColors: 4, uv: 2 } as const;
type Property = keyof typeof propertyTypes;
type Props = Partial<{ [K in Property]: typeof propertyTypes[K] extends "number" ? number : typeof propertyTypes[K] extends "string" ? string : typeof propertyTypes[K] extends "boolean" ? boolean : number[] }>;
type Frame = { time: number; props: Props };
type Layer = { id: string; parent?: string; kind: typeof layerKinds[number]; name: string; frames: Frame[] };
export type ConversionIssue = { layer: string; feature: string };
type Capture = { width: number; height: number; duration: number; frameRate: number; layers: Layer[]; issues: ConversionIssue[] };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`Invalid captured ${label}.`);
  return value;
}

/** The sampler's transient data is validated here; only native JSX is published. */
function parseCapture(value: unknown): Capture {
  if (!record(value) || !Array.isArray(value.layers) || !Array.isArray(value.issues)) throw new Error("Invalid animation capture.");
  const duration = positive(value.duration, "duration");
  const ids = new Set<string>();
  const layers = value.layers.map((layer): Layer => {
    if (!record(layer) || typeof layer.id !== "string" || !layer.id || ids.has(layer.id) || typeof layer.name !== "string" || !Array.isArray(layer.frames)
      || (layer.parent !== undefined && (typeof layer.parent !== "string" || !ids.has(layer.parent)))
      || !layerKinds.some(kind => kind === layer.kind)) throw new Error("Invalid captured layer hierarchy.");
    ids.add(layer.id);
    let previous = -1;
    const frames = layer.frames.map((frame): Frame => {
      if (!record(frame) || !record(frame.props) || typeof frame.time !== "number" || !Number.isFinite(frame.time) || frame.time < 0 || frame.time < previous || frame.time > duration + 0.001) throw new Error(`Invalid captured frame in ${layer.name}.`);
      previous = frame.time;
      const props: Props = {};
      for (const [name, item] of Object.entries(frame.props)) {
        if (!(name in propertyTypes)) throw new Error(`Unsupported captured property: ${name}`);
        const kind = propertyTypes[name as Property];
        if (kind === "array" ? !Array.isArray(item) || item.some(n => typeof n !== "number" || !Number.isFinite(n))
          : kind === "box" ? !Array.isArray(item) || item.length !== 4 || item.some(n => typeof n !== "number" || !Number.isFinite(n)) || item[2] <= 0 || item[3] <= 0
          : typeof item !== kind || (typeof item === "number" && !Number.isFinite(item))) throw new Error(`Invalid captured ${name}.`);
        if (Array.isArray(item) && (name in arrayWidths && item.length % arrayWidths[name as keyof typeof arrayWidths] !== 0
          || name === "indices" && item.some(index => !Number.isInteger(index) || index < 0)
          || name === "dash" && item.some(length => length < 0))) throw new Error(`Invalid captured ${name}.`);
        if (name in SPATIAL_PARAMETERS) parseSpatialParameter(name as SpatialParameter, item);
        if (layer.kind === "path3d" && name === "d") parsePath3D(item);
        Object.assign(props, { [name]: item });
      }
      return { time: frame.time, props };
    });
    if (!frames.length) throw new Error(`Captured layer ${layer.name} has no frames.`);
    if (layer.kind === "path3d" && frames[0].props.d === undefined || layer.kind === "pointCloud" && frames[0].props.points === undefined) throw new Error(`Captured layer ${layer.name} has no geometry.`);
    return { id: layer.id, parent: layer.parent, kind: layer.kind as Layer["kind"], name: layer.name, frames };
  });
  const issues = value.issues.map(issue => {
    if (!record(issue) || typeof issue.layer !== "string" || typeof issue.feature !== "string") throw new Error("Invalid conversion issue.");
    return { layer: issue.layer, feature: issue.feature };
  });
  return { width: positive(value.width, "width"), height: positive(value.height, "height"), frameRate: positive(value.frameRate, "frameRate"), duration, layers, issues };
}

type Key = { time: number; value: number | string | number[] };
const sameValue = (first: Key["value"], second: Key["value"]) => Array.isArray(first) && Array.isArray(second) ? first.length === second.length && first.every((value, index) => value === second[index]) : first === second;

/** Reduce sampled numeric motion within 0.01 units while retaining holds and extrema. */
export function simplifyKeys(keys: Key[], tolerance = 0.01): Key[] {
  if (keys.length < 3) return keys;
  if (typeof keys[0].value === "string" || keys.some(key => Array.isArray(key.value) && (!Array.isArray(keys[0].value) || key.value.length !== keys[0].value.length))) return keys.filter((key, i) => i === 0 || i === keys.length - 1 || !sameValue(key.value, keys[i - 1].value) || !sameValue(key.value, keys[i + 1].value));
  const keep = new Set([0, keys.length - 1]);
  const pending = [[0, keys.length - 1]];
  while (pending.length) {
    const [first, last] = pending.pop()!;
    let maximum = tolerance, farthest = -1;
    for (let i = first + 1; i < last; i++) {
      const progress = (keys[i].time - keys[first].time) / (keys[last].time - keys[first].time || 1);
      const start = keys[first].value, end = keys[last].value, current = keys[i].value;
      const error = Array.isArray(start) && Array.isArray(end) && Array.isArray(current)
        ? current.reduce((maximum, value, index) => Math.max(maximum, Math.abs(value - (start[index] + (end[index] - start[index]) * progress))), 0)
        : Math.abs(Number(current) - (Number(start) + (Number(end) - Number(start)) * progress));
      if (error > maximum) { maximum = error; farthest = i; }
    }
    if (farthest >= 0) { keep.add(farthest); pending.push([first, farthest], [farthest, last]); }
  }
  return [...keep].sort((a, b) => a - b).map(i => keys[i]);
}

const animated = new Set(Object.keys(ANIMATABLE_PROPERTIES));
const paintProperties = new Set<Property>(["fill", "fillOpacity", "stroke", "strokeWidth", "strokeOpacity", "strokeCap", "strokeJoin", "strokeMiterLimit", "strokeDash", "strokeDashOffset"]);
const attr = (name: string, value: unknown) => ` ${name}={${JSON.stringify(value)}}`;

function serializeTree(tree: AuthoredTree, depth: number): string {
  const indent = "  ".repeat(depth);
  const attrs = Object.entries(tree.props).map(([name, value]) => attr(name, value)).join("");
  const children = [
    ...(tree.text === undefined ? [] : [`${indent}  {${JSON.stringify(tree.text)}}`]),
    ...tree.children.map(child => serializeTree(child, depth + 1)),
  ];
  return `${indent}<${tree.tag}${attrs}${children.length ? `>\n${children.join("\n")}\n${indent}</${tree.tag}>` : " />"}`;
}

export function capturedAnimationToJsx(input: unknown, prefix: string, name: string, allowPartial = false) {
  const capture = parseCapture(input);
  const issues = [...capture.issues];
  let keyframeCount = 0;
  const uid = (value: string) => `${prefix}-${value.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const nativeIds = new Set<string>([prefix]);
  const childrenByParent = new Map<string | undefined, Layer[]>();
  for (const layer of capture.layers) {
    if (nativeIds.has(uid(layer.id))) throw new Error("Captured layer IDs collide after normalization.");
    nativeIds.add(uid(layer.id));
    const children = childrenByParent.get(layer.parent) ?? [];
    children.push(layer);
    childrenByParent.set(layer.parent, children);
  }
  const uniqueId = (base: string) => {
    let id = base, suffix = 1;
    while (nativeIds.has(id)) id = `${base}-${suffix++}`;
    nativeIds.add(id);
    return id;
  };
  const keysFor = (layer: Layer, property: Property) => {
    const keys: Key[] = [];
    let previous: Key["value"] | undefined;
    for (const frame of layer.frames) {
      const value = frame.props[property] ?? previous;
      if (typeof value !== "string" && typeof value !== "number" && !Array.isArray(value)) continue;
      keys.push({ time: frame.time, value }); previous = value;
    }
    if (keys.length && keys[0].time > 0 && property === "opacity") keys.unshift({ time: 0, value: 0 }, { time: Math.max(0, keys[0].time - 1 / capture.frameRate), value: 0 });
    return keys;
  };
  const track = (layer: Layer, property: Property, target: string, nodeId: string): AuthoredTree | undefined => {
    const keys = keysFor(layer, property);
    if (keys.length < 2 || keys.every(key => sameValue(key.value, keys[0].value))) return undefined;
    const reduced = simplifyKeys(keys, property.toLowerCase().includes("opacity") ? 0.0001 : 0.01);
    keyframeCount += reduced.length;
    const id = uniqueId(`${nodeId}-${target}`);
    return { tag: "keyframeTrack", props: { id, property: target }, children: reduced.map((key, index) => ({ tag: "keyframe", props: { id: uniqueId(`${id}-${index}`), time: Number(key.time.toFixed(8)), value: key.value }, children: [] })) };
  };
  const render = (layer: Layer): AuthoredTree => {
    const id = uid(layer.id), initial = layer.frames[0].props;
    const node: AuthoredTree = { tag: layer.kind, props: { id, ...(styleKinds.has(layer.kind) ? {} : { name: layer.name, end: capture.duration }) }, children: [] };
    for (const [property, value] of Object.entries(initial) as [Property, Props[Property]][]) {
      if (paintProperties.has(property) || property === "text") continue;
      node.props[property] = value;
      if (animated.has(property)) {
        const motion = track(layer, property, property, id);
        if (motion) node.children.push(motion);
      }
      else if (layer.frames.some(frame => JSON.stringify(frame.props[property] ?? value) !== JSON.stringify(value))) issues.push({ layer: layer.name, feature: `animated ${property}` });
    }
    if (layer.kind === "text") {
      node.text = initial.text ?? "";
      if (layer.frames.some(frame => frame.props.text !== undefined && frame.props.text !== initial.text)) issues.push({ layer: layer.name, feature: "changing text content" });
    }
    for (const style of ["fill", "stroke"] as const) {
      if (initial[style] === undefined) continue;
      const styleId = uniqueId(`${id}-${style}`), tag = style === "fill" ? "solidPaint" : "stroke";
      const properties: [Property, string][] = style === "fill" ? [["fill", "color"], ["fillOpacity", "opacity"]] : [["stroke", "color"], ["strokeWidth", "width"], ["strokeOpacity", "opacity"], ["strokeCap", "cap"], ["strokeJoin", "join"], ["strokeMiterLimit", "miterLimit"], ["strokeDash", "dash"], ["strokeDashOffset", "dashOffset"]];
      const styleNode: AuthoredTree = { tag, props: { id: styleId }, children: [] };
      for (const [property, target] of properties) {
        if (initial[property] !== undefined) styleNode.props[target] = initial[property];
        if (target !== "cap" && target !== "join" && target !== "miterLimit") {
          const motion = track(layer, property, target, styleId);
          if (motion) styleNode.children.push(motion);
        }
        else if (layer.frames.some(frame => frame.props[property] !== undefined && frame.props[property] !== initial[property])) issues.push({ layer: layer.name, feature: `animated ${property}` });
      }
      node.children.push(styleNode);
    }
    for (const child of childrenByParent.get(layer.id) ?? []) node.children.push(render(child));
    return node;
  };
  const tree: AuthoredTree = {
    tag: "group", props: { id: prefix, name, end: capture.duration }, children: [{
      tag: "rect", props: { id: uniqueId(`${prefix}-frame`), name: "Frame", width: capture.width, height: capture.height, end: capture.duration }, children: [
        { tag: "rect", props: { id: uniqueId(`${prefix}-frame-clip`), name: "Frame clip", width: capture.width, height: capture.height, end: capture.duration, mask: true }, children: [] },
        ...(childrenByParent.get(undefined) ?? []).map(layer => render(layer)),
      ],
    }],
  };
  const uniqueIssues = [...new Map(issues.map(issue => [`${issue.layer}\0${issue.feature}`, issue])).values()];
  if (uniqueIssues.length && !allowPartial) throw new Error(`Editable conversion needs unsupported features:\n${uniqueIssues.slice(0, 15).map(issue => `- ${issue.layer}: ${issue.feature}`).join("\n")}\nOriginal source is unchanged. Use --allow-partial only to create an incomplete editable study.`);
  if (!capture.layers.length) throw new Error("Animation has no supported editable layers.");
  const jsx = `export default function Animation() {\n  return (\n${serializeTree(tree, 2)}\n  );\n}\n`;
  return { jsx, tree, width: capture.width, height: capture.height, duration: capture.duration, frameRate: capture.frameRate, layerCount: capture.layers.length + 3, keyframeCount, issues: uniqueIssues };
}
