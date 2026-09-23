import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { build } from "esbuild";

const built = await build({
  stdin: { contents: `
    export {createWorld} from 'koota';
    export {Active, Scene, Computed, FrameRate, Geometry, ChildOf, Selected, Timeline, Workarea, getTimelineView, setTimelineView} from '@diffusionstudio/runtime';
    export {createTimelineController} from './controller';
    export {TimelineSurface} from './surface';
    export {renderRuler} from './render/ruler';
    export {renderWorkarea} from './render/workarea';
    export {fitTimelineView} from './view';
  `, resolveDir: fileURLToPath(new URL("../../web/src/engine/timeline/", import.meta.url)) },
  bundle: true, write: false, format: "cjs", platform: "node",
  logOverride: { "empty-import-meta": "silent" },
  plugins: [{ name: "timeline-io", setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path, importer }) => {
      if ((path === "./timeline" && importer.endsWith("/controller.ts")) || path === "../paths") return { path, external: true };
      if (path === "@/utils" || path === "@/engine/editor" || path === "@/engine/history" || (path === "./editor" && importer.endsWith("/timing.ts"))) return { path, external: true };
    });
  } }],
});

type API = typeof import("../../web/src/engine/timeline/controller")
  & typeof import("../../web/src/engine/timeline/surface")
  & typeof import("../../web/src/engine/timeline/render/ruler")
  & typeof import("../../web/src/engine/timeline/render/workarea")
  & typeof import("../../web/src/engine/timeline/view")
  & Pick<typeof import("koota"), "createWorld">
  & Pick<typeof import("../../../packages/runtime/src"), "Active" | "Scene" | "Computed" | "FrameRate" | "Geometry" | "ChildOf" | "Selected" | "Timeline" | "Workarea" | "getTimelineView" | "setTimelineView">;

class Matrix {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  scaleSelf(x: number, y: number) { this.a *= x; this.d *= y; return this; }
  translateSelf(x: number, y: number) { this.e += x * this.a; this.f += y * this.d; return this; }
  transformPoint(point: { x: number; y: number }) { return { x: point.x * this.a + this.e, y: point.y * this.d + this.f }; }
}
class Rect {
  x = 0; y = 0; width = 800; height = 300;
  get left() { return this.x; }
  get top() { return this.y; }
}
class Element extends EventTarget {
  rect = new Rect();
  style = { width: "", height: "", transform: "", setProperty() {} };
  width = 0; height = 0; scrollHeight = 400; clientHeight = 300;
  capture: number | undefined;
  parentElement: Element | null = null;
  focus() {}
  getBoundingClientRect() { return Object.assign(new Rect(), this.rect); }
  querySelectorAll() { return []; }
  setPointerCapture(id: number) { this.capture = id; }
  hasPointerCapture(id: number) { return this.capture === id; }
  releasePointerCapture() { this.capture = undefined; }
}
function event(target: EventTarget, type: string, x: number, y: number, extra: Record<string, unknown> = {}) {
  const value = new Event(type, { cancelable: true });
  Object.assign(value, { clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, shiftKey: false, ...extra });
  target.dispatchEvent(value);
  return value;
}

