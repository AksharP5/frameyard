import { mkdir, writeFile } from "node:fs/promises";
const root = process.argv[2];
if (!root)
  throw new Error(
    "Usage: node scripts/bench/create-load-projects.mjs /absolute/new-directory",
  );
await mkdir(root);

async function project(name, items) {
  const dir = `${root}/${name}`;
  await mkdir(dir, { recursive: true });
  await writeFile(
    `${dir}/package.json`,
    JSON.stringify(
      { name, private: true, main: "index.tsx", diffusion: {} },
      null,
      2,
    ),
  );
  await writeFile(
    `${dir}/index.tsx`,
    `export default function LoadCheck() { return <stage id="stage" background="#111418" camera={[.6,0,0,.6,60,60]}><scene id="load-scene" name="${name}" width={1920} height={1080} active><rect id="background" name="Background" width={1920} height={1080} fill="#101820" end={12}/><text id="title" name="Title" x={70} y={40} fontSize={42} fontFamily="Inter" fill="#EDF4FA" end={12}>${name}</text>${items}</scene></stage>; }\n`,
  );
}
for (const count of [100, 500, 1000]) {
  const cols = Math.ceil(Math.sqrt(count * 1.75)),
    rows = Math.ceil(count / cols),
    cw = 1780 / cols,
    ch = 870 / rows;
  let items = "";
  for (let i = 0; i < count; i++) {
    const x = 70 + (i % cols) * cw,
      y = 130 + Math.floor(i / cols) * ch,
      delta = Math.min(10, cw * 0.15);
    items += `\n<rect id="item-${i}" name="Animated tile ${i + 1}" x={${x}} y={${y}} width={${cw * 0.65}} height={${ch * 0.65}} cornerRadius={4} fill="${["#80BBEF", "#D79973", "#93B99D"][i % 3]}" end={12}><keyframeTrack id="track-x-${i}" property="x"><keyframe id="x0-${i}" time={0} value={${x - delta}}/><keyframe id="x1-${i}" time={6} value={${x + delta}}/><keyframe id="x2-${i}" time={12} value={${x - delta}}/></keyframeTrack><keyframeTrack id="track-y-${i}" property="y"><keyframe id="y0-${i}" time={0} value={${y + delta}}/><keyframe id="y1-${i}" time={6} value={${y - delta}}/><keyframe id="y2-${i}" time={12} value={${y + delta}}/></keyframeTrack></rect>`;
  }
  await project(`tiles-${count}`, items);
}
let items =
  '<scene3d id="world" name="100 animated meshes and 60 dynamic bodies" width={1920} height={1080} end={12} ambientIntensity={.6} physics={{gravity:[0,500,0]}}>';
for (let i = 0; i < 100; i++) {
  const x = 130 + (i % 20) * 81,
    y = 180 + Math.floor(i / 20) * 89;
  items += `\n<mesh id="mesh-${i}" name="Animated mesh ${i + 1}" x={${x}} y={${y}} z={-250} width={42} height={42} depth={42} fill="#82B8E6" rotationX={-20} castShadow={false}><keyframeTrack id="rotation-${i}" property="rotationY"><keyframe id="r0-${i}" time={0} value={${i * 7}}/><keyframe id="r1-${i}" time={12} value={${i * 7 + 360}}/></keyframeTrack></mesh>`;
}
items +=
  '<mesh id="floor" name="Floor collider" x={70} y={970} width={1780} height={30} depth={350} fill="#34495C" rigidBody={{type:"fixed",friction:.6}}/>';
for (let i = 0; i < 60; i++) {
  const x = 110 + (i % 20) * 85,
    y = 660 + Math.floor(i / 20) * 70;
  items += `\n<mesh id="body-${i}" name="Dynamic body ${i + 1}" shape="${i % 2 ? "box" : "sphere"}" x={${x}} y={${y}} width={40} height={40} depth={40} fill="${i % 2 ? "#DDA077" : "#A9C5AD"}" roughness={.55} rigidBody={{restitution:.55,angularVelocity:[${(i % 5) * 10},${(i % 4) * 10},0],linearDamping:.1}}/>`;
}
items +=
  '<light id="key-light" name="Directional light" type="directional" x={200} y={-150} z={700} targetX={960} targetY={600} intensity={2.2}/></scene3d>';
await project("dense-3d", items);
