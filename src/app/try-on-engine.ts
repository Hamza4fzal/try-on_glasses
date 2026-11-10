import { Vector3 } from 'three';
import { CameraController, CameraError } from '../camera/camera-controller';
import type { ProductConfig, ProductVariant } from '../product/catalog';
import { ContactShadows } from '../render/contact-shadows';
import { FaceOccluder } from '../render/face-occluder';
import { GlassesModel, type RenderQuality } from '../render/glasses-model';
import { GlassesRig } from '../render/glasses-rig';
import { LightEstimator } from '../render/light-estimator';
import { SoftOcclusion } from '../render/soft-occlusion';
import { TryOnRenderer } from '../render/try-on-renderer';
import { FaceTracker, type DelegatePreference, type TrackerFrame } from '../tracking/face-tracker';
import type { FacePose } from '../tracking/pose-solver';
import { TrackingLoop, type TrackingListener } from '../tracking/tracking-loop';
import type { TrueSizeEstimator } from '../tracking/true-size-estimator';
import { EngineError } from './engine-errors';
import { FaceGuidance } from './guidance';
import { PerformanceGovernor, qualityLevels, type QualityLevel } from './perf-governor';

export { EngineError, type EngineErrorCode } from './engine-errors';

export type OcclusionMode = 'soft' | 'hard' | 'off';

export interface TryOnEngineOptions {
  /** Base URL that contains `mediapipe/wasm/` and `mediapipe/face_landmarker.task` (ends with /). */
  assetBase: string;
  /** 'auto' picks 'low' on low-memory / low-core devices. */
  quality?: RenderQuality | 'auto';
  delegate?: DelegatePreference;
  /** Only for tests that read pixels outside the render task. */
  preserveDrawingBuffer?: boolean;
  maxPixelRatio?: number;
  /**
   * Camera to use. The UI owns it so it can request access inside the click that asked for it
   * while this engine is still downloading. Default: a new one.
   */
  camera?: CameraController;
  /**
   * Adaptive quality (default true): lowers render resolution / effects when the device can't
   * keep up with the camera, and raises them again when it can. See perf-governor.ts.
   */
  adaptive?: boolean;
}

/** True when this browser can create a WebGL2 context (three.js requires WebGL2). */
export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

export function autoQuality(): RenderQuality {
  const nav = navigator as Navigator & { deviceMemory?: number };
  if ((nav.deviceMemory ?? 8) <= 3 || (navigator.hardwareConcurrency || 8) <= 4) return 'low';
  return 'high';
}

/**
 * The complete in-browser try-on pipeline, independent of any UI:
 *
 *   camera → MediaPipe face tracking → pose / true size → glasses rig (+ temples) →
 *   live face occluder (soft or hard occlusion) → contact shadows → room light → WebGL
 *
 * Privacy: video frames and landmarks stay in this page's memory. Nothing is sent anywhere;
 * stop() ends every camera track. A photo is only produced on an explicit capture() call and
 * returned to the caller as a local Blob.
 */
export class TryOnEngine {
  readonly camera: CameraController;
  readonly tracker = new FaceTracker();
  readonly loop: TrackingLoop;
  readonly view: TryOnRenderer;
  readonly rig = new GlassesRig();
  readonly occluder = new FaceOccluder();
  readonly softOcclusion = new SoftOcclusion();
  readonly shadows: ContactShadows;
  readonly light: LightEstimator;
  readonly guidance = new FaceGuidance();
  readonly quality: RenderQuality;

  model: GlassesModel | null = null;
  product: ProductConfig | null = null;
  variant: ProductVariant | null = null;
  /** Rendered frames per second (≈ tracked fps). */
  renderFps = 0;
  /** Adaptive quality on/off. Manually choosing occlusion or shadows turns it off. */
  adaptive: boolean;
  readonly governor: PerformanceGovernor;

