import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { transform } from "esbuild";
import type { AuthoredTree } from "@diffusionstudio/jsx";
import { capturedAnimationToJsx, simplifyKeys } from "../src/editable-animation.ts";
import { convertAnimation } from "../src/animation.ts";

test("native conversion retains nested geometry, editable text, styles and reduced timing", async () => {
  const result = capturedAnimationToJsx({ width: 640, height: 360, duration: 1, frameRate: 30, issues: [], layers: [
    { id: "parent", kind: "group", name: "Diagram", frames: [{ time: 0, props: { opacity: 1 } }] },
    { id: "line", parent: "parent", kind: "path", name: "Curve", frames: [0, 0.25, 0.5, 0.75, 1].map(time => ({ time, props: { d: "M 0 0 C 10 0 20 30 40 40", viewBox: [0, 0, 40, 40], width: 40, height: 40, x: time * 100, opacity: 1, stroke: "#abcdef", strokeWidth: 2 } })) },
    { id: "label", parent: "parent", kind: "text", name: "Label", frames: [{ time: 0, props: { text: 'Editable <title> "quoted"', fontFamily: "Inter", fontSize: 24, fill: "#ffffff", opacity: 1 } }] },
  ] }, "converted", "Example");
  assert.equal(result.layerCount, 6);
  assert.equal(result.tree.children[0].props.width, 640);
  assert.equal(result.tree.children[0].children[0].props.mask, true);
  assert.equal(result.keyframeCount, 2);
  assert.match(result.jsx, /<path[^>]*name=\{"Curve"\}/);
  assert.match(result.jsx, /<stroke[^>]*color=\{"#abcdef"\}/);
  assert.match(result.jsx, /property=\{"x"\}/);
  assert.match(result.jsx, /Editable <title>/);
  assert.doesNotMatch(result.jsx, /property=\{"d"\}|<video/);
  await transform(result.jsx, { loader: "tsx" });
});

test("sample reduction preserves pauses, extrema, and incompatible path holds", () => {
  assert.deepEqual(simplifyKeys([{time:0,value:0},{time:1,value:0},{time:2,value:5},{time:3,value:10},{time:4,value:0}]), [{time:0,value:0},{time:1,value:0},{time:3,value:10},{time:4,value:0}]);
  assert.deepEqual(simplifyKeys([{time:0,value:"M 0 0"},{time:1,value:"M 0 0"},{time:2,value:"M 0 0"},{time:3,value:"M 2 2 L 3 3"}]), [{time:0,value:"M 0 0"},{time:2,value:"M 0 0"},{time:3,value:"M 2 2 L 3 3"}]);
});

test("unsupported features and changing unkeyframeable props require explicit partial conversion", () => {
  const capture = { width: 640, height: 360, duration: 1, frameRate: 30, issues: [{layer:"Backdrop",feature:"WebGL canvas"}], layers: [{ id: "label", kind: "text", name: "Label", frames: [
    {time:0,props:{text:"Before",fontSize:24,opacity:1}}, {time:1,props:{text:"After",fontSize:32,opacity:1}},
  ] }] };
  assert.throws(() => capturedAnimationToJsx(capture,"test","Test"), /WebGL canvas.*\n.*animated fontSize.*\n.*changing text content/);
  assert.equal(capturedAnimationToJsx(capture,"test","Test",true).issues.length,3);
  assert.throws(() => capturedAnimationToJsx({...capture,layers:[{...capture.layers[0],parent:"missing"}]},"test","Test",true),/hierarchy/);
});

const data = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
const python = process.env.DIFFUSION_PYTHON ?? join(data,"diffusion-studio/python/bin/python");

