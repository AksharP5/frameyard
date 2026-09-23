/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Render system (was systems/render.ts): draws the document tree onto the
// world's RenderSurface. Runs identically against the editor and capture
// canvases; without a surface it is a no-op. Hit
// regions are pushed callback-less (see HitRegions); the app's input layer
// attaches its handlers.

import { Not, Or } from 'koota';

import { store } from '../world/store';
import {
	COMPOSITE_OPERATIONS, EffectType, GeometryType, PaintType, ScaleModeType,
	TransitionType,
} from '../constants';
import {
	ChildOf, Hidden, Culled, Interactive, IsMask,
	ClipsContent, Geometry, Group, Paint, Color, Caption, ScaleMode, Shader,
	BlendMode, Effect, Transition, MixedCornerRadius, DepthSort,
	LocalTransform, WorldTransform, Computed, Cache,
	Host,
	Mode, FrameRate, Background, RenderSurface,
	HitRegions,
	Root, Highlight, Preset, ColorGrade, VideoDecoderHandle, Scene3D,
} from '../traits';
import { getParentNode } from '../queries/hierarchy';
import { geometryPath, geometryFillRule, projectedGeometryPath } from '../utils/path';
import { hasSpatialCamera, spatialNode } from './spatial';
import { drawScene3D, prepareScenes3D, type ProjectedVisual } from './scene3d-render';
import { drawSpatialLayer } from './spatial-render';
import { invert2D, multiply2D, transformPoint, translate2D, type Mat2D } from '../math';
import { motionEffectsFrame } from '../media/motion-effects';
import { isScene } from '../queries/predicates';
import { getViewMatrix } from '../queries/camera';
import { colorToHex } from '../utils/color';
import { FAILED_COLOR, getGeneratingColor, getSourceFailure, isGenerating } from '../utils/generating';
import { applyStrokeStyle } from '../utils/stroke';
import { renderText } from '../utils/text';
import { getTransitionWindow } from '../utils/transition';
import { getIntrinsicPaint } from '../utils/time';
import { createLinearGradient, createRadialGradient } from './gradients';
import { renderHighlight } from './highlight';
import { prepareSceneEffects, renderWithSceneEffects } from './scene-effects';
import { renderPreset } from './preset';
import {
	resolveImageDecoder, resolveVideoDecoder,
	resolveCaptionDecoder, resolveShaderHost, resolveWaveformPeaks, gradeFrame, sampleColorScopes, beginColorScopeFrame, finishColorScopeFrame,
} from '../media';

import type { Entity, World } from 'koota';
import type { Quad } from '../math/aabb';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const MISSING_ASSET_COLOR = '#5C2828';

function fillGeometry(ctx: Ctx2D, entity: Entity): void {
	const path = geometryPath(entity);
	if (path) ctx.fill(path, geometryFillRule(entity)); else ctx.fill();
}

function clipGeometry(ctx: Ctx2D, entity: Entity): void {
	const path = geometryPath(entity);
	if (path) ctx.clip(path, geometryFillRule(entity)); else ctx.clip();
}

function getCtx(world: World): Ctx2D {
	return world.get(RenderSurface)!.ctx!;
}

export function drawRectPath(world: World, entity: Entity): void {
	const ctx = getCtx(world);
	const computed = store(world, Computed);
	const eid = entity.id();
	const w = computed.width[eid]!;
	const h = computed.height[eid]!;

	const hasMixed = entity.has(MixedCornerRadius);
	let tl = hasMixed ? computed.cornerRadiusTopLeft[eid]! : computed.cornerRadius[eid]!;
	let tr = hasMixed ? computed.cornerRadiusTopRight[eid]! : tl;
	let br = hasMixed ? computed.cornerRadiusBottomRight[eid]! : tl;
	let bl = hasMixed ? computed.cornerRadiusBottomLeft[eid]! : tl;

	ctx.beginPath();

	if (tl === 0 && tr === 0 && br === 0 && bl === 0) {
		ctx.rect(0, 0, w, h);
	} else if (tl === tr && tr === br && br === bl) {
		ctx.roundRect(0, 0, w, h, tl);
	} else {
		// Clamp radii so adjacent corners don't exceed the edge length (CSS spec algorithm)
		const scale = Math.min(
			w / (tl + tr || 1),
			h / (tr + br || 1),
			w / (br + bl || 1),
			h / (bl + tl || 1),
			1,
		);
		if (scale < 1) {
			tl *= scale;
			tr *= scale;
			br *= scale;
			bl *= scale;
		}

		ctx.moveTo(tl, 0);
		ctx.lineTo(w - tr, 0);
		if (tr > 0) ctx.arcTo(w, 0, w, tr, tr);
		else ctx.lineTo(w, 0);
		ctx.lineTo(w, h - br);
		if (br > 0) ctx.arcTo(w, h, w - br, h, br);
		else ctx.lineTo(w, h);
		ctx.lineTo(bl, h);
		if (bl > 0) ctx.arcTo(0, h, 0, h - bl, bl);
		else ctx.lineTo(0, h);
		ctx.lineTo(0, tl);
		if (tl > 0) ctx.arcTo(0, 0, tl, 0, tl);
		else ctx.lineTo(0, 0);
	}

	ctx.closePath();
}

