import type { AnimatableProperty, AuthoredTree, Easing, EllipseProps, GroupProps, PathProps, RectProps, ShadowProps, SolidPaintProps, StrokeProps, TextProps } from "@diffusionstudio/jsx";

type LayerProps = {
  group: GroupProps;
  rect: RectProps;
  ellipse: EllipseProps;
  path: PathProps;
  text: TextProps;
  stroke: StrokeProps;
  shadow: ShadowProps;
  solidPaint: SolidPaintProps;
};

function layer<Tag extends keyof LayerProps>(tag: Tag, props: Omit<LayerProps[Tag], "children">, children: AuthoredTree[] = [], text?: string): AuthoredTree {
  return { tag, props, children, ...(text === undefined ? {} : { text }) };
}

function track(property: AnimatableProperty, frames: readonly (readonly [time: number, value: number | string, easing?: Easing])[]): AuthoredTree {
  return { tag: "keyframeTrack", props: { property }, children: frames.map(([time, value, easing = "cubicBezier(0.22,1,0.36,1)"]) => ({ tag: "keyframe", props: { time, value, easing }, children: [] })) };
}

const label = (name: string, text: string, x: number, y: number, fontSize: number, fill: string, extra: Omit<TextProps, "children"> = {}) =>
  layer("text", { name, x, y, fontSize, fontFamily: "Inter", fontWeight: 500, ...extra }, [layer("solidPaint", { color: fill })], text);

const background = (fill: string) => layer("rect", { name: "Background", width: 1920, height: 1080, fill });
const shadow = (color = "#151F40", blur = 50, opacity = 0.18) => layer("shadow", { color, opacity, blur, offsetY: 18 });

function phoneChat(): AuthoredTree[] {
  const messages = [
    { name: "Maya", text: "Ready when you are.", color: "#BDDACE" },
    { name: "You", text: "Let's make it move.", color: "#C9D6FF" },
    { name: "Maya", text: "Every detail is yours.", color: "#FFD6C4" },
  ];
  return [
    background("#F3F3F0"),
    label("Headline first line", "Conversations", 130, 330, 100, "#20242B", { fontWeight: 600 }),
    label("Headline second line", "with depth.", 130, 445, 100, "#20242B", { fontWeight: 600 }),
    label("Caption", "Make room for the little details.", 136, 614, 30, "#697078"),
    layer("group", { name: "Phone", x: 1180, y: 122, width: 420, height: 820, rotationX: 8, rotationY: -24, rotation: 6, expanded: true }, [
      track("rotationY", [[0, -32], [2, -24], [6, -8]]),
      track("rotationX", [[0, 12], [6, 4]]),
      layer("rect", { name: "Phone frame", width: 420, height: 820, cornerRadius: 58, fill: "#30333B" }, [shadow("#1C2545", 70, 0.25)]),
      layer("rect", { name: "Screen", x: 12, y: 12, width: 396, height: 796, cornerRadius: 48, fill: "#FAFAFA", z: 3 }),
      layer("rect", { name: "Camera island", x: 142, y: 25, width: 136, height: 33, cornerRadius: 18, fill: "#181B20", z: 5 }),
      label("Screen title", "Messages", 40, 95, 36, "#242832", { z: 6, fontWeight: 600 }),
      label("Screen date", "TODAY", 42, 151, 13, "#959CA7", { z: 6, letterSpacing: 2 }),
      ...messages.map((message, index) => layer("group", { name: `Message from ${message.name} ${index + 1}`, x: 29, y: 211 + index * 139, width: 362, height: 111, z: 8 }, [
        track("z", [[0, 8], [0.8 + index * 0.15, 8], [2.1 + index * 0.15, 60 + index * 30], [5.6, 8]]),
        track("x", [[0, 29], [2.2 + index * 0.15, 6 - index * 22], [5.6, 29]]),
        layer("rect", { name: "Message surface", width: 362, height: 111, cornerRadius: 24, fill: "#FFFFFF" }, [shadow("#2F3D60", 20, 0.125)]),
        layer("ellipse", { name: "Avatar", x: 19, y: 22, width: 41, height: 41, fill: message.color }),
        label("Sender", message.name, 78, 18, 18, "#303642", { fontWeight: 600 }),
        label("Message text", message.text, 78, 48, 16, "#697180"),
        label("Timestamp", "Now", 303, 20, 11, "#9BA2AD"),
      ])),
      layer("rect", { name: "Compose field", x: 31, y: 705, width: 358, height: 48, cornerRadius: 24, fill: "#EDEEF2", z: 5 }),
      label("Compose placeholder", "Write a message", 54, 718, 15, "#989DA8", { z: 7 }),
      layer("rect", { name: "Home indicator", x: 142, y: 780, width: 136, height: 5, cornerRadius: 3, fill: "#24262C", z: 6 }),
    ]),
  ];
}

