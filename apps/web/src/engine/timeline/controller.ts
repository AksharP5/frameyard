/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The DOM around the timeline: which canvas it draws on, how big that is,
 * and what the wheel does to it. Everything it changes is view state on the
 * scene (see `./view`), which the draw pass reads back a frame later — the
 * controller itself never paints.
 */

import { getTimelineView } from '@diffusionstudio/runtime';

import { assert, clamp } from '@/utils';
import { getDocumentEditor } from '@/engine/editor';
import { getEditHistory } from '@/engine/history';
import { createPointer } from './pointer';
import { updateDragGestures } from './drag';
import { TimelineSurface } from './surface';
import { timelineSystem } from './timeline';
import {
	getResolution,
	getScrollX,
	getScrollY,
	getTimelineScene,
	pixelsToFrames,
	setResolution,
	setScrollX,
	setScrollY,
	updateTimelineTransform,
	zoomTimelineView,
} from './view';
import {
	SCROLL_X_SENSITIVITY,
	TIMELINE_RESOLUTION_RANGE,
	WHEEL_LINE_HEIGHT,
	WHEEL_PAGE_HEIGHT,
	ZOOM_DELTA_CLAMP,
	ZOOM_SENSITIVITY,
} from './config';
import { getFrameRate } from './view';

import type { Entity, World } from 'koota';

export type TimelineController = ReturnType<typeof createTimelineController>;

