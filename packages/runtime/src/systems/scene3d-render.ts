import * as THREE from 'three';
import { validatePointCloudGeometry } from '@diffusionstudio/jsx';
import type { Entity, World } from 'koota';
import { EffectType, GeometryType } from '../constants';
import {
  Cache, ChildOf, ClipsContent, Color, Computed, Culled, Effect, Generating, Geometry, Hidden, HitRegions, Host, Interactive, IsMask, LightSource,
  MixedCornerRadius, Mode, Paint, Playback, RenderSurface, Root, Scene3D, SourceError, SpatialGeometry, SpatialMaterial, SpatialParameters, Stage, StrokeStyle,
} from '../traits';
import { getParentEntity } from '../queries/hierarchy';
import { sceneCamera, spatialNode } from './spatial';
import { projectPoint3D, rotation4, translation4, multiply4 } from '../math/spatial';
import { invert2D, transformPoint, type Point } from '../math';
import { entityWorldMat } from '../queries/interaction';
import { meshGeometry, sampleSpatialPath, spatialPathGeometry } from './scene3d-geometry';
import { motionEffectsFrame } from '../media/motion-effects';
import { gradeFrame } from '../media/color-grade';
import { SceneFocus } from './scene3d-focus';
import { volumeMaterial } from './scene3d-volume';

export type ProjectedVisual = { d: string; width: number; height: number; sceneX: number; sceneY: number };
type DrawVisual = (entity: Entity, projected?: ProjectedVisual) => void;
type Entry = {
  object: THREE.Object3D; key: string; source?: OffscreenCanvas; texture?: THREE.CanvasTexture<OffscreenCanvas>;
  arrays?: readonly (readonly number[] | undefined)[]; path?: string;
  width?: number; height?: number; padding?: number; paintKey?: string;
};
type SceneRenderer = {
  canvas: OffscreenCanvas; renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera;
  entries: Map<Entity, Entry>; ambient: THREE.AmbientLight; keyLight: THREE.DirectionalLight;
  depthTarget: THREE.WebGLRenderTarget; raycaster: THREE.Raycaster; focus?: SceneFocus; prepared: boolean;
};
type WorldRenderer = {
  canvas: OffscreenCanvas; renderer: THREE.WebGLRenderer; scenes: Map<Entity, SceneRenderer>;
};
const renderers = new WeakMap<World, WorldRenderer>();
const flipY = new THREE.Matrix4().makeScale(1, -1, 1);

function disposeEntry(entry: Entry): void {
  entry.object.traverse(object => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Line) {
      object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
    }
    if (object instanceof THREE.DirectionalLight || object instanceof THREE.SpotLight) object.target.removeFromParent();
    if (object instanceof THREE.Light) object.dispose();
  });
  entry.texture?.dispose(); entry.object.removeFromParent();
}

function disposeScene(state: SceneRenderer): void {
  for (const entry of state.entries.values()) disposeEntry(entry);
  state.entries.clear();
  state.focus?.dispose(); state.depthTarget.dispose();
}

function getRenderer(world: World, root: Entity): SceneRenderer {
  let shared = renderers.get(world);
  if (!shared) {
    // Each scene is composited immediately, so its GPU context and shader cache
    // can be shared with the other 3D viewports in this document.
    const canvas = new OffscreenCanvas(1, 1);
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setClearColor(0, 0); renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setTransparentSort((a, b) => a.groupOrder - b.groupOrder || a.renderOrder - b.renderOrder
      || (!a.material.depthTest && !b.material.depthTest ? (a.object.userData.layerOrder as number) - (b.object.userData.layerOrder as number) : b.z - a.z) || a.id - b.id);
    renderer.toneMapping = THREE.NoToneMapping; renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
    shared = { canvas, renderer, scenes: new Map() }; renderers.set(world, shared);
    const stage = world.get(Root), owned = shared;
    const invalidate = () => { for (const state of owned.scenes.values()) state.prepared = false; };
    const changes = [
      world.onAdd(ChildOf('*'), invalidate), world.onRemove(ChildOf('*'), invalidate),
      world.onChange(SpatialMaterial, invalidate), world.onChange(SpatialGeometry, invalidate),
      world.onChange(SpatialParameters, invalidate), world.onChange(LightSource, invalidate),
    ];
    const release = world.onRemove(Stage, removed => {
      if (removed !== stage) return;
      for (const unsubscribe of changes) unsubscribe();
      for (const state of owned.scenes.values()) disposeScene(state);
      owned.renderer.dispose(); owned.renderer.forceContextLoss();
      owned.canvas.width = owned.canvas.height = 1;
      owned.scenes.clear(); renderers.delete(world); release();
    });
  }
  for (const [entity, state] of shared.scenes) {
    if (entity.isAlive()) continue;
    disposeScene(state); shared.scenes.delete(entity);
  }
  const existing = shared.scenes.get(root);
  if (existing) return existing;
  const { canvas, renderer } = shared;
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  camera.matrixAutoUpdate = false;
  const ambient = new THREE.AmbientLight(0xffffff, .4);
  const keyLight = new THREE.DirectionalLight(0xffffff, 2);
  keyLight.position.set(-600, 900, 1200); scene.add(ambient, keyLight);
  const depthTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true });
  depthTarget.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
  const state = { canvas, renderer, scene, camera, entries: new Map<Entity, Entry>(), ambient, keyLight, depthTarget, raycaster: new THREE.Raycaster(), prepared: false };
  shared.scenes.set(root, state); return state;
}

