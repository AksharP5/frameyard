/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { trait, type Entity, type World } from 'koota';

import type { FontSource } from '../fonts/types';
import type { AssetLibrary, AudioAsset, VideoAsset } from '@diffusionstudio/assets';
import type { GenAi } from '../ai';
import type { Quad } from '../math/aabb';


export const Project = trait({ id: '' });

// Tag on the single stage entity every runtime world owns.
export const Stage = trait();

// World-level pointer to the stage entity
export const Root = trait(() => null as Entity | null);

/**
 * 2D affine camera transform in CSS pixel space (before DPR scaling), on the
 * stage. The render system multiplies this by RenderSurface.resolution
 * to derive the canvas transform.
 */
export const Camera = trait({ a: 0.3, b: 0, c: 0, d: 0.3, e: 85, f: 150 });

export type Camera2D = { a: number; b: number; c: number; d: number; e: number; f: number };

export const DEFAULT_BACKGROUND = 0x161616;

// Stage background color, on the stage entity.
export const Background = trait({ value: DEFAULT_BACKGROUND });

export type RuntimeMode = 'realtime' | 'offline-video' | 'offline-audio';

export const Mode = trait({ value: 'realtime' as RuntimeMode });

// On the world: nothing in this render is to be heard, so no audio decoder is
// ever opened (a frame capture draws pictures and never mixes). A rendering
// concern, kept apart from `Muted`, which is the composition's own — a clip
// the project muted. What is silenced here is still audio the scene has.
export const Silent = trait();

// Frame clock (was timestamp).
export const Time = trait({ now: 0, delta: 0 });

// Render/preview clock. Offline exports may use a different rate from the project.
export const FrameRate = trait({ value: 30 });

// Authored frame units retain their project duration when export FPS differs.
export const ProjectFrameRate = trait({ value: 30 });

// Render target injected by the host. Capture uses an HTML canvas too so HTML
// paint roots can live in its layout subtree. resolution is the pixel ratio.
export const RenderSurface = trait({
	canvas: () => null as HTMLCanvasElement | OffscreenCanvas | null,
	ctx: () => null as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null,
	resolution: 1,
	pendingSeek: () => null as { scene: Entity; width: number; height: number; view: Camera2D } | null,
});

// Audio output injected by the host: a realtime AudioContext in the editor,
// an OfflineAudioContext during capture.
export const AudioEngine = trait({
	context: () => null as AudioContext | OfflineAudioContext | null,
	output: () => null as AudioNode | null,
});

// Fonts registered for text layout.
export const Fonts = trait({ list: () => [] as FontSource[] });

// The project's asset library, once the host has attached one (it needs the
// project's file system): every asset an entity's AssetId can name, library
// and transient alike. Null in a world without a project.
export const Library = trait(() => null as AssetLibrary | null);

export type OriginalVideoFrames = {
	frameRate: number;
	read(frame: number): Promise<{ data: Uint8Array; width: number; height: number }>;
	close(): Promise<void>;
};
export type OriginalMediaProvider = {
	openVideo(asset: VideoAsset, stream?: number): Promise<OriginalVideoFrames>;
	audioFile(asset: AudioAsset | VideoAsset, stream: number): Promise<File>;
};
export const OriginalMedia = trait(() => null as OriginalMediaProvider | null);

// The generation service, once the host has attached one (it needs a
// backend): what the asset system runs `generate.*` sources through, and
// what `getAi(world).generate.image(...)` calls. Optional — in a world
// without one, such sources stay pending and never resolve.
export const Ai = trait(() => null as GenAi | null);

// Per-tick callbacks. A mounted project adds one to feed its `useTicker`
// clock; the playback system fires the set once per tick, after playheads
// advance. Held on the world so anything that runs the systems (the editor
// loop, the encoder) drives the mounts without knowing them.
export const Tickers = trait(() => new Set<() => void>());

// Async barrier for offline capture: systems push decoder/host readiness
// promises here; the encoder awaits and clears them before sampling a frame.
// null in realtime mode (nothing collects).
export const FramePromises = trait({
	list: () => null as (Promise<unknown> | null)[] | null,
});

export type EntityTarget = {
	kind: 'entity';
	id: Entity;
};

export type HudTarget = {
	kind: 'hud';
	id: string;
	quad: Quad;
	entity?: Entity;
};

export type PointerEventType =
	| 'pointermove'
	| 'pointerdown'
	| 'pointerup'
	| 'pointerenter'
	| 'pointerleave'
	| 'dragstart'
	| 'drag'
	| 'dragend'
	| 'click'
	| 'dblclick';

/**
 * A pointer event in canvas device pixels (CSS pixels x resolution), which is
 * the space WorldTransform and the hit region quads are in. Not a DOM event:
 * the app's input layer distills one of these per DOM event, and adds the
 * gesture types (drag*, pointerenter/leave) the DOM has no equivalent for.
 */
export type CanvasPointerEvent = {
	type: PointerEventType;
	clientX: number;
	clientY: number;
	button: number; // 0: left, 1: middle, 2: right
};

export type DispatchedPointerEvent = CanvasPointerEvent & {
	target: EntityTarget | HudTarget;
};

// Paint-order hit regions collected during a render pass (topmost last). The
// render system replaces the list when it draws a new picture and pushes
// callback-less entries for Interactive entities and the stage canvas. The
// app adds HUD controls with handlers and maps callback-less targets to its
// default interaction handlers. A held preview retains its input targets.
export type HitRegion = {
	target: EntityTarget | HudTarget;
	callback?: (world: World, event: DispatchedPointerEvent) => void;
};

export const HitRegions = trait({ list: () => [] as HitRegion[] });
