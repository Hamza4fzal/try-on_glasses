import { CameraModel } from './camera-model';
import { FaceTracker, type TrackerFrame } from './face-tracker';
import { PoseSolver, type FacePose, type PoseSolverConfig } from './pose-solver';
import { TrueSizeEstimator } from './true-size-estimator';

export interface TrackingStats {
  /** Tracked frames per second (new video frames processed). */
  trackFps: number;
  /** Mean inference time per frame (ms), exponentially averaged. */
  inferenceMs: number;
  delegate: 'GPU' | 'CPU';
}

export type TrackingListener = (frame: TrackerFrame, pose: FacePose, trueSize: TrueSizeEstimator) => void;

type VideoWithRVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/**
 * Drives tracking from a <video>: exactly one detection per NEW video frame.
 *
 * Uses requestVideoFrameCallback where available (Chrome, Edge, Safari 15.4+, Firefox 132+),
 * otherwise a requestAnimationFrame loop that skips frames whose currentTime hasn't advanced.
 * Detection runs synchronously before the listener, so the overlay rendered by the listener
 * is computed from the same frame the browser is about to composite — no video/overlay drift.
 *
 * Pauses automatically while the page is hidden.
 */
export class TrackingLoop {
  readonly camera = new CameraModel();
  readonly solver: PoseSolver;
  readonly trueSize: TrueSizeEstimator;
  readonly stats: TrackingStats = { trackFps: 0, inferenceMs: 0, delegate: 'CPU' };

  private running = false;
  private rafHandle = 0;
  private rvfcHandle = 0;
  private lastMediaTime = -1;
  private fpsWindowStart = 0;
  private fpsCount = 0;
  private readonly listeners = new Set<TrackingListener>();
  private readonly onVisibility = () => this.handleVisibility();

  constructor(
    readonly tracker: FaceTracker,
    readonly video: HTMLVideoElement,
    solverConfig: Partial<PoseSolverConfig> = {},
  ) {
    this.solver = new PoseSolver(this.camera, solverConfig);
    this.trueSize = new TrueSizeEstimator(this.camera);
  }

  addListener(fn: TrackingListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastMediaTime = -1;
    this.fpsWindowStart = performance.now();
    this.fpsCount = 0;
    document.addEventListener('visibilitychange', this.onVisibility);
    this.schedule();
  }

  stop(): void {
    this.running = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.cancel();
    this.solver.reset();
  }

  /** New wearer / camera switch: forget per-person estimates. */
  resetPerson(): void {
    this.solver.reset();
    this.trueSize.reset();
  }

  private schedule(): void {
    if (!this.running || document.hidden) return;
    const v = this.video as VideoWithRVFC;
    if (v.requestVideoFrameCallback) {
      this.rvfcHandle = v.requestVideoFrameCallback((now, meta) => this.tick(now, meta.mediaTime));
    } else {
      this.rafHandle = requestAnimationFrame((now) => this.tick(now, this.video.currentTime));
    }
  }

  private cancel(): void {
    const v = this.video as VideoWithRVFC;
    if (this.rvfcHandle && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(this.rvfcHandle);
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rvfcHandle = 0;
    this.rafHandle = 0;
  }

  private tick(now: number, mediaTime: number): void {
    if (!this.running) return;
    const v = this.video;
    const isNewFrame = mediaTime !== this.lastMediaTime;
    if (isNewFrame && v.readyState >= 2 && v.videoWidth > 0) {
      this.lastMediaTime = mediaTime;
      const frame = this.tracker.detect(v, now, v.videoWidth, v.videoHeight);
      const pose = this.solver.update(frame);
      this.trueSize.update(frame, pose);

      this.stats.delegate = this.tracker.delegate;
      this.stats.inferenceMs += (frame.inferenceMs - this.stats.inferenceMs) * 0.1;
      this.fpsCount++;
      const elapsed = now - this.fpsWindowStart;
      if (elapsed >= 500) {
        this.stats.trackFps = (this.fpsCount * 1000) / elapsed;
        this.fpsCount = 0;
        this.fpsWindowStart = now;
      }
      for (const fn of this.listeners) fn(frame, pose, this.trueSize);
    }
    this.schedule();
  }

  private handleVisibility(): void {
    if (document.hidden) {
      this.cancel();
    } else if (this.running) {
      this.solver.reset(); // large time gap: don't smooth across it
      this.schedule();
    }
  }
}