/** Prepare future 3D clips while paused, without changing the playhead or canvas. */
export function prepareScenes3D(world: World, draw: DrawVisual): void {
  if (world.get(Mode)?.value !== 'realtime' || world.query(Playback).some(entity => entity.get(Playback)?.playing)) return;
  for (const root of world.query(Scene3D)) {
    if (renderers.get(world)?.scenes.get(root)?.prepared) continue;
    let ancestor: Entity | null = root;
    while (ancestor && !ancestor.has(Hidden)) ancestor = getParentEntity(ancestor);
    if (ancestor) continue;
    const regions = world.get(HitRegions)?.list, count = regions?.length ?? 0;
    try { drawScene3D(world, root, draw, true); }
    finally { if (regions) regions.length = count; }
  }
}

export function configureSceneCamera(camera: THREE.PerspectiveCamera, root: Entity): void {
  const c = sceneCamera(root);
  camera.near = .05; camera.far = Math.max(100000, Math.abs(c.z) * 100);
  camera.aspect = c.width / Math.max(1, c.height);
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(c.height / (2 * c.perspective * c.zoom)));
  camera.zoom = 1; camera.updateProjectionMatrix();
  camera.projectionMatrix.elements[8] = -2 * (c.offsetX ?? 0) / c.width;
  camera.projectionMatrix.elements[9] = 2 * (c.offsetY ?? 0) / c.height;
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  const native = multiply4(translation4(c.x, c.y, c.z), rotation4(c.rotationX, c.rotationY, c.rotation));
  camera.matrix.copy(flipY).multiply(new THREE.Matrix4().fromArray(native)).multiply(flipY);
  camera.updateMatrixWorld(true);
}

function planeGeometry(width: number, height: number, left = 0, top = 0): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([left, top, 0, left + width, top, 0, left, top + height, 0, left + width, top + height, 0], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 0, 0, 1, 0], 2));
  geometry.setIndex([0, 2, 1, 2, 3, 1]); geometry.computeVertexNormals(); return geometry;
}

function nativeMaterial(entity: Entity): THREE.MeshBasicMaterial | THREE.MeshPhysicalMaterial {
  const options = entity.get(SpatialMaterial);
  return options?.lit === false ? new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }) : new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide });
}

function updateMaterial(material: THREE.Material, entity: Entity, opacity: number, depthTest: boolean): void {
  const c = entity.get(Computed)!, options = entity.get(SpatialMaterial);
  material.opacity = opacity; material.transparent = !depthTest || opacity < 1 || material instanceof THREE.PointsMaterial || material instanceof THREE.ShaderMaterial || ('map' in material && !!material.map);
  material.depthTest = depthTest; material.depthWrite = material.depthTest && opacity >= .999;
  if (material instanceof THREE.MeshBasicMaterial || material instanceof THREE.MeshPhysicalMaterial || material instanceof THREE.PointsMaterial) {
    material.color.setHex(entity.has(Color) ? c.color : 0xffffff);
    material.vertexColors = (material instanceof THREE.PointsMaterial ? c.pointColors : c.vertexColors).length > 0;
  }
  if (material instanceof THREE.MeshBasicMaterial || material instanceof THREE.MeshPhysicalMaterial) material.wireframe = options?.wireframe ?? false;
  if (material instanceof THREE.MeshPhysicalMaterial) {
    material.roughness = c.roughness; material.metalness = c.metalness; material.transmission = c.transmission; material.ior = c.ior;
    material.thickness = c.depth; material.emissive.set(options?.emissive ?? '#000000'); material.emissiveIntensity = c.emissiveIntensity;
    material.depthWrite = opacity >= .999 && material.depthTest;
  }
}