function getScaledImageProps(
	mode: number,
	imgW: number,
	imgH: number,
	targetW: number,
	targetH: number,
): [dx: number, dy: number, sw: number, sh: number] {
	if (mode === ScaleModeType.FILL) {
		return [0, 0, targetW, targetH];
	}
	if (mode === ScaleModeType.FIT) {
		const scale = Math.min(targetW / imgW, targetH / imgH);
		const sw = imgW * scale;
		const sh = imgH * scale;
		return [(targetW - sw) / 2, (targetH - sh) / 2, sw, sh];
	}
	if (mode === ScaleModeType.COVER) {
		const scale = Math.max(targetW / imgW, targetH / imgH);
		const sw = imgW * scale;
		const sh = imgH * scale;
		return [(targetW - sw) / 2, (targetH - sh) / 2, sw, sh];
	}
	// ScaleModeType.NONE — original size
	return [0, 0, imgW, imgH];
}

const EPSILON = 1e-4;

/** Build a single CSS filter fragment from an effect sub-entity. Returns null if hidden or no-op. */
function effectFilter(world: World, sub: Entity): string | null {
	if (sub.has(Hidden)) return null;

	const value = store(world, Computed).value[sub.id()]!;
	const type = store(world, Effect).type[sub.id()] ?? 0;

	if (type === EffectType.LAYER_BLUR) {
		const clamped = Math.max(0, value);
		return clamped > EPSILON ? `blur(${clamped}px)` : null;
	}
	if (type === EffectType.BRIGHTNESS) {
		const clamped = Math.max(0, value);
		return Math.abs(clamped - 1) > EPSILON ? `brightness(${clamped})` : null;
	}
	if (type === EffectType.CONTRAST) {
		const clamped = Math.max(0, value);
		return Math.abs(clamped - 1) > EPSILON ? `contrast(${clamped})` : null;
	}
	if (type === EffectType.GRAYSCALE) {
		const clamped = Math.min(1, Math.max(0, value));
		return clamped > EPSILON ? `grayscale(${clamped})` : null;
	}
	if (type === EffectType.HUE_ROTATION) {
		return Math.abs(value) > EPSILON ? `hue-rotate(${value}deg)` : null;
	}
	if (type === EffectType.INVERT) {
		const clamped = Math.min(1, Math.max(0, value));
		return clamped > EPSILON ? `invert(${clamped})` : null;
	}
	if (type === EffectType.SATURATE) {
		const clamped = Math.max(0, value);
		return Math.abs(clamped - 1) > EPSILON ? `saturate(${clamped})` : null;
	}
	if (type === EffectType.SEPIA) {
		const clamped = Math.min(1, Math.max(0, value));
		return clamped > EPSILON ? `sepia(${clamped})` : null;
	}
	return null;
}

/** CSS filter string from the entity's own blur plus effect sub-entities. */
function buildEffects(world: World, entity: Entity): string | null {
	const parts: string[] = [];

	const blurVal = store(world, Computed).blur[entity.id()]!;
	if (blurVal > EPSILON) {
		parts.push(`blur(${blurVal}px)`);
	}

	const effects = store(world, Cache).effects[entity.id()] ?? [];
	for (const effect of effects) {
		const f = effectFilter(world, effect);
		if (f) parts.push(f);
	}

	if (parts.length === 0) return null;

	return parts.join(' ');
}

/**
 * The geometry's intrinsic fill: its own Color trait (a solid, read from
 * Computed.color so it animates) and its own Paint trait (see
 * `getIntrinsicPaint`), if any, in that order. Drawn into the current path
 * before the Paint sub-entities so it always sits at the bottom of the fill
 * stack. A shader paint first in the stack takes an intrinsic image/video as
 * its input instead (see `renderShaderFill`), in which case the media is not
 * drawn here. Media paints and the surface paint (a `<surface>`, whose host
 * lives on the geometry) are intrinsic; a waveform (an audio clip's) has no
 * picture on the canvas.
 */
export function renderIntrinsicFill(world: World, entity: Entity): void {
	if (entity.has(Color)) {
		const ctx = getCtx(world);
		const computed = store(world, Computed);
		const eid = entity.id();
		ctx.fillStyle = colorToHex(computed.color[eid] ?? 0);
		fillGeometry(ctx, entity);
	}

	const intrinsic = getIntrinsicPaint(entity);
	if (intrinsic === PaintType.SURFACE) {
		const canvas = entity.get(Host)?.element;
		if (canvas instanceof HTMLCanvasElement) {
			const ctx = getCtx(world);
			const computed = store(world, Computed);
			const eid = entity.id();
			ctx.save();
			clipGeometry(ctx, entity);
			ctx.drawImage(canvas, 0, 0, computed.width[eid]!, computed.height[eid]!);
			ctx.restore();
		}
		return;
	}
	if (intrinsic === PaintType.HTML) {
		renderHtmlFill(world, entity, entity);
		return;
	}

	const kind = mediaKind(intrinsic);
	if (kind === null) return;
	if (shaderInput(world, entity, store(world, Cache).fills[entity.id()] ?? [], 0) === entity) return;
	renderMedia(world, entity, entity, kind);
}

type MediaKind = 'IMAGE' | 'VIDEO';

function mediaKind(paint: PaintType | undefined): MediaKind | null {
	if (paint === PaintType.IMAGE) return 'IMAGE';
	if (paint === PaintType.VIDEO) return 'VIDEO';
	return null;
}

/** What the image and video decoders hand out to draw. */
type MediaFrame = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas;

// html-in-canvas (https://github.com/WICG/html-in-canvas). Chromium only,
// behind chrome://flags/#canvas-draw-element; the API surface is still
// moving, so every touchpoint is typed and isolated here.
type DrawElementContext = Ctx2D & {
	drawElementImage(source: Element | unknown, dx: number, dy: number, dw: number, dh: number): DOMMatrix;
};


// Roots whose last drawElementImage threw, so a persistent failure logs once
// rather than flooding the console; drawing again clears the entry.
const failedHtmlRoots = new WeakSet<HTMLElement>();

