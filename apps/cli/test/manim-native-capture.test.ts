import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { transform } from "esbuild";
import { capturedAnimationToJsx } from "../src/editable-animation.ts";
import { manimEditableCapture } from "../src/manim-editable-capture.ts";
import { multiply4, rotation4 } from "../../../packages/runtime/src/math/spatial.ts";

const python = process.env.DIFFUSION_PYTHON ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "diffusion-studio/python/bin/python");
const run = promisify(execFile);
type Props = Record<string, string | number | boolean | number[]>;
type Capture = { layers: { id: string; parent?: string; kind: string; name: string; frames: { time: number; props: Props }[] }[]; issues: { layer: string; feature: string }[] };

async function capture(t: TestContext, source: string) {
  const directory = await mkdtemp(join(tmpdir(), "manim-native-capture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = join(directory, "scene.py");
  const script = join(directory, "capture.py");
  const output = join(directory, "capture.json");
  await writeFile(entry, source);
  await writeFile(script, manimEditableCapture);
  await run(python, ["-B", script, entry, "Diagram", output, "12", join(directory, "media"), "false"], { cwd: directory, maxBuffer: 4 * 1024 * 1024 });
  return { data: JSON.parse(await readFile(output, "utf8")) as Capture, directory };
}

function numeric(props: Props, name: string) {
  const value = props[name];
  assert.equal(typeof value, "number", name);
  return value as number;
}

function project(world: number[], camera: Props) {
  const delta = world.map((value, i) => value - numeric(camera, ["cameraX", "cameraY", "cameraZ"][i]));
  const rotation = rotation4(numeric(camera, "cameraRotationX"), numeric(camera, "cameraRotationY"), numeric(camera, "cameraRotation"));
  const local = [0, 1, 2].map(axis => delta.reduce((sum, value, i) => sum + value * rotation[axis * 4 + i], 0));
  const focal = numeric(camera, "perspective") * numeric(camera, "cameraZoom");
  return [numeric(camera, "width") / 2 + numeric(camera, "cameraOffsetX") + focal * local[0] / -local[2], numeric(camera, "height") / 2 + numeric(camera, "cameraOffsetY") + focal * local[1] / -local[2]];
}

test("Manim 3D capture preserves XYZ curves while matching animated camera projection", { skip: !existsSync(python) }, async t => {
  const { data, directory } = await capture(t, `from manim import *
from pathlib import Path
import json
class Diagram(ThreeDScene):
    def construct(self):
        shape = Square(shade_in_3d=True).rotate(0.4, axis=RIGHT).shift(OUT*0.6)
        self.add(shape)
        self.move_camera(phi=55*DEGREES, theta=25*DEGREES, gamma=12*DEGREES, frame_center=[0.4,-0.2,0.1], zoom=1.2, run_time=0.25)
        self.camera.reset_rotation_matrix()
        expected = self.camera.points_to_subpixel_coords(shape, shape.points[:1]).tolist()[0]
        Path(__file__).with_suffix('.expected.json').write_text(json.dumps(expected))
`);
  assert.deepEqual(data.issues, []);
  const camera = data.layers.find(layer => layer.kind === "scene3d")!;
  const path = data.layers.find(layer => layer.kind === "path3d")!;
  assert.ok(camera && path);
  assert.equal(new Set(path.frames.map(frame => frame.props.d)).size, 1, "camera motion must not rewrite the model geometry");
  assert.notDeepEqual(camera.frames[0].props, camera.frames.at(-1)!.props);
  const props = path.frames.at(-1)!.props;
  assert.equal(props.depthTest, false);
  const firstPoint = String(props.d).slice(2).split(" ").slice(0, 3).map(Number);
  assert.ok(Math.abs(firstPoint[2]) > 1, "depth survives in native geometry");
  const view = camera.frames.at(-1)!.props;
  const world = [firstPoint[0] + numeric(props, "x"), firstPoint[1] + numeric(props, "y"), firstPoint[2]];
  const projected = project(world, view);
  const expected = JSON.parse(await readFile(join(directory, "scene.expected.json"), "utf8")) as number[];
  projected.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 0.01, `${value} != ${expected[i]}`));
  assert.ok(data.layers.some(layer => layer.kind === "linearGradientPaint" && layer.frames[0].props.gradientSpace === "screen"));
  const converted = capturedAnimationToJsx(data, "camera-test", "3D camera");
  assert.match(converted.jsx, /<scene3d/);
  assert.match(converted.jsx, /<path3d/);
  assert.match(converted.jsx, /property=\{"cameraRotationX"\}/);
  await transform(converted.jsx, { loader: "tsx" });
});