function createEntry(entity: Entity, key: string, depthTest: boolean): Entry {
  const type = entity.get(Geometry)?.value, c = entity.get(Computed)!;
  let object: THREE.Object3D;
  if (type === GeometryType.MESH) object = new THREE.Mesh(meshGeometry(entity), nativeMaterial(entity));
  else if (type === GeometryType.LIGHT) {
    const kind = entity.get(LightSource)?.type;
    object = kind === 'ambient' ? new THREE.AmbientLight() : kind === 'directional' ? new THREE.DirectionalLight() : kind === 'spot' ? new THREE.SpotLight() : new THREE.PointLight();
  } else if (type === GeometryType.VOLUME) {
    object = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), volumeMaterial());
  } else if (type === GeometryType.POINT_CLOUD) {
    validatePointCloudGeometry({ points: c.points, pointColors: c.pointColors });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(c.points, 3));
    if (c.pointColors.length) geometry.setAttribute('color', new THREE.Float32BufferAttribute(c.pointColors, 4));
    const material = new THREE.PointsMaterial({ size: c.pointSize, sizeAttenuation: false, transparent: true, vertexColors: c.pointColors.length > 0 });
    material.onBeforeCompile = shader => { shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (length(gl_PointCoord - vec2(.5)) > .5) discard;'); };
    object = new THREE.Points(geometry, material);
  } else if (type === GeometryType.PATH_3D && depthTest) {
    object = new THREE.Group();
    const contours = sampleSpatialPath(c.path3d);
    if (entity.has(Color) || (entity.get(Cache)?.fills.length ?? 0)) object.add(new THREE.Mesh(spatialPathGeometry(contours), nativeMaterial(entity)));
    for (const stroke of entity.get(Cache)?.strokes ?? []) {
      if (stroke.has(Hidden)) continue;
      const radius = stroke.get(Computed)!.strokeWidth / 2;
      if (radius <= 0) continue;
      for (const contour of contours) {
        if (contour.points.length < 2) continue;
        const curve = new THREE.CurvePath<THREE.Vector3>();
        const points = contour.closed ? [...contour.points, contour.points[0]!] : contour.points;
        for (let i = 1; i < points.length; i++) curve.add(new THREE.LineCurve3(points[i - 1]!, points[i]!));
        const material = new THREE.MeshBasicMaterial({ color: stroke.get(Computed)!.color });
        const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(2, points.length * 2), radius, 6, contour.closed), material);
        mesh.userData.stroke = stroke; object.add(mesh);
      }
    }
  } else {
    const source = new OffscreenCanvas(1, 1), texture = new THREE.CanvasTexture(source);
    texture.colorSpace = THREE.SRGBColorSpace; texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter;
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, alphaTest: .002 });
    object = new THREE.Mesh(planeGeometry(1, 1), material); object.matrixAutoUpdate = false;
    return { object, source, texture, key };
  }
  object.matrixAutoUpdate = false;
  if (type === GeometryType.MESH && (entity.get(Cache)?.fills.length ?? 0) > 0 && object instanceof THREE.Mesh) {
    const source = new OffscreenCanvas(1, 1), texture = new THREE.CanvasTexture(source);
    texture.colorSpace = THREE.SRGBColorSpace; texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter;
    object.material.map = texture; object.material.alphaTest = .002;
    return { object, key, source, texture };
  }
  return { object, key };
}

