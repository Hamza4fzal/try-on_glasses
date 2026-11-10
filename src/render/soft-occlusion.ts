import {
  DepthTexture,
  DoubleSide,
  Material,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Scene,
  UnsignedIntType,
  Vector2,
  WebGLRenderTarget,
  type Object3D,
  type PerspectiveCamera,
  type WebGLRenderer,
} from 'three';

/**
 * Soft depth occlusion.
 *
 * The head occluder is rendered depth-only into its own depth texture (same camera, same view
 * crop). Every glasses material is patched to compare its own view depth with the occluder's at
 * the same pixel: fully visible in front of the head, fading to invisible over `softness` cm
 * behind it. So a temple passing behind the head or ear fades out the way it disappears into hair,
 * instead of being cut along a hard polygon edge. The silhouette of the face itself stays sharp
 * (the depth texture jumps to "far" there), as it is in reality.
 *
 * Opaque parts fade through alpha-to-coverage (MSAA samples — no sorting problems); transmissive /
 * transparent parts (lenses) are cut at 50 % or have their alpha scaled.
 *
 * Fallback: with `enabled = false` the patched shaders are a no-op and the caller renders the
 * occluder depth-only in the main pass instead (hard occlusion).
 */
export class SoftOcclusion {
  /** Distance behind the occluder over which glasses fade out (cm). */
  softness = 0.6;
  enabled = true;

  readonly uniforms = {
    vtoOccDepth: { value: null as DepthTexture | null },
    vtoOccNearFar: { value: new Vector2(1, 1000) },
    vtoOccSoft: { value: 0.6 },
    vtoOccOn: { value: 0 },
  };

  private readonly target: WebGLRenderTarget;
  private readonly scene = new Scene();
  private readonly patched = new WeakSet<Material>();
  private readonly size = new Vector2();

  constructor() {
    const depthTexture = new DepthTexture(1, 1, UnsignedIntType);
    this.target = new WebGLRenderTarget(1, 1, { depthBuffer: true, depthTexture, samples: 0 });
    this.uniforms.vtoOccDepth.value = depthTexture;
    this.scene.overrideMaterial = new MeshBasicMaterial({ colorWrite: false, side: DoubleSide });
    this.scene.matrixWorldAutoUpdate = true;
  }

  /**
   * Renders `occluder` into the occlusion depth texture. Call right before the main render, after
   * the renderer has been sized. The occluder is lent to an internal scene and returned to its
   * parent; it is left hidden for the main pass unless `keepVisible` (debug display).
   */
  render(renderer: WebGLRenderer, occluder: Object3D, camera: PerspectiveCamera, keepVisible = false): void {
    const on = this.enabled && occluder.visible;
    this.uniforms.vtoOccOn.value = on ? 1 : 0;
    this.uniforms.vtoOccSoft.value = this.softness;
    if (!on) return;
    renderer.getDrawingBufferSize(this.size);
    if (this.target.width !== this.size.x || this.target.height !== this.size.y) {
      this.target.setSize(this.size.x, this.size.y);
    }
    this.uniforms.vtoOccNearFar.value.set(camera.near, camera.far);

    const parent = occluder.parent;
    this.scene.add(occluder);
    const prevTarget = renderer.getRenderTarget();
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.target);
    renderer.clear(true, true, false);
    renderer.render(this.scene, camera);
    renderer.setRenderTarget(prevTarget);
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    parent?.add(occluder);
    occluder.visible = keepVisible;
  }

  /** Patches a glasses material (idempotent; clones must be patched again). */
  patch(material: Material): void {
    const std = material as MeshStandardMaterial;
    if (!std.isMeshStandardMaterial || this.patched.has(material)) return;
    this.patched.add(material);
    const phys = material as Material & { transmission?: number };
    const blended = material.transparent;
    const transmissive = (phys.transmission ?? 0) > 0;
    // Opaque: fade through MSAA coverage. Transmissive: hard 50 % cut. Blended: alpha.
    const mode = blended ? 2 : transmissive ? 1 : 0;
    if (mode === 0) material.alphaToCoverage = true;
    const u = this.uniforms;
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      prev.call(material, shader, renderer);
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'varying vec4 vVtoOccClip;\nvoid main() {')
        .replace('#include <project_vertex>', '#include <project_vertex>\n\tvVtoOccClip = gl_Position;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          'void main() {',
          'uniform sampler2D vtoOccDepth;\nuniform vec2 vtoOccNearFar;\nuniform float vtoOccSoft;\nuniform float vtoOccOn;\nvarying vec4 vVtoOccClip;\nvoid main() {',
        )
        .replace(
          '#include <dithering_fragment>',
          `#include <dithering_fragment>
	if ( vtoOccOn > 0.5 ) {
		vec2 occUv = vVtoOccClip.xy / vVtoOccClip.w * 0.5 + 0.5;
		float occD = texture2D( vtoOccDepth, occUv ).r;
		if ( occD < 1.0 ) {
			float n = vtoOccNearFar.x, f = vtoOccNearFar.y;
			float occZ = ( n * f ) / ( ( f - n ) * occD - f ); // view-space z of the head (negative)
			float behind = occZ - ( -vViewPosition.z );         // > 0: fragment is behind the head
			float vis = 1.0 - smoothstep( 0.0, vtoOccSoft, behind );
			${mode === 1 ? 'if ( vis < 0.5 ) discard;' : 'if ( vis < 0.004 ) discard;\n\t\t\tgl_FragColor.a *= vis;'}
		}
	}`,
        );
    };
    const prevKey = material.customProgramCacheKey;
    material.customProgramCacheKey = () => `${prevKey.call(material)}|vtoOcc${mode}`;
    material.needsUpdate = true;
  }

  dispose(): void {
    this.target.depthTexture?.dispose();
    this.target.dispose();
    (this.scene.overrideMaterial as Material).dispose();
  }
}