  private occlusion: OcclusionMode;
  private trackerPromise: Promise<void> | null = null;
  private loadToken = 0;
  private lastT = performance.now();
  private fpsCount = 0;
  private fpsT0 = performance.now();
  private captures: { resolve: (c: HTMLCanvasElement) => void; reject: (e: unknown) => void }[] = [];
  private readonly anchor = new Vector3();
  private readonly listeners = new Set<TrackingListener>();
  private disposed = false;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly opts: TryOnEngineOptions,
  ) {
    if (!webglAvailable()) throw new EngineError('webgl-unavailable', 'WebGL 2 is not available in this browser.');
    this.quality = !opts.quality || opts.quality === 'auto' ? autoQuality() : opts.quality;
    this.camera = opts.camera ?? new CameraController();
    this.loop = new TrackingLoop(this.tracker, this.camera.video);
    try {
      this.view = new TryOnRenderer(canvas, { preserveDrawingBuffer: opts.preserveDrawingBuffer, maxPixelRatio: opts.maxPixelRatio });
    } catch (err) {
      throw new EngineError('webgl-unavailable', 'The 3D renderer could not start.', err);
    }
    this.light = new LightEstimator(this.view);
    this.view.add(this.occluder.group);
    this.view.add(this.rig.group);
    this.shadows = new ContactShadows(this.view, this.occluder.faceGeometry, this.occluder.faceSide);
    // Quality ladder: 'high' starts at the top; 'low' (weak device) at the first level without the
    // soft-occlusion and shadow passes. The governor moves along it at runtime.
    const levels = qualityLevels(window.devicePixelRatio || 1, opts.maxPixelRatio ?? 2);
    const start = this.quality === 'high' ? 0 : Math.max(0, levels.findIndex((l) => l.occlusion === 'hard'));
    this.governor = new PerformanceGovernor(levels, start);
    this.adaptive = opts.adaptive ?? true;
    this.occlusion = levels[start].occlusion;
    this.applyLevel(levels[start]);
    this.view.onBeforeRender = () => {
      if (this.occlusion === 'soft') {
        this.softOcclusion.render(this.view.renderer, this.occluder.group, this.view.camera, this.occluder.debugVisible);
      }
    };
    this.loop.addListener(this.onTracked);
  }

  // ------------------------------------------------------------------ loading

  /** Downloads and initialises face tracking (idempotent). Safe to call before camera consent. */
  preloadTracking(): Promise<void> {
    if (!this.trackerPromise) {
      const base = this.opts.assetBase;
      this.trackerPromise = this.tracker
        .init({
          wasmBaseUrl: `${base}mediapipe/wasm`,
          modelUrl: `${base}mediapipe/face_landmarker.task`,
          delegate: this.opts.delegate ?? 'auto',
        })
        .catch((err) => {
          this.trackerPromise = null; // allow retry
          throw new EngineError('tracking-load-failed', 'Face tracking could not be loaded.', err);
        });
    }
    return this.trackerPromise;
  }

  get trackingReady(): boolean {
    return this.tracker.ready;
  }

  /** Loads a product's model (cancels any load in progress) and applies a variant. */
  async loadProduct(product: ProductConfig, variantId?: string): Promise<void> {
    const token = ++this.loadToken;
    const variant = product.variants.find((v) => v.id === variantId) ?? product.variants.find((v) => v.id === product.defaultVariant) ?? product.variants[0] ?? null;
    let m: GlassesModel;
    try {
      m = await GlassesModel.load(product.model, this.quality);
    } catch (err) {
      if (token === this.loadToken) throw new EngineError('model-load-failed', `The 3D model for ${product.name} could not be loaded.`, err);
      return;
    }
    if (token !== this.loadToken || this.disposed) return m.dispose();
    if (variant) await m.setVariant(variant.gltfVariant ?? null, variant.materialOverrides);
    if (token !== this.loadToken || this.disposed) return m.dispose();
    this.prepareModel(m);
    await this.precompile(m);
    if (token !== this.loadToken || this.disposed) return m.dispose();
    this.rig.setModel(m);
    this.rig.setCalibration(product.calibration);
    this.model?.dispose();
    this.model = m;
    this.product = product;
    this.variant = variant;
    if (!this.loop.isRunning) this.renderStill();
  }

  async setVariant(variantId: string): Promise<void> {
    const v = this.product?.variants.find((x) => x.id === variantId);
    if (!v || !this.model) return;
    await this.model.setVariant(v.gltfVariant ?? null, v.materialOverrides);
    this.prepareModel(this.model);
    this.variant = v;
    if (!this.loop.isRunning) this.renderStill();
  }

  /** Applies a variant object directly (fitting lab: variants edited outside the catalogue). */
  async applyVariant(v: ProductVariant): Promise<void> {
    if (!this.model) return;
    await this.model.setVariant(v.gltfVariant ?? null, v.materialOverrides);
    this.prepareModel(this.model);
    this.variant = v;
  }

  /**
   * Compiles the model's shaders (PBR + transmission + occlusion/shadow variants) before it is
   * shown, in parallel where the browser supports KHR_parallel_shader_compile — otherwise the
   * first live frame stalls for hundreds of ms on phones.
   */
  private async precompile(m: GlassesModel): Promise<void> {
    try {
      await this.view.renderer.compileAsync(m.root, this.view.camera, this.view.scene);
    } catch {
      /* not fatal: shaders then compile on first render */
    }
  }

  private prepareModel(m: GlassesModel): void {
    m.forEachMesh((mesh, slot) => {
      // Clear lenses barely shadow; sun lenses would tint it — not worth a coloured shadow pass.
      mesh.castShadow = slot !== 'lens';
      this.softOcclusion.patch(mesh.material as never);
    });
  }

  // ------------------------------------------------------------------ camera / tracking

  /** Requests the camera (no-op if it is already running). MUST be called from a user action. */
  async startCamera(): Promise<void> {
    try {
      if (!this.camera.active) await this.camera.start({ facingMode: 'user' });
    } catch (err) {
      if (err instanceof CameraError) throw err;
      throw new CameraError('unknown', 'The camera could not be started.', err);
    }
    this.view.setVideo(this.camera.video);
  }

  /** Starts tracking + rendering (camera must be running and tracking loaded). */
  startTracking(): void {
    this.guidance.reset();
    this.governor.setCameraFps(this.camera.frameRate);
    this.governor.reset();
    this.loop.start();
  }

  pauseTracking(): void {
    this.loop.stop();
  }

  /** Full stop: tracking, camera tracks (indicator off), video texture. */
  stop(): void {
    this.loop.stop();
    this.camera.stop();
    this.view.setVideo(null);
    this.rig.group.visible = false;
    this.occluder.group.visible = false;
    this.shadows.update(this.anchor, false);
    for (const c of this.captures.splice(0)) c.reject(new Error('Stopped'));
  }

  get mirrored(): boolean {
    return this.camera.shouldMirror;
  }

  get running(): boolean {
    return this.loop.isRunning;
  }

  /** New wearer: forget size / shape estimates. */
  resetPerson(): void {
    this.loop.resetPerson();
    this.occluder.reset();
    this.rig.setHeadWidthScale(1);
  }

  addFrameListener(fn: TrackingListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ------------------------------------------------------------------ rendering options

  get occlusionMode(): OcclusionMode {
    return this.occlusion;
  }

  /** Manual choice (fitting lab): also turns adaptive quality off. */
  set occlusionMode(m: OcclusionMode) {
    this.adaptive = false;
    this.occlusion = m;
    this.applyOcclusionMode();
  }

  /** Manual choice (fitting lab): also turns adaptive quality off. */
  setShadows(on: boolean): void {
    this.adaptive = false;
    this.shadows.enabled = on;
  }

  /** Current adaptive-quality level (index 0 = best) and its settings. */
  get qualityLevel(): { index: number; count: number } & QualityLevel {
    return { index: this.governor.level, count: this.governor.levels.length, ...this.governor.current };
  }

  private applyLevel(l: QualityLevel): void {
    this.view.setPixelRatio(l.pixelRatio);
    this.view.renderer.transmissionResolutionScale = l.transmissionScale;
    if (this.occlusion !== 'off') this.occlusion = l.occlusion;
    this.shadows.enabled = l.shadows;
    this.applyOcclusionMode();
  }

  private applyOcclusionMode(): void {
    this.occluder.enabled = this.occlusion !== 'off';
    this.softOcclusion.enabled = this.occlusion === 'soft';
  }

  /**
   * Photo of exactly what the customer sees (mirrored like the preview), taken from the next
   * rendered frame. Stays in memory; the caller decides what to do with it.
   */
  capture(type = 'image/jpeg', quality = 0.92): Promise<Blob> {
    const frame = new Promise<HTMLCanvasElement>((resolve, reject) => {
      this.captures.push({ resolve, reject });
      // No new video frame soon (paused / stalled camera)? Render the current state instead.
      setTimeout(() => {
        if (this.captures.length) {
          this.view.render();
          this.flushCaptures();
        }
      }, 300);
    });
    return frame.then(
      (canvas) =>
        new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the photo'))), type, quality),
        ),
    );
  }

  private flushCaptures(): void {
    if (!this.captures.length) return;
    try {
      const shot = this.view.snapshot(this.mirrored);
      for (const c of this.captures.splice(0)) c.resolve(shot);
    } catch (err) {
      for (const c of this.captures.splice(0)) c.reject(err);
    }
  }

  /** Renders once without a new video frame (e.g. after a model switch while paused). */
  renderStill(): void {
    if (this.view.contextLost) return;
    this.view.render();
  }

  private readonly onTracked = (frame: TrackerFrame, pose: FacePose, trueSize: TrueSizeEstimator): void => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    this.view.setFrameSize(frame.frameWidth, frame.frameHeight);
    this.occluder.update(frame, pose, this.loop.camera);
    this.rig.setHeadWidthScale(this.occluder.headWidthRatio);
    this.rig.update(pose, trueSize.factor);
    this.anchor.setFromMatrixPosition(this.rig.group.matrix);
    this.shadows.update(this.anchor, pose.valid && this.rig.group.visible);
    this.light.update(this.camera.video, now, dt);
    this.view.render();
    this.flushCaptures(); // same task as render → the drawing buffer is still valid
    if (this.adaptive) {
      const level = this.governor.frame(now);
      if (level) this.applyLevel(level); // takes effect from the next frame
    }

    this.guidance.update(now, frame, pose, this.view.visibleRect, this.light.sceneLuminance);
    this.fpsCount++;
    if (now - this.fpsT0 >= 1000) {
      this.renderFps = (this.fpsCount * 1000) / (now - this.fpsT0);
      this.fpsCount = 0;
      this.fpsT0 = now;
    }
    for (const fn of this.listeners) fn(frame, pose, trueSize);
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.model?.dispose();
    this.model = null;
    this.rig.setModel(null);
    this.shadows.dispose();
    this.softOcclusion.dispose();
    this.occluder.dispose();
    this.view.dispose();
    this.tracker.close();
  }
}

