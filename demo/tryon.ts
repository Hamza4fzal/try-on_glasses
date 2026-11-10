/**
 * Phase 3 fitting lab: live camera → tracking → 3D glasses (WebGL) with per-product calibration.
 * This is the developer/admin tool; the customer-facing modal comes in Phase 5.
 */
import { CameraController, CameraError } from '../src/camera/camera-controller';
import { DebugOverlay } from '../src/debug/debug-overlay';
import { loadCatalog, type ProductConfig, type ProductVariant } from '../src/product/catalog';
import { FaceOccluder } from '../src/render/face-occluder';
import { GlassesModel, type RenderQuality } from '../src/render/glasses-model';
import { GlassesRig } from '../src/render/glasses-rig';
import { LightEstimator } from '../src/render/light-estimator';
import { TryOnRenderer } from '../src/render/try-on-renderer';
import { FaceTracker } from '../src/tracking/face-tracker';
import { TrackingLoop } from '../src/tracking/tracking-loop';
import { LabPanel } from './lab-ui';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const quality: RenderQuality = params.get('quality') === 'low' ? 'low' : 'high';
const stage = $('stage');
const status = $('status');
const btnStart = $<HTMLButtonElement>('start');
const btnSwitch = $<HTMLButtonElement>('switch');
const btnStop = $<HTMLButtonElement>('stop');

const base = import.meta.env.BASE_URL;
const camera = new CameraController($<HTMLVideoElement>('video'));
const tracker = new FaceTracker();
const loop = new TrackingLoop(tracker, camera.video);
const view = new TryOnRenderer($<HTMLCanvasElement>('gl'), { preserveDrawingBuffer: params.has('capture') });
const overlay = new DebugOverlay($<HTMLCanvasElement>('overlay'), $('hud'));
overlay.enabled = false;
overlay.showMesh = false;
const rig = new GlassesRig();
const occluder = new FaceOccluder();
const light = new LightEstimator(view);
view.add(occluder.group);
view.add(rig.group);

const testHooks = params.has('capture');
let model: GlassesModel | null = null;
let loadToken = 0;
let renderFps = 0;
let fpsCount = 0;
let fpsT0 = performance.now();
let lastT = performance.now();

const catalog = await loadCatalog(new URL('../products/products.json', location.href).href);
const panel = new LabPanel(document.body, catalog, {
  onProduct: (p) => void showProduct(p),
  onVariant: (v) => void applyVariant(v),
  onCalibration: (c) => rig.setCalibration(c),
});
panel.addToggle('Debug overlay (landmarks, HUD)', false, (on) => {
  overlay.enabled = on;
  if (!on) overlay.clear();
});
panel.addToggle('Face mesh in overlay', false, (on) => (overlay.showMesh = on));
panel.addToggle('Glasses axes + bounding box', false, (on) => rig.setDebug(on));
panel.addToggle('Show occluder', false, (on) => occluder.setDebug(on));
panel.addToggle('Occlusion', true, (on) => (occluder.enabled = on));
panel.addToggle('Match room lighting', true, (on) => {
  light.enabled = on;
  if (!on) {
    view.scene.environmentIntensity = 1;
    view.keyLight.intensity = 1.1;
  }
});

async function showProduct(p: ProductConfig): Promise<void> {
  const token = ++loadToken;
  status.textContent = `Loading ${p.name}…`;
  try {
    const m = await GlassesModel.load(p.model, quality);
    if (token !== loadToken) return m.dispose();
    const v = panel.variant;
    if (v) await m.setVariant(v.gltfVariant ?? null, v.materialOverrides);
    if (token !== loadToken) return m.dispose();
    rig.setModel(m);
    model?.dispose();
    model = m;
    rig.setCalibration(panel.calibration);
    const meta = m.meta;
    panel.setInfo(`${meta.title ?? p.name}\n${meta.lensWidthMm}□${meta.bridgeMm}-${meta.templeLengthMm} · frame ${meta.frameWidthMm} mm`);
    if (status.textContent?.startsWith('Loading')) status.textContent = '';
  } catch (err) {
    if (token === loadToken) status.textContent = `Could not load ${p.name}: ${String(err)}`;
    console.error(err);
  }
}

async function applyVariant(v: ProductVariant): Promise<void> {
  await model?.setVariant(v.gltfVariant ?? null, v.materialOverrides);
}