function renderHtmlFill(world: World, entity: Entity, source: Entity): void {
	const root = source.get(Host)?.element;
	const surface = world.get(RenderSurface);
	const ctx = surface?.ctx;
	if (!(ctx instanceof CanvasRenderingContext2D)) return;
	if (!(root instanceof HTMLElement)) return;

	const computed = store(world, Computed);
	const eid = entity.id();

	ctx.save();
	clipGeometry(ctx, entity);

	const width = computed.width[eid]!;
	const height = computed.height[eid]!;
	root.style.width = `${width}px`;
	root.style.height = `${height}px`;

	try {
		(ctx as DrawElementContext).drawElementImage(root, 0, 0, width, height);
	} catch (error) {
		if (!failedHtmlRoots.has(root)) {
			failedHtmlRoots.add(root);
			console.error(`Error drawing <HtmlPaint> content: ${error instanceof Error ? `${error.name}: ${error.message}` : error}`);
		}
	}

	ctx.restore();
}

/**
 * Draws the current frame of `source` (an image or video paint, or the
 * geometry itself for intrinsic media) into `entity`'s box, fitted by the
 * source's ScaleMode; a failed decoder paints the missing-asset color.
 */
function renderMedia(world: World, entity: Entity, source: Entity, kind: MediaKind): void {
	const ctx = getCtx(world);
	const computed = store(world, Computed);
	const eid = entity.id();
	const w = computed.width[eid]!;
	const h = computed.height[eid]!;

	let frame: MediaFrame | null | undefined;
	let failed = false;
	if (kind === 'IMAGE') {
		const decoder = resolveImageDecoder(world, source)?.decoder;
		frame = decoder?.getBitmap(w, h);
		failed = decoder?.failed ?? false;
	} else {
		const decoder = resolveVideoDecoder(world, source);
		frame = decoder?.toBitmap();
		failed = decoder?.errored ?? false;
	}

	if (frame) {
		ctx.save();
		clipGeometry(ctx, entity);

		const mode = store(world, ScaleMode).value[source.id()] ?? 0;
		const [dx, dy, sw, sh] = getScaledImageProps(mode, frame.width, frame.height, w, h);
		const graded = gradeFrame(world, entity.has(ColorGrade) ? entity : source, frame);
		sampleColorScopes(world, entity, graded);
		ctx.drawImage(graded, dx, dy, sw, sh);

		ctx.restore();
	} else if (failed) {
		ctx.fillStyle = MISSING_ASSET_COLOR;
		fillGeometry(ctx, entity);
	}
}

export function renderFills(world: World, entity: Entity): void {
	const ctx = getCtx(world);
	const computed = store(world, Computed);
	const paintStore = store(world, Paint);
	const blendMode = store(world, BlendMode);
	const eid = entity.id();
	const fills = store(world, Cache).fills[eid] ?? [];

	for (let index = 0; index < fills.length; index++) {
		const fill = fills[index]!;
		if (fill.has(Hidden) || shaderConsumesFill(world, entity, fills, index)) continue;
		const fid = fill.id();
		const savedAlpha = ctx.globalAlpha;
		const savedCO = ctx.globalCompositeOperation;
		const bi = blendMode.value[fid] ?? 0;

		if (bi !== 0) {
			ctx.globalCompositeOperation = COMPOSITE_OPERATIONS[bi]!;
		}

		ctx.globalAlpha = savedAlpha * computed.opacity[fid]!;

		const paint = paintStore.value[fid];
		if (paint === PaintType.IMAGE) {
			renderMedia(world, entity, fill, 'IMAGE');
		} else if (paint === PaintType.VIDEO) {
			renderMedia(world, entity, fill, 'VIDEO');
		} else if (paint === PaintType.HTML) {
			renderHtmlFill(world, entity, fill);
		} else if (paint === PaintType.SURFACE) {
			const canvas = fill.get(Host)?.element;
			if (canvas instanceof HTMLCanvasElement) {
				ctx.save();
				clipGeometry(ctx, entity);
				ctx.drawImage(canvas, 0, 0, computed.width[eid]!, computed.height[eid]!);
				ctx.restore();
			}
		} else if (paint === PaintType.SOLID) {
			ctx.fillStyle = colorToHex(computed.color[fid]!);
			fillGeometry(ctx, entity);
		} else if (paint === PaintType.LINEAR_GRADIENT) {
			const w = computed.width[eid]!;
			const h = computed.height[eid]!;
			ctx.fillStyle = createLinearGradient(world, fill, ctx, w, h);
			fillGeometry(ctx, entity);
		} else if (paint === PaintType.RADIAL_GRADIENT) {
			const w = computed.width[eid]!;
			const h = computed.height[eid]!;
			ctx.fillStyle = createRadialGradient(world, fill, ctx, w, h);
			fillGeometry(ctx, entity);
		} else if (paint === PaintType.WAVEFORM) {
			renderWaveform(world, entity, fill);
		} else if (paint === PaintType.SHADER) {
			renderShaderFill(world, entity, fills, index);
		}

		ctx.globalCompositeOperation = savedCO;
		ctx.globalAlpha = savedAlpha;
	}
}

/**
 * Whether `source` is a picture a shader can sample: an image/video paint,
 * be it a paint sub-entity or the geometry's own intrinsic paint.
 */
function shaderMediaKind(world: World, source: Entity): 'IMAGE' | 'VIDEO' | null {
	if (!source.has(Paint)) return null;
	const paint = store(world, Paint).value[source.id()];
	if (paint === PaintType.IMAGE) return 'IMAGE';
	if (paint === PaintType.VIDEO) return 'VIDEO';
	return null;
}

