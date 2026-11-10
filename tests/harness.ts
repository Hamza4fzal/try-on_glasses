/**
 * Deterministic tracking benchmark.
 *
 * Renders a real face photo into a 1280×720 canvas under a scripted 2D motion (translate, scale,
 * in-plane roll) with per-frame sensor-like noise, and feeds each frame — with synthetic 30 fps
 * timestamps — through the production FaceTracker + PoseSolver + TrueSizeEstimator.
 *
 * Because the image transform of every frame is known exactly, the expected nose-bridge position,
 * roll and scale are known too, so we can measure:
 *   - raw landmark accuracy (tracker),
 *   - solved/smoothed anchor accuracy incl. smoothing lag (what the user would see),
 *   - jitter while still, roll accuracy, scale tracking, loss/re-acquisition.
 *
 * Limitation (by construction): a still photo cannot produce real 3D yaw/pitch rotation. Those
 * are verified with a live webcam in the tracking lab.
 */
import { Matrix4, Vector3 } from 'three';
import { CameraModel } from '../src/tracking/camera-model';
import { FaceTracker, type TrackerFrame } from '../src/tracking/face-tracker';
import { LM } from '../src/tracking/landmarks';
import { canonical, DEFAULT_POSE_SOLVER_CONFIG, PoseSolver, type PoseSolverConfig } from '../src/tracking/pose-solver';
import { TrueSizeEstimator } from '../src/tracking/true-size-estimator';

interface Motion {
  dx: number;
  dy: number;
  s: number;
  rotDeg: number;
  hidden?: boolean;
}
interface Segment {
  name: string;
  seconds: number;
  static?: boolean;
  /** Inject webcam-like tracking noise (see NOISE) into the tracker output before solving. */
  noisy?: boolean;
  motion: (t: number) => Motion;
}

/**
 * Estimated real-webcam tracking noise (1σ), applied on top of the tracker output:
 * common-mode face jitter, independent per-landmark jitter, and pose-matrix rotation jitter.
 */
const NOISE = { commonPx: 0.5, perLandmarkPx: 0.6, rotationDeg: 0.35 };

const W = 1280;
const H = 720;
const FPS = 30;
const FACE_CENTER = { x: 400, y: 200 }; // in source-image pixels (portrait.jpg)
const BASE_SCALE = 1.15;

const TAU = Math.PI * 2;
const SEGMENTS: Segment[] = [
  { name: 'static', seconds: 3, static: true, motion: () => ({ dx: 0, dy: 0, s: 1, rotDeg: 0 }) },
  {
    name: 'pan (±220px horiz, ±70px vert, ~0.5Hz)',
    seconds: 4,
    motion: (t) => ({ dx: 220 * Math.sin(TAU * 0.5 * t), dy: 70 * Math.sin(TAU * 0.35 * t), s: 1, rotDeg: 0 }),
  },
  {
    name: 'approach/recede (scale 0.65–1.35)',
    seconds: 4,
    motion: (t) => ({ dx: 0, dy: 0, s: 1 + 0.35 * Math.sin(TAU * 0.4 * t), rotDeg: 0 }),
  },
  {
    name: 'roll (±22°)',
    seconds: 4,
    motion: (t) => ({ dx: 0, dy: 0, s: 1, rotDeg: 22 * Math.sin(TAU * 0.4 * t) }),
  },
  {
    name: 'combined fast',
    seconds: 3,
    motion: (t) => ({
      dx: 160 * Math.sin(TAU * 0.8 * t),
      dy: 40 * Math.cos(TAU * 0.6 * t),
      s: 1 + 0.2 * Math.sin(TAU * 0.5 * t),
      rotDeg: 12 * Math.sin(TAU * 0.7 * t),
    }),
  },
  { name: 'face hidden', seconds: 1, motion: () => ({ dx: 0, dy: 0, s: 1, rotDeg: 0, hidden: true }) },
  { name: 'reacquire static', seconds: 2, static: true, motion: () => ({ dx: 0, dy: 0, s: 1, rotDeg: 0 }) },
  { name: 'noisy static', seconds: 3, static: true, noisy: true, motion: () => ({ dx: 0, dy: 0, s: 1, rotDeg: 0 }) },
  {
    name: 'noisy pan',
    seconds: 4,
    noisy: true,
    motion: (t) => ({ dx: 220 * Math.sin(TAU * 0.5 * t), dy: 70 * Math.sin(TAU * 0.35 * t), s: 1, rotDeg: 0 }),
  },
  {
    name: 'noisy slow drift (natural micro-motion)',
    seconds: 3,
    noisy: true,
    motion: (t) => ({ dx: 12 * Math.sin(TAU * 0.25 * t), dy: 6 * Math.sin(TAU * 0.2 * t), s: 1, rotDeg: 1.5 * Math.sin(TAU * 0.3 * t) }),
  },
];