function kineticType(): AuthoredTree[] {
  return [
    background("#111815"),
    ...[
      { text: "Make", x: 125, y: 175, size: 234, fill: "#E7EDE8", delay: 0 },
      { text: "it", x: 860, y: 175, size: 234, fill: "#E7EDE8", delay: 0.16 },
      { text: "move.", x: 120, y: 440, size: 284, fill: "#BBD9AA", delay: 0.32 },
    ].map((word) => layer("group", { name: `Word: ${word.text}`, x: word.x, y: word.y, width: 1300, height: 340 }, [
      track("offsetY", [[word.delay, 110], [word.delay + 1, 0], [4.4, 0], [5, -70]]),
      track("opacity", [[word.delay, 0], [word.delay + 0.5, 1], [4.5, 1], [5, 0]]),
      label("Text", word.text, 0, 0, word.size, word.fill, { fontWeight: 600, letterSpacing: -9 }),
    ])),
    layer("rect", { name: "Underline", x: 133, y: 795, width: 1670, height: 3, fill: "#637264" }, [track("scaleX", [[0.5, 0.01], [1.7, 1]])]),
    label("Closing line", "Every word. Every keyframe.", 137, 864, 35, "#98A99A"),
  ];
}

function growthChart(): AuthoredTree[] {
  const start = "M 0 400 L 160 400 L 320 400 L 480 400 L 640 400 L 800 400 L 960 400 L 1120 400 L 1280 400 L 1440 400";
  const green = "M 0 388 L 160 355 L 320 330 L 480 268 L 640 281 L 800 200 L 960 158 L 1120 185 L 1280 82 L 1440 12";
  const blue = "M 0 405 L 160 389 L 320 365 L 480 370 L 640 326 L 800 310 L 960 295 L 1120 227 L 1280 216 L 1440 171";
  return [
    background("#101A16"),
    label("Metric", "43,715", 155, 104, 170, "#F0F4EC", { fontWeight: 600, letterSpacing: -6 }),
    label("Metric description", "Good things take shape.", 166, 310, 33, "#A1B2A5"),
    layer("group", { name: "Chart", x: 173, y: 430, width: 1500, height: 480, expanded: true }, [
      ...[0, 200, 400].map((y, index) => layer("rect", { name: `Grid line ${index + 1}`, y, width: 1440, height: 1, fill: "#26392D" })),
      ...[{ name: "Series A", d: green, color: "#72D9A7" }, { name: "Series B", d: blue, color: "#90B7DD" }].map((series, index) => layer("path", { name: series.name, d: start, width: 1440, height: 430 }, [
        layer("stroke", { color: series.color, width: 7, cap: "round", join: "round" }),
        track("d", [[0.4 + index * 0.3, start], [2.3 + index * 0.3, series.d]]),
      ])),
      label("Start label", "Day 1", 0, 458, 22, "#819887"),
      label("End label", "Day 30", 1370, 458, 22, "#819887"),
    ]),
    layer("ellipse", { name: "Series A legend marker", x: 173, y: 990, width: 18, height: 18, fill: "#72D9A7" }),
    label("Series A legend", "First idea", 207, 983, 24, "#B4C5B9"),
    layer("ellipse", { name: "Series B legend marker", x: 432, y: 990, width: 18, height: 18, fill: "#90B7DD" }),
    label("Series B legend", "Next iteration", 466, 983, 24, "#B4C5B9"),
  ];
}