/** The current frame of a video/image source, as a GPU-uploadable source. */
function shaderSourceBitmap(
	world: World,
	source: Entity,
	w: number,
	h: number,
): { source: MediaFrame; width: number; height: number } | null {
	const kind = shaderMediaKind(world, source);

	if (kind === 'IMAGE') {
		const bitmap = resolveImageDecoder(world, source)?.decoder?.getBitmap(w, h);
		return bitmap ? { source: bitmap, width: bitmap.width, height: bitmap.height } : null;
	}
	if (kind === 'VIDEO') {
		const frame = resolveVideoDecoder(world, source)?.toBitmap();
		return frame ? { source: frame, width: frame.width, height: frame.height } : null;
	}
	return null;
}

/**
 * The media directly below the fill at `index`, if it is one a shader could
 * take as input: the visible image/video paint right before it, or, for the
 * first fill, the geometry's own intrinsic image/video. Only the immediate
 * neighbor counts (a hidden paint in between decouples the pair).
 */
function mediaBelow(world: World, entity: Entity, fills: Entity[], index: number): Entity | null {
	const source = index === 0 ? entity : fills[index - 1]!;
	if (source.has(Hidden)) return null;
	return shaderMediaKind(world, source) === null ? null : source;
}

/**
 * The media the shader paint at `index` will sample this frame, or null when
 * it has none to (there is no shader there, it is not ready, nothing samplable
 * sits below it, or that has no frame yet). Whatever it returns is drawn by
 * the shader and not on its own — a consumed media that the shader then fails
 * to draw would blank the element, so this checks pipeline readiness and frame
 * availability, and `renderShaderFill` draws exactly what it says.
 */
function shaderInput(world: World, entity: Entity, fills: Entity[], index: number): Entity | null {
	const shader = fills[index];
	if (shader === undefined || store(world, Paint).value[shader.id()] !== PaintType.SHADER) return null;
	if (shader.has(Hidden)) return null;
	if (!resolveShaderHost(world, shader)?.ready) return null;

	const media = mediaBelow(world, entity, fills, index);
	if (media === null) return null;

	const computed = store(world, Computed);
	const w = computed.width[entity.id()]!;
	const h = computed.height[entity.id()]!;
	return shaderSourceBitmap(world, media, w, h) === null ? null : media;
}

/**
 * Whether the fill at `index` is the input of a ready shader paint directly
 * above it (see `shaderInput`).
 */
function shaderConsumesFill(world: World, entity: Entity, fills: Entity[], index: number): boolean {
	return shaderInput(world, entity, fills, index + 1) === fills[index];
}

/**
 * Draws a shader paint: the media directly below it — the image/video paint
 * before it in the fill stack, or the geometry's intrinsic media under the
 * first fill — is sampled as the shader's `source` texture and its output
 * lands in the parent's box in the media's place. Without media below the
 * shader runs procedurally over a transparent source; before the pipeline is
 * ready it draws nothing and the media, if any, draws normally.
 */
function renderShaderFill(world: World, entity: Entity, fills: Entity[], index: number): void {
	const ctx = getCtx(world);
	const computed = store(world, Computed);

	const host = resolveShaderHost(world, fills[index]!);
	if (!host?.ready) return;

	const eid = entity.id();
	const w = computed.width[eid]!;
	const h = computed.height[eid]!;

	// Anything but samplable media below (no fill below, a hidden one, a
	// solid/gradient) runs the shader procedurally over a transparent source,
	// stacking like a normal paint.
	const media = mediaBelow(world, entity, fills, index);
	let input: ReturnType<typeof shaderSourceBitmap> = null;
	if (media !== null) {
		input = shaderSourceBitmap(world, media, w, h);
		if (!input) return;
		const graded = gradeFrame(world, entity.has(ColorGrade) ? entity : media, input.source);
		sampleColorScopes(world, entity, graded);
		input = { ...input, source: graded };
	}

	const fit = input
		? getScaledImageProps(store(world, ScaleMode).value[media!.id()] ?? 0, input.width, input.height, w, h)
		: [0, 0, w, h] as [number, number, number, number];
	const fps = world.get(FrameRate)?.value ?? 30;
	const time = (computed.localTime[eid] ?? 0) / fps;

	ctx.save();
	clipGeometry(ctx, entity);
	host.draw(ctx, w, h, input?.source ?? null, input?.width ?? 1, input?.height ?? 1, fit, time, store(world, Shader).uniforms[fills[index]!.id()] ?? null);
	ctx.restore();
}

function renderShadows(world: World, entity: Entity): void {
	const ctx = getCtx(world);
	const computed = store(world, Computed);

	const shadows = store(world, Cache).shadows[entity.id()];
	if (!shadows) return;

	ctx.save();
	const savedAlpha = ctx.globalAlpha;

	// ctx.shadowBlur/OffsetX/OffsetY are in device-pixel space and are not
	// affected by the current transform, so scale them up to match the
	// content transform (camera * resolution).
	const transform = ctx.getTransform();
	const shadowScale = Math.hypot(transform.a, transform.b);

	for (const shadow of shadows) {
		if (shadow.has(Hidden)) continue;
		const sid = shadow.id();
		const color = colorToHex(computed.color[sid]!);
		ctx.shadowColor = color;
		ctx.fillStyle = color;
		ctx.globalAlpha = savedAlpha * computed.opacity[sid]!;
		ctx.shadowBlur = computed.blur[sid]! * shadowScale;
		ctx.shadowOffsetX = computed.offsetX[sid]! * shadowScale;
		ctx.shadowOffsetY = computed.offsetY[sid]! * shadowScale;
		fillGeometry(ctx, entity);
	}

	ctx.restore();
}

