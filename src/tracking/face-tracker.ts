import { FaceLandmarker, FilesetResolver, type FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import { LANDMARK_COUNT_WITH_IRIS } from './landmarks';

export type DelegatePreference = 'auto' | 'GPU' | 'CPU';

export interface FaceTrackerOptions {
  /** Base URL of the self-hosted MediaPipe wasm directory (no trailing slash needed). */
  wasmBaseUrl: string;
  /** URL of the self-hosted face_landmarker.task model. */
  modelUrl: string;
  delegate?: DelegatePreference;
  minFaceDetectionConfidence?: number;
  minFacePresenceConfidence?: number;
  minTrackingConfidence?: number;
}

/**
 * Result of one detection, copied into preallocated buffers (no per-frame allocation on our side).
 * Landmarks are normalized: x,y ∈ [0,1] of the UNMIRRORED frame; z is relative depth in units of frame width.
 */
export interface TrackerFrame {
  timestampMs: number;
  hasFace: boolean;
  landmarkCount: number;
  /** xyz triplets, capacity 478. */
  landmarks: Float32Array;
  /** 4×4 facial transformation matrix, COLUMN-major (Three.js Matrix4.fromArray order). */
  matrix: Float32Array;
  hasMatrix: boolean;
  inferenceMs: number;
  frameWidth: number;
  frameHeight: number;
}

export type TrackerSource = HTMLVideoElement | HTMLCanvasElement | ImageBitmap | OffscreenCanvas;

export class FaceTracker {
  private landmarker: FaceLandmarker | null = null;
  private lastTimestamp = -1;
  private activeDelegate: 'GPU' | 'CPU' = 'CPU';
  private gpuFailed = false;
  private options: Required<FaceTrackerOptions> | null = null;
  private fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;

  readonly frame: TrackerFrame = {
    timestampMs: 0,
    hasFace: false,
    landmarkCount: 0,
    landmarks: new Float32Array(LANDMARK_COUNT_WITH_IRIS * 3),
    matrix: new Float32Array(16),
    hasMatrix: false,
    inferenceMs: 0,
    frameWidth: 0,
    frameHeight: 0,
  };

  get delegate(): 'GPU' | 'CPU' {
    return this.activeDelegate;
  }

  get ready(): boolean {
    return this.landmarker !== null;
  }

  async init(opts: FaceTrackerOptions): Promise<void> {
    this.options = {
      delegate: 'auto',
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      ...opts,
    };
    this.fileset = await FilesetResolver.forVisionTasks(this.options.wasmBaseUrl.replace(/\/$/, ''));

    const pref = this.options.delegate;
    if (pref === 'CPU') {
      await this.create('CPU');
      return;
    }
    try {
      await this.create('GPU');
    } catch (err) {
      if (pref === 'GPU') throw err;
      console.warn('[vto] GPU delegate unavailable, falling back to CPU', err);
      this.gpuFailed = true;
      await this.create('CPU');
    }
  }

  private async create(delegate: 'GPU' | 'CPU'): Promise<void> {
    const o = this.options!;
    this.landmarker?.close();
    this.landmarker = null;
    this.landmarker = await FaceLandmarker.createFromOptions(this.fileset!, {
      baseOptions: { modelAssetPath: o.modelUrl, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      minFaceDetectionConfidence: o.minFaceDetectionConfidence,
      minFacePresenceConfidence: o.minFacePresenceConfidence,
      minTrackingConfidence: o.minTrackingConfidence,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: true,
    });
    this.activeDelegate = delegate;
    this.lastTimestamp = -1;
  }

  /**
   * Runs detection synchronously on the given frame. Timestamps must increase; we enforce it.
   * Returns the shared `frame` object (overwritten on every call).
   */
  detect(source: TrackerSource, timestampMs: number, width: number, height: number): TrackerFrame {
    const lm = this.landmarker;
    const f = this.frame;
    f.hasFace = false;
    f.hasMatrix = false;
    f.landmarkCount = 0;
    if (!lm || width === 0 || height === 0) return f;

    const ts = timestampMs <= this.lastTimestamp ? this.lastTimestamp + 1 : timestampMs;
    this.lastTimestamp = ts;

    const t0 = performance.now();
    let result: FaceLandmarkerResult;
    try {
      result = lm.detectForVideo(source, ts);
    } catch (err) {
      // Some mobile GPU drivers fail at inference time rather than creation time.
      if (this.activeDelegate === 'GPU' && !this.gpuFailed) {
        console.warn('[vto] GPU inference failed; switching to CPU delegate', err);
        this.gpuFailed = true;
        void this.create('CPU');
        return f;
      }
      throw err;
    }
    f.inferenceMs = performance.now() - t0;
    f.timestampMs = ts;
    f.frameWidth = width;
    f.frameHeight = height;

    const faces = result.faceLandmarks;
    if (!faces || faces.length === 0) return f;
    const pts = faces[0];
    const n = Math.min(pts.length, LANDMARK_COUNT_WITH_IRIS);
    const out = f.landmarks;
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      out[i * 3] = p.x;
      out[i * 3 + 1] = p.y;
      out[i * 3 + 2] = p.z;
    }
    f.landmarkCount = n;
    f.hasFace = n >= 468;

    const mats = result.facialTransformationMatrixes;
    if (mats && mats.length > 0 && mats[0].data.length === 16) {
      copyAsColumnMajor(mats[0].data, f.matrix);
      f.hasMatrix = true;
    }
    return f;
  }

  close(): void {
    this.landmarker?.close();
    this.landmarker = null;
  }
}

/**
 * MediaPipe's Matrix proto carries its own packing; rather than trusting the layout of a given
 * release, detect it: an affine 4×4 has [0,0,0,1] as its last ROW. In column-major storage that row
 * lives at indices 3,7,11,15; in row-major storage, at 12,13,14,15.
 */
function copyAsColumnMajor(src: ArrayLike<number>, out: Float32Array): void {
  const colMajorLooksAffine = Math.abs(src[3]) + Math.abs(src[7]) + Math.abs(src[11]) < 1e-5;
  const rowMajorLooksAffine = Math.abs(src[12]) + Math.abs(src[13]) + Math.abs(src[14]) < 1e-5;
  if (colMajorLooksAffine || !rowMajorLooksAffine) {
    for (let i = 0; i < 16; i++) out[i] = src[i];
  } else {
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[c * 4 + r] = src[r * 4 + c];
  }
}
