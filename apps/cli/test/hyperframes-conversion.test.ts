import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AuthoredTree } from "@diffusionstudio/jsx";
import { convertAnimation } from "../src/animation.ts";
import { capturedAnimationToJsx, simplifyKeys } from "../src/editable-animation.ts";
import { affine4, multiply4, projectPoint3D, rotation4, scale4, translation4 } from "../../../packages/runtime/src/math/spatial.ts";

const descendants = (node: AuthoredTree): AuthoredTree[] => [node, ...node.children.flatMap(descendants)];
const data = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
const hyperframes = process.env.DIFFUSION_HYPERFRAMES_BIN ?? join(data, "diffusion-studio/tools/node_modules/.bin/hyperframes");

test("native capture keeps gradient stops and effects independently editable", () => {
  const result = capturedAnimationToJsx({width:100,height:100,duration:1,frameRate:12,issues:[],layers:[
    {id:"box",kind:"rect",name:"Box",frames:[{time:0,props:{width:100,height:100}}]},
    {id:"paint",parent:"box",kind:"linearGradientPaint",name:"Gradient",frames:[{time:0,props:{rotation:45}}]},
    {id:"stop",parent:"paint",kind:"colorStop",name:"Stop",frames:[{time:0,props:{offset:0,color:"#000000"}},{time:1,props:{offset:0.5,color:"#ffffff"}}]},
    {id:"blur",parent:"box",kind:"effect",name:"Blur",frames:[{time:0,props:{type:"blur",value:0}},{time:1,props:{type:"blur",value:4}}]},
  ]},"test","Test");
  const nodes=descendants(result.tree);
  assert.deepEqual(nodes.filter(node=>node.tag==="keyframeTrack").map(node=>node.props.property),["offset","color","value"]);
  assert.equal(nodes.find(node=>node.tag==="colorStop")?.props.end,undefined);
  assert.deepEqual(simplifyKeys([{time:0,value:[0,1,2]},{time:0.5,value:[1,2,3]},{time:1,value:[2,3,4]}]),[{time:0,value:[0,1,2]},{time:1,value:[2,3,4]}]);
});

