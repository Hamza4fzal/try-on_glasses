import type { TrackerFrame } from '../tracking/face-tracker';
import { LM } from '../tracking/landmarks';
import type { FacePose } from '../tracking/pose-solver';

export type GuidanceHint = 'no-face' | 'move-closer' | 'move-back' | 'center' | 'low-light' | 'face-camera' | null;

/**
 * Turns tracking state into ONE short, stable hint for the customer ("Move a little closer"…).
 * A hint appears only after its condition has held for `showMs` and clears after `clearMs`, so
 * it never flickers. Thresholds are relative to the VISIBLE crop of the camera image.
 */
export class FaceGuidance {
  hint: GuidanceHint = 'no-face';
  showMs = 700;
  clearMs = 250;
  private candidate: GuidanceHint = null;
  private since = 0;
  private lastFaceAt = -Infinity;
  onChange: ((hint: GuidanceHint) => void) | null = null;

  reset(): void {
    this.hint = 'no-face';
    this.candidate = null;
    this.since = 0;
    this.lastFaceAt = -Infinity;
    this.onChange?.(this.hint);
  }

  update(now: number, frame: TrackerFrame, pose: FacePose, visible: readonly number[], luminance: number): void {
    const want = this.evaluate(now, frame, pose, visible, luminance);
    if (want !== this.candidate) {
      this.candidate = want;
      this.since = now;
    }
    const delay = want === null ? this.clearMs : this.showMs;
    if (want !== this.hint && now - this.since >= delay) {
      this.hint = want;
      this.onChange?.(want);
    }
  }

  private evaluate(now: number, frame: TrackerFrame, pose: FacePose, visible: readonly number[], luminance: number): GuidanceHint {
    if (frame.hasFace) this.lastFaceAt = now;
    if (!frame.hasFace || !pose.valid) return now - this.lastFaceAt > 400 ? 'no-face' : this.hint;
    const W = frame.frameWidth, H = frame.frameHeight;
    const visW = (visible[2] - visible[0]) * W;
    const visH = (visible[3] - visible[1]) * H;
    const ref = Math.min(visW, visH);
    // Nose bridge outside the central part of what the customer sees.
    const L = frame.landmarks;
    const u = (L[LM.noseBridgeMid * 3] - visible[0]) / (visible[2] - visible[0]);
    const v = (L[LM.noseBridgeMid * 3 + 1] - visible[1]) / (visible[3] - visible[1]);
    if (u < 0.18 || u > 0.82 || v < 0.15 || v > 0.8) return 'center';
    if (pose.eyeSpanPx < 0.085 * ref) return 'move-closer';
    if (pose.eyeSpanPx > 0.42 * ref) return 'move-back';
    if (Math.abs(pose.yawDeg) > 50 || Math.abs(pose.pitchDeg) > 35) return 'face-camera';
    if (luminance < 0.012) return 'low-light';
    return null;
  }
}
