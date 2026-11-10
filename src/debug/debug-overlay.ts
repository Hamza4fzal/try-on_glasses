import { FaceLandmarker } from '@mediapipe/tasks-vision';
import { Vector3 } from 'three';
import type { CameraModel } from '../tracking/camera-model';
import type { TrackerFrame } from '../tracking/face-tracker';
import { LM } from '../tracking/landmarks';
import { canonical, type FacePose } from '../tracking/pose-solver';
import type { TrueSizeEstimator } from '../tracking/true-size-estimator';
import type { TrackingStats } from '../tracking/tracking-loop';

export interface DebugExtras {
  renderFps?: number;
  /** Glasses world-space bounding box corners projected by the caller (normalized uv), optional. */
  glassesBoxUV?: ArrayLike<number>;
  lines?: string[];
}

const TESSELATION = FaceLandmarker.FACE_LANDMARKS_TESSELATION;
const EYE_POINTS = [LM.rightEyeOuter, LM.rightEyeInner, LM.leftEyeInner, LM.leftEyeOuter];
const PREDICTED_POINTS = [
  LM.rightEyeOuter, LM.rightEyeInner, LM.leftEyeInner, LM.leftEyeOuter,
  LM.noseBridgeTop, LM.noseBridgeMid, LM.noseTip, LM.rightFaceEdge, LM.leftFaceEdge, LM.chin, LM.forehead,
];

/**
 * Developer overlay. The canvas uses the video's own pixel grid (unmirrored); mirror it with the
 * same CSS transform as the video so drawings line up. The HUD is plain DOM so text is never mirrored.
 *
 * Legend:
 *   faint mesh            — raw landmarks (tesselation)
 *   cyan dots             — eye corner references
 *   yellow circles        — iris fits (true-size ruler)
 *   magenta cross         — observed nose-bridge anchor (landmarks)
 *   white hollow circles  — canonical face points re-projected through the solved pose (should sit on the landmarks)
 *   RGB axes              — solved glasses origin: X red (subject's left), Y green (up), Z blue (out of face)
 *   orange box            — glasses bounding box (when provided)
 */
export class DebugOverlay {
  readonly canvas: HTMLCanvasElement;
  readonly hud: HTMLElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly p = new Vector3();
  private readonly q = new Vector3();
  private readonly uv = { x: 0, y: 0 };
  private readonly uv2 = { x: 0, y: 0 };
  enabled = true;
  showMesh = true;

  constructor(canvas?: HTMLCanvasElement, hud?: HTMLElement) {
    this.canvas = canvas ?? document.createElement('canvas');
    this.hud = hud ?? document.createElement('pre');
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.hud.textContent = '';
  }

  draw(
    frame: TrackerFrame,
    pose: FacePose,
    camera: CameraModel,
    trueSize: TrueSizeEstimator,
    stats: TrackingStats,
    extras: DebugExtras = {},
  ): void {
    if (!this.enabled) return;
    const W = frame.frameWidth;
    const H = frame.frameHeight;
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);
    const unit = Math.max(1, H / 720); // line widths scale with resolution
    const L = frame.landmarks;

