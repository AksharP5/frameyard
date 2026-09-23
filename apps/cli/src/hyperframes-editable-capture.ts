/** Uses the already installed HyperFrames browser dependency and Chromium. */
export const hyperframesEditableCapture = String.raw`
import { createServer } from "node:http";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const [entry, output, fps, project, browserModule, executablePath] = process.argv.slice(2);
const source = dirname(entry);
const types = {".html":"text/html", ".js":"text/javascript", ".mjs":"text/javascript", ".css":"text/css", ".svg":"image/svg+xml", ".png":"image/png", ".jpg":"image/jpeg", ".woff":"font/woff", ".woff2":"font/woff2"};
const server = createServer(async (request, response) => {
  try {
    const file = await realpath(resolve(source, "." + decodeURIComponent(new URL(request.url, "http://localhost").pathname)));
    const path = relative(source, file);
    if (path.startsWith(".."+sep) || path === ".." || isAbsolute(path) || !(await stat(file)).isFile()) throw new Error("File outside composition");
    response.writeHead(200, {"Content-Type":types[extname(file)] ?? "application/octet-stream"});
    response.end(await readFile(file));
  } catch { response.writeHead(404); response.end("Not found"); }
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const origin = "http://127.0.0.1:" + server.address().port;
let browser;
try {
  const {default: puppeteer} = await import(pathToFileURL(browserModule).href);
  browser = await puppeteer.launch({executablePath, headless:true, args:["--disable-dev-shm-usage"], timeout:30000});
  const page = await browser.newPage();
  const animationSession = await page.createCDPSession();
  await animationSession.send("Animation.enable");
  await animationSession.send("Animation.setPlaybackRate",{playbackRate:0});
  await page.setViewport({width:1920,height:1080,deviceScaleFactor:1});
  const failures = [];
  page.on("pageerror", error => failures.push(String(error)));
  page.on("requestfailed", request => failures.push(request.url() + ": " + request.failure()?.errorText));
  await page.goto(origin + "/" + encodeURIComponent(relative(source, entry)), {waitUntil:"networkidle0",timeout:30000});
  const metadata = await page.evaluate(async () => {
    await document.fonts.ready;
    const root = document.querySelector("[data-composition-id]");
    if (!root && window.__DIFFUSION_EDITABLE__!==undefined)return {width:innerWidth,height:innerHeight};
    if (!root) throw new Error("No data-composition-id root found");
    return {width:Number(root.dataset.width || root.clientWidth),height:Number(root.dataset.height || root.clientHeight)};
  });
  await page.setViewport({...metadata,deviceScaleFactor:1});
  const capture = await page.evaluate(async (overrideFps) => {
    const root = document.querySelector("[data-composition-id]");
    const frameRate = Number(overrideFps || root?.dataset.fps || 30);
    const editable=window.__DIFFUSION_EDITABLE__;
    if(editable!==undefined)return await (typeof editable==="function"?editable({frameRate}):editable);
    const duration = Number(root.dataset.duration);
    if (!(duration > 0) || !Number.isFinite(duration) || !(frameRate >= 1 && frameRate <= 240)) throw new Error("Composition needs finite data-duration and frame rate");
    const timelines = Object.entries(window.__timelines || {});
    if(!timelines.length && !root.getAnimations({subtree:true}).length)throw new Error("Editable HyperFrames conversion requires a registered GSAP timeline, CSS/Web Animations timeline, or window.__DIFFUSION_EDITABLE__ capture");
    const webAnimations = new Map();
    window.gsap?.ticker?.sleep();
    const webFonts = new Set([...document.fonts].map(face=>face.family.replace(/^["']|["']$/g,"").toLowerCase()));
    const layers = new Map(), identities = new WeakMap(), issues = new Map(), svgPathBounds = new Map(), svgGradientFrames = new Map(), svgClipFrames = new Map();
    let count = 0, samples = 0;
    const idFor = element => {
      if (!identities.has(element)) identities.set(element, "element-" + count++);
      return identities.get(element);
    };
    const issue = (layer, feature) => issues.set(layer + "\0" + feature, {layer,feature});
    const number = value => Math.round(value * 100000) / 100000;
    const rgba = value => {
      const match = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(value);
      if (!match) return {color:value,opacity:value === "transparent" ? 0 : 1};
      return {color:"#"+match.slice(1,4).map(v=>Math.round(Number(v)).toString(16).padStart(2,"0")).join(""),opacity:Number(match[4] ?? 1)};
    };
    const layer = (id,parent,kind,name,props,time) => {
      if (!layers.has(id)) layers.set(id,{id,parent,kind,name,frames:[]});
      const item = layers.get(id);
      if (item.parent !== parent) issue(name,"changing DOM parent");
      if (item.kind !== kind) issue(name,"changing element geometry kind");
      if (props.rotation!==undefined && item.frames.length) {
        const previous=item.frames.at(-1).props,unwrap=(value,prior)=>number(value+360*Math.round((prior-value)/360));
        if(props.rotationX!==undefined && previous.rotationX!==undefined) {
          if(Math.abs(Math.abs(props.rotationX)-90)<0.0001){props.rotationY+=Math.sign(props.rotationX)*previous.rotation;props.rotation=previous.rotation;}
          const alternatives=[[props.rotationX,props.rotationY,props.rotation],[180-props.rotationX,props.rotationY+180,props.rotation+180]].map(values=>values.map((value,i)=>unwrap(value,[previous.rotationX,previous.rotationY,previous.rotation][i])));
          const cost=values=>values.reduce((total,value,i)=>total+(value-[previous.rotationX,previous.rotationY,previous.rotation][i])**2,0);
          [props.rotationX,props.rotationY,props.rotation]=cost(alternatives[0])<=cost(alternatives[1])?alternatives[0]:alternatives[1];
        } else props.rotation=unwrap(props.rotation,previous.rotation);
      }
      const frames=item.frames, sample={time:number(time),props};
      if(!frames.length && time>0 && layers.get(parent)?.frames[0].time<time && (props.mask || kind==="colorStop"))issue(name,props.mask?"changing clipping geometry presence":"changing gradient stop count");
      if(!frames.length && time>0 && kind==="effect") {
        const initial={...props,value:["brightness","contrast","saturate"].includes(props.type)?1:0};
        frames.push({time:0,props:initial},{time:number(Math.max(0,time-1/frameRate)),props:initial});
      }
      if (frames.length>1 && JSON.stringify(frames.at(-1).props)===JSON.stringify(props) && JSON.stringify(frames.at(-2).props)===JSON.stringify(props)) frames[frames.length-1]=sample;
      else frames.push(sample);
      if (++samples > 500000) throw new Error("Editable capture exceeds 500,000 object samples. Split the composition into shorter components.");
    };
    const affine = (matrix,name) => {
      if (matrix.is2D===false) issue(name,"3D transform");
      const scaleX=Math.hypot(matrix.a,matrix.b),det=matrix.a*matrix.d-matrix.b*matrix.c;
      const scaleY=scaleX>1e-8?det/scaleX:Math.hypot(matrix.c,matrix.d);
      const dot=matrix.a*matrix.c+matrix.b*matrix.d;
      if(Math.abs(det)<1e-8 && Math.abs(dot)>1e-8) issue(name,"singular skew transform");
      return {anchorX:0,anchorY:0,x:number(matrix.e),y:number(matrix.f),rotation:number((scaleX>1e-8?Math.atan2(matrix.b,matrix.a):Math.atan2(-matrix.c,matrix.d))*180/Math.PI),scaleX:number(scaleX),scaleY:number(scaleY),skewX:number(Math.abs(det)>1e-8?Math.atan(dot/det)*180/Math.PI:0)};
    };
    const affine3D = matrix => {
      if(Math.max(Math.abs(matrix.m14),Math.abs(matrix.m24),Math.abs(matrix.m34),Math.abs(matrix.m44-1))>1e-8)throw new Error("3D CSS transform with embedded perspective");
      const u=[matrix.m11,matrix.m12,matrix.m13],v=[matrix.m21,matrix.m22,matrix.m23],w=[matrix.m31,matrix.m32,matrix.m33];
      const sx=Math.hypot(...u);
      if(sx<1e-8)throw new Error("singular 3D CSS transform");
      const q1=u.map(value=>value/sx),dot=q1.reduce((sum,value,i)=>sum+value*v[i],0),orthogonal=v.map((value,i)=>value-dot*q1[i]),sy=Math.hypot(...orthogonal);
      if(sy<1e-8)throw new Error("singular 3D CSS transform");
      const q2=orthogonal.map(value=>value/sy),q3=[q1[1]*q2[2]-q1[2]*q2[1],q1[2]*q2[0]-q1[0]*q2[2],q1[0]*q2[1]-q1[1]*q2[0]],sz=q3.reduce((sum,value,i)=>sum+value*w[i],0);
      if(w.some((value,i)=>Math.abs(value-q3[i]*sz)>1e-5*Math.max(1,Math.abs(sz))))throw new Error("3D CSS transform with depth shear");
      const rx=Math.asin(Math.max(-1,Math.min(1,-q3[1]))),ry=Math.abs(Math.cos(rx))>1e-8?Math.atan2(q3[0],q3[2]):Math.atan2(-q1[2],q1[0]),rz=Math.abs(Math.cos(rx))>1e-8?Math.atan2(q1[1],q2[1]):0;
      return {anchorX:0,anchorY:0,x:number(matrix.m41),y:number(matrix.m42),z:number(matrix.m43),rotationX:number(rx*180/Math.PI),rotationY:number(ry*180/Math.PI),rotation:number(rz*180/Math.PI),scaleX:number(sx),scaleY:number(sy),scaleZ:number(sz),skewX:number(Math.atan(dot/sy)*180/Math.PI)};
    };
    const splitCSS = (value,separator=",") => {
      const parts=[];
      let depth=0,quote="",start=0;
      for(let i=0;i<value.length;i++) {
        const char=value[i];
        if(quote){if(char===quote && value[i-1]!=="\\")quote="";continue;}
        if(char==='"' || char==="'"){quote=char;continue;}
        if(char==="(")depth++;if(char===")")depth--;
        if(!depth && (separator===" "?/\s/.test(char):char===separator)) {if(value.slice(start,i).trim())parts.push(value.slice(start,i).trim());start=i+1;}
      }
      if(value.slice(start).trim())parts.push(value.slice(start).trim());
      return parts;
    };
    const cssLength = (value,size) => {
      if(!/^-?(?:\d*\.)?\d+(?:px|%)?$/.test(value))throw new Error("unsupported CSS length: "+value);
      return parseFloat(value)*(value.endsWith("%")?size/100:1);
    };
    const cssAngle = value => {
      const match=/^(-?(?:\d*\.)?\d+)(deg|grad|rad|turn)$/.exec(value);
      if(!match)throw new Error("unsupported CSS angle: "+value);
      return Number(match[1])*({deg:1,grad:0.9,rad:180/Math.PI,turn:360}[match[2]]);
    };
    const emitFilters = (id,name,filter,time,seen) => {
      if(!filter || filter==="none")return;
      const supported={blur:"blur",brightness:"brightness",contrast:"contrast",grayscale:"grayscale","hue-rotate":"hueRotate",invert:"invert",saturate:"saturate",sepia:"sepia"};
      for(const [index,part] of splitCSS(filter," ").entries()) {
        const match=/^([a-z-]+)\(([^()]*)\)$/.exec(part);
        if(!match || !supported[match[1]]){issue(name,"filter: "+part);continue;}
        try {
          const type=supported[match[1]],value=type==="hueRotate"?cssAngle(match[2]):cssLength(match[2],1);
          const child=id+"-filter-"+index;
          layer(child,id,"effect",name+" "+type,{type,value:number(value)},time);seen.add(child);
        } catch(error){issue(name,String(error.message));}
      }
    };
    const emitBackground = (id,name,background,width,height,time,seen,style) => {
      if(!background || background==="none" || width<=0 || height<=0)return;
      for(const [index,part] of splitCSS(background).reverse().entries()) {
        try {
          const match=/^(linear|radial)-gradient\((.*)\)$/.exec(part);
          if(!match)throw new Error("background image: "+part);
          const values=splitCSS(match[2]);
          const css=(property,fallback)=>style?splitCSS(style[property]).reverse()[index%splitCSS(style[property]).length]:fallback;
          if(css("backgroundSize","auto")!=="auto" && css("backgroundSize","auto")!=="auto auto")throw new Error("background-size: "+css("backgroundSize"));
          if(css("backgroundClip","border-box")!=="border-box")throw new Error("background-clip: "+css("backgroundClip"));
          if(css("backgroundBlendMode","normal")!=="normal")throw new Error("background blend mode");
          const origin=css("backgroundOrigin","border-box"),border=origin!=="border-box",padding=origin==="content-box";
          const left=style?(border?parseFloat(style.borderLeftWidth):0)+(padding?parseFloat(style.paddingLeft):0):0,right=style?(border?parseFloat(style.borderRightWidth):0)+(padding?parseFloat(style.paddingRight):0):0;
          const top=style?(border?parseFloat(style.borderTopWidth):0)+(padding?parseFloat(style.paddingTop):0):0,bottom=style?(border?parseFloat(style.borderBottomWidth):0)+(padding?parseFloat(style.paddingBottom):0):0;
          const w=width-left-right,h=height-top-bottom;
          let kind="linearGradientPaint",angle=180,length,props={opacity:1};
          if(match[1]==="linear") {
            if(values[0].startsWith("to ")) {
              const direction=values.shift().slice(3).split(" "),dx=direction.includes("right")?1:direction.includes("left")?-1:0,dy=direction.includes("bottom")?1:direction.includes("top")?-1:0;
              if(!dx && !dy)throw new Error("gradient direction");
              angle=Math.atan2(dx*(dy?h:1),-dy*(dx?w:1))*180/Math.PI;
            } else if(/^-?[\d.]+(?:deg|grad|rad|turn)$/.test(values[0]))angle=cssAngle(values.shift());
            const radians=angle*Math.PI/180,dx=Math.sin(radians),dy=-Math.cos(radians);
            length=Math.abs(w*dx)+Math.abs(h*dy);
            props={...props,x1:(left+w/2-dx*length/2)/width,y1:(top+h/2-dy*length/2)/height,x2:(left+w/2+dx*length/2)/width,y2:(top+h/2+dy*length/2)/height};
          } else {
            kind="radialGradientPaint";
            const specification=/^(circle|ellipse|closest-|farthest-|at\b|[\d.]+(?:px|%))/.test(values[0])?values.shift():"ellipse farthest-corner";
            const pieces=specification.split(/\bat\s+/),tokens=pieces[0].trim().split(/\s+/).filter(Boolean),position=(pieces[1]||"50% 50%").trim().split(/\s+/);
            if(position.length===1)position.push("50%");
            if(position.length!==2)throw new Error("radial gradient position");
            const coordinate=(value,size)=>value==="center"?size/2:value==="left"||value==="top"?0:value==="right"||value==="bottom"?size:cssLength(value,size);
            if(position[0]==="top" || position[0]==="bottom")position.reverse();
            const cx=coordinate(position[0],w),cy=coordinate(position[1],h),circle=tokens.includes("circle");
            const sizes=tokens.filter(token=>token!=="circle" && token!=="ellipse"),extent=sizes[0]||"farthest-corner";
            const horizontal=[Math.abs(cx),Math.abs(w-cx)],vertical=[Math.abs(cy),Math.abs(h-cy)],corners=horizontal.flatMap(x=>vertical.map(y=>Math.hypot(x,y)));
            let rx,ry;
            if(/^(closest|farthest)-(side|corner)$/.test(extent)) {
              const choose=extent.startsWith("closest")?Math.min:Math.max;
              if(circle)rx=ry=choose(...(extent.endsWith("side")?[...horizontal,...vertical]:corners));
              else {rx=choose(...horizontal);ry=choose(...vertical);if(extent.endsWith("corner")){rx*=Math.SQRT2;ry*=Math.SQRT2;}}
            } else if(circle || sizes.length===1)rx=ry=cssLength(extent,w);
            else {rx=cssLength(sizes[0],w);ry=cssLength(sizes[1],h);}
            length=rx;
            props={...props,centerX:(left+cx)/width,centerY:(top+cy)/height,radiusX:rx/width,radiusY:ry/height,focalX:(left+cx)/width,focalY:(top+cy)/height};
          }
          if(!(length>0) || Object.values(props).some(value=>!Number.isFinite(value)))throw new Error("degenerate gradient");
          const stops=[];
          for(const value of values) {
            const tokens=splitCSS(value," "),offsets=[];
            while(tokens.length>1 && /^-?(?:\d*\.)?\d+(?:%|px)$/.test(tokens.at(-1)))offsets.unshift(cssLength(tokens.pop(),length)/length);
            const color=tokens.join(" ");
            if(!CSS.supports("color",color) || offsets.length>2)throw new Error("gradient color stop: "+value);
            for(const offset of offsets.length?offsets:[undefined])stops.push({...rgba(color),offset});
          }
          if(stops.length<2)throw new Error("gradient needs two color stops");
          stops[0].offset??=0;stops.at(-1).offset??=1;
          let previous=0;
          for(let i=1;i<stops.length;i++)if(stops[i].offset!==undefined) {
            stops[i].offset=Math.max(stops[previous].offset,stops[i].offset);
            for(let j=previous+1;j<i;j++)stops[j].offset=stops[previous].offset+(stops[i].offset-stops[previous].offset)*(j-previous)/(i-previous);
            previous=i;
          }
          const first=Math.min(0,stops[0].offset),last=Math.max(1,stops.at(-1).offset);
          if(first<0 || last>1) {
            if(kind!=="linearGradientPaint")throw new Error("radial gradient stops outside 0–100%");
            const dx=props.x2-props.x1,dy=props.y2-props.y1;
            props.x2=props.x1+dx*last;props.y2=props.y1+dy*last;props.x1+=dx*first;props.y1+=dy*first;
            for(const stop of stops)stop.offset=(stop.offset-first)/(last-first);
          }
          const child=id+"-gradient-"+index;
          layer(child,id,kind,name+" gradient",Object.fromEntries(Object.entries(props).map(([key,value])=>[key,number(value)])),time);seen.add(child);
          for(const [i,stop] of stops.entries()) {const stopId=child+"-stop-"+i;layer(stopId,child,"colorStop","Color stop",{color:stop.color,opacity:stop.opacity,offset:number(stop.offset)},time);seen.add(stopId);}
        } catch(error){issue(name,String(error.message));}
      }
    };
    const emitClip = (id,name,clip,width,height,time,seen) => {
      if(!clip || clip==="none")return;
      try {
        const match=/^(inset|circle|ellipse|polygon|path)\((.*)\)$/.exec(clip);
        if(!match)throw new Error("clip-path: "+clip);
        const [type,content]=match.slice(1);
        let kind="path",props={x:0,y:0,width,height,anchorX:0,anchorY:0,rotation:0,scaleX:1,scaleY:1,skewX:0,mask:true,opacity:1};
        if(type==="inset") {
          const [insets,round]=content.split(/\s+round\s+/),tokens=insets.split(" ");
          if(tokens.length>4)throw new Error("inset clip lengths");
          const top=cssLength(tokens[0],height),right=cssLength(tokens[1]||tokens[0],width),bottom=cssLength(tokens[2]||tokens[0],height),left=cssLength(tokens[3]||tokens[1]||tokens[0],width);
          kind="rect";props={...props,x:left,y:top,width:Math.max(0,width-left-right),height:Math.max(0,height-top-bottom)};
          if(round){if(round.includes(" ") || round.includes("/"))throw new Error("compound rounded inset clip");props.cornerRadius=cssLength(round,Math.min(props.width,props.height));}
        } else if(type==="circle" || type==="ellipse") {
          const [radii,at]=content.split(/\s+at\s+/),position=(at||"50% 50%").split(" "),radius=radii.split(" ");
          if(position.length!==2)throw new Error("clip position");
          const coordinate=(value,size)=>value==="center"?size/2:value==="left"||value==="top"?0:value==="right"||value==="bottom"?size:cssLength(value,size);
          const cx=coordinate(position[0],width),cy=coordinate(position[1],height);
          const extent=(value,size,center)=>value==="closest-side"?Math.min(center,size-center):value==="farthest-side"?Math.max(center,size-center):cssLength(value,size);
          const rx=type==="circle"?radius[0]==="closest-side"?Math.min(cx,width-cx,cy,height-cy):radius[0]==="farthest-side"?Math.max(cx,width-cx,cy,height-cy):cssLength(radius[0],Math.hypot(width,height)/Math.SQRT2):extent(radius[0],width,cx);
          const ry=type==="circle"?rx:extent(radius[1],height,cy);
          kind="ellipse";props={...props,x:cx-rx,y:cy-ry,width:rx*2,height:ry*2};
        } else {
          props.viewBox=[0,0,Math.max(width,0.001),Math.max(height,0.001)];
          if(type==="path") {
            const parts=splitCSS(content),data=parts.pop();
            if(!/^(["']).*\1$/.test(data))throw new Error("clip path data");
            props.d=data.slice(1,-1);props.fillRule=parts[0]||"nonzero";
          } else {
            const points=splitCSS(content);props.fillRule=["evenodd","nonzero"].includes(points[0])?points.shift():"nonzero";
            props.d=points.map((point,i)=>{const pair=point.split(" ");if(pair.length!==2)throw new Error("clip polygon point");return (i?"L ":"M ")+cssLength(pair[0],width)+" "+cssLength(pair[1],height);}).join(" ")+" Z";
          }
        }
        const child=id+"-css-clip";layer(child,id,kind,name+" clip",props,time);seen.add(child);
        if(kind==="path") {
          const union=svgPathBounds.get(child)||{left:0,top:0,right:0.001,bottom:0.001};
          union.right=Math.max(union.right,width);union.bottom=Math.max(union.bottom,height);svgPathBounds.set(child,union);
        }
      } catch(error){issue(name,String(error.message));}
    };
    const svgPaint = (style,name,element) => {
      const paint=value=>{
        if(value==="none")return {color:"#000000",opacity:0};
        if(value.startsWith("url("))return {color:"#000000",opacity:0};
        return rgba(value);
      };
      const fill=paint(style.fill),stroke=paint(style.stroke);
      for(const [property,empty] of [["maskImage","none"],["vectorEffect","none"],["markerStart","none"],["markerMid","none"],["markerEnd","none"],["paintOrder","normal"]]) if(style[property] && style[property]!==empty)issue(name,property+": "+style[property]);
      if(!["miter","round","bevel"].includes(style.strokeLinejoin))issue(name,"SVG stroke join: "+style.strokeLinejoin);
      const viewport=element.ownerSVGElement.viewBox.baseVal,diagonal=Math.hypot(viewport.width||element.ownerSVGElement.clientWidth,viewport.height||element.ownerSVGElement.clientHeight)/Math.SQRT2;
      return {fill:fill.color,fillOpacity:fill.opacity*Number(style.fillOpacity),stroke:stroke.color,strokeWidth:parseFloat(style.strokeWidth)||0,strokeOpacity:stroke.opacity*Number(style.strokeOpacity),strokeCap:style.strokeLinecap,strokeJoin:style.strokeLinejoin,strokeMiterLimit:Number(style.strokeMiterlimit),strokeDash:style.strokeDasharray==="none"?[]:style.strokeDasharray.split(/[ ,]+/).map(value=>cssLength(value,diagonal)),strokeDashOffset:cssLength(style.strokeDashoffset||"0",diagonal)};
    };
    const svgReference = value => {
      const match=/^url\(["']?([^"')]+)["']?\)$/.exec(value);
      if(!match)throw new Error("SVG reference: "+value);
      const url=new URL(match[1],location.href);
      if(url.origin!==location.origin || url.pathname!==location.pathname)throw new Error("external SVG reference");
      const target=document.getElementById(decodeURIComponent(url.hash.slice(1)));
      if(!target)throw new Error("missing SVG reference: "+url.hash);
      return target;
    };
    const emitSVGGradient = (id,name,element,style,box,time,seen,targetBox=box) => {
      for(const paint of ["fill","stroke"]) {
        if(!style[paint].startsWith("url("))continue;
        try {
          const gradient=svgReference(style[paint]),chain=[],visited=new Set();
          let current=gradient;
          while(current) {
            if(visited.has(current))throw new Error("cyclic SVG gradient reference");
            if(!(current instanceof SVGLinearGradientElement) && !(current instanceof SVGRadialGradientElement))throw new Error("SVG paint server: "+current.tagName);
            chain.push(current);visited.add(current);
            current=current.href.baseVal?svgReference('url("'+current.href.baseVal+'")'):null;
          }
          const attribute=(property,fallback)=>chain.find(item=>item.hasAttribute(property))?.getAttribute(property)??fallback;
          if(attribute("spreadMethod","pad")!=="pad")throw new Error("repeating or reflected SVG gradient");
          if(getComputedStyle(gradient).colorInterpolation!=="srgb")throw new Error("SVG gradient color interpolation");
          const objectBox=attribute("gradientUnits","objectBoundingBox")==="objectBoundingBox",viewport=element.ownerSVGElement.viewBox.baseVal;
          const gradientTransform=chain.find(item=>item.hasAttribute("gradientTransform"))?.gradientTransform.baseVal.consolidate()?.matrix;
          let matrix=objectBox?new DOMMatrix().translate(box.x,box.y).scale(box.width,box.height):new DOMMatrix();
          if(gradientTransform)matrix=matrix.multiply(gradientTransform);
          const length=(property,fallback,axis)=>cssLength(attribute(property,fallback),objectBox?1:axis==="x"?viewport.width||element.ownerSVGElement.clientWidth:viewport.height||element.ownerSVGElement.clientHeight);
          const point=(x,y)=>new DOMPoint(x,y).matrixTransform(matrix);
          let kind="linearGradientPaint",props={opacity:Number(style[paint+"Opacity"])};
          if(gradient instanceof SVGLinearGradientElement) {
            const start=point(length("x1","0%","x"),length("y1","0%","y")),end=point(length("x2","100%","x"),length("y2","0%","y"));
            props={...props,x1:number((start.x-targetBox.x)/targetBox.width),y1:number((start.y-targetBox.y)/targetBox.height),x2:number((end.x-targetBox.x)/targetBox.width),y2:number((end.y-targetBox.y)/targetBox.height)};
          } else {
            kind="radialGradientPaint";
            const cx=length("cx","50%","x"),cy=length("cy","50%","y"),radiusValue=attribute("r","50%"),radius=cssLength(radiusValue,objectBox?1:Math.hypot(viewport.width,viewport.height)/Math.SQRT2),center=point(cx,cy),focal=point(length("fx",attribute("cx","50%"),"x"),length("fy",attribute("cy","50%"),"y"));
            if(Number(attribute("fr","0"))!==0)throw new Error("SVG radial gradient inner radius");
            if(Math.abs(matrix.b)>1e-8 || Math.abs(matrix.c)>1e-8)throw new Error("rotated or skewed SVG radial gradient");
            props={...props,centerX:number((center.x-targetBox.x)/targetBox.width),centerY:number((center.y-targetBox.y)/targetBox.height),radiusX:number(Math.abs(radius*matrix.a)/targetBox.width),radiusY:number(Math.abs(radius*matrix.d)/targetBox.height),focalX:number((focal.x-targetBox.x)/targetBox.width),focalY:number((focal.y-targetBox.y)/targetBox.height)};
          }
          let parent=id;
          if(paint==="stroke") {
            parent=id+"-gradient-stroke";
            const stroke={color:"#000000",opacity:1,width:parseFloat(style.strokeWidth)||0,cap:style.strokeLinecap,join:style.strokeLinejoin,miterLimit:Number(style.strokeMiterlimit)};
            if(style.strokeDasharray!=="none"){stroke.dash=style.strokeDasharray.split(/[ ,]+/).map(value=>cssLength(value,Math.hypot(viewport.width,viewport.height)/Math.SQRT2));stroke.dashOffset=parseFloat(style.strokeDashoffset)||0;}
            layer(parent,id,"stroke",name+" stroke",stroke,time);seen.add(parent);
          }
          const child=id+"-"+paint+"-gradient";
          layer(child,parent,kind,name+" gradient",props,time);seen.add(child);
          if(!svgGradientFrames.has(child))svgGradientFrames.set(child,{owner:id,frames:[]});
          svgGradientFrames.get(child).frames.push({time:number(time),box:{x:targetBox.x,y:targetBox.y,width:targetBox.width,height:targetBox.height},props:{...props}});
          const stops=chain.find(item=>[...item.children].some(child=>child instanceof SVGStopElement));
          if(!stops)throw new Error("SVG gradient has no stops");
          for(const [index,stop] of [...stops.children].filter(child=>child instanceof SVGStopElement).entries()) {
            const stopStyle=getComputedStyle(stop),color=rgba(stopStyle.stopColor),stopId=child+"-stop-"+index;
            layer(stopId,child,"colorStop","Color stop",{offset:Math.max(0,Math.min(1,stop.offset.baseVal)),color:color.color,opacity:color.opacity*Number(stopStyle.stopOpacity)},time);seen.add(stopId);
          }
        } catch(error){issue(name,String(error.message));}
      }
    };
    const emitSVGClip = (id,name,element,clip,box,origin,time,seen) => {
      if(!clip || clip==="none")return;
      if(!clip.startsWith("url(")){emitClip(id,name,clip,box.width,box.height,time,seen);return;}
      try {
        const path=svgReference(clip);
        if(!(path instanceof SVGClipPathElement))throw new Error("SVG clipping source is not a clipPath");
        const children=[...path.children].filter(child=>child instanceof SVGGraphicsElement);
        if(children.length!==1)throw new Error("SVG clipPath requires one geometry");
        const child=children[0],tag=child.tagName.toLowerCase();
        if(!["path","rect","circle","ellipse","polygon","polyline"].includes(tag))throw new Error("SVG clip geometry: "+tag);
        const style=getComputedStyle(child);
        if(style.clipPath!=="none" || style.maskImage!=="none")throw new Error("nested SVG clip geometry");
        let matrix=new DOMMatrix().translate(-origin.x,-origin.y);
        if(path.clipPathUnits.baseVal===2)matrix=matrix.translate(box.x,box.y).scale(box.width,box.height);
        const pathTransform=path.transform.baseVal.consolidate()?.matrix;
        if(pathTransform)matrix=matrix.multiply(pathTransform);
        const childTransform=new DOMMatrix(style.transform==="none"?undefined:style.transform),pivot=style.transformOrigin.split(" ").map(parseFloat);
        matrix=matrix.translate(pivot[0],pivot[1]).multiply(childTransform).translate(-pivot[0],-pivot[1]);
        const bounds=child.getBBox(),width=Math.max(bounds.width,0.001),height=Math.max(bounds.height,0.001);
        let kind="path",props={...affine(matrix.translate(bounds.x,bounds.y),name),width:number(width),height:number(height),mask:true,opacity:1};
        if(tag==="rect") {
          kind="rect";
          const rx=child.rx.baseVal.value,ry=child.ry.baseVal.value;
          if(rx!==ry)throw new Error("elliptical SVG clip corners");
          props.cornerRadius=rx;
        } else if(tag==="circle" || tag==="ellipse")kind="ellipse";
        else {
          props.viewBox=[bounds.x,bounds.y,width,height];props.fillRule=style.clipRule;
          props.d=tag==="path"?(style.d?.startsWith('path("')?JSON.parse(style.d.slice(5,-1)):child.getAttribute("d")):[...child.points].map((point,i)=>(i?"L ":"M ")+point.x+" "+point.y).join(" ")+(tag==="polygon"?" Z":"");
        }
        const maskId=id+"-svg-clip";layer(maskId,id,kind,name+" clip",props,time);seen.add(maskId);
        if(!svgClipFrames.has(maskId))svgClipFrames.set(maskId,{owner:id,frames:[]});
        svgClipFrames.get(maskId).frames.push({time:number(time),box:{x:box.x,y:box.y},props:{...props}});
        if(kind==="path") {
          const union=svgPathBounds.get(maskId)||{left:bounds.x,top:bounds.y,right:bounds.x+width,bottom:bounds.y+height};
          union.left=Math.min(union.left,bounds.x);union.top=Math.min(union.top,bounds.y);union.right=Math.max(union.right,bounds.x+width);union.bottom=Math.max(union.bottom,bounds.y+height);svgPathBounds.set(maskId,union);
        }
      } catch(error){issue(name,String(error.message));}
    };
    const textCanvas=document.createElement("canvas").getContext("2d");
    const frames = Math.ceil(duration*frameRate);
    for (let frame=0;frame<=frames;frame++) {
      const time = Math.min(frame/frameRate,duration);
      for (const [id,timeline] of timelines) {
        const element = [...document.querySelectorAll("[data-composition-id]")].find(item=>item.dataset.compositionId===id);
        let start=0;
        for (let ancestor=element;ancestor && ancestor!==root;ancestor=ancestor.parentElement) start += Number(ancestor.dataset.start || 0);
        if (typeof timeline.totalTime !== "function") throw new Error("Timeline " + id + " does not support totalTime");
        timeline.pause().totalTime(Math.max(0,time-start),false);
      }
      for (const animation of root.getAnimations({subtree:true})) {
        if (!webAnimations.has(animation)) {
          if (!(animation.timeline instanceof DocumentTimeline)) { issue("Composition","non-document animation timeline"); continue; }
          let start=0;
          for(let element=animation.effect?.target;element && element!==root;element=element.parentElement) start+=Number(element.dataset.start||0);
          webAnimations.set(animation,{start,rate:animation.playbackRate});
          animation.pause();
        }
      }
      for(const [animation,{start,rate}] of webAnimations) animation.currentTime=(time-start)*1000*rate;
      const elements = [root,...root.querySelectorAll("*")].filter(element=>!element.closest("script,style,link,meta,defs,title,desc,metadata"));
      const styles = new Map(), layouts = new Map(), originals = new Map();
      for (const element of elements) {
        const computed = getComputedStyle(element);
        const style = {};
        for (const prop of ["transform","transformOrigin","display","visibility","opacity","backgroundColor","backgroundImage","backgroundSize","backgroundOrigin","backgroundClip","backgroundBlendMode","paddingTop","paddingRight","paddingBottom","paddingLeft","filter","backdropFilter","boxShadow","textShadow","clipPath","maskImage","mixBlendMode","perspective","perspectiveOrigin","transformStyle","backfaceVisibility","position","overflowX","overflowY","fontFamily","fontSize","fontWeight","fontStyle","lineHeight","letterSpacing","textAlign","whiteSpace","textTransform","textDecorationLine","color","direction","objectFit","objectPosition","borderTopWidth","borderRightWidth","borderBottomWidth","borderLeftWidth","borderTopColor","borderRightColor","borderBottomColor","borderLeftColor","borderTopStyle","borderRightStyle","borderBottomStyle","borderLeftStyle","borderTopLeftRadius","borderTopRightRadius","borderBottomLeftRadius","borderBottomRightRadius","translate","rotate","scale","zIndex","fill","fillOpacity","fillRule","stroke","strokeWidth","strokeOpacity","strokeLinecap","strokeLinejoin","strokeMiterlimit","strokeDasharray","strokeDashoffset","vectorEffect","markerStart","markerMid","markerEnd","paintOrder","dominantBaseline","alignmentBaseline","writingMode","rx","ry","d"]) style[prop] = computed[prop];
        styles.set(element,style);
        originals.set(element,element.getAttribute("style"));
        element.style.setProperty("transform","matrix(1,0,0,1,0,0)","important");
        for (const property of ["translate","rotate","scale"]) element.style.setProperty(property,"none","important");
      }
      for (const element of elements) {
        const bounds = element.getBoundingClientRect();
        const text = [];
        for (const node of element.childNodes) {
          if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
          const range = document.createRange(),lines=[];
          let offset=0;
          for(const character of node.textContent) {
            range.setStart(node,offset);offset+=character.length;range.setEnd(node,offset);
            const rect=range.getBoundingClientRect();
            if(!rect.width || !rect.height)continue;
            let line=lines.at(-1);
            if(!line || Math.abs(line.bounds.top-rect.top)>0.5) {line={text:"",bounds:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height}};lines.push(line);}
            line.text+=character;
            line.bounds.left=Math.min(line.bounds.left,rect.left);line.bounds.right=Math.max(line.bounds.right,rect.right);
            line.bounds.bottom=Math.max(line.bounds.bottom,rect.bottom);line.bounds.width=line.bounds.right-line.bounds.left;line.bounds.height=line.bounds.bottom-line.bounds.top;
          }
          text.push({node,lines});
        }
        layouts.set(element,{bounds,text});
      }
      for (const element of elements) {
        const original = originals.get(element);
        if (original===null) element.removeAttribute("style"); else element.setAttribute("style",original);
      }
      const svgTextRuns=new Map(),svgTextStarts=new Map();
      for(const textRoot of elements.filter(element=>element instanceof SVGTextElement)) {
        if(!textRoot.getNumberOfChars())continue;
        const walker=document.createTreeWalker(textRoot,NodeFilter.SHOW_TEXT),runs=[];
        let previous="",node;
        while((node=walker.nextNode())) {
          if(!styles.has(node.parentElement))continue;
          const preserve=/^(pre|break-spaces)/.test(styles.get(node.parentElement).whiteSpace);
          let text=preserve?node.textContent:node.textContent.replace(/[ \t\r\n\f]+/g," ");
          if(!preserve && (!previous || previous.endsWith(" ")))text=text.replace(/^ /,"");
          runs.push({node,text,preserve,offset:0});
          if(text)previous=text;
        }
        const last=runs.findLast(run=>run.text);
        if(last && !last.preserve)last.text=last.text.replace(/ $/,"");
        let offset=0;
        for(const run of runs){run.offset=offset;offset+=run.text.length;svgTextRuns.set(run.node,run);}
        if(offset!==textRoot.getNumberOfChars())issue(textRoot.id||"SVG text","fragmented SVG text positioning");
      }
      const seen = new Set();
      const contentParent = element => idFor(element)+(element instanceof SVGSVGElement?"-viewport":styles.get(element)?.perspective!=="none"?"-perspective":"");
      const pageStyle=getComputedStyle(document.body),htmlStyle=getComputedStyle(document.documentElement);
      const background=rgba(pageStyle.backgroundColor), htmlBackground=rgba(htmlStyle.backgroundColor);
      const pageFill=background.opacity ? background : htmlBackground;
      if (pageStyle.backgroundImage!=="none" || htmlStyle.backgroundImage!=="none") issue("Page","background image or gradient");
      layer("page-background",undefined,"rect","Page background",{x:0,y:0,width:Number(root.dataset.width||root.clientWidth),height:Number(root.dataset.height||root.clientHeight),opacity:1,fill:pageFill.color,fillOpacity:pageFill.opacity},time);seen.add("page-background");
      for (let ancestor=root.parentElement;ancestor;ancestor=ancestor.parentElement) {
        const ancestorStyle=getComputedStyle(ancestor);
        for (const property of ["transform","perspective","filter","backdropFilter"]) if (ancestorStyle[property]!=="none") issue("Page",property+" above composition root");
        if (Number(ancestorStyle.opacity)!==1) issue("Page","opacity above composition root");
      }
      const renderNodes=[root],walker=document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);
      let renderNode;
      while((renderNode=walker.nextNode()))if(styles.has(renderNode) || (renderNode.nodeType===Node.TEXT_NODE && (renderNode.parentElement instanceof SVGTextElement || renderNode.parentElement instanceof SVGTSpanElement) && styles.has(renderNode.parentElement)))renderNodes.push(renderNode);
      for (const element of renderNodes) {
        if(element.nodeType===Node.TEXT_NODE) {
          const run=svgTextRuns.get(element),parentElement=element.parentElement;
          if(!run?.text || !parentElement.getNumberOfChars())continue;
          const style=styles.get(parentElement),text=run.text,offset=run.offset-(svgTextStarts.get(parentElement)||0),name=parentElement.id||"SVG text";
          if(offset+text.length>parentElement.getNumberOfChars()){issue(name,"fragmented SVG text positioning");continue;}
          const family=style.fontFamily.split(",")[0].replace(/^["']|["']$/g,"");
          if(webFonts.has(family.toLowerCase()))issue(name,"web font requires a matching native font: "+family);
          textCanvas.font=style.fontStyle+" "+style.fontWeight+" "+style.fontSize+" "+style.fontFamily;
          textCanvas.letterSpacing=style.letterSpacing==="normal"?"0px":style.letterSpacing;
          const position=parentElement.getStartPositionOfChar(offset),metrics=textCanvas.measureText(text),textId=idFor(element);
          layer(textId,idFor(parentElement),"text",text.slice(0,60),{x:number(position.x),y:number(position.y-metrics.fontBoundingBoxAscent),width:number(metrics.width+1),height:number(metrics.fontBoundingBoxAscent+metrics.fontBoundingBoxDescent),opacity:1,text,fontFamily:family,fontSize:parseFloat(style.fontSize),fontWeight:Number(style.fontWeight)||400,fontStyle:style.fontStyle,letterSpacing:parseFloat(style.letterSpacing)||0,textAlign:"left",textBaseline:"alphabetic",...svgPaint(style,name,parentElement)},time);seen.add(textId);
          const textRoot=parentElement.closest("text");
          if(textRoot!==parentElement && (style.fill.startsWith("url(") || style.stroke.startsWith("url("))) {
            const relative=parentElement.getCTM().inverse().multiply(textRoot.getCTM());
            if(Math.max(Math.abs(relative.a-1),Math.abs(relative.d-1),Math.abs(relative.b),Math.abs(relative.c),Math.abs(relative.e),Math.abs(relative.f))>1e-8)issue(name,"transformed SVG text run gradient");
          }
          emitSVGGradient(textId,name,parentElement,style,textRoot.getBBox(),time,seen,{x:position.x,y:position.y-metrics.fontBoundingBoxAscent,width:metrics.width+1,height:metrics.fontBoundingBoxAscent+metrics.fontBoundingBoxDescent});
          continue;
        }
        const id = idFor(element), parent = element===root ? undefined : contentParent(element.parentElement);
        const style=styles.get(element), layout=layouts.get(element), bounds=layout.bounds;
        const name=element.getAttribute("data-layer-name") || element.getAttribute("aria-label") || element.id || element.tagName.toLowerCase();
        if(style.visibility==="visible")for(let ancestor=element.parentElement;ancestor && styles.has(ancestor);ancestor=ancestor.parentElement) {
          if(styles.get(ancestor).visibility==="hidden"){issue(name,"visibility override below hidden ancestor");break;}
        }
        if (element instanceof SVGGraphicsElement && !(element instanceof SVGSVGElement)) {
          const parentMatrix=element.parentElement.getCTM?.(),matrix=element.getCTM();
          if(!parentMatrix || !matrix || !layers.has(parent)){issue(name,"unsupported SVG parent");continue;}
          const cssMatrix=new DOMMatrix(style.transform==="none"?undefined:style.transform);
          if(!cssMatrix.is2D)issue(name,"3D SVG transform");
          let local;
          if(Math.abs(parentMatrix.a*parentMatrix.d-parentMatrix.b*parentMatrix.c)>1e-9)local=parentMatrix.inverse().multiply(matrix);
          else {
            const origin=style.transformOrigin.split(" ").map(parseFloat),box=element.getBBox();
            const transformBox=getComputedStyle(element).transformBox;
            if(transformBox==="fill-box"){origin[0]+=box.x;origin[1]+=box.y;}
            if(transformBox==="stroke-box")issue(name,"singular SVG stroke-box transform");
            local=new DOMMatrix().translate(origin[0],origin[1]).multiply(cssMatrix).translate(-origin[0],-origin[1]);
          }
          const visible=style.display!=="none" && style.visibility!=="hidden";
          const base={...affine(local,name),opacity:visible?Number(style.opacity):0};
          const tag=element.tagName.toLowerCase(),paint=svgPaint(style,name,element);
          if(style.mixBlendMode!=="normal")issue(name,"SVG blend mode: "+style.mixBlendMode);
          if(tag==="g" || tag==="a" || tag==="text" || tag==="tspan") {
            layer(id,parent,"group",name,base,time);seen.add(id);
            emitFilters(id,name,style.filter,time,seen);
            emitSVGClip(id,name,element,style.clipPath,element.getBBox(),{x:0,y:0},time,seen);
            if(tag==="text" || tag==="tspan") {
              for(const attribute of ["x","y","dx","dy","rotate"]) if(element[attribute]?.baseVal?.numberOfItems>1 || (attribute==="rotate" && element[attribute]?.baseVal?.numberOfItems))issue(name,"per-character SVG positioning");
              if(element.hasAttribute("textLength"))issue(name,"SVG textLength adjustment");
              if(!["auto","alphabetic"].includes(style.dominantBaseline) || !["auto","baseline"].includes(style.alignmentBaseline))issue(name,"SVG text baseline adjustment");
              if(style.writingMode!=="horizontal-tb")issue(name,"vertical SVG text");
              const descendantRuns=[...svgTextRuns.values()].filter(run=>element.contains(run.node));
              svgTextStarts.set(element,descendantRuns[0]?.offset||0);
              if(descendantRuns.reduce((count,run)=>count+run.text.length,0)!==element.getNumberOfChars())issue(name,"fragmented SVG text positioning");
            }
            continue;
          }
          if(!["path","rect","circle","ellipse","line","polyline","polygon"].includes(tag)){issue(name,"unsupported SVG "+tag+" element");continue;}
          const box=element.getBBox(),width=Math.max(box.width,0.001),height=Math.max(box.height,0.001);
          const props={...affine(local.translate(box.x,box.y),name),width:number(width),height:number(height),opacity:base.opacity,...paint};
          let kind="path",d="";
          if(tag==="circle" || tag==="ellipse")kind="ellipse";
          else if(tag==="rect") {
            const viewport=element.ownerSVGElement,viewBox=viewport.viewBox.baseVal;
            const radius=(value,size)=>value==="auto"?undefined:parseFloat(value)*(value.includes("%")?size/100:1);
            let rx=radius(style.rx,viewBox.width||viewport.width.baseVal.value),ry=radius(style.ry,viewBox.height||viewport.height.baseVal.value);
            rx=rx??ry??0;ry=ry??rx;rx=Math.min(rx,width/2);ry=Math.min(ry,height/2);
            if(rx===0 || ry===0){kind="rect";props.cornerRadius=0;}
            else if(Math.abs(rx-ry)<0.001){kind="rect";props.cornerRadius=number(rx);}
            else {const x=box.x,y=box.y,r=Math.min(rx,width/2),s=Math.min(ry,height/2);d="M "+(x+r)+" "+y+" H "+(x+width-r)+" A "+r+" "+s+" 0 0 1 "+(x+width)+" "+(y+s)+" V "+(y+height-s)+" A "+r+" "+s+" 0 0 1 "+(x+width-r)+" "+(y+height)+" H "+(x+r)+" A "+r+" "+s+" 0 0 1 "+x+" "+(y+height-s)+" V "+(y+s)+" A "+r+" "+s+" 0 0 1 "+(x+r)+" "+y+" Z";}
          } else if(tag==="line")d="M "+element.x1.baseVal.value+" "+element.y1.baseVal.value+" L "+element.x2.baseVal.value+" "+element.y2.baseVal.value;
          else if(tag==="polyline" || tag==="polygon") {
            d=Array.from({length:element.points.numberOfItems},(_,i)=>{const point=element.points.getItem(i);return (i?"L ":"M ")+point.x+" "+point.y;}).join(" ");if(tag==="polygon" && d)d+=" Z";
          } else d=/^path\(["'](.*)["']\)$/.exec(style.d)?.[1] ?? element.getAttribute("d") ?? "";
          if(kind==="path") {
            props.d=d;props.fillRule=style.fillRule;props.viewBox=[number(box.x),number(box.y),number(width),number(height)];
            const union=svgPathBounds.get(id) || {left:box.x,top:box.y,right:box.x+width,bottom:box.y+height};
            union.left=Math.min(union.left,box.x);union.top=Math.min(union.top,box.y);union.right=Math.max(union.right,box.x+width);union.bottom=Math.max(union.bottom,box.y+height);svgPathBounds.set(id,union);
          }
          layer(id,parent,kind,name,props,time);seen.add(id);
          emitFilters(id,name,style.filter,time,seen);
          emitSVGGradient(id,name,element,style,{x:box.x,y:box.y,width,height},time,seen);
          emitSVGClip(id,name,element,style.clipPath,box,box,time,seen);
          continue;
        }
        if (!(element instanceof HTMLElement) && !(element instanceof SVGSVGElement)) { issue(name,"unsupported SVG "+element.tagName.toLowerCase()+" element"); continue; }
        if (element.closest("canvas,iframe,video,audio,foreignObject")) { issue(name,element.tagName.toLowerCase()+" content"); continue; }
        if(element instanceof SVGSVGElement && element.ownerSVGElement){issue(name,"nested SVG viewport");continue;}
        if (element.hasAttribute("data-composition-src") || element.hasAttribute("data-composition-file")) issue(name,"external nested composition");
        for (const [property,empty] of [["backdropFilter","none"],["boxShadow","none"],["textShadow","none"],["maskImage","none"],["mixBlendMode","normal"],["textDecorationLine","none"]]) {
          if (style[property] && style[property]!==empty) issue(name,property+": "+style[property]);
        }
        for (const pseudo of ["::before","::after"]) {
          const content=getComputedStyle(element,pseudo).content;
          if (content && content!=="none" && content!=="normal") issue(name,pseudo+" content");
        }
        if (style.position==="fixed" || style.position==="sticky") issue(name,style.position+" positioning");
        if (style.zIndex!=="auto" && Number(style.zIndex)!==0) issue(name,"CSS stacking order (z-index)");
        let transform=new DOMMatrix();
        if(style.translate!=="none") {
          const values=style.translate.split(" ");
          const length=(value,size)=>parseFloat(value||"0")*(value?.endsWith("%")?size/100:1);
          transform=transform.translate(length(values[0],bounds.width),length(values[1],bounds.height),length(values[2],0));
        }
        if(style.rotate!=="none") {
          const values=style.rotate.split(" ");
          const angle=cssAngle(values.at(-1));
          if(values.length===4)transform=transform.rotateAxisAngle(Number(values[0]),Number(values[1]),Number(values[2]),angle);
          else transform=transform.rotateAxisAngle(values[0]==="x"?1:0,values[0]==="y"?1:0,values.length===1 || values[0]==="z"?1:0,angle);
        }
        if(style.scale!=="none") {
          const values=style.scale.split(" ").map(Number);
          transform=transform.scale(values[0],values[1]??values[0],values[2]??1);
        }
        transform=transform.multiply(new DOMMatrix(style.transform==="none"?undefined:style.transform));
        const origin=style.transformOrigin.split(" ").map(parseFloat);
        const p=element===root ? bounds : layouts.get(element.parentElement)?.bounds;
        if (!p) { issue(name,"unsupported parent element"); continue; }
        const local=new DOMMatrix().translate((element===root?0:bounds.left-p.left)+origin[0],(element===root?0:bounds.top-p.top)+origin[1],origin[2]||0).multiply(transform).translate(-origin[0],-origin[1],-(origin[2]||0));
        let perspectiveParent=element.parentElement;
        while(perspectiveParent && styles.has(perspectiveParent) && styles.get(perspectiveParent).perspective==="none")perspectiveParent=perspectiveParent.parentElement;
        if(!styles.has(perspectiveParent))perspectiveParent=null;
        let position;
        try {
          if(!local.is2D) {
            if(!perspectiveParent)throw new Error("3D CSS transform without a perspective container");
            if(element.parentElement!==perspectiveParent)throw new Error("nested 3D CSS transform across a flattened parent");
            if(style.backfaceVisibility!=="visible")throw new Error("3D CSS backface visibility");
          }
          position=perspectiveParent?affine3D(local):affine(local,name);
        } catch(error) {
          issue(name,error.message+"; provide window.__DIFFUSION_EDITABLE__ layers for this 3D composition");
          position=affine(local,name);
        }
        let visible=style.display!=="none" && style.visibility!=="hidden";
        let clipStart=0;
        for (let ancestor=element;ancestor;ancestor=ancestor.parentElement) { clipStart+=Number(ancestor.dataset.start||0); if(ancestor===root) break; }
        const clipDuration=Number(element.dataset.duration||duration);
        if (element.hasAttribute("data-start")) visible = visible && time>=clipStart && time<clipStart+clipDuration;
        const fill=rgba(style.backgroundColor);
        const props={...position,width:number(bounds.width),height:number(bounds.height),opacity:visible?number(Number(style.opacity)):0,fill:fill.color,fillOpacity:fill.opacity};
        for (const [css,native] of [["borderTopLeftRadius","cornerRadiusTopLeft"],["borderTopRightRadius","cornerRadiusTopRight"],["borderBottomLeftRadius","cornerRadiusBottomLeft"],["borderBottomRightRadius","cornerRadiusBottomRight"]]) {
          if (style[css].includes(" ")) issue(name,"elliptical border radius");
          props[native]=number(parseFloat(style[css])*(style[css].includes("%")?Math.min(bounds.width,bounds.height)/100:1));
        }
        layer(id,parent,"rect",name,props,time);seen.add(id);
        emitBackground(id,name,style.backgroundImage,props.width,props.height,time,seen,style);
        emitFilters(id,name,style.filter,time,seen);
        emitClip(id,name,style.clipPath,props.width,props.height,time,seen);
        if(element instanceof SVGSVGElement) {
          const viewportId=id+"-viewport";
          layer(viewportId,id,"group",name+" viewBox",{...affine(element.getCTM(),name),opacity:1},time);seen.add(viewportId);
        }
        if (style.overflowX==="hidden" || style.overflowY==="hidden" || style.overflowX==="clip" || style.overflowY==="clip") {
          if (style.overflowX!==style.overflowY) issue(name,"single-axis overflow clipping");
          const maskId=id+"-mask";
          layer(maskId,id,"rect",name+" clip",{x:0,y:0,width:props.width,height:props.height,mask:true,opacity:1,cornerRadiusTopLeft:props.cornerRadiusTopLeft,cornerRadiusTopRight:props.cornerRadiusTopRight,cornerRadiusBottomLeft:props.cornerRadiusBottomLeft,cornerRadiusBottomRight:props.cornerRadiusBottomRight},time);seen.add(maskId);
        }
        if (element instanceof HTMLImageElement) {
          if (!element.complete || !element.naturalWidth) issue(name,"unready image");
          let width=bounds.width,height=bounds.height;
          if (style.objectFit==="contain" || style.objectFit==="cover") {
            const ratio=style.objectFit==="contain"?Math.min(width/element.naturalWidth,height/element.naturalHeight):Math.max(width/element.naturalWidth,height/element.naturalHeight);
            width=element.naturalWidth*ratio;height=element.naturalHeight*ratio;
          } else if (style.objectFit!=="fill") issue(name,"object-fit: "+style.objectFit);
          if (style.objectPosition!=="50% 50%") issue(name,"object-position: "+style.objectPosition);
          const imageId=id+"-image";
          layer(imageId,id,"image",name+" image",{x:number((bounds.width-width)/2),y:number((bounds.height-height)/2),width:number(width),height:number(height),src:element.currentSrc,opacity:1},time);seen.add(imageId);
          if (style.objectFit==="cover") {
            const maskId=id+"-image-clip";
            layer(maskId,id,"rect",name+" image clip",{x:0,y:0,width:props.width,height:props.height,mask:true,opacity:1},time);seen.add(maskId);
          }
        }
        const border=Number.parseFloat(style.borderTopWidth);
        const borderWidths=["borderTopWidth","borderRightWidth","borderBottomWidth","borderLeftWidth"].map(key=>parseFloat(style[key]));
        if (borderWidths.some(value=>value>0)) {
          if (borderWidths.some(value=>value!==border) || ["borderRightColor","borderBottomColor","borderLeftColor"].some(key=>style[key]!==style.borderTopColor) || ["borderTopStyle","borderRightStyle","borderBottomStyle","borderLeftStyle"].some(key=>style[key]!=="solid")) issue(name,"nonuniform or nonsolid border");
          const color=rgba(style.borderTopColor),borderId=id+"-border";
          layer(borderId,id,"rect",name+" border",{x:border/2,y:border/2,width:Math.max(0,props.width-border),height:Math.max(0,props.height-border),opacity:1,stroke:color.color,strokeOpacity:color.opacity,strokeWidth:border,cornerRadiusTopLeft:Math.max(0,props.cornerRadiusTopLeft-border/2),cornerRadiusTopRight:Math.max(0,props.cornerRadiusTopRight-border/2),cornerRadiusBottomLeft:Math.max(0,props.cornerRadiusBottomLeft-border/2),cornerRadiusBottomRight:Math.max(0,props.cornerRadiusBottomRight-border/2)},time);seen.add(borderId);
        }
        if(style.perspective!=="none") {
          if(element instanceof SVGSVGElement || perspectiveParent || style.transformStyle!=="flat" || element!==root && !["hidden","clip"].includes(style.overflowX))issue(name,"nested or unbounded CSS perspective; provide window.__DIFFUSION_EDITABLE__ layers");
          const perspective=Math.max(1,parseFloat(style.perspective)),point=style.perspectiveOrigin.split(" ").map(parseFloat),sceneId=id+"-perspective";
          layer(sceneId,id,"scene3d",name+" perspective",{x:0,y:0,anchorX:0,anchorY:0,width:Math.max(props.width,0.001),height:Math.max(props.height,0.001),perspective,cameraZ:perspective,cameraX:point[0],cameraY:point[1],cameraOffsetX:point[0]-props.width/2,cameraOffsetY:point[1]-props.height/2,depthTest:false,depthSort:"layer",opacity:1},time);seen.add(sceneId);
        }
        for (const {node,lines} of layout.text) for(const [lineIndex,line] of lines.entries()) {
          const textId=idFor(node)+"-line-"+lineIndex,color=rgba(style.color),textBounds=line.bounds;
          let text=line.text;
          if (!style.whiteSpace.startsWith("pre")) text=text.replace(/\s+/g," ");
          if (style.textTransform==="uppercase") text=text.toUpperCase();
          if (style.textTransform==="lowercase") text=text.toLowerCase();
          if (style.textTransform!=="none" && style.textTransform!=="uppercase" && style.textTransform!=="lowercase") issue(name,"text-transform: "+style.textTransform);
          if(style.direction!=="ltr" || style.writingMode!=="horizontal-tb")issue(name,"bidirectional or vertical HTML text");
          const family=style.fontFamily.split(",")[0].replace(/^["']|["']$/g,"");
          if (webFonts.has(family.toLowerCase())) issue(name,"web font requires a matching native font: "+family);
          const textProps={x:number(textBounds.left-bounds.left),y:number(textBounds.top-bounds.top),width:number(textBounds.width+1),height:number(textBounds.height),opacity:1,text,fontFamily:family,fontSize:parseFloat(style.fontSize),fontWeight:Number(style.fontWeight)||400,fontStyle:style.fontStyle,letterSpacing:parseFloat(style.letterSpacing)||0,textAlign:"left",textBaseline:"alphabetic",fill:color.color,fillOpacity:color.opacity};
          layer(textId,contentParent(element),"text",text.slice(0,60),textProps,time);seen.add(textId);
        }
      }
      const observed=new Map(),emitted=new Map();
      for (const id of seen) { const parent=layers.get(id).parent; if(!observed.has(parent))observed.set(parent,[]); observed.get(parent).push(id); }
      for (const [id,item] of layers) if(seen.has(id)) { if(!emitted.has(item.parent))emitted.set(item.parent,[]); emitted.get(item.parent).push(id); }
      for (const [parent,ids] of observed) if(JSON.stringify(ids)!==JSON.stringify(emitted.get(parent))) issue(parent?layers.get(parent).name:"Composition","changing DOM stacking order");
      for (const [id,item] of layers) if (!seen.has(id)) {
        const props={...item.frames.at(-1).props};
        if(seen.has(item.parent) && (props.mask || item.kind==="colorStop"))issue(item.name,props.mask?"changing clipping geometry presence":"changing gradient stop count");
        if(item.kind==="effect")props.value=["brightness","contrast","saturate"].includes(props.type)?1:0;
        else props.opacity=0;
        layer(id,item.parent,item.kind,item.name,props,time);
        for(const records of [svgGradientFrames.get(id),svgClipFrames.get(id)])if(records)records.frames.push({time:number(time),box:records.frames.at(-1).box,props:{...props}});
      }
    }
    for(const [id,{frames}] of svgClipFrames)layers.get(id).frames=frames.map(({time,props})=>({time,props}));
    // One fixed view box spans each animated path, retaining its original SVG commands and holes.
    for(const [id,box] of svgPathBounds)for(const frame of layers.get(id).frames) {
      const props=frame.props,[left,top]=props.viewBox,angle=props.rotation*Math.PI/180,tangent=Math.tan(props.skewX*Math.PI/180),cos=Math.cos(angle),sin=Math.sin(angle);
      const dx=box.left-left,dy=box.top-top;
      props.x=number(props.x+cos*props.scaleX*dx+(cos*tangent-sin)*props.scaleY*dy);
      props.y=number(props.y+sin*props.scaleX*dx+(sin*tangent+cos)*props.scaleY*dy);
      props.width=number(box.right-box.left);props.height=number(box.bottom-box.top);props.viewBox=[number(box.left),number(box.top),props.width,props.height];
    }
    for(const [id,{owner,frames}] of svgGradientFrames) {
      const union=svgPathBounds.get(owner);
      if(!union)continue;
      const width=union.right-union.left,height=union.bottom-union.top;
      layers.get(id).frames=frames.map(({time,box,props})=>{
        for(const key of ["x1","x2","centerX","focalX"])if(props[key]!==undefined)props[key]=number((props[key]*box.width+box.x-union.left)/width);
        for(const key of ["y1","y2","centerY","focalY"])if(props[key]!==undefined)props[key]=number((props[key]*box.height+box.y-union.top)/height);
        if(props.radiusX!==undefined)props.radiusX=number(props.radiusX*box.width/width);
        if(props.radiusY!==undefined)props.radiusY=number(props.radiusY*box.height/height);
        return {time,props};
      });
    }
    for(const [id,{owner,frames}] of svgClipFrames) {
      const union=svgPathBounds.get(owner);
      if(!union)continue;
      for(const [index,frame] of layers.get(id).frames.entries()) {
        frame.props.x=number(frame.props.x+frames[index].box.x-union.left);
        frame.props.y=number(frame.props.y+frames[index].box.y-union.top);
      }
    }
    return {width:Number(root.dataset.width||root.clientWidth),height:Number(root.dataset.height||root.clientHeight),duration,frameRate,layers:[...layers.values()],issues:[...issues.values()]};
  },fps);
  if(capture===undefined)throw new Error("Editable capture hook returned no data");
  if(Array.isArray(capture?.issues))for (const failure of failures) capture.issues.push({layer:"Composition",feature:failure});
  for (const layer of Array.isArray(capture?.layers)?capture.layers:[]) for (const frame of Array.isArray(layer?.frames)?layer.frames:[]) {
    if (typeof frame?.props?.src!=="string" || !frame.props.src.startsWith(origin+"/")) continue;
    frame.props.src=relative(project,resolve(source,"."+decodeURIComponent(new URL(frame.props.src).pathname))).split(sep).join("/");
  }
  await writeFile(output,JSON.stringify(capture));
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}
`;
