import * as THREE from 'three';

/** March a deterministic density field in the volume's own coordinates, stopping at scene depth. */
export function volumeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, depthTest: false, depthWrite: false, side: THREE.BackSide,
    uniforms: {
      tint: { value: new THREE.Color('#ffffff') }, density: { value: .7 }, noiseScale: { value: 3 },
      time: { value: 0 }, flowSpeed: { value: .2 }, scatter: { value: .5 }, opacity: { value: 1 },
      eye: { value: new THREE.Vector3() }, viewport: { value: new THREE.Vector2() },
      depthMap: { value: null }, inverseWorld: { value: new THREE.Matrix4() },
      cameraWorld: { value: new THREE.Matrix4() }, inverseProjection: { value: new THREE.Matrix4() },
      lightColor: { value: new THREE.Color(1, 1, 1) }, lightDirection: { value: new THREE.Vector3(.4, .7, .4).normalize() },
    },
    vertexShader: `varying vec3 localPosition;
      void main() { localPosition = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `precision highp float;
      varying vec3 localPosition;
      uniform vec3 tint, eye, lightColor, lightDirection;
      uniform float density, noiseScale, time, flowSpeed, scatter, opacity;
      uniform vec2 viewport;
      uniform sampler2D depthMap;
      uniform mat4 inverseWorld, cameraWorld, inverseProjection;
      float hash(vec3 p) { p = fract(p * .3183099 + vec3(.1,.2,.3)); p *= 17.; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
      float noise(vec3 p) {
        vec3 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
        return mix(mix(mix(hash(i), hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
          mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
      }
      float field(vec3 p) {
        vec3 q = p * noiseScale + vec3(time*flowSpeed*.15, -time*flowSpeed, time*flowSpeed*.08);
        float n = noise(q)*.57 + noise(q*2.03)*.28 + noise(q*4.11)*.15;
        float edge = 1.-smoothstep(.2,.52,length(p*vec3(1.,.85,1.)));
        return smoothstep(.32,.68,n)*edge*density*10.;
      }
      void main() {
        vec3 dir = normalize(localPosition-eye);
        vec3 safeDir = mix(dir, vec3(.000001), lessThan(abs(dir), vec3(.000001)));
        vec3 a = (-vec3(.5)-eye)/safeDir, b = (vec3(.5)-eye)/safeDir;
        vec3 lo=min(a,b), hi=max(a,b);
        float enter=max(0.,max(lo.x,max(lo.y,lo.z))), leave=min(hi.x,min(hi.y,hi.z));
        vec2 uv=gl_FragCoord.xy/viewport;
        float depth=texture2D(depthMap,uv).x;
        if (depth < .999999) {
          vec4 view=inverseProjection*vec4(uv*2.-1.,depth*2.-1.,1.); view/=view.w;
          vec3 solid=(inverseWorld*cameraWorld*view).xyz;
          leave=min(leave,dot(solid-eye,dir));
        }
        if(leave<=enter) discard;
        float stepSize=(leave-enter)/72., alpha=0.; vec3 color=vec3(0.);
        for(int i=0;i<72;i++) {
          vec3 p=eye+dir*(enter+(float(i)+.5)*stepSize);
          float d=field(p), amount=(1.-exp(-d*stepSize))*opacity;
          float shadow=exp(-field(p+lightDirection*.12)*.2);
          vec3 lighting=mix(vec3(1.),lightColor*(.3+.7*shadow),scatter);
          color+=(1.-alpha)*amount*tint*lighting; alpha+=(1.-alpha)*amount;
          if(alpha>.995) break;
        }
        if(alpha<.001) discard;
        gl_FragColor=vec4(color/max(alpha,.0001),alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