function renderStrokes(world: World, entity: Entity): void {
	const ctx = getCtx(world);
	const eid = entity.id();
	const strokes = store(world, Cache).strokes[eid];
	if (!strokes) return;

	const computed = store(world, Computed);
	const blendMode = store(world, BlendMode);
	const paintStore = store(world, Paint);

	for (const stroke of strokes) {
		if (stroke.has(Hidden)) continue;
		const sid = stroke.id();
		const savedAlpha = ctx.globalAlpha;
		const savedCO = ctx.globalCompositeOperation;
		const bi = blendMode.value[sid] ?? 0;

		if (bi !== 0) {
			ctx.globalCompositeOperation = COMPOSITE_OPERATIONS[bi]!;
		}

		applyStrokeStyle(ctx, world, stroke);
		ctx.globalAlpha = savedAlpha * computed.opacity[sid]!;

		const paintType = paintStore.value[sid];
		if (paintType === PaintType.LINEAR_GRADIENT) {
			const w = computed.width[eid]!;
			const h = computed.height[eid]!;
			ctx.strokeStyle = createLinearGradient(world, stroke, ctx, w, h);
		} else if (paintType === PaintType.RADIAL_GRADIENT) {
			const w = computed.width[eid]!;
			const h = computed.height[eid]!;
			ctx.strokeStyle = createRadialGradient(world, stroke, ctx, w, h);
		} else {
			ctx.strokeStyle = colorToHex(computed.color[sid]!);
		}
		const path = geometryPath(entity);
		if (path) ctx.stroke(path); else ctx.stroke();

		ctx.globalCompositeOperation = savedCO;
		ctx.globalAlpha = savedAlpha;
	}
}

/**
 * The pulse a node waiting on a generation is filled with
 */
function renderGenerating(world: World, entity: Entity): void {
	const errored = getSourceFailure(entity) !== undefined;
	if (!errored && !isGenerating(entity)) return;

	const ctx = getCtx(world);
	ctx.fillStyle = errored ? FAILED_COLOR : getGeneratingColor(world);
	fillGeometry(ctx, entity);
}

// ── WAVEFORM paint ─────────────────────────────────────
//
// Renders an audio asset's pre-computed peaks as a bar chart inside the
// parent geometry's bounds. Sourced from the paint's own AssetId — the paint
// carries its asset reference, exactly like IMAGE and VIDEO paints.

const WAVEFORM_BAR_WIDTH = 6;
const WAVEFORM_BAR_GAP = 6;
const WAVEFORM_BAR_RADIUS = WAVEFORM_BAR_WIDTH / 2;
const WAVEFORM_MIN_BAR_HEIGHT = 4;
const WAVEFORM_PADDING = 12;
const WAVEFORM_BG_COLOR = '#202020';
const WAVEFORM_BG_RADIUS = 12;

function renderWaveform(world: World, entity: Entity, fill: Entity): void {
	const ctx = getCtx(world);
	const computed = store(world, Computed);

	const peaks = resolveWaveformPeaks(world, fill);
	if (!peaks || peaks.length === 0) return;

	const w = computed.width[entity.id()]!;
	const h = computed.height[entity.id()]!;

	ctx.save();
	ctx.clip();

	// Background
	ctx.fillStyle = WAVEFORM_BG_COLOR;
	ctx.beginPath();
	ctx.roundRect(0, 0, w, h, WAVEFORM_BG_RADIUS);
	ctx.fill();

	// Bars
	const step = WAVEFORM_BAR_WIDTH + WAVEFORM_BAR_GAP;
	const availableWidth = w - WAVEFORM_PADDING * 2;
	const barCount = Math.floor(availableWidth / step);
	const maxBarHeight = h - WAVEFORM_PADDING * 2;
	if (barCount <= 0 || maxBarHeight <= 0) {
		ctx.restore();
		return;
	}

	const startX = WAVEFORM_PADDING + (availableWidth - barCount * step + WAVEFORM_BAR_GAP) / 2;

	ctx.fillStyle = '#ffffff';

	for (let i = 0; i < barCount; i++) {
		const peakIndex = Math.floor((i / barCount) * peaks.length);
		const value = (peaks[peakIndex] ?? 0) / 255;
		const barHeight = Math.max(value * maxBarHeight, WAVEFORM_MIN_BAR_HEIGHT);
		const x = startX + i * step;
		const y = (h - barHeight) / 2;

		ctx.beginPath();
		ctx.roundRect(x, y, WAVEFORM_BAR_WIDTH, barHeight, WAVEFORM_BAR_RADIUS);
		ctx.fill();
	}

	ctx.restore();
}

function renderShapeNode(world: World, entity: Entity): void {
	drawRectPath(world, entity);
	renderShadows(world, entity);
	renderIntrinsicFill(world, entity);
	renderFills(world, entity);
	renderGenerating(world, entity);
	renderStrokes(world, entity);
}

function renderTextNode(world: World, entity: Entity): void {
	renderText(world, entity, false);
}

function renderCaptionNode(world: World, entity: Entity): void {
	resolveCaptionDecoder(world, entity)?.draw(world, entity);
}

// ── Transition rendering ─────────────────────────────────────