test("Manim surfaces, tilted image quads and fixed camera objects remain editable 3D geometry", { skip: !existsSync(python) }, async t => {
  const { data, directory } = await capture(t, `from manim import *
from pathlib import Path
import json
import numpy as np
class Diagram(ThreeDScene):
    def construct(self):
        image=ImageMobject(np.ones((2,2,3),dtype=np.uint8)*255).set_height(2).rotate(0.3,axis=UP).rotate(0.2,axis=RIGHT).rotate(0.4).stretch(1.2,0)
        fixed=Square(side_length=0.3).shift(UP*1.5)
        billboard=Triangle().scale(0.3).shift(LEFT)
        surface=Surface(lambda u,v:np.array([u,v,0.5*u*v]),u_range=[-1,1],v_range=[-1,1],resolution=(2,2))
        self.add(image,surface)
        self.add_fixed_in_frame_mobjects(fixed)
        self.add_fixed_orientation_mobjects(billboard)
        self.move_camera(phi=35*DEGREES,theta=-20*DEGREES,gamma=8*DEGREES,frame_center=[0.1,0.2,-0.1],run_time=0.25)
        self.camera.reset_rotation_matrix()
        expected={name:self.camera.points_to_subpixel_coords(mob,mob.points if name=='image' else mob.points[:1]).tolist() for name,mob in [('image',image),('Square',fixed),('Triangle',billboard)]}
        Path(__file__).with_suffix('.expected.json').write_text(json.dumps(expected))
`);
  assert.deepEqual(data.issues, []);
  assert.equal(data.layers.filter(layer => layer.kind === "path3d").length, 6, "surface faces and fixed objects retain separate XYZ paths");
  const expected = JSON.parse(await readFile(join(directory, "scene.expected.json"), "utf8")) as Record<string, number[][]>;
  const camera = data.layers.find(layer => layer.kind === "scene3d")!.frames.at(-1)!.props;
  const image = data.layers.find(layer => layer.kind === "image")!.frames.at(-1)!.props;
  const orientation = multiply4(rotation4(numeric(image, "rotationX"), numeric(image, "rotationY")), rotation4(0, 0, numeric(image, "rotation")));
  const width = numeric(image, "width"), height = numeric(image, "height");
  for (const [index, [x, y]] of [[0, 0], [width, 0], [0, height], [width, height]].entries()) {
    const skewedX = x + Math.tan(numeric(image, "skewX") * Math.PI / 180) * y;
    const world = [0, 1, 2].map(axis => numeric(image, ["x", "y", "z"][axis]) + orientation[axis] * skewedX + orientation[4 + axis] * y);
    project(world, camera).forEach((value, axis) => assert.ok(Math.abs(value - expected.image[index][axis]) < 0.01));
  }
  for (const name of ["Square", "Triangle"]) {
    const path = data.layers.find(layer => layer.kind === "path3d" && layer.name === `${name} path`)!.frames.at(-1)!.props;
    const point = String(path.d).slice(2).split(" ").slice(0, 3).map(Number);
    point[0] += numeric(path, "x"); point[1] += numeric(path, "y");
    project(point, camera).forEach((value, axis) => assert.ok(Math.abs(value - expected[name][0][axis]) < 0.01));
  }
  assert.deepEqual(capturedAnimationToJsx(data, "geometry-test", "Native geometry").issues, []);
});