export function createTimelineController(world: World) {
	const surface = world.get(TimelineSurface)!;

	const pointer = createPointer({
		get marquee() { return surface.marquee; },
		get canvas() { return surface.canvas; },
		get ctx() { return surface.ctx; },
	});

	let layersEl: HTMLElement | null = null;
	let layersViewportEl: HTMLElement | null = null;
	// How far the row labels have been scrolled sideways, in pixels. A DOM
	// concern rather than the scene's: it is the same for every scene.
	let layerScrollX = 0;
	let viewportWidth = window.innerWidth;
	let pan: { pointerId: number; scene: Entity; clientX: number; scrollX: number; resolution: number } | null = null;
	let pointerId: number | null = null;

	/** Runs `action` against the scene on show, if there is one. */
	const withScene = (action: (scene: Entity) => void): void => {
		const scene = getTimelineScene(world);
		if (scene !== null) action(scene);
	};

	/**
	 * A gesture moved the view: report it so the file remembers where the
	 * scene's timeline is looking (`<scene timeline>`), the way the camera
	 * controller reports a pan. No `previous`, so it never enters the history.
	 */
	const reportView = (scene: Entity): void => {
		const view = getTimelineView(world, scene);
		if (view) getDocumentEditor(world).reportEdit(scene, 'timeline', view);
	};

	const handlePointerDown = (event: PointerEvent): void => {
		if (event.button === 0 || event.button === 1) surface.canvas?.focus({ preventScroll: true });
		if (pan) return;
		if (event.button !== 1) {
			if (event.button !== 0 || pointerId !== null) return;
			pointerId = event.pointerId;
			getEditHistory(world).beginGesture();
			pointer.down(event);
			surface.canvas?.setPointerCapture(event.pointerId);
			return;
		}
		if (pointer.position && pointer.position.state !== 'idle') return;
		const scene = getTimelineScene(world);
		if (scene === null) return;
		event.preventDefault();
		pan = {
			pointerId: event.pointerId, scene, clientX: event.clientX,
			scrollX: getScrollX(world, scene), resolution: getResolution(world, scene),
		};
		surface.panning = true;
		surface.canvas?.setPointerCapture(event.pointerId);
	};

	const finishPan = (): void => {
		if (!pan) return;
		const finished = pan;
		pan = null;
		surface.panning = false;
		if (surface.canvas?.hasPointerCapture(finished.pointerId)) surface.canvas.releasePointerCapture(finished.pointerId);
		if (finished.scene.isAlive()) reportView(finished.scene);
	};

	const handlePointerMove = (event: PointerEvent): void => {
		if (!pan) {
			if (pointerId !== null && event.pointerId !== pointerId) return;
			pointer.move(event);
			return;
		}
		if (event.pointerId !== pan.pointerId) return;
		if (getTimelineScene(world) !== pan.scene || !(event.buttons & 4)) {
			finishPan();
			return;
		}
		setScrollX(world, pan.scene, pan.scrollX - (event.clientX - pan.clientX) / pan.resolution);
		updateTimelineTransform(world, pan.scene);
	};

	const handlePointerUp = (event: PointerEvent): void => {
		if (pan) {
			if (event.pointerId === pan.pointerId) finishPan();
			return;
		}
		if (event.pointerId !== pointerId) return;
		pointerId = null;
		pointer.up(event);
		// Consume the lift and settle moved clips before closing the undo step.
		timelineSystem(world);
		updateDragGestures(world, surface);
		getEditHistory(world).endGesture();
	};

	const cancelPointer = (): void => {
		if (pointerId === null) return;
		const canceledId = pointerId;
		pointerId = null;
		if (surface.canvas?.hasPointerCapture(canceledId)) surface.canvas.releasePointerCapture(canceledId);
		pointer.cancel();
		surface.marquee = null;
		getEditHistory(world).cancelGesture();
		updateDragGestures(world, surface);
	};

	const handlePointerCancel = (event: PointerEvent): void => {
		if (pan?.pointerId === event.pointerId) finishPan();
		else if (pointerId === event.pointerId) cancelPointer();
	};

	const handleLostCapture = (event: PointerEvent): void => {
		if (pan?.pointerId === event.pointerId) finishPan();
		else if (pointerId === event.pointerId) cancelPointer();
	};

	const handleBlur = (): void => {
		finishPan();
		cancelPointer();
	};

	const handleAuxClick = (event: MouseEvent): void => {
		if (event.button === 1) event.preventDefault();
	};

	const applyResize = (): void => {
		const { canvas } = surface;
		const parent = canvas?.parentElement;
		if (!parent || !canvas) return;

		const previousWidth = surface.layout.width;
		const viewportResized = viewportWidth !== window.innerWidth;
		viewportWidth = window.innerWidth;
		surface.layout = parent.getBoundingClientRect();
		const nextWidth = surface.layout.width;
		if (!viewportResized && previousWidth > 0 && nextWidth > 0 && previousWidth !== nextWidth) {
			withScene((scene) => {
				// Keep both ends of the visible time range when a panel takes space.
				// Window resizing, including startup, preserves the saved pixels-per-second zoom.
				setResolution(world, scene, getResolution(world, scene) * nextWidth / previousWidth);
				reportView(scene);
			});
		}
		applyScroll();

		const dpr = window.devicePixelRatio;

		canvas.style.width = `${surface.layout.width}px`;
		canvas.style.height = `${surface.layout.height}px`;

		const width = Math.floor(surface.layout.width * dpr);
		const height = Math.floor(surface.layout.height * dpr);
		if (canvas.width === width && canvas.height === height) return;

		canvas.width = width;
		canvas.height = height;
	};

	const resize = (): void => {
		applyResize();
		withScene((scene) => updateTimelineTransform(world, scene));
		timelineSystem(world);
	};

	const observer = new ResizeObserver(resize);

	const layerObserver = new ResizeObserver(() => {
		applyScroll();
		withScene((scene) => updateTimelineTransform(world, scene));
	});

	/**
	 * Moves the DOM row labels to match the canvas's vertical scroll, clamped
	 * to the height of the layer list.
	 */
	const applyVerticalScroll = (): void => {
		if (!layersEl || !layersViewportEl) return;

		withScene((scene) => {
			const scrollY = clamp(getScrollY(world, scene), 0, Math.max(0, layersEl!.scrollHeight - layersViewportEl!.clientHeight));
			setScrollY(world, scene, scrollY);
			layersEl!.style.transform = `translateY(${-scrollY}px)`;
		});
	};

	const applyLayerScrollX = (): void => {
		if (!layersEl) return;
		// Measure label widths only when horizontal scrolling or layout changes.
		let maxScrollX = 0;
		for (const label of layersEl.querySelectorAll<HTMLElement>('[data-layer-label]')) {
			maxScrollX = Math.max(maxScrollX, label.scrollWidth - label.clientWidth);
		}
		layerScrollX = clamp(layerScrollX, 0, maxScrollX);
		layersEl.style.setProperty('--layer-x', `${layerScrollX}px`);
	};

	const applyScroll = (): void => {
		applyVerticalScroll();
		applyLayerScrollX();
	};

	const labelObserver = new MutationObserver(applyLayerScrollX);

	/**
	 * One axis at a time, in the order the gesture is most likely to have
	 * meant: zoom while a modifier is held, then whichever of the two scroll
	 * axes the wheel moved further in.
	 */
	const handleWheel = (event: WheelEvent): void => {
		event.preventDefault();

		withScene((scene) => {
			const { deltaX, deltaY } = normalizeWheel(event);
			const resolution = getResolution(world, scene);
			const scrollX = getScrollX(world, scene);

			if (event.altKey || event.ctrlKey || event.metaKey) {
				const delta = clamp(deltaY, -ZOOM_DELTA_CLAMP, ZOOM_DELTA_CLAMP);
				const next = clamp(
					resolution * Math.exp(-delta * ZOOM_SENSITIVITY),
					Math.min(resolution, 1 / TIMELINE_RESOLUTION_RANGE[1]),
					Math.max(resolution, 1 / TIMELINE_RESOLUTION_RANGE[0]),
				);

				zoomTimelineView(world, scene, next, surface.layout.width);
			} else if (Math.abs(deltaX) > Math.abs(deltaY)) {
				setScrollX(world, scene, scrollX + (deltaX * SCROLL_X_SENSITIVITY) / resolution);
			} else {
				setScrollY(world, scene, getScrollY(world, scene) + deltaY);
				applyVerticalScroll();
			}

			updateTimelineTransform(world, scene);
			reportView(scene);
		});
	};

	/** The wheel over the row labels, which scroll but do not zoom. */
	const scroll = (event: WheelEvent): void => {
		event.preventDefault();

		withScene((scene) => {
			const { deltaX, deltaY } = normalizeWheel(event);

			if (Math.abs(deltaX) > Math.abs(deltaY)) {
				layerScrollX += deltaX;
				applyLayerScrollX();
			} else {
				setScrollY(world, scene, getScrollY(world, scene) + deltaY);
				applyVerticalScroll();
			}

			updateTimelineTransform(world, scene);
			reportView(scene);
		});
	};

	/** Programmatic vertical scroll, for gestures that hold near an edge. */
	const scrollBy = (deltaY: number): void => {
		withScene((scene) => {
			setScrollY(world, scene, getScrollY(world, scene) + deltaY);
			applyVerticalScroll();
			updateTimelineTransform(world, scene);
			reportView(scene);
		});
	};

	const clientToFrame = (clientX: number): number => {
		const scene = getTimelineScene(world);
		if (scene === null) return 0;

		const resolution = getResolution(world, scene);
		const rect = surface.canvas?.getBoundingClientRect();

		return pixelsToFrames(clientX - (rect?.left ?? 0) + getScrollX(world, scene) * resolution, resolution);
	};

	const clientToTime = (clientX: number): number => clientToFrame(clientX) / getFrameRate(world);

	const setMinimized = (minimized: boolean): void => {
		surface.minimized = minimized;
	};

	const attachCanvas = (): void => {
		const canvas = document.getElementById('timeline-canvas') as HTMLCanvasElement | null;
		assert(canvas, 'Timeline canvas must be defined');

		const parent = canvas.parentElement;
		assert(parent, 'Timeline canvas must have a parent element');

		surface.canvas = canvas;
		canvas.tabIndex = -1;
		surface.ctx = canvas.getContext('2d');
		surface.layout = parent.getBoundingClientRect();
		viewportWidth = window.innerWidth;

		observer.observe(parent);

		canvas.addEventListener('wheel', handleWheel);
		canvas.addEventListener('pointerdown', handlePointerDown);
		canvas.addEventListener('auxclick', handleAuxClick);
		canvas.addEventListener('lostpointercapture', handleLostCapture);

		applyResize();
	};

	const detachCanvas = (): void => {
		handleBlur();
		observer.disconnect();

		surface.canvas?.removeEventListener('wheel', handleWheel);
		surface.canvas?.removeEventListener('pointerdown', handlePointerDown);
		surface.canvas?.removeEventListener('auxclick', handleAuxClick);
		surface.canvas?.removeEventListener('lostpointercapture', handleLostCapture);

		// Dropped rather than kept stale: the draw pass no-ops until another
		// canvas is attached.
		surface.canvas = null;
		surface.ctx = null;
	};

	/**
	 * The row labels and the pointer, which outlive the canvas: the timeline
	 * can be collapsed and reopened without the rows going anywhere.
	 */
	const mount = (): void => {
		const layers = document.querySelector<HTMLElement>('[data-timeline-layers]');
		assert(layers, 'Timeline layers element must be defined');

		const viewport = document.querySelector<HTMLElement>('[data-timeline-layers-viewport]');
		assert(viewport, 'Timeline layers viewport element must be defined');

		layersEl = layers;
		layersViewportEl = viewport;
		surface.pointer = pointer;

		layerObserver.observe(layers);
		labelObserver.observe(layers, { childList: true, characterData: true, subtree: true });

		// On the body, so a drag that leaves the canvas still finishes.
		document.body.addEventListener('pointermove', handlePointerMove, { passive: true });
		document.body.addEventListener('pointerup', handlePointerUp, { passive: true });
		document.body.addEventListener('pointercancel', handlePointerCancel, { passive: true });
		window.addEventListener('blur', handleBlur);
	};

	const unmount = (): void => {
		handleBlur();
		layerObserver.disconnect();
		labelObserver.disconnect();
		surface.pointer = null;

		document.body.removeEventListener('pointermove', handlePointerMove);
		document.body.removeEventListener('pointerup', handlePointerUp);
		document.body.removeEventListener('pointercancel', handlePointerCancel);
		window.removeEventListener('blur', handleBlur);
	};

	return {
		mount,
		unmount,
		attachCanvas,
		detachCanvas,
		scroll,
		scrollBy,
		clientToFrame,
		clientToTime,
		setMinimized,
	};
}

/**
 * Wheel deltas in the units the event says they are in. A line or a page is
 * whatever the platform decides; pixels are the only comparable unit.
 */
function normalizeWheel(event: WheelEvent): { deltaX: number; deltaY: number } {
	const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
		? WHEEL_LINE_HEIGHT
		: event.deltaMode === WheelEvent.DOM_DELTA_PAGE
			? WHEEL_PAGE_HEIGHT
			: 1;

	return { deltaX: event.deltaX * scale, deltaY: event.deltaY * scale };
}