function renderTransition(world: World, scene: Entity, left: Entity, draw = (node: Entity) => renderNode(world, node)): Entity | undefined {
	const ctx = getCtx(world);
	const computed = store(world, Computed);

	const currentTime = computed.localTime[scene.id()]!;

	const children = store(world, Cache).children[scene.id()] ?? [];
	const right = children.find(sibling => computed.start[sibling.id()] === computed.end[left.id()]);
	if (!right) return;

	const win = getTransitionWindow(world, left, right);

	if (currentTime < win.start || currentTime >= win.end) return;

	// we are transitioning
	const duration = win.end - win.start;
	const completion = (currentTime - win.start) / duration;

	const type = store(world, Transition).type[left.id()] ?? TransitionType.DISSOLVE;

	const parent = getParentNode(left);
	if (parent === null) return;
	const width = computed.width[parent.id()]!;
	const height = computed.height[parent.id()]!;

	switch (type) {
		case TransitionType.SLIDE_FROM_RIGHT: {
			draw(left);
			ctx.save();
			ctx.translate(((1 - completion) ** 2 * width) | 0, 0);
			draw(right);
			ctx.restore();
			break;
		}
		case TransitionType.SLIDE_FROM_LEFT: {
			draw(left);
			ctx.save();
			ctx.translate(((1 - completion) ** 2 * width * -1) | 0, 0);
			draw(right);
			ctx.restore();
			break;
		}
		case TransitionType.FADE_TO_BLACK: {
			if (completion < 0.5) {
				draw(left);
			} else {
				draw(right);
			}
			ctx.save();
			ctx.beginPath();
			ctx.rect(0, 0, width, height);
			ctx.closePath();
			ctx.fillStyle = '#000000';
			ctx.globalAlpha = completion < 0.5 ? 2 * completion : 2 * (1 - completion);
			ctx.fill();
			ctx.restore();
			break;
		}
		case TransitionType.FADE_TO_WHITE: {
			if (completion < 0.5) {
				draw(left);
			} else {
				draw(right);
			}
			ctx.save();
			ctx.beginPath();
			ctx.rect(0, 0, width, height);
			ctx.closePath();
			ctx.fillStyle = '#FFFFFF';
			ctx.globalAlpha = completion < 0.5 ? 2 * completion : 2 * (1 - completion);
			ctx.fill();
			ctx.restore();
			break;
		}
		default: {
			// Dissolve (default)
			draw(left);
			ctx.save();
			ctx.globalAlpha = completion;
			draw(right);
			ctx.restore();
			break;
		}
	}

	return right;
}