function geometryStudy(): AuthoredTree[] {
  const points = Array.from({ length: 25 }, (_, index) => {
    const x = index * 46;
    return { x, y: 250 - Math.sin(index / 24 * Math.PI * 2) * 180 };
  });
  const d = points.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ");
  return [
    background("#F3F0E9"),
    label("Title", "A little change.", 135, 105, 106, "#272922", { fontWeight: 600, letterSpacing: -4 }),
    label("Equation", "y = sin(x)", 141, 248, 44, "#8D6550"),
    layer("group", { name: "Coordinate plane", x: 370, y: 395, width: 1130, height: 520, expanded: true }, [
      ...[0, 180, 360, 540, 720, 900, 1080].map((x, index) => layer("rect", { name: `Vertical guide ${index + 1}`, x, width: 1, height: 500, fill: "#DCD7CE" })),
      ...[70, 250, 430].map((y, index) => layer("rect", { name: `Horizontal guide ${index + 1}`, y, width: 1104, height: 1, fill: "#DCD7CE" })),
      layer("path", { name: "Axes", d: "M 0 0 L 0 500 M 0 250 L 1130 250", width: 1130, height: 500 }, [layer("stroke", { color: "#99938A", width: 3 })]),
      layer("path", { name: "Sine curve", d, width: 1104, height: 500 }, [layer("stroke", { color: "#BA7554", width: 6, cap: "round", join: "round" }), track("opacity", [[0, 0], [1.2, 1]])]),
      layer("ellipse", { name: "Moving point", x: -13, y: 237, width: 26, height: 26, fill: "#644635" }, [
        track("x", points.map((point, index) => [0.7 + index / 24 * 4.6, point.x - 13, "linear"])),
        track("y", points.map((point, index) => [0.7 + index / 24 * 4.6, point.y - 13, "linear"])),
      ]),
      label("X axis label", "x", 1150, 231, 30, "#77736C"),
      label("Y axis label", "y", -13, -51, 30, "#77736C"),
    ]),
  ];
}

function studioWindow(): AuthoredTree[] {
  return [
    background("#F7F6F3"),
    label("Title", "Your next\nbig idea.", 115, 142, 174, "#242830", { fontWeight: 600, letterSpacing: -7, leading: 0.98 }),
    label("Subtitle", "Built one layer at a time.", 130, 638, 33, "#85888E"),
    layer("group", { name: "Studio window", x: 866, y: 264, width: 884, height: 588, rotationY: -13, rotationX: 5, expanded: true }, [
      track("offsetY", [[0, 140], [1.7, 0]]),
      track("rotationY", [[0, -22], [5.5, -5]]),
      layer("rect", { name: "Window surface", width: 884, height: 588, cornerRadius: 23, fill: "#FFFFFF" }, [shadow("#8593DB", 80, 0.31)]),
      layer("rect", { name: "Sidebar surface", x: 1, y: 56, width: 202, height: 509, fill: "#F6F7FA", cornerRadius: 10, z: 1 }),
      ...["#DE8D87", "#DFC488", "#9ABE9F"].map((fill, index) => layer("ellipse", { name: `Window control ${index + 1}`, x: 23 + index * 24, y: 21, width: 11, height: 11, fill, z: 2 })),
      label("Window title", "Motion Studio", 338, 14, 17, "#7F8491", { z: 2 }),
      label("Sidebar title", "Layers", 26, 86, 18, "#353D4B", { z: 3, fontWeight: 600 }),
      ...["Opening", "Headline", "Composition", "Sound", "Closing"].map((text, index) => label(`Layer label ${index + 1}`, text, 36, 144 + index * 49, 15, "#7E8593", { z: 3 })),
      layer("rect", { name: "Canvas", x: 226, y: 81, width: 632, height: 302, cornerRadius: 13, fill: "#EAEFFA", z: 2 }),
      label("Canvas title", "Make it yours.", 275, 194, 57, "#43567D", { z: 4, fontWeight: 600, letterSpacing: -2 }),
      layer("group", { name: "Sound clip", x: 237, y: 420, width: 600, height: 100, z: 14 }, [
        layer("rect", { name: "Clip surface", width: 600, height: 100, cornerRadius: 13, fill: "#F5E5E1" }),
        ...Array.from({ length: 28 }, (_, index) => {
          const height = 15 + Math.abs(Math.sin(index * 0.7) * Math.cos(index * 0.27)) * 57;
          return layer("rect", { name: `Waveform bar ${index + 1}`, x: 21 + index * 20, y: (100 - height) / 2, width: 6, height, cornerRadius: 3, fill: "#D39A90", z: 2 }, [track("scaleY", [[0.7 + index * 0.025, 0.1], [1.6 + index * 0.025, 1]])]);
        }),
      ]),
    ]),
    layer("group", { name: "Floating control", x: 1445, y: 670, width: 306, height: 188, z: 90, rotationY: -10 }, [
      track("offsetY", [[0.8, 100], [2.3, 0]]),
      layer("rect", { name: "Control surface", width: 306, height: 188, cornerRadius: 25, backdropBlur: 12, refraction: 0.12 }, [layer("solidPaint", { color: "#FFFFFF", opacity: 0.9 }), shadow("#BC96CE", 44, 0.31)]),
      label("Control heading", "Make some room", 27, 26, 22, "#484250", { fontWeight: 600, z: 2 }),
      label("Control description", "For the next idea.", 29, 66, 15, "#A29BA8", { z: 2 }),
      layer("rect", { name: "Slider track", x: 30, y: 131, width: 244, height: 4, cornerRadius: 2, fill: "#E0D6E4", z: 2 }),
      layer("ellipse", { name: "Slider thumb", x: 116, y: 121, width: 24, height: 24, fill: "#B7A0C4", z: 5 }, [track("x", [[1.4, 32], [3.4, 202]])]),
    ]),
  ];
}