test("installed Manim converts objects and frozen holds without flattening or overwriting source", {skip:!existsSync(python)}, async t => {
  const project = await mkdtemp(join(tmpdir(),"editable-manim-test-"));
  t.after(()=>rm(project,{recursive:true,force:true}));
  await mkdir(join(project,"animations/source"),{recursive:true});
  const source = "from manim import *\nclass Diagram(Scene):\n    def construct(self):\n        shape = Circle(radius=1, color=BLUE).set_fill(BLUE,opacity=0.4)\n        title = Text('Editable',font_size=36).to_edge(UP)\n        self.add(shape,title)\n        self.play(shape.animate.shift(RIGHT),run_time=0.5)\n        self.wait(0.5)\n";
  await writeFile(join(project,"animations/source/scene.py"),source);
  await writeFile(join(project,"package.json"),JSON.stringify({diffusion:{animations:{diagram:{engine:"manim",source:"animations/source",entry:"scene.py",scene:"Diagram",frameRate:12,output:"assets/diagram.mp4"}}}}));
  const first = await convertAnimation("diagram",project);
  const jsx = await readFile(first.output,"utf8");
  assert.equal(first.duration,1);
  assert.equal(first.frameRate,12);
  assert.ok(first.layerCount>5);
  assert.ok(first.keyframeCount<100);
  assert.match(jsx,/<path/);
  assert.match(jsx,/name=\{"Editable"\}/);
  assert.doesNotMatch(jsx,/<video/);
  assert.equal(await readFile(join(project,"animations/source/scene.py"),"utf8"),source);
  await writeFile(first.output,"// manual edit\n"+jsx);
  const second=await convertAnimation("diagram",project);
  assert.notEqual(second.output,first.output);
  assert.ok((await readFile(first.output,"utf8")).startsWith("// manual edit"));
  assert.ok(!(await readdir(join(project,"animations"))).some(name=>name.startsWith(".editable-")));
  await transform(await readFile(second.output,"utf8"),{loader:"tsx"});

  await writeFile(join(project,"animations/source/scene.py"),"from manim import *\nclass Diagram(MovingCameraScene):\n    def construct(self):\n        self.add(Circle())\n        self.play(self.camera.frame.animate.scale(0.5).shift(RIGHT),run_time=0.5)\n");
  const moving=await convertAnimation("diagram",project);
  assert.deepEqual(moving.issues,[]);
  assert.match(await readFile(moving.output,"utf8"),/property=\{"width"\}/);
  await writeFile(join(project,"animations/source/scene.py"),"from manim import *\nclass Diagram(ThreeDScene):\n    def construct(self):\n        self.add(Square())\n        self.wait(0.1)\n");
  assert.deepEqual((await convertAnimation("diagram",project)).issues,[]);
  await writeFile(join(project,"animations/source/scene.py"),"from manim import *\nimport numpy as np\nclass Diagram(Scene):\n    def construct(self):\n        self.add(ImageMobject(np.ones((4,4,3),dtype=np.uint8)*255))\n        self.wait(0.1)\n");
  assert.deepEqual((await convertAnimation("diagram",project)).issues,[]);
  await writeFile(join(project,"animations/source/scene.py"),"from manim import *\nconfig.renderer='opengl'\nclass Diagram(Scene):\n    pass\n");
  await assert.rejects(convertAnimation("diagram",project),/Cairo renderer, not OpenGL/);
  await writeFile(join(project,"animations/source/scene.py"),"from manim import *\nclass Diagram(Scene):\n    def construct(self):\n        first,second=Square(),Circle()\n        self.add(first,second)\n        self.wait(0.1)\n        self.bring_to_back(second)\n        self.wait(0.1)\n");
  assert.deepEqual((await convertAnimation("diagram",project)).issues,[]);
  await writeFile(join(project,"animations/source/scene.py"),"from manim import *\nclass Diagram(Scene):\n    def construct(self):\n        self.add(VGroup(Square(z_index=10)),Circle(z_index=5))\n        self.wait(0.1)\n");
  assert.deepEqual((await convertAnimation("diagram",project)).issues,[]);
  await writeFile(join(project,"animations/source/scene.py"),"from manim import *\nclass Diagram(Scene):\n    def construct(self):\n        self.add(VGroup(Square(z_index=0),Triangle(z_index=10)),Circle(z_index=5))\n        self.wait(0.1)\n");
  await assert.rejects(convertAnimation("diagram",project),/object stacking order crosses group boundaries/);
  await writeFile(join(project,"animations/source/scene.py"),"from manim import *\nclass Diagram(Scene):\n    def construct(self):\n        self.add(Line(cap_style=CapStyleType.ROUND,joint_type=LineJointType.ROUND))\n        self.wait(0.1)\n");
  assert.deepEqual((await convertAnimation("diagram",project)).issues,[]);
});

