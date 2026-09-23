import * as THREE from 'three';

/** A depth-aware circle-of-confusion pass. Its buffers exist only for scenes that use aperture. */
export class SceneFocus {
  readonly target = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true });
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.Camera();
  readonly material = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false, transparent: true,
    uniforms: {
      source: { value: this.target.texture }, depthMap: { value: null },
      size: { value: new THREE.Vector2() }, near: { value: .05 }, far: { value: 100000 },
      focus: { value: 1000 }, aperture: { value: 0 },
    },
    vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
    fragmentShader: `precision highp float;
      varying vec2 vUv;
      uniform sampler2D source, depthMap;
      uniform vec2 size;
      uniform float near, far, focus, aperture;
      void main(){
        float depth=texture2D(depthMap,vUv).x;
        float distance=near*far/(far-depth*(far-near));
        float radius=min(100.,aperture*abs(distance-focus)/max(1.,distance));
        vec4 center=texture2D(source,vUv);
        if(radius<.25){gl_FragColor=center;} else {
        vec4 color=vec4(center.rgb*center.a,center.a);
        float weight=1.;
        for(int i=0;i<24;i++){
          float n=float(i)+.5, angle=n*2.39996323;
          vec2 offset=vec2(cos(angle),sin(angle))*sqrt(n/24.)*radius/size;
          vec4 sampleColor=texture2D(source,vUv+offset);
          color+=vec4(sampleColor.rgb*sampleColor.a,sampleColor.a);weight+=1.;
        }
        color/=weight;gl_FragColor=vec4(color.rgb/max(.0001,color.a),color.a);
        }
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  readonly quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);

  constructor() {
    this.target.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.material.uniforms.depthMap!.value = this.target.depthTexture;
    this.scene.add(this.quad);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, width: number, height: number, focus: number, aperture: number): void {
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
    const uniforms = this.material.uniforms;
    uniforms.size!.value.set(width, height); uniforms.near!.value = camera.near; uniforms.far!.value = camera.far;
    uniforms.focus!.value = focus; uniforms.aperture!.value = aperture;
    renderer.setRenderTarget(this.target); renderer.render(scene, camera);
    renderer.setRenderTarget(null); renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.target.dispose(); this.quad.geometry.dispose(); this.material.dispose();
  }
}