function paintTexture(world: World, entity: Entity, entry: Entry, requestedResolution: number, maxTextureSize: number, draw: DrawVisual, projected?: ProjectedVisual): void {
  const surface = world.get(RenderSurface)!, c = entity.get(Computed)!;
  const width = Math.max(1, projected?.width ?? c.width), height = Math.max(1, projected?.height ?? c.height);
  const strokes = entity.get(Cache)?.strokes ?? [], shadows = entity.get(Cache)?.shadows ?? [];
  const meshPaint = entity.get(Geometry)?.value === GeometryType.MESH;
  const effectBlur = (entity.get(Cache)?.effects ?? []).filter(effect => !effect.has(Hidden) && effect.get(Effect)?.type === EffectType.LAYER_BLUR).reduce((sum, effect) => sum + effect.get(Computed)!.value, 0);
  const padding = meshPaint ? 0 : Math.ceil(Math.max(2, (c.blur + effectBlur) * 3,
    ...strokes.map(stroke => (stroke.get(Computed)?.strokeWidth ?? 1) * (stroke.get(StrokeStyle)?.miterLimit ?? 10) / 2),
    ...shadows.map(shadow => { const s = shadow.get(Computed)!; return s.blur * 3 + Math.abs(s.offsetX) + Math.abs(s.offsetY); })));
  const resolution = Math.min(requestedResolution, maxTextureSize / Math.max(width + padding * 2, height + padding * 2));
  const textureWidth = Math.max(1, Math.ceil((width + padding * 2) * resolution));
  const textureHeight = Math.max(1, Math.ceil((height + padding * 2) * resolution));
  const source = entry.source!;
  let paintKey: string | undefined;
  if (!projected && entity.get(Geometry)?.value === GeometryType.RECT && entity.has(Color)
    && !entity.has(Paint) && !entity.has(Generating) && !entity.has(SourceError)
    && c.blur === 0 && c.cornerRadius === 0 && !entity.has(MixedCornerRadius)
    && !strokes.length && !shadows.length && !(entity.get(Cache)?.fills.length)
    && !(entity.get(Cache)?.effects.length)) {
    let simple = true;
    for (let owner: Entity | null = entity; owner && !owner.has(Scene3D); owner = getParentEntity(owner)) {
      if (owner.has(ClipsContent) || owner.get(Cache)?.masks.length) { simple = false; break; }
    }
    if (simple) paintKey = JSON.stringify([width, height, padding, resolution, textureWidth, textureHeight, c.color]);
  }
  if (paintKey && entry.paintKey === paintKey && source.width === textureWidth && source.height === textureHeight) return;
  entry.paintKey = undefined;
  if (source.width !== textureWidth || source.height !== textureHeight) { source.width = textureWidth; source.height = textureHeight; }
  const ctx = source.getContext('2d')!;
  ctx.reset(); ctx.scale(resolution, resolution); ctx.clearRect(0, 0, source.width / resolution, source.height / resolution); ctx.translate(padding, padding);
  world.set(RenderSurface, { canvas: source, ctx, resolution });
  try { draw(entity, projected); } finally { world.set(RenderSurface, surface); }
  entry.texture!.needsUpdate = true;
  entry.paintKey = paintKey;
  if (!meshPaint && (entry.width !== width || entry.height !== height || entry.padding !== padding)) {
    const mesh = entry.object as THREE.Mesh;
    mesh.geometry.dispose(); mesh.geometry = planeGeometry(width + padding * 2, height + padding * 2, -padding, -padding);
    entry.width = width; entry.height = height; entry.padding = padding;
  }
}

