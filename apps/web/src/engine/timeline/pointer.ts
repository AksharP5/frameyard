/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { assert } from "@/utils";
import * as cfg from "./config";

import type { Marquee } from "./surface";

type MousePosition = {
  state: 'idle';
  currentX: number;
  currentY: number;
} | {
  state: 'pressed' | 'pressing' | 'lifted';
  initialX: number;
  initialY: number;
  timestamp: number;
  currentX: number;
  currentY: number;
  deltaX: number;
  deltaY: number;
}

type TransformedRegion = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  id: string;
  passthrough: boolean;
}

type HitRegions = {
  prev: Array<TransformedRegion>;
  next: Array<TransformedRegion>;
  id: string;
  index: number;
};

export type TimelinePointer = ReturnType<typeof createPointer>;

type PointerOptions = {
  marquee?: Marquee | null;
  canvas?: HTMLCanvasElement | null;
  ctx?: CanvasRenderingContext2D | null;
};

export function createPointer(options: PointerOptions) {
  let position: MousePosition | null = null;
  let pressRegionID: string | null = null;
  let hitRegions: HitRegions = {
    prev: [],
    next: [],
    id: '',
    index: 0,
  };
  let lastClickPosition: {
    x: number;
    y: number;
    timestamp: number;
  } | null = null;

  let shiftPressed = false;
  let altPressed = false;
  let hits: { primary: string | null; passive: Set<string> } | null = null;

  function down(event: PointerEvent) {
    const rect = options.canvas?.getBoundingClientRect();
    if (!rect || event.button !== 0) return;
    hits = null;

    const currentX = event.clientX - rect.left;
    const currentY = event.clientY - rect.top;

    position = {
      state: 'pressed',
      timestamp: performance.now(),
      initialX: currentX,
      initialY: currentY,
      currentX,
      currentY,
      deltaX: 0,
      deltaY: 0,
    };

    shiftPressed = event.shiftKey;
    altPressed = event.altKey;
  }

  function move(event: PointerEvent) {
    const rect = options.canvas?.getBoundingClientRect();
    if (!rect) return;
    hits = null;

    shiftPressed = event.shiftKey;
    altPressed = event.altKey;

    const currentX = event.clientX - rect.left;
    const currentY = event.clientY - rect.top;

    if (!position) {
      position = {
        state: 'idle',
        currentX,
        currentY,
      };
      return;
    }

    if (position.state != 'idle') {
      position.deltaX = currentX - position.initialX;
      position.deltaY = currentY - position.initialY;
    }

    position.currentX = currentX;
    position.currentY = currentY;
  }

  function up(event: PointerEvent) {
    const rect = options.canvas?.getBoundingClientRect();
    if (!rect) return;
    if (!position || position.state === 'idle') return;
    hits = null;

    const currentX = event.clientX - rect.left;
    const currentY = event.clientY - rect.top;

    position = {
      ...position,
      state: 'lifted',
      currentX,
      currentY,
      deltaX: currentX - position.initialX,
      deltaY: currentY - position.initialY,
    };
    pressRegionID = null;
    shiftPressed = event.shiftKey;
    altPressed = event.altKey;
  }

  function cancel() {
    if (position) position = { state: 'idle', currentX: position.currentX, currentY: position.currentY };
    pressRegionID = null;
    lastClickPosition = null;
    hits = null;
  }


  function scope(id: string) {
    hitRegions.id = id;
    hitRegions.index = 0;

    return pointer;
  }

  function region(x = 0, y = 0, w: number, h: number, id?: string, passthrough = false) {
    assert(options.ctx, 'Canvas context must be set');

    if (!position) return {
      hovering: false,
      clicked: false,
      pressing: false,
      pressed: false,
      dragging: false,
      doubleClicked: false,
      intersectsMarquee: false,
    };

    const regionData = {
      id: `${hitRegions.id}/${id ?? hitRegions.index}`,
      ...transformRegionToCanvas(options.ctx, x, y, w, h),
      passthrough,
    };

    hitRegions.index++;
    hitRegions.next.push(regionData);

    // Every region sees the same pointer and previous frame. Scan once per
    // frame or pointer event, rather than once for every clip and trim handle.
    if (!hits) {
      const mouseX = position.currentX * window.devicePixelRatio;
      const mouseY = position.currentY * window.devicePixelRatio;
      hits = { primary: null, passive: new Set() };
      for (const region of hitRegions.prev) {
        if (mouseX < region.minX || mouseX >= region.maxX || mouseY < region.minY || mouseY >= region.maxY) continue;
        if (region.passthrough) hits.passive.add(region.id);
        else hits.primary = region.id;
      }
    }

    let isPrimary = hits.primary === regionData.id;
    let isPassive = hits.passive.has(regionData.id);
    let hovering = isPrimary || isPassive;
    let pressing = hovering && position?.state == 'pressing';
    let pressed = hovering && position?.state == 'pressed';

    // Track the region that was pressed down on
    if (pressed) {
      pressRegionID = hits.primary;
    }

    // Assign dragging state after a distance threshold has been passed
    let dragging = false;
    if (position?.state == 'pressing' && pressRegionID == regionData.id) {
      const distance = Math.sqrt(position.deltaX ** 2 + position.deltaY ** 2);
      dragging = distance >= cfg.CLICK_DISTANCE_THRESHOLD;
    }

    // Only consider click if pointer hasn't moved beyond the distance threshold
    let clicked = false;
    if (position?.state == 'lifted') {
      const distance = Math.sqrt(position.deltaX ** 2 + position.deltaY ** 2);
      clicked = distance < cfg.CLICK_DISTANCE_THRESHOLD && hovering;
    }

    let doubleClicked = false;
    if (clicked && lastClickPosition) {
      const delta = performance.now() - lastClickPosition.timestamp;
      const distance = Math.sqrt(
        Math.pow(position.currentX - lastClickPosition.x, 2) +
        Math.pow(position.currentY - lastClickPosition.y, 2)
      );
      doubleClicked = delta < cfg.DOUBLE_CLICK_THRESHOLD && hovering && distance < 10;
    }

    let intersectsMarquee = false;
    if (options.marquee) {
      // Convert marquee selection from CSS pixels to canvas coordinates
      const marqueeMinX = options.marquee.x * window.devicePixelRatio;
      const marqueeMaxX = (options.marquee.x + options.marquee.width) * window.devicePixelRatio;
      const marqueeMinY = options.marquee.y * window.devicePixelRatio;
      const marqueeMaxY = (options.marquee.y + options.marquee.height) * window.devicePixelRatio;

      // Check intersection: regions intersect if they overlap
      intersectsMarquee = !(
        regionData.maxX < marqueeMinX ||
        regionData.minX > marqueeMaxX ||
        regionData.maxY < marqueeMinY ||
        regionData.minY > marqueeMaxY
      );
    }

    return {
      hovering, // If the pointer is over the rect
      clicked, // If the rect was clicked this frame
      pressing, // If the pointer is pressing down on the rect this frame
      pressed, // If the just started pressing down on the rect this frame
      dragging, // If the pointer is dragging the rect this frame
      doubleClicked, // If the rect was double clicked this frame
      intersectsMarquee, // If the region intersects the marquee selection
    };
  }

  function reset() {
    hits = null;
    hitRegions.prev = [...hitRegions.next];
    hitRegions.next.length = 0;

    if (position?.state == 'lifted') {
      position = {
        ...position,
        state: 'idle',
      };
      lastClickPosition = {
        x: position.currentX,
        y: position.currentY,
        timestamp: performance.now(),
      };
    }

    if (position?.state == 'pressed') {
      position = {
        ...position,
        state: 'pressing',
      };
    }
  }

  const pointer = {
    get position() {
      return position;
    },
    get shiftPressed() {
      return shiftPressed;
    },
    get altPressed() {
      return altPressed;
    },
    down,
    move,
    up,
    cancel,
    scope,
    region,
    reset,
  };

  return pointer;
}

function transformRegionToCanvas(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const { a, b, c, d, e, f } = ctx.getTransform();
  const originX = a * x + c * y + e;
  const originY = b * x + d * y + f;

  // Bound the transformed rectangle without allocating four DOMPoints per handle.
  return {
    minX: originX + Math.min(0, a * w) + Math.min(0, c * h),
    maxX: originX + Math.max(0, a * w) + Math.max(0, c * h),
    minY: originY + Math.min(0, b * w) + Math.min(0, d * h),
    maxY: originY + Math.max(0, b * w) + Math.max(0, d * h),
  };
}
