# Virtual Eyewear Try-On

In-browser 3D glasses try-on: **MediaPipe Face Landmarker** for face tracking, **Three.js** for rendering.
The engine is built and validated as a standalone app first. WordPress/WooCommerce integration comes
after it's approved.

**Privacy:** all processing happens in the browser. The MediaPipe runtime and model are self-hosted,
so no camera frames, landmarks or images ever leave the device and no third-party server is contacted
at runtime.

## Quick start

```bash
npm install          # also vendors MediaPipe wasm + model into public/mediapipe (sha256-verified)
npm run dev          # http://localhost:5173/demo/tracking.html
npm run dev:https    # HTTPS on your LAN for phone testing (accept the self-signed certificate)
```

| Command | What it does |
|---|---|
| `npm run typecheck` | TypeScript strict check |
| `npm run build` | Production build into `dist/` |
| `npm run test:tracking` | Headless-Chrome tracking benchmark + page smoke test (uses installed Chrome; `CHROME_PATH` overrides) |
| `npm run test:tracking:sweep` | Prints filter-parameter trade-off tables (used to tune smoothing) |

## Status

| Phase | State |
|---|---|
| 1. Project setup (standalone) | ✅ |
| 2. Tracking engine + tracking lab | ✅ automated tests pass. **Needs a live-webcam check of yaw/pitch** |
| 3. 3D rendering engine, GLB glasses, calibration | next |
| 4. WordPress plugin | after you approve the standalone app |
| 5. Occlusion, materials, photo capture | |
| 6. Performance, device testing, production build | |

## Tracking lab (`demo/tracking.html`)

The overlay draws the following:

- **Faint mesh**: raw MediaPipe landmarks.
- **Cyan dots**: eye corners. **Yellow circles**: iris fits, used as the true-size ruler.
- **Magenta cross**: the observed nose-bridge anchor.
- **White hollow circles**: canonical face points re-projected through the solved pose. *They should
  stay on the matching landmarks (eye corners, nose, chin, cheeks) as you turn, tilt and move.*
- **RGB axes**: the solved glasses origin. Red points to your left, green up, blue out of your face.
- **HUD**: fps, inference time, delegate, yaw/pitch/roll, confidence, fit residual, anchor position,
  scale, and the true-size factor `k`.

Query params: `?delegate=CPU` or `?delegate=GPU` forces the inference backend (default `auto` = GPU with CPU fallback).

## How tracking works (`src/tracking`)

1. **FaceTracker** runs Face Landmarker in VIDEO mode, one face, with transformation matrices enabled.
   It uses the GPU delegate and falls back to CPU if the GPU fails at creation or during inference.
2. **CameraModel** reproduces MediaPipe's virtual camera (63° vertical FOV, frame aspect, unmirrored),
   so projection and the tracker's own assumptions agree exactly.
3. **PoseSolver** combines three sources:
   - Rotation comes from MediaPipe's matrix.
   - Position is pinned to the *observed* nose bridge (landmarks 168/6), so the bridge cannot slide off
     the nose.
   - Depth is set so the rotated canonical eye region matches the observed eye-region spread.
   One-Euro filters smooth position and log-depth, and adaptive quaternion slerp smooths rotation.
   The output is a face matrix that maps canonical face space (cm) to camera space.
4. **TrueSizeEstimator** uses the iris (≈ 11.7 mm in adults) as a physical ruler to estimate each
   wearer's real face scale `k`. That lets glasses authored at true size look correctly sized on wide
   and narrow faces. It samples only near-frontal frames, takes a running median, then clamps and eases it.
5. **TrackingLoop** runs exactly one detection per new video frame (`requestVideoFrameCallback`) and
   pauses while the tab is hidden.

**Mirroring:** all math runs on the unmirrored frame. The selfie preview is mirrored only at display
time with CSS, applied to video and overlay together.

## Benchmark results (headless Chrome, CPU delegate, 1280×720)

The face photo is moved along scripted paths, with webcam-like noise injected
(0.5 px whole-face, 0.6 px per landmark, 0.35° rotation, 1σ). Percentages are of the eye-corner span (~136 px).

| Check | Result | Target |
|---|---|---|
| Still: jitter of solved anchor | 0.25 px/frame (raw 1.18) | ≤ 0.3 |
| Still: scale pulsing | 0.065 %/frame | ≤ 0.15 |
| Still: roll jitter | 0.043°/frame | ≤ 0.05 |
| Natural micro-motion: anchor error p95 | 1.4 % | ≤ 3 |
| Fast pan (≈ 690 px/s peak): anchor error p95 incl. smoothing lag | 5.2 % | ≤ 6 |
| Fast combined motion: anchor error p95 | 5.6 % | ≤ 6 |
| Roll ±22°: mean error | 1.24° | ≤ 1.5 |
| Approach/recede ±35 %: scale error p95 | 3.5 % | ≤ 4 |
| Face lost → pose hidden after | 5 frames (180 ms hold) | ≤ 6 |
| Face regained → valid pose after | 0 frames | ≤ 3 |

**Not covered by the benchmark:** a still photo cannot produce real 3D yaw or pitch. Those are verified
live in the tracking lab.

## Layout

```
src/camera/      camera access, errors, switching
src/tracking/    FaceTracker, CameraModel, PoseSolver, TrueSizeEstimator, TrackingLoop, canonical face data
src/debug/       debug overlay + HUD
src/utils/       One-Euro filters
demo/            tracking lab page
tests/           benchmark harness + headless runner
tools/           MediaPipe vendoring, canonical face model converter
```

The canonical face model (`tools/data/canonical_face_model.obj`, generated
`src/tracking/canonical-face-data.ts`) is from MediaPipe, © The MediaPipe Authors, Apache License 2.0.