    if (frame.hasFace) {
      if (this.showMesh) {
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.lineWidth = 0.75 * unit;
        ctx.beginPath();
        for (const { start, end } of TESSELATION) {
          ctx.moveTo(L[start * 3] * W, L[start * 3 + 1] * H);
          ctx.lineTo(L[end * 3] * W, L[end * 3 + 1] * H);
        }
        ctx.stroke();
      }

      ctx.fillStyle = '#22d3ee';
      for (const i of EYE_POINTS) dot(ctx, L[i * 3] * W, L[i * 3 + 1] * H, 3 * unit);

      if (frame.landmarkCount >= 478) {
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 1.5 * unit;
        for (const [c, ring] of [
          [LM.rightIrisCenter, LM.rightIrisRing],
          [LM.leftIrisCenter, LM.leftIrisRing],
        ] as const) {
          const cx = L[c * 3] * W, cy = L[c * 3 + 1] * H;
          let r = 0;
          for (const k of ring) r += Math.hypot(L[k * 3] * W - cx, L[k * 3 + 1] * H - cy);
          ctx.beginPath();
          ctx.arc(cx, cy, r / ring.length, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      const t = 0.5;
      const ax = (L[LM.noseBridgeTop * 3] * (1 - t) + L[LM.noseBridgeMid * 3] * t) * W;
      const ay = (L[LM.noseBridgeTop * 3 + 1] * (1 - t) + L[LM.noseBridgeMid * 3 + 1] * t) * H;
      ctx.strokeStyle = '#e879f9';
      ctx.lineWidth = 2 * unit;
      cross(ctx, ax, ay, 7 * unit);
    }

    if (pose.valid) {
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 1.25 * unit;
      for (const i of PREDICTED_POINTS) {
        canonical(i, this.p).applyMatrix4(pose.faceMatrix);
        if (camera.project(this.p, this.uv)) {
          ctx.beginPath();
          ctx.arc(this.uv.x * W, this.uv.y * H, 5 * unit, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // Axes at the glasses origin (anchor), 3 cm long, in face space.
      const a = pose.anchorCanonical;
      const axes: [number, number, number, string][] = [
        [3, 0, 0, '#ef4444'],
        [0, 3, 0, '#22c55e'],
        [0, 0, 3, '#3b82f6'],
      ];
      this.p.copy(a).applyMatrix4(pose.faceMatrix);
      if (camera.project(this.p, this.uv)) {
        ctx.lineWidth = 3 * unit;
        for (const [x, y, z, color] of axes) {
          this.q.set(a.x + x, a.y + y, a.z + z).applyMatrix4(pose.faceMatrix);
          if (!camera.project(this.q, this.uv2)) continue;
          ctx.strokeStyle = color;
          ctx.beginPath();
          ctx.moveTo(this.uv.x * W, this.uv.y * H);
          ctx.lineTo(this.uv2.x * W, this.uv2.y * H);
          ctx.stroke();
        }
        ctx.fillStyle = '#fff';
        dot(ctx, this.uv.x * W, this.uv.y * H, 3.5 * unit);
      }
    }

    const box = extras.glassesBoxUV;
    if (box && box.length >= 4) {
      ctx.strokeStyle = '#fb923c';
      ctx.lineWidth = 1.5 * unit;
      ctx.strokeRect(box[0] * W, box[1] * H, (box[2] - box[0]) * W, (box[3] - box[1]) * H);
    }

    const f1 = (n: number) => n.toFixed(1);
    const f3 = (n: number) => n.toFixed(3);
    const lines = [
      `video      ${W}×${H}   delegate ${stats.delegate}`,
      `fps        track ${f1(stats.trackFps)}${extras.renderFps != null ? `   render ${f1(extras.renderFps)}` : ''}`,
      `inference  ${f1(stats.inferenceMs)} ms`,
      `face       ${frame.hasFace ? 'yes' : 'NO'}   pose ${pose.valid ? 'valid' : '—'}`,
    ];
    if (pose.valid) {
      const c = pose.anchorCamera;
      lines.push(
        `confidence ${f3(pose.confidence)}   residual ${(pose.fitResidual * 100).toFixed(2)}% of eye span`,
        `yaw ${f1(pose.yawDeg)}°  pitch ${f1(pose.pitchDeg)}°  roll ${f1(pose.rollDeg)}°`,
        `anchor     x ${f1(c.x)}  y ${f1(c.y)}  z ${f1(c.z)} cm`,
        `scale σ    ${f3(pose.modelScale)}   align r ${f3(pose.alignRatio)}   eye span ${f1(pose.eyeSpanPx)} px`,
        `true-size  k ${f3(trueSize.factor)} (raw ${f3(trueSize.rawEstimate)}, n=${trueSize.sampleCount}, iris ${f1(trueSize.lastIrisPx)} px)`,
      );
    }
    if (extras.lines) lines.push(...extras.lines);
    this.hud.textContent = lines.join('\n');
  }
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function cross(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(x - s, y);
  ctx.lineTo(x + s, y);
  ctx.moveTo(x, y - s);
  ctx.lineTo(x, y + s);
  ctx.stroke();
}