function clipSpatialGeometry(world: World, entity: Entity, plane: Mat2D): void {
	const ctx = getCtx(world);
	const project = (x: number, y: number) => transformPoint(plane, x, y);
	const vector = projectedGeometryPath(entity, project);
	if (vector) { ctx.clip(vector, geometryFillRule(entity)); return; }
	const frame = entity.get(Computed)!;
	const radii = entity.has(MixedCornerRadius)
		? [frame.cornerRadiusTopLeft, frame.cornerRadiusTopRight, frame.cornerRadiusBottomRight, frame.cornerRadiusBottomLeft]
		: [frame.cornerRadius, frame.cornerRadius, frame.cornerRadius, frame.cornerRadius];
	const scale = Math.min(1, frame.width / (radii[0]! + radii[1]! || 1), frame.height / (radii[1]! + radii[2]! || 1),
		frame.width / (radii[2]! + radii[3]! || 1), frame.height / (radii[3]! + radii[0]! || 1));
	const path = new Path2D();
	for (let corner = 0; corner < 4; corner++) {
		const radius = radii[(corner + 1) % 4]! * scale;
		const cx = corner < 2 ? frame.width - radius : radius;
		const cy = corner === 0 || corner === 3 ? radius : frame.height - radius;
		for (let n = 0; n <= 12; n++) {
			const angle = (-90 + corner * 90 + n / 12 * 90) * Math.PI / 180;
			const point = project(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
			if (corner === 0 && n === 0) path.moveTo(point.x, point.y); else path.lineTo(point.x, point.y);
		}
	}
	path.closePath();
	ctx.clip(path);
}

function renderSpatialChildren(world: World, parent: Entity, scene: Entity): void {
	const cache = store(world, Cache);
	const children = [...(cache.children[parent.id()] ?? [])];
	// UI compositions retain local layer depth; solid assemblies can sort faces by camera distance.
	if (parent.get(DepthSort)?.value === 'camera') {
		children.sort((a, b) => (spatialNode(world, b)?.distance ?? 0) - (spatialNode(world, a)?.distance ?? 0));
	} else {
		const computed = store(world, Computed);
		children.sort((a, b) => computed.positionZ[a.id()]! - computed.positionZ[b.id()]!);
	}
	const draw = (entity: Entity): void => {
		const spatial = spatialNode(world, entity);
		const values = entity.get(Computed)!;
		if (!spatial?.visible || entity.has(Hidden) || entity.has(IsMask) || values.visibility === 0) return;
		const ctx = getCtx(world);
		if (entity.has(Interactive)) world.get(HitRegions)?.list.push({ target: { kind: 'entity', id: entity } });
		ctx.save();
		for (const mask of cache.masks[entity.id()] ?? []) {
			const projected = spatialNode(world, mask);
			if (projected?.visible && mask.get(Computed)?.visibility !== 0) clipSpatialGeometry(world, mask, projected.plane);
		}
		ctx.globalAlpha *= values.opacity;
		const mode = entity.get(BlendMode)?.value ?? 0;
		if (mode) ctx.globalCompositeOperation = COMPOSITE_OPERATIONS[mode]!;
		const effects = buildEffects(world, entity);
		if (effects) ctx.filter = effects;
		const camera = scene.get(Computed)!;
		if (camera.aperture > 0) {
			const radius = Math.min(100, camera.aperture * Math.abs(spatial.distance - camera.focusDistance) / Math.max(1, spatial.distance));
			if (radius > .01) ctx.filter = `${effects ?? ''} blur(${radius * world.get(RenderSurface)!.resolution}px)`.trim();
		}
		if (values.backdropBlur || values.refraction) {
			ctx.save();
			clipSpatialGeometry(world, entity, spatial.plane);
			renderGlass(world, entity, multiply2D(ctx.getTransform(), spatial.plane));
			ctx.restore();
		}
		if (entity.has(Geometry) || entity.has(Preset) || entity.has(Highlight)) {
			drawSpatialLayer(world, entity, spatial.plane, scene, () => entity.has(Scene3D)
        ? drawScene3D(world, entity, (child, projected) => renderSceneVisual(world, child, projected))
        : renderVisual(world, entity));
		}
		if (entity.has(ClipsContent)) clipSpatialGeometry(world, entity, spatial.plane);
		if (!entity.has(Scene3D)) renderSpatialChildren(world, entity, scene);
		ctx.restore();
	};
	const transitioned = new Set<Entity>();
	for (const child of children) {
		if (transitioned.has(child)) continue;
		if (child.has(Transition)) {
			const partner = renderTransition(world, parent, child, draw);
			if (partner) { transitioned.add(partner); continue; }
		}
		draw(child);
	}
}

function renderGlass(world: World, entity: Entity, plane: Mat2D): void {
	const surface = world.get(RenderSurface)!;
	const ctx = surface.ctx!;
	const frame = motionEffectsFrame(world, entity, surface.canvas!, surface.resolution, plane);
	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.drawImage(frame, 0, 0);
	ctx.restore();
}

function renderVisual(world: World, entity: Entity): void {
	const eid = entity.id();
	if (entity.has(Preset)) {
		renderPreset(world, entity);
	} else if (entity.has(Highlight)) {
		renderHighlight(world, entity);
	} else if (entity.has(Caption)) {
		renderCaptionNode(world, entity);
	} else if (store(world, Geometry).value[eid] === GeometryType.TEXT) {
		renderTextNode(world, entity);
	} else if ([GeometryType.RECT, GeometryType.PATH, GeometryType.ELLIPSE].includes(store(world, Geometry).value[eid]!)) {
		renderShapeNode(world, entity);
	}

}

/** Native paints render identically on ordinary planes and projected Cairo path contours. */
function renderSceneVisual(world: World, entity: Entity, projected?: ProjectedVisual): void {
  const ctx = getCtx(world);
  ctx.save();
  const effects = buildEffects(world, entity);
  if (effects) ctx.filter = effects;
  const spatial = spatialNode(world, entity);
  if (spatial) {
    const toLocal = projected ? translate2D(-projected.sceneX, -projected.sceneY) : invert2D(spatial.world);
    const clip = (mask: Entity) => {
      const node = spatialNode(world, mask);
      if (!node?.visible || mask.has(Hidden) || mask.get(Computed)?.visibility === 0) return;
      clipSpatialGeometry(world, mask, multiply2D(toLocal, projected ? node.plane : node.world));
    };
    for (let owner: Entity | null = entity; owner && owner !== spatial.scene; owner = getParentNode(owner)) {
      for (const mask of owner.get(Cache)?.masks ?? []) clip(mask);
      if (owner !== entity && owner.has(ClipsContent)) clip(owner);
    }
  }
  if (!projected) {
    try {
      if (entity.has(Scene3D)) drawScene3D(world, entity, (child, override) => renderSceneVisual(world, child, override));
      else if (entity.get(Geometry)?.value === GeometryType.MESH) renderShapeNode(world, entity);
      else renderVisual(world, entity);
    } finally { ctx.restore(); }
    return;
  }
  const geometry = store(world, Geometry), computed = store(world, Computed), id = entity.id();
  const previous = { type: geometry.value[id]!, path: computed.pathData[id]!, width: computed.width[id]!, height: computed.height[id]! };
  geometry.value[id] = GeometryType.PATH;
  computed.pathData[id] = projected.d; computed.width[id] = projected.width; computed.height[id] = projected.height;
  try { renderVisual(world, entity); } finally {
    geometry.value[id] = previous.type; computed.pathData[id] = previous.path;
    computed.width[id] = previous.width; computed.height[id] = previous.height;
    ctx.restore();
  }
}

export function renderNode(world: World, entity: Entity): void {
	const ctx = getCtx(world);
	const computed = store(world, Computed);
	const eid = entity.id();

	if (computed.visibility[eid] === 0 || entity.has(Culled)) return;

	if (entity.has(Interactive)) {
		world.get(HitRegions)?.list.push({
			target: { kind: 'entity', id: entity },
		});
	}

	if (entity.has(IsMask) || entity.has(Hidden)) return;

	ctx.save();

	const local = store(world, LocalTransform);
	ctx.transform(
		local.a[eid]!,
		local.b[eid]!,
		local.c[eid]!,
		local.d[eid]!,
		local.e[eid]!,
		local.f[eid]!,
	);

	const worldTransform = store(world, WorldTransform);
	const matrix = (id: number): Mat2D => ({
		a: worldTransform.a[id]!, b: worldTransform.b[id]!, c: worldTransform.c[id]!,
		d: worldTransform.d[id]!, e: worldTransform.e[id]!, f: worldTransform.f[id]!,
	});
	for (const mask of store(world, Cache).masks[eid] ?? []) {
		if (computed.visibility[mask.id()] === 0) continue;
		const projected = spatialNode(world, mask);
		if (projected && !projected.visible) continue;
		clipSpatialGeometry(world, mask, projected?.scene === entity
			? projected.plane
			: multiply2D(invert2D(matrix(eid)), projected?.world ?? matrix(mask.id())));
	}

	// Opacity and blend mode. The store slot may hold a destroyed entity's
	// value (ids are recycled), so it is only readable behind has().
	ctx.globalAlpha *= computed.opacity[eid]!;
	const bi = entity.has(BlendMode) ? store(world, BlendMode).value[eid] ?? 0 : 0;
	if (bi !== 0) ctx.globalCompositeOperation = COMPOSITE_OPERATIONS[bi]!;

	const effects = buildEffects(world, entity);
	let initialFilter = 'none';

	if (effects !== null) {
		initialFilter = ctx.filter;
		ctx.filter = effects;
	}


	if (computed.backdropBlur[eid] || computed.refraction[eid]) {
		ctx.save();
		drawRectPath(world, entity);
		clipGeometry(ctx, entity);
		renderGlass(world, entity, ctx.getTransform());
		ctx.restore();
	}
	renderVisual(world, entity);
  if (entity.has(Scene3D)) {
    drawScene3D(world, entity, (child, projected) => renderSceneVisual(world, child, projected));
    ctx.restore();
    return;
  }
	// Clip and render children
	const children = store(world, Cache).children[eid] ?? [];
	if (children.length) {
		if (entity.has(ClipsContent)) {
			ctx.save();
			drawRectPath(world, entity);
			clipGeometry(ctx, entity);
		}

		let transitioned: Set<Entity> | undefined;
		if (hasSpatialCamera(world, entity)) renderSpatialChildren(world, entity, entity);
		for (const child of hasSpatialCamera(world, entity) ? [] : children) {
			if (transitioned?.has(child)) continue;
			// Edge case: Child with transition
			if (child.has(Transition)) {
				const partner = renderTransition(world, entity, child);
				if (partner) { (transitioned ??= new Set()).add(partner); continue; }
			}

			if (isScene(child)) renderWithSceneEffects(world, child, () => renderNode(world, child));
			else renderNode(world, child);
		}

		if (entity.has(ClipsContent)) {
			ctx.restore();
		}
	}

	// Reset filter after drawing
	if (initialFilter !== 'none') {
		ctx.filter = initialFilter;
	}

	ctx.restore();
}

/**
 * Render system entry point. Call after transformSystem.
 *
 * Reads camera, background, and canvas size from world state and applies
 * DPR * Camera as the base canvas transform before drawing top-level nodes.
 * Without a render surface (headless world) this is a no-op.
 * Returns false when nothing was drawn, so the host also retains its HUD.
 */
export function renderSystem(world: World): boolean {
	const surface = world.get(RenderSurface);
	const ctx = surface?.ctx;
	const canvas = surface?.canvas;
	if (!ctx || !canvas) return false;

	const view = getViewMatrix(world);
	const seek = surface.pendingSeek;
	if (seek) {
		let waiting = false;
		let failed = false;
		if (world.get(Mode)?.value === 'realtime' && seek.scene.isAlive()
			&& canvas.width === seek.width && canvas.height === seek.height
			&& Object.entries(view).every(([key, value]) => value === seek.view[key as keyof typeof seek.view])) {
			for (const source of world.query(VideoDecoderHandle, Not(Hidden))) {
				const node = source.has(Geometry) ? source : getParentNode(source);
				if (node?.get(Computed)?.visibility !== 1) continue;
				let ancestor: Entity | null = node;
				while (ancestor && ancestor !== seek.scene && !ancestor.has(Hidden) && !ancestor.has(Culled)
					&& ancestor.get(Computed)?.visibility !== 0) ancestor = getParentNode(ancestor);
				if (ancestor !== seek.scene || ancestor.has(Hidden) || ancestor.has(Culled)) continue;
				const decoder = source.get(VideoDecoderHandle);
				if (decoder?.errored) failed = true;
				else if (decoder && !decoder.toBitmap()) waiting = true;
			}
		}
		// A seek keeps the last composition until the incoming picture exists.
		// Gaps, failed media, changed views, and exports still render immediately.
		if (waiting && !failed) return false;
		world.set(RenderSurface, { pendingSeek: null });
	}

	const regions = world.get(HitRegions)?.list;
	if (regions) regions.length = 0;
	beginColorScopeFrame(world);
	const cw = canvas.width;
	const ch = canvas.height;

	// Clear + background (identity transform for full-canvas clear)
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, cw, ch);

	// The stage background is a preview-only affordance; offline encoding
	// renders just the scene onto a transparent canvas (the scene paints its
	// own fill if it has one).
	if (world.get(Mode)?.value === 'realtime') {
		ctx.fillStyle = colorToHex(world.get(Root)!.get(Background)?.value ?? 0);
		ctx.fillRect(0, 0, cw, ch);
		world.get(HitRegions)?.list.push({
			target: { kind: 'hud', id: 'canvas', quad: getCanvasQuad(cw, ch) },
		});
	}

	// Apply camera transform: DPR * Camera
	ctx.setTransform(view.a, view.b, view.c, view.d, view.e, view.f);

	// Render top-level nodes.
	const stage = world.get(Root)!;
	prepareSceneEffects(world);
	prepareScenes3D(world, (child, projected) => renderSceneVisual(world, child, projected));
	for (const entity of world.query(Or(Geometry, Group), ChildOf(stage), Not(Culled))) {
		renderWithSceneEffects(world, entity, () => renderNode(world, entity));
	}
	finishColorScopeFrame(world);
	return true;
}

function getCanvasQuad(width: number, height: number): Quad {
	return [
		{ x: 0, y: 0 },
		{ x: width, y: 0 },
		{ x: width, y: height },
		{ x: 0, y: height },
	];
}