function spatialCube(): AuthoredTree[] {
  const faces: { name: string; x?: number; y?: number; z?: number; rotationX?: number; rotationY?: number; fill: string }[] = [
    { name: "Back face", z: -160, rotationY: 180, fill: "#727B91" },
    { name: "Left face", x: -160, rotationY: -90, fill: "#BAC5D8" },
    { name: "Right face", x: 160, rotationY: 90, fill: "#7488A9" },
    { name: "Top face", y: -160, rotationX: 90, fill: "#DCE5F0" },
    { name: "Bottom face", y: 160, rotationX: -90, fill: "#566681" },
    { name: "Front face", z: 160, fill: "#A4B8D0" },
  ];
  return [
    background("#121824"),
    label("Title", "Another\ndimension.", 128, 268, 138, "#E5EAF1", { fontWeight: 600, leading: 1.05, letterSpacing: -5 }),
    label("Caption", "Six faces. One composition.", 135, 656, 31, "#8999AF"),
    layer("group", { name: "Cube", x: 1180, y: 368, width: 320, height: 320, rotationX: -22, rotationY: 30, rotation: -4, depthSort: "camera", expanded: true }, [
      track("rotationY", [[0, 25, "cubicBezier(0.45,0,0.55,1)"], [6, 235]]),
      track("rotationX", [[0, -22, "cubicBezier(0.45,0,0.55,1)"], [6, -36]]),
      ...faces.map((face) => layer("rect", { ...face, width: 320, height: 320 }, [layer("stroke", { width: 2, color: "#DAE5F3", opacity: 0.5 })])),
    ]),
  ];
}

export const MOTION_BLOCKS = [
  { id: "phone-chat", title: "Phone & chat", description: "Floating messages and a slowly turning phone.", duration: 6, create: phoneChat },
  { id: "kinetic-type", title: "Make it move", description: "Oversized type with a staggered entrance.", duration: 5, create: kineticType },
  { id: "growth-chart", title: "Growth chart", description: "Two editable vector series changing shape.", duration: 6, create: growthChart },
  { id: "geometry-study", title: "Geometry study", description: "A moving point on an editable sine curve.", duration: 6, create: geometryStudy },
  { id: "studio-window", title: "Studio launch", description: "Layered windows, waveform bars and floating controls.", duration: 6, create: studioWindow },
  { id: "spatial-cube", title: "Another dimension", description: "A rotating cube with six individually editable faces.", duration: 6, create: spatialCube },
] as const;

export type MotionBlock = typeof MOTION_BLOCKS[number];

export function motionBlockTree(block: MotionBlock): AuthoredTree {
  return layer("group", { name: block.title, width: 1920, height: 1080, end: block.duration, expanded: true }, block.create());
}