function fixture() {
  const canvas = new Element();
  const parent = new Element();
  canvas.parentElement = parent;
  const body = new Element();
  const window = Object.assign(new EventTarget(), { devicePixelRatio: 1, innerWidth: 1200 });
  const resizeCallbacks: (() => void)[] = [];
  class Observer {
    constructor(callback: () => void) { resizeCallbacks.push(callback); }
    observe() {} disconnect() {}
  }
  let transform = new Matrix();
  const transforms: Matrix[] = [];
  const context = {
    save() { transforms.push(Object.assign(new Matrix(), transform)); },
    restore() { transform = transforms.pop()!; },
    translate(x: number, y: number) { transform.translateSelf(x, y); },
    getTransform() { return transform; },
    stroke() {}, fill() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, fillText() {},
  };
  Object.assign(canvas, { getContext: () => context });
  const edits: { name: string; value: unknown }[] = [];
  const reports: unknown[] = [];
  const module = { exports: {} as API };
  const dependencies = {
    "@/utils": { assert, clamp: (value: number, min: number, max: number) => Math.max(min, Math.min(value, max)) },
    "@/engine/history": { getEditHistory: () => ({ beginGesture() {}, endGesture() {}, cancelGesture() {} }) },
    "../paths": { IN_POINT_PATH: {}, OUT_POINT_PATH: {} },
    "./timeline": { timelineSystem() {} },
    "@/engine/editor": { getDocumentEditor: () => ({ reportEdit: (_scene: unknown, _name: string, value: unknown) => reports.push(value) }) },
    "./editor": { getDocumentEditor: () => ({
      editProperty: (entity: import("koota").Entity, name: string, value: false | number[]) => {
        edits.push({ name, value });
        if (value === false) entity.remove(module.exports.Workarea);
        else {
          entity.add(module.exports.Workarea);
          entity.set(module.exports.Workarea, { start: Math.round(value[0] * 30), end: Math.round(value[1] * 30) });
        }
      },
      reportEdit: (_scene: unknown, _name: string, value: unknown) => reports.push(value),
    }) },
  };
  runInThisContext(`(function(require,module,exports,window,document,DOMMatrix,DOMRect,DOMPoint,ResizeObserver,WheelEvent){"use strict";${built.outputFiles[0].text}\n})`)((name: keyof typeof dependencies) => {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`);
    return dependencies[name];
  }, module, module.exports, window,
  { body, getElementById: () => canvas, querySelector: () => new Element() }, Matrix, Rect,
  class {
    x: number; y: number;
    constructor(x: number, y: number) { this.x = x; this.y = y; }
  }, Observer, { DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 });
  const api = module.exports;
  const world = api.createWorld(api.FrameRate({ value: 30 }), api.TimelineSurface);
  const scene = world.spawn(api.Scene, api.Active, api.Computed({ localTime: 150 }), api.Timeline({ resolution: 2, scrollX: 0 }));
  const clip = world.spawn(api.Geometry, api.ChildOf(scene), api.Selected, api.Computed({ start: 60, end: 120 }));
  const controller = api.createTimelineController(world);
  controller.mount();
  controller.attachCanvas();
  const surface = world.get(api.TimelineSurface)!;
  function draw() {
    api.renderRuler(world, scene, surface);
    api.renderWorkarea(world, scene, surface);
    surface.pointer!.reset();
  }
  function down(x: number, y: number, shiftKey = false) {
    event(body, "pointermove", x, y, { shiftKey });
    draw(); draw();
    event(canvas, "pointerdown", x, y, { shiftKey });
    draw();
  }
  function move(x: number, y: number, shiftKey = false) { event(body, "pointermove", x, y, { shiftKey }); draw(); }
  function up(x: number, y: number) { event(body, "pointerup", x, y, { buttons: 0 }); draw(); }
  function close() { controller.detachCanvas(); controller.unmount(); world.destroy(); }
  return { ...api, world, scene, clip, surface, controller, canvas, parent, body, window, resizeCallbacks, edits, reports, down, move, up, close };
}

test("workarea creation snaps both directions to selected clip cuts and releases from the following playhead", () => {
  const f = fixture();
  f.down(124, 12, true);
  f.move(236, 12, true);
  assert.equal(f.scene.get(f.Workarea)?.start, 60);
  assert.equal(f.scene.get(f.Workarea)?.end, 120);
  f.move(210, 12, true);
  assert.equal(f.scene.get(f.Workarea)?.end, 105);
  f.move(208, 12, true);
  assert.equal(f.scene.get(f.Workarea)?.end, 104);
  f.up(208, 12);
  f.down(236, 12, true);
  f.move(124, 12, true);
  assert.equal(f.scene.get(f.Workarea)?.start, 60);
  assert.equal(f.scene.get(f.Workarea)?.end, 120);
  f.move(-40, 12, true);
  assert.equal(f.scene.get(f.Workarea)?.start, 0);
  f.close();
});

test("workarea handles snap to cuts and the playhead, and moving the bar preserves its duration", () => {
  const f = fixture();
  f.scene.add(f.Workarea({ start: 30, end: 90 }));
  f.down(58, 30);
  f.move(115, 30);
  assert.equal(f.scene.get(f.Workarea)?.start, 60);
  f.up(115, 30);
  f.down(182, 30);
  f.move(240, 30);
  assert.equal(f.scene.get(f.Workarea)?.end, 120);
  f.up(240, 30);
  f.down(242, 30);
  f.move(299, 30);
  assert.equal(f.scene.get(f.Workarea)?.end, 150);
  f.up(299, 30);
  f.down(180, 30);
  f.move(356, 30);
  assert.equal(f.scene.get(f.Workarea)?.start, 150);
  assert.equal(f.scene.get(f.Workarea)?.end, 240);
  f.up(356, 30);
  f.down(350, 30);
  f.move(-200, 30);
  assert.equal(f.scene.get(f.Workarea)?.start, 0);
  assert.equal(f.scene.get(f.Workarea)?.end, 90);
  f.up(-200, 30);
  f.scene.set(f.Workarea, { start: 60, end: 120 });
  f.down(118, 30);
  f.move(300, 30);
  assert.equal(f.scene.get(f.Workarea)?.start, 119);
  f.up(300, 30);
  f.down(242, 30);
  f.move(80, 30);
  assert.equal(f.scene.get(f.Workarea)?.end, 120);
  f.close();
});

test("middle drag pans without changing clips or playhead, clamps at zero, and ends on cancellation", () => {
  const f = fixture();
  const down = event(f.canvas, "pointerdown", 400, 100, { button: 1, buttons: 4 });
  assert.equal(down.defaultPrevented, true);
  event(f.body, "pointermove", 200, 120, { button: -1, buttons: 4 });
  assert.equal(f.scene.get(f.Timeline)?.scrollX, 100);
  assert.equal(f.scene.get(f.Computed)?.localTime, 150);
  assert.equal(f.clip.has(f.Selected), true);
  assert.equal(f.edits.length, 0);
  assert.equal(f.surface.pointer?.position, null);
  event(f.body, "pointermove", 500, 120, { button: -1, buttons: 4 });
  assert.equal(f.scene.get(f.Timeline)?.scrollX, -4);
  event(f.body, "pointercancel", 500, 120, { buttons: 0 });
  assert.equal(f.surface.panning, false);
  assert.equal(f.canvas.capture, undefined);
  assert.equal(f.reports.length, 1);
  assert.deepEqual(f.reports[0], f.getTimelineView(f.world, f.scene));
  f.close();
});

test("startup window resizes preserve the restored timeline view without saving another zoom", () => {
  const f = fixture();
  f.setTimelineView(f.world, f.scene, [53.02164, 12, 20]);
  const restored = f.getTimelineView(f.world, f.scene);
  for (const [windowWidth, canvasWidth] of [[1600, 1200], [1916, 1516]]) {
    f.window.innerWidth = windowWidth;
    f.parent.rect.width = canvasWidth;
    f.resizeCallbacks[0]();
    assert.equal(f.canvas.width, canvasWidth);
    assert.equal(f.surface.layout.width, canvasWidth);
    assert.deepEqual(f.getTimelineView(f.world, f.scene), restored);
  }
  assert.deepEqual(f.reports, []);
  f.close();
});

test("resizing either panel preserves the visible time span, playhead, and marked range", () => {
  const f = fixture();
  f.scene.set(f.Timeline, { scrollX: 45 });
  f.scene.add(f.Workarea({ start: 60, end: 120 }));
  const visibleRange = () => [
    f.controller.clientToFrame(f.parent.rect.left),
    f.controller.clientToFrame(f.parent.rect.left + f.parent.rect.width),
  ];
  const before = visibleRange();
  assert.equal(f.canvas.width, 800);
  f.parent.rect.width = 460;
  f.window.devicePixelRatio = 2;
  f.resizeCallbacks[0]();
  assert.equal(f.canvas.style.width, "460px");
  assert.equal(f.canvas.width, 920);
  assert.equal(f.surface.layout.width, 460);
  assert.deepEqual(visibleRange(), before, 'widening the right sidebar keeps both endpoint frames visible');
  f.parent.rect.x = 160;
  f.parent.rect.width = 640;
  f.canvas.rect.x = 160;
  f.resizeCallbacks[0]();
  assert.deepEqual(visibleRange(), before, 'changing the left panel also preserves the visible range');
  const resolution = f.scene.get(f.Timeline)?.resolution;
  f.parent.rect.height = 200;
  f.resizeCallbacks[0]();
  assert.equal(f.scene.get(f.Timeline)?.resolution, resolution, 'height-only resizing does not zoom');
  assert.equal(f.scene.get(f.Computed)?.localTime, 150);
  assert.deepEqual(f.scene.get(f.Workarea), { start: 60, end: 120 });
  assert.equal(f.clip.has(f.Selected), true);
  f.close();
});

test("wheel zoom anchors the playhead independent of pointer position and brings an offscreen playhead into view", () => {
  const f = fixture();
  f.scene.set(f.Timeline, { scrollX: 100 });
  const position = () => {
    const view = f.scene.get(f.Timeline)!;
    return (150 - view.scrollX) * view.resolution;
  };
  for (const deltaY of [-20, -20, 20, 20]) {
    event(f.canvas, "wheel", 700, 100, { ctrlKey: true, deltaX: 0, deltaY, deltaMode: 0 });
    assert.ok(Math.abs(position() - 100) < 1e-8);
  }
  assert.ok(Math.abs(f.scene.get(f.Timeline)!.resolution - 2) < 1e-8);
  f.scene.set(f.Timeline, { scrollX: 500 });
  event(f.canvas, "wheel", 10, 100, { altKey: true, deltaX: 0, deltaY: -20, deltaMode: 0 });
  assert.ok(position() >= 0 && position() <= f.surface.layout.width);
  assert.equal(f.scene.get(f.Computed)?.localTime, 150);
  assert.equal(f.edits.length, 0);
  assert.equal(f.reports.length, 5);
  assert.deepEqual(f.reports.at(-1), f.getTimelineView(f.world, f.scene));
  f.close();
});

test("fit includes the complete scene in the canvas width at short and long durations, independent of workarea", () => {
  const f = fixture();
  f.scene.add(f.Workarea({ start: 60, end: 120 }));
  for (const width of [300, 800]) {
    for (const frames of [1, 300, 30 * 60 * 60 * 24]) {
      f.scene.set(f.Computed, { end: frames });
      f.fitTimelineView(f.world, f.scene, width);
      const view = f.scene.get(f.Timeline)!;
      assert.ok(Math.abs(-view.scrollX * view.resolution - 8) < 1e-8);
      assert.ok(Math.abs((frames - view.scrollX) * view.resolution - (width - 8)) < 1e-8);
      assert.equal(f.scene.get(f.Computed)?.localTime, 150);
    }
  }
  const previous = f.scene.get(f.Timeline)!.resolution;
  f.fitTimelineView(f.world, f.scene, 0);
  assert.equal(f.scene.get(f.Timeline)?.resolution, previous);
  f.close();
});
