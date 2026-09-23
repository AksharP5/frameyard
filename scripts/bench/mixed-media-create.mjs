import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    video: { type: "string" },
    broll: { type: "string" },
    music: { type: "string" },
    transcript: { type: "string" },
  },
});
for (const key of ["project", "video", "broll", "music", "transcript"]) {
  if (!values[key])
    throw new Error(
      `Missing --${key}. Supply a new project directory and local media paths.`,
    );
}
const project = resolve(values.project);
const suppliedTranscript = JSON.parse(
  await readFile(values.transcript, "utf8"),
);
const transcript = Array.isArray(suppliedTranscript)
  ? suppliedTranscript
  : suppliedTranscript.segments;
if (!Array.isArray(transcript))
  throw new Error(
    "Transcript must be a segment array or a local ASR segments object.",
  );
if (
  !transcript.every(
    (segment) =>
      typeof segment?.text === "string" &&
      Array.isArray(segment.words) &&
      segment.words.every(
        (word) =>
          typeof word?.text === "string" &&
          Number.isFinite(word.start) &&
          Number.isFinite(word.end) &&
          word.start >= 0 &&
          word.end >= word.start &&
          word.end <= 150,
      ),
  )
) {
  throw new Error(
    "Transcript needs valid word timestamps for the edited 150-second dialogue.",
  );
}
for (const key of ["video", "broll", "music"]) {
  if (!(await stat(values[key])).isFile())
    throw new Error(`--${key} must be a local file.`);
}
const cuts = [
  [0, 20],
  [30, 55],
  [70, 95],
  [105, 130],
  [145, 170],
  [190, 220],
];
let time = 0;
const clips = cuts.map(([sourceIn, sourceOut], index) => {
  const start = time;
  time += sourceOut - sourceIn;
  return { id: `take-${index + 1}`, start, end: time, sourceIn, sourceOut };
});
await mkdir(project);
await mkdir(`${project}/assets`);
const assets = {};
for (const key of ["video", "broll", "music"]) {
  const original = resolve(values[key]);
  const name = `${key}${extname(original)}`;
  await symlink(original, `${project}/assets/${name}`);
  assets[key] = name;
}
assets.transcript = "transcript.json";
await writeFile(
  `${project}/assets/transcript.json`,
  JSON.stringify(transcript),
);
const elements = [
  '<rect id="background" name="Background" width={1920} height={1080} fill="#101820" end={150}/>',
];
for (const [index, clip] of clips.entries()) {
  const timing = `start={${clip.start}} end={${clip.end}} sourceIn={${clip.sourceIn}} sourceOut={${clip.sourceOut}}`;
  elements.push(
    `<video id="${clip.id}" name="Dialogue cut ${index + 1}" src=${JSON.stringify(assets.video)} width={1920} height={1080} ${timing} muted/>`,
  );
  elements.push(
    `<audio id="dialogue-${index + 1}" name="Dialogue audio ${index + 1}" src=${JSON.stringify(assets.video)} ${timing} volume={-3}/>`,
  );
}
for (const [index, [start, end, sourceIn]] of [
  [12, 18, 2],
  [40, 48, 25],
  [70, 78, 50],
  [105, 114, 75],
  [135, 145, 100],
].entries()) {
  elements.push(`<video id="broll-${index + 1}" name="Screen detail ${index + 1}" src=${JSON.stringify(assets.broll)} x={1100} y={90} width={720} height={405} start={${start}} end={${end}} sourceIn={${sourceIn}} sourceOut={${sourceIn + end - start}} muted>
    <shadow id="broll-shadow-${index}" color="#000000" blur={18} offsetY={10} opacity={0.55}/>
    <stroke id="broll-stroke-${index}" color="#EDF3F7" width={3}/>
    <effect id="broll-blur-${index}" type="blur" value={0}><keyframeTrack id="broll-blur-track-${index}" property="value"><keyframe id="blur-in-${index}" time={${sourceIn}} value={5}/><keyframe id="blur-settle-${index}" time={${sourceIn + 0.4}} value={0}/></keyframeTrack></effect>
    <keyframeTrack id="broll-x-track-${index}" property="x"><keyframe id="broll-x-in-${index}" time={${sourceIn}} value={1160}/><keyframe id="broll-x-settle-${index}" time={${sourceIn + 0.4}} value={1100} easing="easeOut"/></keyframeTrack>
  </video>`);
}
for (const [index, [start, end]] of [
  [56, 64],
  [120, 130],
].entries()) {
  elements.push(`<scene3d id="world-${index}" name="Native 3D insert ${index + 1}" x={1080} y={80} width={720} height={540} start={${start}} end={${end}} ambientIntensity={0.6} physics={{gravity:[0,500,0]}}>
    <mesh id="floor-${index}" name="Fixed floor" x={20} y={470} width={680} height={20} depth={300} fill="#334B60" rigidBody={{type:"fixed"}}/>
    <light id="light-${index}" type="directional" x={0} y={-150} z={600} targetX={360} targetY={280} intensity={2}/>`);
  for (let mesh = 0; mesh < 12; mesh++)
    elements.push(
      `<mesh id="cube-${index}-${mesh}" name="Rotating cube ${mesh + 1}" x={${70 + (mesh % 6) * 100}} y={${70 + Math.floor(mesh / 6) * 100}} width={50} height={50} depth={50} rotationX={-20} fill="#82B9E5" castShadow={false}><keyframeTrack id="rotate-${index}-${mesh}" property="rotationY"><keyframe id="rot-in-${index}-${mesh}" time={0} value={${mesh * 15}}/><keyframe id="rot-out-${index}-${mesh}" time={${end - start}} value={${mesh * 15 + 180}}/></keyframeTrack></mesh>`,
    );
  for (let body = 0; body < 8; body++)
    elements.push(
      `<mesh id="body-${index}-${body}" name="Falling body ${body + 1}" x={${60 + body * 78}} y={300} width={42} height={42} depth={42} shape="${body % 2 ? "box" : "sphere"}" fill="#DDA77F" rigidBody={{restitution:0.45}}/>`,
    );
  elements.push("</scene3d>");
}
elements.push(
  `<audio id="music-bed" name="Music bed" src=${JSON.stringify(assets.music)} start={0} end={150} sourceIn={0} sourceOut={150} volume={-28}><keyframeTrack id="music-envelope" property="volume"><keyframe id="music-in" time={0} value={-60}/><keyframe id="music-level" time={2} value={-28}/><keyframe id="music-out-start" time={148} value={-28}/><keyframe id="music-out" time={150} value={-60}/></keyframeTrack></audio>`,
);
elements.push(
  '<rect id="caption-backdrop" name="Caption contrast" x={0} y={820} width={1920} height={170} fill="#090D12" opacity={0.7} start={0} end={150}/>',
);
elements.push(
  `<captions id="captions" name="Edited dialogue captions" src=${JSON.stringify(assets.transcript)} preset="whisper" verticalAlign="bottom" offsetY={-45} start={0} end={150}/>`,
);
elements.push(
  '<text id="edit-marker" name="Edit verification title" x={75} y={60} width={800} height={80} fontSize={42} fontFamily="Inter" fill="#FFFFFF" start={0} end={6}>Mixed-media edit<shadow id="title-shadow" color="#000000" blur={10} offsetY={3}/></text>',
);
await writeFile(
  `${project}/index.tsx`,
  `export default function MixedMedia() { return <stage background="#171A1E" camera={[0.6,0,0,0.6,50,80]}><scene id="mixed-scene" name="Mixed-media validation" width={1920} height={1080} active>${elements.join("\n")}</scene></stage>; }\n`,
);
await writeFile(
  `${project}/package.json`,
  JSON.stringify(
    {
      name: "frameyard-mixed-media-validation",
      private: true,
      main: "index.tsx",
      diffusion: {
        export: {
          "mixed-scene": {
            format: "mp4",
            video: {
              codec: "avc",
              resolution: 1080,
              fps: 30,
              bitrate: 12000000,
            },
            audio: { codec: "aac" },
          },
        },
      },
    },
    null,
    2,
  ),
);
await writeFile(
  `${project}/benchmark.json`,
  JSON.stringify(
    {
      duration: time,
      clips,
      assets,
      sources: Object.fromEntries(
        ["video", "broll", "music", "transcript"].map((key) => [
          key,
          resolve(values[key]),
        ]),
      ),
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    project,
    duration: time,
    clips: clips.length,
    transcriptSegments: transcript.length,
  }),
);