function projectedPath(world: World, entity: Entity, root: Entity): { visual: ProjectedVisual; left: number; top: number; depth: number } {
  const node = spatialNode(world, entity)!, camera = sceneCamera(root);
  const tokens = entity.get(Computed)!.path3d.match(/[MLCQZ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) ?? [];
  const projected: (string | { x: number; y: number; depth: number })[] = [];
  const points: { x: number; y: number; depth: number }[] = [];
  for (let i = 0; i < tokens.length;) {
    if (/^[MLCQZ]$/.test(tokens[i]!)) { projected.push(tokens[i++]!); continue; }
    const point = projectPoint3D(node.model, camera, Number(tokens[i++]), Number(tokens[i++]), Number(tokens[i++]));
    if (point.depth > .01) points.push(point);
    projected.push(point);
  }
  if (!points.length) return { visual: { d: '', width: 1, height: 1, sceneX: 0, sceneY: 0 }, left: 0, top: 0, depth: 1000 };
  // Cairo projects the cubic controls before drawing; its paint coordinates use those same bounds.
  const left = Math.min(...points.map(p => p.x)), top = Math.min(...points.map(p => p.y));
  const width = Math.max(1, Math.max(...points.map(p => p.x)) - left), height = Math.max(1, Math.max(...points.map(p => p.y)) - top);
  const d = projected.map(point => typeof point === 'string' ? point : `${point.x - left} ${point.y - top}`).join(' ');
  return { visual: { d, width, height, sceneX: left, sceneY: top }, left, top, depth: Math.max(1, points.reduce((sum, p) => sum + p.depth, 0) / points.length) };
}

/** Native layers share one depth buffer and one scene render, including their individually editable paints. */
export function drawScene3D(world: World, root: Entity, draw: DrawVisual, preparing = false): void {
  const surface = world.get(RenderSurface)!, output = surface.ctx!, frame = root.get(Computed)!;
  if (frame.width <= 0 || frame.height <= 0) return;
  const state = getRenderer(world, root), { renderer, scene, camera } = state;
  const view = output.getTransform(), displayScale = Math.max(Math.hypot(view.a, view.b), Math.hypot(view.c, view.d));
  const requested = world.get(Mode)?.value === 'realtime' ? Math.min(surface.resolution, Math.max(.1, displayScale)) : surface.resolution;
  const resolution = Math.min(requested, renderer.capabilities.maxTextureSize / Math.max(frame.width, frame.height));
  const width = Math.max(1, Math.ceil(frame.width * resolution)), height = Math.max(1, Math.ceil(frame.height * resolution));
  if (state.depthTarget.width !== width || state.depthTarget.height !== height) state.depthTarget.setSize(width, height);
  configureSceneCamera(camera, root);
  state.ambient.intensity = frame.ambientIntensity;
  scene.fog = frame.fogDensity > 0 ? new THREE.FogExp2(root.get(SpatialMaterial)?.fogColor ?? '#ffffff', frame.fogDensity / 100) : null;
  const seen = new Set<Entity>(), volumes: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[] = [];
  let authoredLights = 0, layerOrder = 0;
  const walk = (entity: Entity, inheritedOpacity: number, inheritedDepthTest: boolean): void => {
    const c = entity.get(Computed)!, type = entity.get(Geometry)?.value;
    const spatial = spatialNode(world, entity);
    if (entity.has(Hidden) || entity.has(IsMask) || !spatial) return;
    if (!preparing && (entity.has(Culled) || c.visibility === 0 || !spatial.visible)) return;
    const opacity = inheritedOpacity * c.opacity;
    const authoredDepth = entity.get(Host)?.props.depthTest;
    const depthTest = typeof authoredDepth === 'boolean' ? authoredDepth : inheritedDepthTest;
    if (opacity <= 0 && !preparing) return;
    if (type !== undefined) {
      const geometry = entity.get(SpatialGeometry), options = entity.get(SpatialMaterial);
      // Authored arrays are copied on edits; animated arrays are replaced by motionSystem.
      const arrays = type === GeometryType.MESH && geometry?.shape === 'custom'
        ? [c.vertices, geometry.indices, geometry.normals, geometry.uv, c.vertexColors]
        : type === GeometryType.POINT_CLOUD ? [c.points, c.pointColors] : [];
      const path = type === GeometryType.PATH_3D ? c.path3d : undefined;
      const key = JSON.stringify([type, c.width, c.height, c.depth, geometry?.shape, options?.lit, depthTest, (entity.get(Cache)?.fills.length ?? 0) > 0, entity.get(LightSource)?.type,
        type === GeometryType.PATH_3D ? entity.get(Cache)?.strokes.map(stroke => [stroke, stroke.get(Computed)?.strokeWidth, stroke.has(Hidden)]) : null]);
      let entry = state.entries.get(entity);
      if (!entry || entry.key !== key || entry.path !== path || entry.arrays?.length !== arrays.length || arrays.some((array, index) => entry!.arrays![index] !== array)) {
        if (entry) disposeEntry(entry);
        entry = createEntry(entity, key, depthTest); entry.arrays = arrays; entry.path = path;
        state.entries.set(entity, entry); scene.add(entry.object);
      }
      seen.add(entity);
      const object = entry.object;
      object.matrix.copy(flipY).multiply(new THREE.Matrix4().fromArray(spatial.model));
      object.renderOrder = c.renderOrder; object.visible = true; object.userData.entity = entity;
      object.traverse(child => {
        child.renderOrder = c.renderOrder; child.userData.entity = entity; child.userData.layerOrder = layerOrder++;
        if (child instanceof THREE.Mesh || child instanceof THREE.Points) {
          const target = child.userData.stroke as Entity | undefined;
          for (const material of Array.isArray(child.material) ? child.material : [child.material]) updateMaterial(material, target ?? entity, opacity * (target?.get(Computed)?.opacity ?? 1), depthTest);
          child.castShadow = options?.castShadow ?? true; child.receiveShadow = options?.receiveShadow ?? true;
        }
      });
      if (object instanceof THREE.Points) (object.material as THREE.PointsMaterial).size = c.pointSize * resolution;
      if (entry.source) {
        if (type === GeometryType.PATH_3D) {
          const projected = projectedPath(world, entity, root);
          paintTexture(world, entity, entry, resolution, renderer.capabilities.maxTextureSize, draw, projected.visual);
          const cameraValues = sceneCamera(root), focal = cameraValues.perspective * cameraValues.zoom, scale = projected.depth / focal;
          object.matrix.copy(camera.matrixWorld).multiply(new THREE.Matrix4().makeTranslation(
            (projected.left - frame.width / 2 - frame.cameraOffsetX) * scale,
            (frame.height / 2 + frame.cameraOffsetY - projected.top) * scale, -projected.depth,
          )).multiply(new THREE.Matrix4().makeScale(scale, -scale, 1));
        } else paintTexture(world, entity, entry, resolution, renderer.capabilities.maxTextureSize, draw);
        const material = (object as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>).material;
        material.color.setHex(0xffffff); material.depthWrite = opacity >= .999 && depthTest;
      }
      if (object instanceof THREE.Light) {
        authoredLights++; object.color.setHex(c.color); object.intensity = c.intensity * opacity;
        if (object instanceof THREE.PointLight || object instanceof THREE.SpotLight) { object.distance = c.distance; object.decay = c.decay; }
        if (object instanceof THREE.DirectionalLight || object instanceof THREE.SpotLight || object instanceof THREE.PointLight) {
          object.castShadow = options?.castShadow ?? true; object.shadow.mapSize.set(2048, 2048);
          object.shadow.bias = -.0002; object.shadow.normalBias = 2; object.shadow.camera.near = .1; object.shadow.camera.far = Math.max(10000, Math.max(frame.width, frame.height) * 8);
          if (object instanceof THREE.DirectionalLight) {
            const reach = Math.max(frame.width, frame.height) * 1.25;
            object.shadow.camera.left = -reach; object.shadow.camera.right = reach; object.shadow.camera.top = reach; object.shadow.camera.bottom = -reach;
          } else if (object instanceof THREE.SpotLight) { object.angle = c.coneAngle * Math.PI / 180; object.penumbra = c.penumbra; }
          object.shadow.camera.updateProjectionMatrix();
        }
        if (object instanceof THREE.DirectionalLight || object instanceof THREE.SpotLight) {
          object.target.position.set(c.targetX, -c.targetY, c.targetZ); scene.add(object.target); object.target.updateMatrixWorld();
        }
      }
      if (type === GeometryType.VOLUME) {
        const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
        object.matrix.multiply(new THREE.Matrix4().makeTranslation(c.width / 2, c.height / 2, 0)).multiply(new THREE.Matrix4().makeScale(c.width, c.height, Math.max(.001, c.depth)));
        const uniforms = mesh.material.uniforms;
        uniforms.tint!.value.setHex(c.color); uniforms.density!.value = c.density; uniforms.noiseScale!.value = c.noiseScale;
        uniforms.time!.value = c.localTimeInSeconds; uniforms.flowSpeed!.value = c.flowSpeed; uniforms.scatter!.value = c.scatter; uniforms.opacity!.value = opacity;
        uniforms.viewport!.value.set(width, height); uniforms.depthMap!.value = state.depthTarget.depthTexture;
        uniforms.inverseProjection!.value.copy(camera.projectionMatrixInverse); uniforms.cameraWorld!.value.copy(camera.matrixWorld);
        uniforms.inverseWorld!.value.copy(object.matrix).invert(); uniforms.eye!.value.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(uniforms.inverseWorld!.value);
        mesh.material.depthTest = false; mesh.material.depthWrite = false;
        volumes.push(mesh);
      }
      object.updateMatrixWorld(true);
      if (!preparing && entity.has(Interactive)) world.get(HitRegions)?.list.push({ target: { kind: 'entity', id: entity } });
    }
    if (!entity.has(Scene3D)) for (const child of entity.get(Cache)?.children ?? []) walk(child, opacity, depthTest);
  };
  for (const child of root.get(Cache)?.children ?? []) walk(child, 1, root.get(SpatialMaterial)?.depthTest ?? true);
  for (const [entity, entry] of state.entries) {
    if (seen.has(entity)) continue;
    let owner = entity.isAlive() ? getParentEntity(entity) : null;
    while (owner && !owner.has(Scene3D)) owner = getParentEntity(owner);
    if (owner === root) entry.object.visible = false;
    else { disposeEntry(entry); state.entries.delete(entity); }
  }
  state.keyLight.visible = authoredLights === 0;
  scene.updateMatrixWorld(true);
  // Nested 3D textures can resize the shared canvas while entries are painted.
  if (state.canvas.width !== width || state.canvas.height !== height) renderer.setSize(width, height, false);
  if (volumes.length) {
    const key = [...state.entries.values()].map(entry => entry.object).find(object => object.visible && (object instanceof THREE.DirectionalLight || object instanceof THREE.SpotLight)) ?? state.keyLight;
    const lightPosition = new THREE.Vector3().setFromMatrixPosition(key.matrixWorld);
    for (const volume of volumes) {
      const uniforms = volume.material.uniforms;
      const direction = lightPosition.clone().sub(new THREE.Vector3().setFromMatrixPosition(volume.matrixWorld)).transformDirection(uniforms.inverseWorld!.value);
      uniforms.lightDirection!.value.copy(direction);
      uniforms.lightColor!.value.copy(key instanceof THREE.Light ? key.color : state.ambient.color).multiplyScalar(Math.min(2, frame.ambientIntensity + (key instanceof THREE.Light ? key.intensity : 1) * .45));
    }
    for (const volume of volumes) volume.visible = false;
    renderer.setRenderTarget(state.depthTarget); renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    for (const volume of volumes) volume.visible = true;
  }
  if (frame.aperture > 0) {
    state.focus ??= new SceneFocus();
    state.focus.render(renderer, scene, camera, width, height, frame.focusDistance, frame.aperture * resolution);
  } else renderer.render(scene, camera);
  if (preparing) { state.prepared = true; return; }
  const finished = motionEffectsFrame(world, root, state.canvas, resolution);
  output.drawImage(gradeFrame(world, root, finished), 0, 0, frame.width, frame.height);
}

/** Ray picking follows the same depth buffer ordering as rendering; the authored entity is returned. */
export function pickScene3D(world: World, root: Entity, point: Point): Entity | null {
  const state = renderers.get(world)?.scenes.get(root);
  if (!state) return null;
  const local = transformPoint(invert2D(entityWorldMat(world, root)), point.x, point.y), c = root.get(Computed)!;
  state.raycaster.setFromCamera(new THREE.Vector2(local.x / c.width * 2 - 1, 1 - local.y / c.height * 2), state.camera);
  state.raycaster.params.Points = { threshold: 4 };
  const hits = state.raycaster.intersectObjects([...state.entries.values()].filter(entry => entry.object.visible).map(entry => entry.object), true);
  hits.sort((a, b) => {
    const am = a.object instanceof THREE.Mesh || a.object instanceof THREE.Points ? a.object.material : null;
    const bm = b.object instanceof THREE.Mesh || b.object instanceof THREE.Points ? b.object.material : null;
    const overlayA = am && !Array.isArray(am) && !am.depthTest, overlayB = bm && !Array.isArray(bm) && !bm.depthTest;
    if (overlayA || overlayB) return Number(overlayB) - Number(overlayA) || b.object.renderOrder - a.object.renderOrder
      || (b.object.userData.layerOrder as number) - (a.object.userData.layerOrder as number);
    return a.distance - b.distance;
  });
  return (hits[0]?.object.userData.entity as Entity | undefined) ?? null;
}