test("Manim capture retains gradient paints, background strokes, image opacity and point arrays", { skip: !existsSync(python) }, async t => {
  const { data } = await capture(t, `from manim import *
import numpy as np
class Diagram(Scene):
    def construct(self):
        shape = Circle(cap_style=CapStyleType.ROUND, joint_type=LineJointType.BEVEL).set_fill([RED,BLUE], opacity=0.6).set_stroke([GREEN,YELLOW], width=8)
        shape.set_stroke(WHITE, width=12, background=True)
        image = ImageMobject(np.array([[[255,0,0,255],[0,255,0,128]],[[0,0,255,255],[255,255,255,0]]],dtype=np.uint8)).rotate(0.3).shift(RIGHT*2)
        cloud = PMobject(stroke_width=7).add_points(np.array([[0,0,0],[1,1,0]]),rgbas=np.array([[1,0,0,1],[0,0,1,0.5]]))
        self.add(shape,image,cloud)
        self.play(image.animate.set_opacity(0.3),cloud.animate.shift(RIGHT),shape.animate.set_fill([BLUE,GREEN],opacity=0.3),run_time=0.25)
`);
  assert.deepEqual(data.issues, []);
  const gradients = data.layers.filter(layer => layer.kind === "linearGradientPaint");
  assert.equal(gradients.length, 2);
  assert.ok(gradients.every(layer => typeof layer.frames[0].props.x1 === "number" && typeof layer.frames[0].props.y2 === "number"));
  assert.ok(data.layers.some(layer => layer.kind === "colorStop" && new Set(layer.frames.map(frame => frame.props.color)).size > 1));
  assert.ok(data.layers.some(layer => layer.kind === "path" && layer.name.endsWith("background stroke")));
  assert.ok(data.layers.filter(layer => layer.kind === "stroke").every(layer => layer.frames[0].props.cap === "round" && layer.frames[0].props.join === "bevel"));
  const image = data.layers.find(layer => layer.kind === "image")!;
  assert.equal(image.frames.filter(frame => frame.props.src !== undefined).length, 1, "opacity animation must retain a single original image");
  assert.equal(image.frames.at(-1)!.props.opacity, 0.3);
  assert.ok(Math.abs(numeric(image.frames[0].props, "rotation") + 0.3 * 180 / Math.PI) < 0.001);
  const bytes = Buffer.from(String(image.frames[0].props.src).split(",")[1], "base64");
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  const cloud = data.layers.find(layer => layer.kind === "pointCloud")!;
  assert.deepEqual(cloud.frames[0].props.pointColors, [1, 0, 0, 1, 0, 0, 1, 0.5]);
  assert.equal(cloud.frames[0].props.pointSize, 7);
  assert.notDeepEqual(cloud.frames[0].props.points, cloud.frames.at(-1)!.props.points);
  assert.equal(data.layers.find(layer => layer.id === cloud.parent)?.kind, "scene3d");
  const converted = capturedAnimationToJsx(data, "media-test", "Native media");
  assert.match(converted.jsx, /<pointCloud/);
  assert.match(converted.jsx, /property=\{"points"\}/);
  assert.match(converted.jsx, /<linearGradientPaint/);
  await transform(converted.jsx, { loader: "tsx" });
});

test("Manim changing painter order is sampled; unsupported corner warps still report an issue", { skip: !existsSync(python) }, async t => {
  const { data } = await capture(t, `from manim import *
import numpy as np
class Diagram(Scene):
    def construct(self):
        first,second=Square(),Circle()
        self.add(first,second)
        self.wait(0.1)
        self.bring_to_back(second)
        self.wait(0.1)
        image=ImageMobject(np.ones((2,2,3),dtype=np.uint8)*255)
        image.points[3] += RIGHT*0.3
        self.add(image)
        self.wait(0.1)
`);
  assert.deepEqual(data.issues.map(issue => issue.feature), ["non-planar image corner warp"]);
  const square = data.layers.find(layer => layer.kind === "path" && layer.name.startsWith("Square"))!;
  assert.notEqual(square.frames[0].props.renderOrder, square.frames.at(-1)!.props.renderOrder);
});
