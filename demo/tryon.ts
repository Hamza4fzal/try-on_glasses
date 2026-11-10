/**
 * Fitting lab: live camera → tracking → 3D glasses (WebGL) with per-product calibration and
 * debug views. The developer/admin tool; customers use the try-on modal (demo/shop.html).
 */
import { EngineError, TryOnEngine, type OcclusionMode } from '../src/app/try-on-engine';
import { CameraError } from '../src/camera/camera-controller';
import { DebugOverlay } from '../src/debug/debug-overlay';
import { loadCatalog, type ProductConfig, type ProductVariant } from '../src/product/catalog';
import type { RenderQuality } from '../src/render/glasses-model';
import { LabPanel } from './lab-ui';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const q = params.get('quality');
const quality: RenderQuality | 'auto' = q === 'low' || q === 'high' ? q : 'high';
const stage = $('stage');
const status = $('status');
const btnStart = $<HTMLButtonElement>('start');
const btnSwitch = $<HTMLButtonElement>('switch');
const btnStop = $<HTMLButtonElement>('stop');
const d = params.get('delegate');

const engine = new TryOnEngine($<HTMLCanvasElement>('gl'), {
  assetBase: new URL('../', import.meta.url).href, // site root (see demo/tracking.ts)
  quality,
  delegate: d === 'CPU' || d === 'GPU' ? d : 'auto',
  preserveDrawingBuffer: params.has('capture'),
  // The lab is for manual inspection: adaptive quality only with ?adaptive (or the toggle).
  adaptive: params.has('adaptive'),
});
const { camera, tracker, loop, view, rig, occluder, light } = engine;
const overlay = new DebugOverlay($<HTMLCanvasElement>('overlay'), $('hud'));
overlay.enabled = false;
overlay.showMesh = false;
const testHooks = params.has('capture');

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
panel.addToggle('Live face shape (occluder)', true, (on) => (occluder.liveShape = on));
const adaptiveBox = panel.addToggle('Adaptive quality (as customers get it)', engine.adaptive, (on) => (engine.adaptive = on));
// Manual choices switch adaptive quality off (otherwise it would override them).
panel.addSelect('Occlusion', ['soft', 'hard', 'off'], engine.occlusionMode, (m) => {
  engine.occlusionMode = m as OcclusionMode;
  adaptiveBox.checked = false;
});
panel.addToggle('Contact shadows', engine.shadows.enabled, (on) => {
  engine.setShadows(on);
  adaptiveBox.checked = false;
});
panel.addToggle('Match room lighting', true, (on) => {
  light.enabled = on;
  if (!on) {
    view.scene.environmentIntensity = 1;
    view.keyLight.intensity = 1.1;
  }
});

async function showProduct(p: ProductConfig): Promise<void> {
  status.textContent = `Loading ${p.name}…`;
  try {
    await engine.loadProduct(p, panel.variant?.id);
    if (engine.product !== p) return; // superseded
    const v = panel.variant;
    if (v) await engine.applyVariant(v);
    rig.setCalibration(panel.calibration);
    const meta = engine.model?.meta ?? {};
    panel.setInfo(`${meta.title ?? p.name}\n${meta.lensWidthMm}□${meta.bridgeMm}-${meta.templeLengthMm} · frame ${meta.frameWidthMm} mm`);
    if (status.textContent?.startsWith('Loading')) status.textContent = '';
  } catch (err) {
    status.textContent = err instanceof Error ? err.message : String(err);
    console.error(err);
  }
}

async function applyVariant(v: ProductVariant): Promise<void> {
  await engine.applyVariant(v);
}

engine.addFrameListener((frame, pose, trueSize) => {
  if (testHooks) (window as unknown as { __lastFrame: Float32Array }).__lastFrame = frame.landmarks;
  if (overlay.enabled) {
    const c = rig.calibration;
    const f = rig.templeFit;
    overlay.draw(frame, pose, loop.camera, trueSize, loop.stats, {
      renderFps: engine.renderFps,
      lines: [
        `model ${panel.product.id}/${engine.model?.variant ?? '-'}  kEff ${rig.kEff.toFixed(3)}  dpr ${view.pixelRatio}  quality ${engine.quality}  ${engine.adaptive ? `adaptive ${engine.qualityLevel.index + 1}/${engine.qualityLevel.count} (${engine.governor.fps.toFixed(0)} fps)` : 'manual'}`,
        `calib scale ${c.scale.toFixed(3)} off [${c.offsetMm.map((v) => v.toFixed(1)).join(', ')}] mm rot [${c.rotationDeg.map((v) => v.toFixed(1)).join(', ')}]°`,
        `temples L ${f[0].spreadDeg.toFixed(1)}°/${f[0].droopDeg.toFixed(1)}°  R ${f[1].spreadDeg.toFixed(1)}°/${f[1].droopDeg.toFixed(1)}°${f[0].clamped || f[1].clamped ? ' clamped' : ''}  head width ×${occluder.headWidthRatio.toFixed(3)}`,
        `occlusion ${engine.occlusionMode}${occluder.live ? ' (live face)' : ' (rigid)'}  shadows ${engine.shadows.enabled ? 'on' : 'off'}  light lum ${light.sceneLuminance.toFixed(3)} env ${view.scene.environmentIntensity.toFixed(2)}`,
        `guidance ${engine.guidance.hint ?? '-'}`,
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
    const tracking = engine.preloadTracking();
    await engine.startCamera();
    stage.classList.toggle('mirror', engine.mirrored);
    if (!tracker.ready) status.textContent = 'Loading face tracking…';
    await tracking;
    engine.startTracking();
    setRunning(true);
    status.textContent = '';
  } catch (err) {
    engine.stop();
    btnStart.disabled = false;
    status.textContent = err instanceof CameraError || err instanceof EngineError ? err.message : String(err);
    console.error(err);
  }
});

btnSwitch.addEventListener('click', async () => {
  loop.stop();
  try {
    await camera.switchCamera();
    stage.classList.toggle('mirror', engine.mirrored);
    engine.resetPerson();
    engine.startTracking();
  } catch (err) {
    status.textContent = String(err);
    setRunning(false);
  }
});

btnStop.addEventListener('click', () => {
  engine.stop();
  overlay.clear();
  engine.renderStill();
  setRunning(false);
  status.textContent = 'Camera stopped.';
});

window.addEventListener('resize', () => view.resize());
window.addEventListener('pagehide', () => engine.stop());

await showProduct(panel.product);
status.textContent = 'Fitting lab — press Start camera';

// Exposed for automated tests and console inspection.
Object.assign(window, {
  __vto: {
    engine,
    camera,
    tracker,
    loop,
    view,
    rig,
    occluder,
    panel,
    get model() {
      return engine.model;
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