// Seeded PRNG (mulberry32) so every solver configuration sees identical noise.
let rngState = 1;
function seed(s: number): void {
  rngState = s >>> 0;
}
function rand(): number {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function gauss(): number {
  // Box–Muller
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * rand());
}

const noiseRot = new Matrix4();
const noiseM = new Matrix4();
const noiseAxis = new Vector3();
function injectNoise(frame: TrackerFrame): void {
  if (!frame.hasFace) return;
  const L = frame.landmarks;
  const cx = (NOISE.commonPx * gauss()) / W;
  const cy = (NOISE.commonPx * gauss()) / H;
  for (let i = 0; i < frame.landmarkCount; i++) {
    L[i * 3] += cx + (NOISE.perLandmarkPx * gauss()) / W;
    L[i * 3 + 1] += cy + (NOISE.perLandmarkPx * gauss()) / H;
  }
  if (frame.hasMatrix) {
    noiseAxis.set(gauss(), gauss(), gauss()).normalize();
    noiseRot.makeRotationAxis(noiseAxis, ((NOISE.rotationDeg * Math.PI) / 180) * Math.abs(gauss()));
    noiseM.fromArray(frame.matrix).multiply(noiseRot);
    noiseM.toArray(frame.matrix);
  }
}

interface FrameRecord {
  seg: number;
  motion: Motion;
  hasFace: boolean;
  valid: boolean;
  rawX: number; rawY: number;
  poseX: number; poseY: number;
  expX: number; expY: number;
  roll: number; expRoll: number;
  yaw: number; pitch: number;
  /** Eye-corner span of the SOLVED pose, projected (px) — what the glasses' size follows. */
  poseSpan: number;
  residual: number; confidence: number;
  k: number; inferenceMs: number;
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

function makeNoise(): HTMLCanvasElement[] {
  const tiles: HTMLCanvasElement[] = [];
  for (let n = 0; n < 6; n++) {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    for (let i = 0; i < img.data.length; i += 4) {
      const g = 128 + ((Math.random() + Math.random() + Math.random() - 1.5) * 255) / 1.5;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = g;
      img.data[i + 3] = 22;
    }
    ctx.putImageData(img, 0, 0);
    tiles.push(c);
  }
  return tiles;
}

function toCanvas(m: Motion, px: number, py: number): [number, number] {
  const a = (m.rotDeg * Math.PI) / 180;
  const sx = (px - FACE_CENTER.x) * BASE_SCALE * m.s;
  const sy = (py - FACE_CENTER.y) * BASE_SCALE * m.s;
  return [W / 2 + m.dx + sx * Math.cos(a) - sy * Math.sin(a), H / 2 + m.dy + sx * Math.sin(a) + sy * Math.cos(a)];
}

function stats(values: number[]) {
  if (values.length === 0) return { n: 0, mean: NaN, p95: NaN, max: NaN };
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))],
    max: s[s.length - 1],
  };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** One tracker output, recorded once so solver configs can be compared on identical input. */
interface RecordedFrame {
  seg: number;
  motion: Motion;
  frame: TrackerFrame;
}

let recording: { frames: RecordedFrame[]; delegate: 'GPU' | 'CPU' } | null = null;

function cloneFrame(f: TrackerFrame): TrackerFrame {
  return { ...f, landmarks: f.landmarks.slice(), matrix: f.matrix.slice() };
}

