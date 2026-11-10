import {
  DirectionalLight,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  NeutralToneMapping,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Texture,
  VideoTexture,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MEDIAPIPE_VERTICAL_FOV_DEG } from '../tracking/camera-model';

export interface TryOnRendererOptions {
  /** Upper bound for devicePixelRatio (cost grows with its square). */
  maxPixelRatio?: number;
  /** Keep the drawing buffer after compositing (needed only for readPixels-style tests). */
  preserveDrawingBuffer?: boolean;
}

const VIDEO_DISTANCE = 1000; // cm; the camera image lives on a plane at this depth

/**
 * Renders the camera image and the 3D glasses in ONE WebGL canvas:
 *  - the virtual camera reproduces MediaPipe's (63° vertical FOV, frame aspect, unmirrored), so the
 *    face matrix from the tracker can be used directly;
 *  - the video is a plane filling the frustum, so lens transmission/refraction samples the real
 *    image and photo capture is a single canvas read;
 *  - "object-fit: cover" is done with setViewOffset: only the visible crop is rendered, at the
 *    display's resolution (no wasted pixels);
 *  - the video texture is uploaded inside the same video-frame callback that produced the pose,
 *    so image and glasses are always from the same frame.
 *
 * Mirroring (selfie view) is a CSS transform on the canvas; the math stays unmirrored.
 */
export class TryOnRenderer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(MEDIAPIPE_VERTICAL_FOV_DEG, 16 / 9, 1, VIDEO_DISTANCE * 1.5);
  readonly keyLight = new DirectionalLight(0xffffff, 1.1);
  pixelRatio: number;

  private videoTexture: VideoTexture | null = null;
  private readonly videoMesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly pmrem: PMREMGenerator;
  private readonly envTexture: Texture;
  private frameW = 0;
  private frameH = 0;
  private viewW = 0;
  private viewH = 0;
  private lost = false;
  onContextLost: (() => void) | null = null;
  onContextRestored: (() => void) | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    opts: TryOnRendererOptions = {},
  ) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
    });
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, opts.maxPixelRatio ?? 2);
    this.renderer.outputColorSpace = SRGBColorSpace;
    // Khronos PBR Neutral: faithful product colours (no hue shifts) for materials.
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;

    this.videoMesh = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({ toneMapped: false, depthWrite: false, depthTest: false }),
    );
    this.videoMesh.renderOrder = -1000;
    this.videoMesh.frustumCulled = false;
    this.videoMesh.visible = false;
    this.scene.add(this.videoMesh);

    this.pmrem = new PMREMGenerator(this.renderer);
    this.envTexture = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTexture;
    this.scene.environmentIntensity = 1;
    this.keyLight.position.set(-30, 60, 80); // above-front-left, camera space (cm)
    this.scene.add(this.keyLight);

    canvas.addEventListener('webglcontextlost', this.handleLost);
    canvas.addEventListener('webglcontextrestored', this.handleRestored);
  }

  add(o: Object3D): void {
    this.scene.add(o);
  }

  setVideo(video: HTMLVideoElement | null): void {
    if (this.videoTexture?.image === video) return;
    this.videoTexture?.dispose();
    this.videoTexture = null;
    if (video) {
      // VideoTexture (not Texture): three.js special-cases it for upload format and sizing.
      const t = new VideoTexture(video);
      t.colorSpace = SRGBColorSpace;
      t.minFilter = LinearFilter;
      t.magFilter = LinearFilter;
      t.generateMipmaps = false;
      this.videoTexture = t;
    }
    this.videoMesh.material.map = this.videoTexture;
    this.videoMesh.material.needsUpdate = true;
    this.videoMesh.visible = !!video;
  }

  /** Match the virtual camera to the tracked frame size. Cheap; call every frame. */
  setFrameSize(w: number, h: number): void {
    if (w === this.frameW && h === this.frameH) return;
    this.frameW = w;
    this.frameH = h;
    this.camera.aspect = w / h;
    const height = 2 * VIDEO_DISTANCE * Math.tan(((MEDIAPIPE_VERTICAL_FOV_DEG / 2) * Math.PI) / 180);
    this.videoMesh.scale.set(height * this.camera.aspect, height, 1);
    this.videoMesh.position.set(0, 0, -VIDEO_DISTANCE);
    this.viewW = 0; // force view recompute
    this.resize();
  }

  /** Re-fit to the canvas' CSS size (call on resize / orientation change). */
  resize(): void {
    const cssW = Math.max(1, this.canvas.clientWidth);
    const cssH = Math.max(1, this.canvas.clientHeight);
    const pr = this.pixelRatio;
    if (cssW === this.viewW && cssH === this.viewH && this.renderer.getPixelRatio() === pr) return;
    this.viewW = cssW;
    this.viewH = cssH;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(cssW, cssH, false);
    if (this.frameW && this.frameH) {
      // object-fit: cover → scale the full frame to cover the view, render the centred crop.
      const s = Math.max(cssW / this.frameW, cssH / this.frameH);
      const fullW = this.frameW * s, fullH = this.frameH * s;
      this.camera.setViewOffset(fullW, fullH, (fullW - cssW) / 2, (fullH - cssH) / 2, cssW, cssH);
    }
    this.camera.updateProjectionMatrix();
  }

  setPixelRatio(pr: number): void {
    this.pixelRatio = pr;
    this.resize();
  }

  /** Upload the current video frame and draw. Call once per tracked video frame. */
  render(): void {
    if (this.lost) return;
    // Upload the frame that was just tracked (VideoTexture's own frame callback may run later).
    if (this.videoTexture) this.videoTexture.needsUpdate = true;
    this.resize();
    this.renderer.render(this.scene, this.camera);
  }

  get contextLost(): boolean {
    return this.lost;
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.handleLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleRestored);
    this.videoMesh.geometry.dispose();
    this.videoMesh.material.dispose();
    this.videoTexture?.dispose();
    this.envTexture.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
  }

  private readonly handleLost = (e: Event) => {
    e.preventDefault(); // allow restoration
    this.lost = true;
    this.onContextLost?.();
  };

  private readonly handleRestored = () => {
    this.lost = false;
    this.onContextRestored?.();
  };
}
