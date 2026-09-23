import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AuthoredTree } from "@diffusionstudio/jsx";
import { convertAnimation } from "../src/animation.ts";

const data = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
const hyperframes = process.env.DIFFUSION_HYPERFRAMES_BIN ?? join(data, "diffusion-studio/tools/node_modules/.bin/hyperframes");
const chromium = process.env.DIFFUSION_CHROMIUM_BIN ?? ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(existsSync);
const vite = process.env.DIFFUSION_TEST_VITE_URL;

// Opt in against an existing dev server; both browser pages belong to this test.
test("imported CSS 3D planes preserve camera, paints, clipping and DOM order", { skip: !vite || !chromium || !existsSync(hyperframes) }, async t => {
  const project = await mkdtemp(join(tmpdir(), "hyperframes-native-pixels-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const source = join(project, "animations/source");
  await mkdir(source, { recursive: true });
  await writeFile(join(project, "package.json"), JSON.stringify({ diffusion: { animations: {
    test: { engine: "hyperframes", source: "animations/source", frameRate: 4, output: "assets/test.mp4" },
  } } }));

  const { default: puppeteer } = await import(createRequire(realpathSync(hyperframes)).resolve("puppeteer-core"));
  const browser = await puppeteer.launch({ headless: true, executablePath: chromium, protocolTimeout: 30_000, args: ["--no-sandbox", "--enable-unsafe-swiftshader"] });
  t.after(() => browser.close());
  const sourcePage = await browser.newPage(), nativePage = await browser.newPage();
  await sourcePage.setViewport({ width: 320, height: 200, deviceScaleFactor: 1 });
  await nativePage.goto(new URL("/@vite/client", vite).href);
  await nativePage.setContent("<!doctype html><body></body>");
  const runtimeUrl = new URL(`/@fs${fileURLToPath(new URL("../../../packages/runtime/src/index.ts", import.meta.url))}`, vite).href;
  const reconcilerUrl = new URL(`/@fs${fileURLToPath(new URL("../../../packages/reconciler/src/index.ts", import.meta.url))}`, vite).href;
  const errors: string[] = [];
  nativePage.on("pageerror", (error: Error) => errors.push(error.message));

  for (const [name, children] of [
    ["tilted gradient", '<div id="tilt" class="plane"></div>'],
    ["flat DOM order", '<div id="front" class="plane"></div><div id="back" class="plane"></div>'],
    ["clipped plane", '<div id="tilt" class="plane" style="clip-path:polygon(0 0,100% 0,50% 100%,0 100%)"></div>'],
    ["blurred plane", '<div id="tilt" class="plane" style="filter:blur(8px)"></div>'],
  ] as const) await t.test(name, async t => {
    const html = `<!doctype html><html><head><style>
      body{margin:0}
      #root{position:relative;width:320px;height:200px;background:white;perspective:400px;perspective-origin:30% 60%}
      .plane{position:absolute;transform-origin:20% 70%}
      #tilt{left:40px;top:30px;width:100px;height:60px;background:linear-gradient(90deg,red,blue);transform:translateZ(30px) rotateY(25deg) rotateX(20deg) rotateZ(15deg) skewX(10deg) scale(1.2,0.8)}
      #front{left:170px;top:70px;width:75px;height:60px;background:red;transform:translateZ(60px)}
      #back{left:175px;top:75px;width:75px;height:60px;background:blue;transform:translateZ(-60px)}
    </style></head><body><div id="root" data-composition-id="main" data-duration="1" data-width="320" data-height="200">${children}</div>
    <script>window.__timelines={main:{pause(){return this},totalTime(){return this}}}</script></body></html>`;
    await writeFile(join(source, "index.html"), html);
    const converted = await convertAnimation("test", project);
    assert.deepEqual(converted.issues, []);
    await sourcePage.bringToFront();
    await sourcePage.setContent(html, { waitUntil: "load" });
    const screenshot = await sourcePage.screenshot({ type: "png" });
    const result = await nativePage.evaluate(async ({ tree, sourcePng, runtimeUrl, reconcilerUrl }: {
      tree: AuthoredTree; sourcePng: string; runtimeUrl: string; reconcilerUrl: string;
    }) => {
      const r = await import(runtimeUrl) as typeof import("../../../packages/runtime/src/index.ts");
      const d = await import(reconcilerUrl) as typeof import("../../../packages/reconciler/src/index.ts");
      const world = r.createRuntimeWorld("css-native-pixels"), document = d.createRuntimeDocument(world);
      const canvas = new OffscreenCanvas(320, 200), context = canvas.getContext("2d")!;
      const awaitFrames = async () => {
        const list = world.get(r.FramePromises)?.list;
        while (list?.length) await Promise.all(list.splice(0));
      };
      try {
        r.resetCamera(world);
        world.set(r.Mode, { value: "offline-video" });
        world.set(r.RenderSurface, { canvas, ctx: context, resolution: 1 });
        d.withDocument(document, () => d.insert(document.stage, d.renderAuthored({
          tag: "scene", props: { width: 320, height: 200, end: 2, active: true }, children: [tree],
        })));
        r.setPlayhead(world, r.getActiveEntity(world)!, 0);
        r.playbackSystem(world); await awaitFrames();
        r.motionSystem(world); r.transformSystem(world); r.renderSystem(world);
        await awaitFrames(); r.renderSystem(world);
        const native = context.getImageData(0, 0, 320, 200).data;
        const image = await createImageBitmap(await (await fetch(sourcePng)).blob());
        context.reset(); context.drawImage(image, 0, 0); image.close();
        const source = context.getImageData(0, 0, 320, 200).data;
        let interior = 0, mismatches = 0;
        for (let y = 1; y < 199; y++) for (let x = 1; x < 319; x++) {
          const index = (y * 320 + x) * 4;
          // Ignore browser/native edge antialiasing; compare flat regions and gradient interiors.
          const variation = Math.max(...[-321, -320, -319, -1, 1, 319, 320, 321].flatMap(offset =>
            [0, 1, 2, 3].map(channel => Math.abs(source[index + channel]! - source[index + offset * 4 + channel]!))));
          if (variation >= 8) continue;
          interior++;
          if ([0, 1, 2, 3].some(channel => Math.abs(source[index + channel]! - native[index + channel]!) > 16)) mismatches++;
        }
        const index = (100 * 320 + 220) * 4;
        const picked = world.query(r.Geometry).filter(entity => ["front", "back"].includes(entity.get(r.Name)?.value ?? "") && r.isPointerInEntity(world, entity, { x: 220, y: 100 })).map(entity => entity.get(r.Name)?.value);
        return { interior, mismatches, overlap: Array.from(native.slice(index, index + 4)), sourceOverlap: Array.from(source.slice(index, index + 4)), picked };
      } finally { document.dispose(); world.destroy(); }
    }, { tree: converted.tree, sourcePng: `data:image/png;base64,${Buffer.from(screenshot).toString("base64")}`, runtimeUrl, reconcilerUrl });
    t.diagnostic(`${name}: ${result.mismatches} / ${result.interior} interior pixels differ`);
    assert.ok(result.interior > 55_000, `${name}: enough interior pixels sampled`);
    assert.ok(result.mismatches < 30, `${name}: ${result.mismatches} interior pixels differ`);
    if (name === "flat DOM order") {
      assert.deepEqual(result.sourceOverlap, [0, 0, 255, 255], "reference screenshot contains the blue plane");
      assert.deepEqual(result.overlap, [0, 0, 255, 255], "later blue plane paints over nearer red plane");
      assert.deepEqual(result.picked, ["back"], "pointer selects the visible later blue plane");
    }
  });
  assert.deepEqual(errors, [], "no browser render errors");
});