test("browser capture samples CSS motion and preserves gradients, filters, clips and wrapped text", {skip:!existsSync(hyperframes)}, async t => {
  const project=await mkdtemp(join(tmpdir(),"hyperframes-native-capture-"));
  t.after(()=>rm(project,{recursive:true,force:true}));
  const source=join(project,"animations/source");
  await mkdir(source,{recursive:true});
  await writeFile(join(project,"package.json"),JSON.stringify({diffusion:{animations:{test:{engine:"hyperframes",source:"animations/source",frameRate:4,output:"assets/test.mp4"}}}}));
  const html='<!doctype html><html><head><style>body{margin:0}#root{position:relative;width:320px;height:200px}#box{position:absolute;left:20px;top:20px;width:120px;height:80px;background:linear-gradient(90deg,red 0%,blue 100%);clip-path:polygon(0% 0%,100% 0%,75% 100%,0% 100%);transform-origin:0 0;transform:skewX(10deg);translate:10px 5px;rotate:20deg;scale:1.2 0.8;animation:move 1s linear both}#text{position:absolute;top:110px;width:100px;color:black;font:20px sans-serif}@keyframes move{from{filter:blur(0px);opacity:0.5}to{filter:blur(4px);opacity:1}}</style></head><body><div id="root" data-composition-id="main" data-duration="1" data-width="320" data-height="200"><div id="box"></div><div id="text">Editable text wraps across lines</div></div></body></html>';
  await writeFile(join(source,"index.html"),html);
  const report=await convertAnimation("test",project);
  assert.deepEqual(report.issues,[]);
  const nodes=descendants(report.tree),box=nodes.find(node=>node.props.name==="box")!;
  assert.equal(box.props.x,30);assert.equal(box.props.y,25);
  assert.equal(box.props.anchorX,0);assert.equal(box.props.rotation,20);
  assert.equal(box.props.scaleX,1.2);assert.equal(box.props.scaleY,0.8);
  assert.ok(Number(box.props.skewX)>10,"individual nonuniform scale must compose before skew");
  const gradient=box.children.find(node=>node.tag==="linearGradientPaint")!;
  assert.equal(gradient.props.x1,0);assert.equal(gradient.props.y1,0.5);assert.equal(gradient.props.x2,1);assert.equal(gradient.props.y2,0.5);
  assert.deepEqual(gradient.children.map(node=>node.props.offset),[0,1]);
  assert.deepEqual(gradient.children.map(node=>node.props.color),["#ff0000","#0000ff"]);
  assert.equal(box.children.find(node=>node.props.mask)?.props.d,"M 0 0 L 120 0 L 90 80 L 0 80 Z");
  const effect=box.children.find(node=>node.tag==="effect")!;
  assert.equal(effect.props.value,0);
  assert.deepEqual(effect.children[0].children.map(node=>node.props.value),[0,4]);
  const text=nodes.filter(node=>node.tag==="text");
  assert.ok(text.length>=3);
  assert.equal(text.map(node=>node.text?.trim()).join(" "),"Editable text wraps across lines");
  assert.ok(Number(text[1].props.y)>Number(text[0].props.y));
  assert.doesNotMatch(await readFile(report.output,"utf8"),/<video/);
  await writeFile(join(source,"index.html"),html.replace("filter:blur(4px)","filter:drop-shadow(1px 2px 3px red)"));
  await assert.rejects(convertAnimation("test",project),/filter: drop-shadow/);

  const svg='<svg width="320" height="200" viewBox="0 0 320 200"><defs><linearGradient id="linear"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient><radialGradient id="radial" cx="50%" cy="40%" r="50%" fx="25%" fy="30%"><stop offset="0" stop-color="white"/><stop offset="1" stop-color="black"/></radialGradient><clipPath id="clip"><circle cx="250" cy="50" r="25"/></clipPath></defs><path id="morph" d="M 10 0 H 110 V 80 H 10 Z" fill="url(#linear)" stroke="url(#linear)" stroke-width="3" stroke-dasharray="4 2"/><rect id="radial-box" x="210" y="10" width="80" height="80" fill="url(#radial)" clip-path="url(#clip)"/></svg>';
  await writeFile(join(source,"index.html"),'<!doctype html><html><head><style>body{margin:0}#root{width:320px;height:200px}</style></head><body><div id="root" data-composition-id="main" data-duration="1" data-width="320" data-height="200">'+svg+'</div><script>window.__timelines={main:{pause(){return this},totalTime(time){document.querySelector("#morph").setAttribute("d","M 10 0 H "+(110+100*time)+" V 80 H 10 Z");return this}}}</script></body></html>');
  const svgReport=await convertAnimation("test",project),svgNodes=descendants(svgReport.tree);
  assert.deepEqual(svgReport.issues,[]);
  const morph=svgNodes.find(node=>node.props.name==="morph")!;
  assert.deepEqual(morph.props.viewBox,[10,0,200,80]);
  const paint=morph.children.find(node=>node.tag==="linearGradientPaint")!;
  assert.equal(paint.props.x2,0.5);
  assert.deepEqual(paint.children.find(node=>node.props.property==="x2")?.children.map(node=>node.props.value),[0.5,1]);
  const stroke=morph.children.find(node=>node.tag==="stroke" && node.children.some(child=>child.tag==="linearGradientPaint"))!;
  assert.deepEqual(stroke.props.dash,[4,2]);
  const radialBox=svgNodes.find(node=>node.props.name==="radial-box")!;
  const radial=radialBox.children.find(node=>node.tag==="radialGradientPaint")!;
  assert.equal(radial.props.centerX,0.5);assert.equal(radial.props.centerY,0.4);
  assert.equal(radial.props.radiusX,0.5);assert.equal(radial.props.radiusY,0.5);
  assert.equal(radial.props.focalX,0.25);assert.equal(radial.props.focalY,0.3);
  const clip=radialBox.children.find(node=>node.props.mask)!;
  assert.equal(clip.tag,"ellipse");assert.equal(clip.props.x,15);assert.equal(clip.props.y,15);assert.equal(clip.props.width,50);

  await writeFile(join(source,"index.html"),html.replace('background:linear-gradient(90deg,red 0%,blue 100%)','background:radial-gradient(ellipse 40px 20px at 25% 50%,red,blue)'));
  const radialReport=await convertAnimation("test",project),cssRadial=descendants(radialReport.tree).find(node=>node.tag==="radialGradientPaint")!;
  assert.deepEqual(radialReport.issues,[]);
  assert.equal(cssRadial.props.centerX,0.25);assert.equal(cssRadial.props.centerY,0.5);
  assert.equal(cssRadial.props.radiusX,0.33333);assert.equal(cssRadial.props.radiusY,0.25);

  const textSvg=svg.replace('</svg>','<text id="gradient-label" x="10" y="140" font-size="24" font-family="sans-serif" fill="url(#linear)">One <tspan>gradient</tspan> across runs</text></svg>');
  await writeFile(join(source,"index.html"),'<!doctype html><html><head><style>body{margin:0}#root{width:320px;height:200px}</style></head><body><div id="root" data-composition-id="main" data-duration="1" data-width="320" data-height="200">'+textSvg+'</div><script>window.__timelines={main:{pause(){return this},totalTime(){return this}}}</script></body></html>');
  const textReport=await convertAnimation("test",project),textNodes=descendants(textReport.tree).filter(node=>node.tag==="text");
  assert.deepEqual(textReport.issues,[]);assert.equal(textNodes.length,3);
  const endpoints=textNodes.map(node=>{
    const gradient=node.children.find(child=>child.tag==="linearGradientPaint")!;
    return [Number(node.props.x)+Number(gradient.props.x1)*Number(node.props.width),Number(node.props.x)+Number(gradient.props.x2)*Number(node.props.width)];
  });
  for(const point of endpoints) {
    assert.ok(Math.abs(point[0]-endpoints[0][0])<0.001);
    assert.ok(Math.abs(point[1]-endpoints[0][1])<0.002,"all SVG text runs must share the full text gradient");
  }

  const css3d='<!doctype html><html><head><style>body{margin:0}#root{position:relative;width:320px;height:200px;perspective:400px;perspective-origin:30% 60%}#tilt{position:absolute;left:40px;top:30px;width:100px;height:60px;background:red;transform-origin:20% 70%;transform:translateZ(30px) rotateY(25deg) rotateX(20deg) rotateZ(15deg) skewX(10deg) scale(1.2,0.8)}</style></head><body><div id="root" data-composition-id="main" data-duration="1" data-width="320" data-height="200"><div id="tilt">Tilted</div></div><script>const box=document.querySelector("#tilt");box.dataset.layerName=JSON.stringify(box.getBoundingClientRect().toJSON());window.__timelines={main:{pause(){return this},totalTime(){return this}}}</script></body></html>';
  await writeFile(join(source,"index.html"),css3d);
  const spatial=await convertAnimation("test",project),spatialNodes=descendants(spatial.tree),scene=spatialNodes.find(node=>node.tag==="scene3d")!,tilt=spatialNodes.find(node=>String(node.props.name).startsWith("{"))!;
  assert.deepEqual(spatial.issues,[]);
  const p=tilt.props,angle=Number(p.rotation)*Math.PI/180,skew=Math.tan(Number(p.skewX)*Math.PI/180),cos=Math.cos(angle),sin=Math.sin(angle);
  const model=multiply4(translation4(Number(p.x),Number(p.y),Number(p.z)),multiply4(rotation4(Number(p.rotationX),Number(p.rotationY)),multiply4(affine4({a:cos*Number(p.scaleX),b:sin*Number(p.scaleX),c:(cos*skew-sin)*Number(p.scaleY),d:(sin*skew+cos)*Number(p.scaleY),e:0,f:0}),scale4(1,1,Number(p.scaleZ)))));
  const camera={x:Number(scene.props.cameraX),y:Number(scene.props.cameraY),z:Number(scene.props.cameraZ),perspective:Number(scene.props.perspective),zoom:1,rotationX:0,rotationY:0,rotation:0,width:320,height:200,offsetX:Number(scene.props.cameraOffsetX),offsetY:Number(scene.props.cameraOffsetY)};
  const corners=[[0,0],[100,0],[100,60],[0,60]].map(([x,y])=>projectPoint3D(model,camera,x,y,0));
  const expected=JSON.parse(String(p.name)) as {left:number;top:number;right:number;bottom:number};
  for(const [actual,wanted] of [[Math.min(...corners.map(p=>p.x)),expected.left],[Math.max(...corners.map(p=>p.x)),expected.right],[Math.min(...corners.map(p=>p.y)),expected.top],[Math.max(...corners.map(p=>p.y)),expected.bottom]])assert.ok(Math.abs(actual-wanted)<0.001,`native projection ${actual} must match browser ${wanted}`);
  await writeFile(join(source,"index.html"),css3d.replace('totalTime(){return this}','totalTime(time){box.style.transform="rotateY("+(170+40*time)+"deg)";return this}'));
  const rotation=await convertAnimation("test",project),rotationTrack=descendants(rotation.tree).find(node=>node.tag==="keyframeTrack" && node.props.property==="rotationY")!;
  assert.equal(rotationTrack.children.length,2);
  assert.ok(Math.abs(Number(rotationTrack.children[0].props.value)-170)<0.001);
  assert.ok(Math.abs(Number(rotationTrack.children[1].props.value)-210)<0.001);
  await writeFile(join(source,"index.html"),css3d.replace('translateZ(30px)','perspective(300px) translateZ(30px)'));
  await assert.rejects(convertAnimation("test",project),/embedded perspective.*__DIFFUSION_EDITABLE__/);

  await writeFile(join(source,"index.html"),'<!doctype html><html><body><canvas width="320" height="200"></canvas><script>window.__DIFFUSION_EDITABLE__=async({frameRate})=>({width:320,height:200,duration:1,frameRate,issues:[],layers:[{id:"world",kind:"scene3d",name:"Custom world",frames:[{time:0,props:{width:320,height:200}}]},{id:"points",parent:"world",kind:"pointCloud",name:"Particles",frames:[{time:0,props:{points:[0,0,0],pointSize:4}},{time:1,props:{points:[100,30,20],pointSize:8}}]}]});</script></body></html>');
  const hook=await convertAnimation("test",project);
  assert.deepEqual(hook.issues,[]);assert.equal(hook.frameRate,4);
  assert.ok(descendants(hook.tree).some(node=>node.tag==="pointCloud"));
  assert.ok(descendants(hook.tree).some(node=>node.tag==="keyframeTrack" && node.props.property==="points"));
  await writeFile(join(source,"index.html"),'<!doctype html><html><body><canvas></canvas><script>window.__DIFFUSION_EDITABLE__={width:320,height:200,duration:1,frameRate:4,issues:[],layers:[{id:"invalid",kind:"pointCloud",name:"Invalid",frames:[{time:0,props:{points:[0,1]}}]}]};</script></body></html>');
  await assert.rejects(convertAnimation("test",project),/Invalid captured points/);
});
