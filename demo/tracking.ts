/**
 * Phase 2 tracking lab: camera → Face Landmarker → PoseSolver → debug overlay.
 * No 3D rendering yet; the solved pose is visualised as re-projected canonical points and axes.
 */
import { CameraController, CameraError } from '../src/camera/camera-controller';
import { DebugOverlay } from '../src/debug/debug-overlay';
import { FaceTracker } from '../src/tracking/face-tracker';
import { TrackingLoop } from '../src/tracking/tracking-loop';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $('stage');
const status = $('status');
const btnStart = $<HTMLButtonElement>('start');
const btnSwitch = $<HTMLButtonElement>('switch');
const btnMesh = $<HTMLButtonElement>('mesh');
const btnStop = $<HTMLButtonElement>('stop');

const base = import.meta.env.BASE_URL;
const camera = new CameraController($<HTMLVideoElement>('video'));
const tracker = new FaceTracker();
const overlay = new DebugOverlay($<HTMLCanvasElement>('overlay'), $('hud'));
const loop = new TrackingLoop(tracker, camera.video);

// Exposed for automated tests and console inspection (read-only use).
(window as unknown as { __vto: unknown }).__vto = { camera, tracker, loop };

loop.addListener((frame, pose, trueSize) => {
  overlay.draw(frame, pose, loop.camera, trueSize, loop.stats);
  status.textContent = frame.hasFace ? '' : 'Looking for your face…';
});

camera.onInterrupted = (err) => {
  loop.stop();
  overlay.clear();
  setRunning(false);
  status.textContent = err.message;
};

function setRunning(on: boolean): void {
  btnStart.disabled = on;
  btnSwitch.disabled = !on;
  btnMesh.disabled = !on;
  btnStop.disabled = !on;
}

btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  try {
    status.textContent = 'Starting camera…';
    await camera.start({ facingMode: 'user' });
    stage.classList.toggle('mirror', camera.shouldMirror);
    if (!tracker.ready) {
      status.textContent = 'Loading face tracking…';
      await tracker.init({
        wasmBaseUrl: `${base}mediapipe/wasm`,
        modelUrl: `${base}mediapipe/face_landmarker.task`,
      });
    }
    loop.start();
    setRunning(true);
    status.textContent = '';
  } catch (err) {
    camera.stop();
    btnStart.disabled = false;
    status.textContent = err instanceof CameraError ? `${err.code}: ${err.message}` : String(err);
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

btnMesh.addEventListener('click', () => {
  overlay.showMesh = !overlay.showMesh;
});

btnStop.addEventListener('click', () => {
  loop.stop();
  camera.stop();
  overlay.clear();
  setRunning(false);
  status.textContent = 'Camera stopped.';
});

window.addEventListener('pagehide', () => {
  loop.stop();
  camera.stop();
});