loop.addListener((frame, pose, trueSize) => {
  if (testHooks) (window as unknown as { __lastFrame: Float32Array }).__lastFrame = frame.landmarks;
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  view.setFrameSize(frame.frameWidth, frame.frameHeight);
  rig.update(pose, trueSize.factor);
  occluder.update(pose.faceMatrix, pose.valid);
  light.update(camera.video, now, dt);
  view.render();

  fpsCount++;
  if (now - fpsT0 >= 1000) {
    renderFps = (fpsCount * 1000) / (now - fpsT0);
    fpsCount = 0;
    fpsT0 = now;
  }
  if (overlay.enabled) {
    const c = rig.calibration;
    const f = rig.templeFit;
    overlay.draw(frame, pose, loop.camera, trueSize, loop.stats, {
      renderFps,
      lines: [
        `model ${panel.product.id}/${model?.variant ?? '-'}  kEff ${rig.kEff.toFixed(3)}  dpr ${view.pixelRatio}`,
        `calib scale ${c.scale.toFixed(3)} off [${c.offsetMm.map((v) => v.toFixed(1)).join(', ')}] mm rot [${c.rotationDeg.map((v) => v.toFixed(1)).join(', ')}]°`,
        `temples L ${f[0].spreadDeg.toFixed(1)}°/${f[0].droopDeg.toFixed(1)}°  R ${f[1].spreadDeg.toFixed(1)}°/${f[1].droopDeg.toFixed(1)}°${f[0].clamped || f[1].clamped ? ' clamped' : ''}`,
        `light lum ${light.sceneLuminance.toFixed(3)} env ${view.scene.environmentIntensity.toFixed(2)}  quality ${quality}`,
      ],
    });
  }
  status.textContent = frame.hasFace ? '' : 'Looking for your face…';
});

view.onContextLost = () => {
  status.textContent = 'Graphics were reset by the browser — restarting 3D…';
};
view.onContextRestored = () => location.reload();

camera.onInterrupted = (err) => {
  loop.stop();
  setRunning(false);
  status.textContent = err.message;
};

function setRunning(on: boolean): void {
  btnStart.disabled = on;
  btnSwitch.disabled = !on;
  btnStop.disabled = !on;
}

btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  try {
    status.textContent = 'Starting camera…';
    await camera.start({ facingMode: 'user' });
    stage.classList.toggle('mirror', camera.shouldMirror);
    view.setVideo(camera.video);
    if (!tracker.ready) {
      status.textContent = 'Loading face tracking…';
      const d = params.get('delegate');
      await tracker.init({
        wasmBaseUrl: `${base}mediapipe/wasm`,
        modelUrl: `${base}mediapipe/face_landmarker.task`,
        delegate: d === 'CPU' || d === 'GPU' ? d : 'auto',
      });
    }
    loop.start();
    setRunning(true);
    status.textContent = '';
  } catch (err) {
    camera.stop();
    view.setVideo(null);
    btnStart.disabled = false;
    status.textContent = err instanceof CameraError ? err.message : String(err);
    console.error(err);
  }
});

btnSwitch.addEventListener('click', async () => {
  loop.stop();
  try {
    await camera.switchCamera();
    stage.classList.toggle('mirror', camera.shouldMirror);
    loop.resetPerson();
    loop.start();
  } catch (err) {
    status.textContent = String(err);
    setRunning(false);
  }
});

btnStop.addEventListener('click', () => {
  loop.stop();
  camera.stop();
  view.setVideo(null);
  overlay.clear();
  rig.group.visible = false;
  occluder.update(rig.group.matrix, false);
  view.render();
  setRunning(false);
  status.textContent = 'Camera stopped.';
});

window.addEventListener('resize', () => view.resize());
window.addEventListener('pagehide', () => {
  loop.stop();
  camera.stop();
});

await showProduct(panel.product);
status.textContent = 'Fitting lab — press Start camera';

// Exposed for automated tests and console inspection.
Object.assign(window, {
  __vto: {
    camera,
    tracker,
    loop,
    view,
    rig,
    occluder,
    panel,
    get model() {
      return model;
    },
    async show(productId: string, variantId?: string) {
      const p = catalog.products.find((x) => x.id === productId);
      if (!p) return;
      panel.selectProduct(p);
      await showProduct(p);
      const v = p.variants.find((x) => x.id === variantId);
      if (v) {
        panel.selectVariant(v);
        await applyVariant(v);
      }
    },
  },
});
document.title += ' (ready)';