const gsap = process.env.DIFFUSION_TEST_GSAP;
const hyperframes = process.env.DIFFUSION_HYPERFRAMES_BIN ?? join(data,"diffusion-studio/tools/node_modules/.bin/hyperframes");
test("installed HyperFrames GSAP source converts text, image, clipping and transform keys; complex CSS fails closed", {skip:!gsap || !existsSync(gsap) || !existsSync(hyperframes)}, async t => {
  const project=await mkdtemp(join(tmpdir(),"editable-hyperframes-test-"));
  t.after(()=>rm(project,{recursive:true,force:true}));
  const directory=join(project,"animations/source");
  await mkdir(directory,{recursive:true});
  await copyFile(gsap!,join(directory,"gsap.min.js"));
  await writeFile(join(directory,"icon.svg"),'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>');
  const html='<!doctype html><html><head><script src="gsap.min.js"></script><style>body{margin:0}#root{position:relative;width:640px;height:360px;overflow:hidden;background:#112233}#box{position:absolute;left:40px;top:50px;width:200px;height:100px;border:2px solid white;border-radius:12px;color:white;font:24px sans-serif}img{width:20px;height:20px}</style></head><body><div id="root" data-composition-id="main" data-duration="1" data-width="640" data-height="360"><div id="box"><span>Editable title</span><img src="icon.svg"></div></div><script>const tl=gsap.timeline({paused:true});tl.to("#box",{x:100,duration:1,ease:"none"});window.__timelines={main:tl};</script></body></html>';
  await writeFile(join(directory,"index.html"),html);
  await writeFile(join(project,"package.json"),JSON.stringify({diffusion:{animations:{title:{engine:"hyperframes",source:"animations/source",frameRate:12,output:"assets/title.mp4"}}}}));
  const report=await convertAnimation("title",project);
  const jsx=await readFile(report.output,"utf8");
  assert.deepEqual(report.issues,[]);
  assert.match(jsx,/<text/);
  assert.match(jsx,/Editable title/);
  assert.match(jsx,/<image.*src=\{"animations\/source\/icon.svg"\}/);
  assert.match(jsx,/mask=\{true\}/);
  assert.match(jsx,/property=\{"x"\}/);
  await transform(jsx,{loader:"tsx"});
  const before=await readdir(join(project,"animations"));
  await writeFile(join(directory,"index.html"),html.replace("background:#112233","background:#112233;filter:drop-shadow(1px 2px 3px red)"));
  await assert.rejects(convertAnimation("title",project),/filter: drop-shadow/);
  assert.deepEqual(await readdir(join(project,"animations")),before);
  const partial=await convertAnimation("title",project,{allowPartial:true});
  assert.ok(partial.issues.some(issue=>issue.feature.includes("filter")));
  const unsupported=html.replace("</style>",'@font-face{font-family:ConversionWebFont;src:local("DejaVu Sans")}span{font-family:ConversionWebFont}</style>')
    .replace('<span>','<canvas></canvas><svg><path d="M 0 0 L 2 2"/></svg><video></video><div style="width:10px;height:10px;transform:perspective(500px) rotateY(20deg)"></div><span>')
    .replace('window.__timelines={main:tl};','tl.call(()=>document.querySelector("#box").append(document.querySelector("span")),[],0.5);window.__timelines={main:tl};');
  await writeFile(join(directory,"index.html"),unsupported);
  await assert.rejects(convertAnimation("title",project),/Editable conversion needs unsupported features/);
  const reportUnsupported=await convertAnimation("title",project,{allowPartial:true});
  for (const feature of ["canvas content","video content","3D CSS transform","web font requires","changing DOM stacking order"]) assert.ok(reportUnsupported.issues.some(issue=>issue.feature.includes(feature)),feature);

  const svg='<svg id="diagram" viewBox="0 0 320 180" style="width:640px;height:360px"><defs><filter id="blur"><feGaussianBlur stdDeviation="2"/></filter></defs><g id="outer" transform="translate(20 10)"><g id="inner" transform="rotate(5) skewX(10)"><path id="ring" fill="red" fill-rule="evenodd" d="M 0 0 H 80 V 80 H 0 Z M 20 20 H 60 V 60 H 20 Z"/><rect id="rounded" x="95" y="0" width="40" height="30" rx="4" fill="blue"/><circle id="circle" cx="110" cy="60" r="12" fill="green"/><g id="pop" transform="scale(0)"><ellipse id="ellipse" cx="155" cy="60" rx="18" ry="9" fill="yellow"/></g><line id="line" x1="0" y1="95" x2="30" y2="95" stroke="white" stroke-width="2"/><polyline id="polyline" points="40,95 50,85 60,95" fill="none" stroke="white"/><polygon id="polygon" points="75,95 85,85 95,95" fill="white"/><text id="label" x="0" y="130" font-family="sans-serif" font-size="20" fill="white">Editable SVG</text></g></g></svg>';
  const svgHtml='<!doctype html><html><head><script src="gsap.min.js"></script><style>body{margin:0}#root{width:640px;height:360px;background:#112233}</style></head><body><div id="root" data-composition-id="main" data-duration="1" data-width="640" data-height="360">'+svg+'</div><script>const tl=gsap.timeline({paused:true});tl.to("#outer",{attr:{transform:"translate(40 10)"},duration:1,ease:"none"});tl.to("#ring",{attr:{d:"M 0 0 H 100 V 80 H 0 Z M 20 20 H 60 V 60 H 20 Z"},duration:1,ease:"none"},0);tl.to("#circle",{attr:{r:20},duration:1,ease:"none"},0);tl.to("#pop",{attr:{transform:"scale(1)"},duration:1,ease:"none"},0);window.__timelines={main:tl};</script></body></html>';
  await writeFile(join(directory,"index.html"),svgHtml);
  const svgReport=await convertAnimation("title",project);
  assert.deepEqual(svgReport.issues,[]);
  const svgJsx=await readFile(svgReport.output,"utf8");
  assert.match(svgJsx,/<path[^>]*name=\{"ring"\}/);
  assert.match(svgJsx,/fillRule=\{"evenodd"\}/);
  assert.match(svgJsx,/viewBox=\{\[0,0,100,80\]\}/);
  assert.match(svgJsx,/property=\{"d"\}/);
  assert.match(svgJsx,/<ellipse[^>]*name=\{"circle"\}/);
  assert.match(svgJsx,/<ellipse[^>]*name=\{"ellipse"\}/);
  assert.match(svgJsx,/<rect[^>]*name=\{"rounded"\}/);
  assert.match(svgJsx,/Editable SVG/);
  assert.match(svgJsx,/skewX=\{10\}/);
  assert.doesNotMatch(svgJsx,/<image/);
  await transform(svgJsx,{loader:"tsx"});
  await writeFile(join(directory,"index.html"),svgHtml.replace('id="outer"','id="outer" filter="url(#blur)"'));
  await assert.rejects(convertAnimation("title",project),/filter: url/);

  const mixedText=svgHtml.replace("Editable SVG",'  A <tspan>B</tspan> C  ');
  await writeFile(join(directory,"index.html"),mixedText);
  const textReport=await convertAnimation("title",project);
  assert.deepEqual(textReport.issues,[]);
  const descendants=(node:AuthoredTree):AuthoredTree[]=>[node,...node.children.flatMap(descendants)];
  const label=descendants(textReport.tree).find(node=>node.props.name==="label")!;
  assert.deepEqual(label.children.map(node=>node.tag),["text","group","text"]);
  const runs=descendants(label).filter(node=>node.tag==="text");
  assert.deepEqual(runs.map(node=>node.text),["A ","B"," C"]);
  assert.ok(Number(runs[2].props.x)>Number(runs[1].props.x)+10,"text after tspan must follow B instead of overlapping it");
  await writeFile(join(directory,"index.html"),svgHtml.replace('id="outer"','id="outer" visibility="hidden"').replace('id="ring"','id="ring" visibility="visible"'));
  await assert.rejects(convertAnimation("title",project),/visibility override below hidden ancestor/);
});
