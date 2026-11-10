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
npm run dev          # http://localhost:5173/  → links to the three labs
npm run dev:https    # HTTPS on your LAN for phone testing (accept the self-signed certificate)
```

| Page | What it is |
|---|---|
| `demo/tryon.html` | **Fitting lab**: live camera try-on, product + colour pickers, calibration sliders, debug overlays, calibration JSON export |
| `demo/viewer.html` | **3D fit preview**: the glasses on MediaPipe's canonical head from any angle, no camera needed |
| `demo/tracking.html` | **Tracking lab**: landmarks, solved pose, jitter HUD |

| Command | What it does |
|---|---|
| `npm run typecheck` | TypeScript strict check |
| `npm run build` | Production build into `dist/` |
| `npm run test` | Both test suites below |
| `npm run test:tracking` | Headless-Chrome tracking benchmark + page smoke test (uses installed Chrome; `CHROME_PATH` overrides) |
| `npm run test:tracking:sweep` | Prints filter-parameter trade-off tables (used to tune smoothing) |
| `npm run test:render` | Model validation, glasses fit on a real face photo, variants, GPU-leak and camera-stop checks |
| `npm run models` | Regenerates the dev glasses models (`public/models/*.glb`) |
| `npm run shots` | Multi-angle screenshots of every model on the reference head → `test-output/shots/` |

## Status

| Phase | State |
|---|---|
| 1. Project setup (standalone) | ✅ |
| 2. Tracking engine + tracking lab | ✅ automated tests pass; live webcam check done |
| 3. 3D rendering engine, GLB glasses, calibration | ✅ automated tests pass. **Needs a live-webcam look** |
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

## 3D rendering (`src/render`, `src/product`)

- **One WebGL canvas** shows both the camera image and the glasses. The virtual camera is identical
  to MediaPipe's, so the tracked face matrix is used directly. The video frame is uploaded in the
  same callback that produced the pose, so image and glasses never drift apart. "Cover" cropping
  uses a view offset, so only visible pixels are rendered. Lens transmission refracts the real image.
- **GlassesModel** loads a GLB built to [docs/MODEL_SPEC.md](docs/MODEL_SPEC.md). It switches
  colourways (KHR_materials_variants), applies per-product material overrides, and has a cheaper
  no-transmission mode (`?quality=low`). It frees every GPU resource on dispose.
- **GlassesRig** places the frame:

  ```
  camera ← F(face) · T(nose rest) · S(1/k) · T(offset) · R(tilt/yaw/roll) · S(scale)
  ```

  `k` is the wearer's iris-measured real size, so frames keep their true size on every face.
  Temples are aimed at the ear rests of a canonical head model, and tilt and scale are
  compensated automatically.
- **FaceOccluder** is invisible, depth-only geometry for the face, skull and ears. It hides temple
  parts that pass behind the head.
- **LightEstimator** follows the room's brightness using a tiny local downsample of the camera
  image, so the glasses don't glow in a dark room.
- **Product catalogue** (`public/products/products.json`, stand-in for WooCommerce meta) holds the
  model URL, colourways and calibration. Every value is sanitised and clamped on load.

### Dev models (`npm run models`)

Generated parametrically at true size as real glTF files. They are stand-ins until production
Blender models exist.

| Model | Style | Size | Colourways |
|---|---|---|---|
| Aria | soft-square acetate, rivets | 52□18-145 | havana, black, crystal, honey |
| Mira | cat-eye acetate | 51□19-140 | black, rose crystal, havana |
| Orbit | round metal panto, nose pads | 49□21-145 | gold, silver, gunmetal, matte black |
| Pilot | aviator sunglasses, double bridge | 58□14-140 | gold/G-15, silver/gradient, gunmetal/blue mirror |

Every model has these parts:

- **Front:** an SDF-grown acetate front or swept wire rims, with polished rounded edges, base
  curve, wrap and pantoscopic tilt.
- **Lenses:** separate lens meshes.
- **Temples:** pivoted at the hinges.
- **Hardware:** barrel hinges with screws, plus nose pads on arms for the metal frames.

Every file passes the Khronos validator.

### Render test results (headless Chrome, real face photo)

| Model | Lens centre below pupil | Lens centre outside pupil | Temple spread / droop |
|---|---|---|---|
| Aria | 7.5 % | 5.8 % | 7.3° / 5.7° |
| Mira | 6.8 % | 6.0 % | 6.3° / 6.4° |
| Orbit | 4.5 % | 6.0 % | 8.2° / 2.0° |
| Pilot | 8.3 % | 7.3 % | 6.1° / 6.8° |

Percentages are of the eye-corner span (1 % ≈ 0.9 mm). On top of these measurements:

- The nose rest sits within 0.2 % of the tracked bridge.
- There is no GPU memory growth over repeated product switches.
- All camera tracks stop.

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
src/render/      renderer, GLB model + variants, face rig, occluder, light estimation
src/product/     catalogue types, calibration, sanitising
src/debug/       debug overlay + HUD
src/utils/       One-Euro filters
demo/            fitting lab, 3D fit preview, tracking lab
public/models/   generated dev GLBs        public/products/  catalogue JSON
docs/            MODEL_SPEC.md (GLB contract for real models)
tests/           tracking benchmark, render tests, screenshot tool
tools/           MediaPipe vendoring, canonical face converter, parametric glasses generator
```

The canonical face model (`tools/data/canonical_face_model.obj`, generated
`src/tracking/canonical-face-data.ts`) is from MediaPipe, © The MediaPipe Authors, Apache License 2.0.