/** Runs real Face Landmarker inference over the scripted sequence (slow; done once). */
async function record(delegate: 'CPU' | 'GPU' = 'CPU') {
  const base = import.meta.env.BASE_URL;
  const img = await loadImage(`${base}test-assets/portrait.jpg`);
  const noise = makeNoise();
  const canvas = document.getElementById('frame') as HTMLCanvasElement;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const tracker = new FaceTracker();
  await tracker.init({ wasmBaseUrl: `${base}mediapipe/wasm`, modelUrl: `${base}mediapipe/face_landmarker.task`, delegate });

  const frames: RecordedFrame[] = [];
  let ts = 1000;
  for (let si = 0; si < SEGMENTS.length; si++) {
    const seg = SEGMENTS[si];
    const n = Math.round(seg.seconds * FPS);
    for (let f = 0; f < n; f++) {
      const m = seg.motion(f / FPS);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#6b6259';
      ctx.fillRect(0, 0, W, H);
      if (!m.hidden) {
        const [cx, cy] = toCanvas(m, FACE_CENTER.x, FACE_CENTER.y);
        ctx.translate(cx, cy);
        ctx.rotate((m.rotDeg * Math.PI) / 180);
        ctx.scale(BASE_SCALE * m.s, BASE_SCALE * m.s);
        ctx.translate(-FACE_CENTER.x, -FACE_CENTER.y);
        ctx.drawImage(img, 0, 0);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
      ctx.drawImage(noise[(f + si) % noise.length], 0, 0);
      ts += 1000 / FPS;
      frames.push({ seg: si, motion: m, frame: cloneFrame(tracker.detect(canvas, ts, W, H)) });
    }
  }
  recording = { frames, delegate: tracker.delegate };
  tracker.close();
  return { frames: frames.length, delegate: tracker.delegate };
}

/** Replays the recording through a fresh solver with the given config (fast; repeatable). */
function evaluate(solverConfig: Partial<PoseSolverConfig> = {}) {
  if (!recording) throw new Error('call recordTracking() first');
  seed(12345);
  const camera = new CameraModel();
  const solver = new PoseSolver(camera, structuredClone(solverConfig));
  const trueSize = new TrueSizeEstimator(camera);
  const records: FrameRecord[] = [];
  const uv = { x: 0, y: 0 };
  const uv2 = { x: 0, y: 0 };
  const pA = new Vector3();
  const pB = new Vector3();

  for (const rf of recording.frames) {
    const si = rf.seg;
    const seg = SEGMENTS[si];
    const m = rf.motion;
    {
      const frame = cloneFrame(rf.frame);
      if (seg.noisy) injectNoise(frame);
      const pose = solver.update(frame);
      trueSize.update(frame, pose);

      const L = frame.landmarks;
      const rec: FrameRecord = {
        seg: si, motion: m, hasFace: frame.hasFace, valid: pose.valid,
        rawX: NaN, rawY: NaN, poseX: NaN, poseY: NaN, expX: NaN, expY: NaN,
        roll: pose.rollDeg, expRoll: NaN, yaw: pose.yawDeg, pitch: pose.pitchDeg, poseSpan: NaN,
        residual: pose.fitResidual, confidence: pose.confidence, k: trueSize.factor, inferenceMs: frame.inferenceMs,
      };
      if (frame.hasFace) {
        rec.rawX = ((L[LM.noseBridgeTop * 3] + L[LM.noseBridgeMid * 3]) / 2) * W;
        rec.rawY = ((L[LM.noseBridgeTop * 3 + 1] + L[LM.noseBridgeMid * 3 + 1]) / 2) * H;
      }
      if (pose.valid && camera.project(pose.anchorCamera, uv)) {
        rec.poseX = uv.x * W;
        rec.poseY = uv.y * H;
        canonical(LM.rightEyeOuter, pA).applyMatrix4(pose.faceMatrix);
        canonical(LM.leftEyeOuter, pB).applyMatrix4(pose.faceMatrix);
        if (camera.project(pA, uv) && camera.project(pB, uv2)) {
          rec.poseSpan = Math.hypot((uv2.x - uv.x) * W, (uv2.y - uv.y) * H);
        }
      }
      records.push(rec);
    }
  }

  // Ground truth from the clean static segment (identity transform), skipping warm-up frames.
  const baseline = records.filter((r) => r.seg === 0 && r.valid).slice(10);
  const srcAnchor: [number, number] = [
    FACE_CENTER.x + (mean(baseline.map((r) => r.rawX)) - W / 2) / BASE_SCALE,
    FACE_CENTER.y + (mean(baseline.map((r) => r.rawY)) - H / 2) / BASE_SCALE,
  ];
  const roll0 = mean(baseline.map((r) => r.roll));
  const span0 = mean(baseline.map((r) => r.poseSpan));
  for (const r of records) {
    [r.expX, r.expY] = toCanvas(r.motion, srcAnchor[0], srcAnchor[1]);
    // Clockwise image rotation (canvas y-down) = negative roll about +Z (toward camera).
    r.expRoll = roll0 - r.motion.rotDeg;
  }

  const segReports = SEGMENTS.map((seg, si) => {
    const rs = records.filter((r) => r.seg === si);
    const tracked = rs.filter((r) => r.valid && !r.motion.hidden);
    const rawErr = rs.filter((r) => r.hasFace).map((r) => Math.hypot(r.rawX - r.expX, r.rawY - r.expY));
    const poseErr = tracked.map((r) => Math.hypot(r.poseX - r.expX, r.poseY - r.expY));
    const rollErr = tracked.map((r) => Math.abs(r.roll - r.expRoll));
    const scaleErr = tracked.map((r) => Math.abs(r.poseSpan / (span0 * r.motion.s) - 1) * 100);
    const steps: number[] = [];
    const rollSteps: number[] = [];
    const scaleSteps: number[] = [];
    for (let i = 1; i < tracked.length; i++) {
      steps.push(Math.hypot(tracked[i].poseX - tracked[i - 1].poseX, tracked[i].poseY - tracked[i - 1].poseY));
      rollSteps.push(Math.abs(tracked[i].roll - tracked[i - 1].roll));
      scaleSteps.push(Math.abs(tracked[i].poseSpan / tracked[i - 1].poseSpan - 1) * 100);
    }
    const rawSteps: number[] = [];
    const rawTracked = rs.filter((r) => r.hasFace);
    for (let i = 1; i < rawTracked.length; i++) {
      rawSteps.push(Math.hypot(rawTracked[i].rawX - rawTracked[i - 1].rawX, rawTracked[i].rawY - rawTracked[i - 1].rawY));
    }
    return {
      segment: seg.name,
      frames: rs.length,
      detectedFrames: rs.filter((r) => r.hasFace).length,
      validFrames: tracked.length,
      rawAnchorErrPx: stats(rawErr),
      poseAnchorErrPx: stats(poseErr),
      poseAnchorErrPctEyeSpan: stats(poseErr.map((e) => (e / span0) * 100)),
      rollErrDeg: stats(rollErr),
      scaleErrPct: stats(scaleErr),
      residualPct: stats(tracked.map((r) => r.residual * 100)),
      confidence: stats(tracked.map((r) => r.confidence)),
      ...(seg.static
        ? { rawJitterPx: stats(rawSteps), jitterPx: stats(steps), rollJitterDeg: stats(rollSteps), scaleJitterPct: stats(scaleSteps) }
        : {}),
    };
  });

  const segIndex = (name: string) => SEGMENTS.findIndex((s) => s.name === name);
  const reacquireFrames = records.filter((r) => r.seg === segIndex('reacquire static')).findIndex((r) => r.valid);
  const hiddenRecs = records.filter((r) => r.seg === segIndex('face hidden'));

  return {
    delegate: recording.delegate,
    noise: NOISE,
    eyeSpanBaselinePx: span0,
    roll0,
    yawPitchStatic: stats(baseline.map((r) => Math.hypot(r.yaw, r.pitch))),
    trueSizeFactor: records[records.length - 1].k,
    inferenceMs: stats(records.filter((r) => r.hasFace).map((r) => r.inferenceMs)),
    validWhileHidden: hiddenRecs.filter((r) => r.valid).length,
    hiddenFrames: hiddenRecs.length,
    reacquireFrames,
    segments: segReports,
  };
}

Object.assign(window, { recordTracking: record, evaluateTracking: evaluate, DEFAULT_POSE_SOLVER_CONFIG });
document.title += ' (ready)';

