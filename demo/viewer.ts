/**
 * 3D fit preview: the glasses on MediaPipe's canonical head (no camera needed). Shows exactly what
 * the try-on rig computes — nose rest, true size, temples aimed at the ears — from any angle, so
 * models and calibration can be checked for natural positioning and model quality.
 */
import {
  ACESFilmicToneMapping,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  NeutralToneMapping,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadCatalog, type ProductConfig } from '../src/product/catalog';
import { GlassesModel, type RenderQuality } from '../src/render/glasses-model';
import { GlassesRig } from '../src/render/glasses-rig';
import { HEAD_MODEL } from '../src/render/head-model';
import { CANONICAL_POSITIONS, CANONICAL_TRIANGLES } from '../src/tracking/canonical-face-data';
import { LabPanel } from './lab-ui';

const params = new URLSearchParams(location.search);
const quality: RenderQuality = params.get('quality') === 'low' ? 'low' : 'high';
const canvas = document.getElementById('gl') as HTMLCanvasElement;
const status = document.getElementById('status')!;

// ?thumb: transparent background, no head — used by tools/render-thumbs.mjs for product images.
const thumb = params.has('thumb');
const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: thumb, preserveDrawingBuffer: params.has('capture') });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = params.get('tone') === 'aces' ? ACESFilmicToneMapping : NeutralToneMapping;
const scene = new Scene();
scene.background = thumb ? null : new Color(0x1d1d20);
const pmrem = new PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
const key = new DirectionalLight(0xffffff, 1.1);
key.position.set(-30, 60, 80);
scene.add(key);

const camera = new PerspectiveCamera(26, 1, 1, 2000);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 2.4, 1);
controls.enableDamping = true;

// --- head: canonical face + skull + ears (cm, canonical space)
const skin = new MeshStandardMaterial({ color: 0xc9a28a, roughness: 0.62, metalness: 0 });
const proxy = new MeshStandardMaterial({ color: 0x8d7b70, roughness: 0.8, transparent: true, opacity: 0.55 });
const faceGeom = new BufferGeometry();
faceGeom.setAttribute('position', new BufferAttribute(CANONICAL_POSITIONS.slice(), 3));
faceGeom.setIndex(new BufferAttribute(CANONICAL_TRIANGLES, 1));
faceGeom.computeVertexNormals();
if (faceGeom.getAttribute('normal').getZ(1) < 0) {
  // Make normals face outwards for lighting.
  const idx = faceGeom.getIndex()!;
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i + 1);
    idx.setX(i + 1, idx.getX(i + 2));
    idx.setX(i + 2, a);
  }
  faceGeom.computeVertexNormals();
}
const head = new Mesh(faceGeom, skin);
scene.add(head);
const skull = new Mesh(new SphereGeometry(1, 48, 32), proxy);
skull.scale.set(...HEAD_MODEL.skull.radii);
skull.position.set(...HEAD_MODEL.skull.center);
scene.add(skull);
for (const side of [1, -1]) {
  const ear = new Mesh(new SphereGeometry(1, 24, 16), proxy);
  ear.scale.set(...HEAD_MODEL.ear.radii);
  ear.position.set(side * HEAD_MODEL.ear.center[0], HEAD_MODEL.ear.center[1], HEAD_MODEL.ear.center[2]);
  scene.add(ear);
}

// Eye markers (iris discs at the pupils) to judge lens centration and vertex distance.
const irisMat = new MeshStandardMaterial({ color: 0x2b1d14, roughness: 0.3 });
for (const [outer, inner, upper, lower] of [[33, 133, 159, 145], [263, 362, 386, 374]]) {
  const p = (i: number, a: number) => CANONICAL_POSITIONS[i * 3 + a];
  const cx = (p(outer, 0) + p(inner, 0)) / 2;
  const cy = (p(upper, 1) + p(lower, 1)) / 2;
  const cz = Math.max(p(upper, 2), p(lower, 2)) + 0.15;
  const iris = new Mesh(new SphereGeometry(0.58, 24, 12), irisMat);
  iris.scale.set(1, 1, 0.35);
  iris.position.set(cx, cy, cz);
  scene.add(iris);
}

const rig = new GlassesRig();
scene.add(rig.group);
let k = 1;
let model: GlassesModel | null = null;
let loadToken = 0;

type V3 = [number, number, number];
const DEFAULT_TARGET: V3 = [0, 2.4, 1];
const VIEWS: Record<string, { pos: V3; target?: V3 }> = {
  front: { pos: [0, 2.6, 48] },
  three: { pos: [30, 6, 36] },
  side: { pos: [48, 3, 2] },
  top: { pos: [0, 46, 10] },
  under: { pos: [8, -30, 36] },
  close: { pos: [12, 4, 20] },
  hinge: { pos: [17, 10, 12], target: [6.6, 3.6, 4.2] },
  inside: { pos: [-4, 6, -14], target: [5, 3, 4] },
  product: { pos: [21, 7.5, 33], target: [0.6, 2.4, -2.2] },
};
function setView(name: string): void {
  const v = VIEWS[name] ?? VIEWS.front;
  controls.target.set(...(v.target ?? DEFAULT_TARGET));
  camera.position.set(...v.pos);
  controls.update();
}
setView(params.get('view') ?? 'front');

async function showProduct(p: ProductConfig, variantId?: string): Promise<void> {
  const token = ++loadToken;
  status.textContent = `Loading ${p.name}…`;
  const m = await GlassesModel.load(p.model, quality);
  if (token !== loadToken) {
    m.dispose();
    return;
  }
  rig.setModel(m);
  model?.dispose();
  model = m;
  rig.setCalibration(panel.calibration);
  const v = p.variants.find((x) => x.id === variantId) ?? panel.variant;
  if (v) await m.setVariant(v.gltfVariant ?? null, v.materialOverrides);
  updateInfo();
  status.textContent = '';
}

function updateInfo(): void {
  if (!model) return;
  const f = rig.templeFit;
  const m = model.meta;
  panel.setInfo(
    `${m.title ?? panel.product.name}\n` +
      `${m.lensWidthMm}□${m.bridgeMm}-${m.templeLengthMm} · frame ${m.frameWidthMm} mm\n` +
      `temples: L ${f[0].spreadDeg.toFixed(1)}° spread / ${f[0].droopDeg.toFixed(1)}° droop` +
      `${f[0].clamped || f[1].clamped ? ' (clamped)' : ''}`,
  );
}

const catalog = await loadCatalog(new URL('../products/products.json', location.href).href);
const panel = new LabPanel(document.body, catalog, {
  onProduct: (p) => void showProduct(p),
  onVariant: (v) => void model?.setVariant(v.gltfVariant ?? null, v.materialOverrides),
  onCalibration: (c) => {
    rig.setCalibration(c);
    rig.updateCanonical(k);
    updateInfo();
  },
});
panel.addToggle('Axes + bounding box', false, (on) => rig.setDebug(on));
panel.addToggle('Show head', true, (on) => {
  head.visible = on;
  skull.visible = on;
  scene.children.forEach((o) => (o as Mesh).material === proxy && (o.visible = on));
});
const sizeRow = document.createElement('label');
sizeRow.className = 'lab-row';
sizeRow.innerHTML = '<span>Face size k</span><input type="range" min="0.85" max="1.15" step="0.01" value="1"><output>1.00</output>';
sizeRow.querySelector('input')!.addEventListener('input', (e) => {
  k = Number((e.target as HTMLInputElement).value);
  sizeRow.querySelector('output')!.textContent = k.toFixed(2);
});
panel.debugBox.append(sizeRow);

document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view!)));

await showProduct(panel.product, params.get('variant') ?? undefined);
if (thumb) {
  head.visible = false;
  scene.children.forEach((o) => ((o as Mesh).material === proxy || (o as Mesh).material === irisMat ? (o.visible = false) : 0));
}

function resize(): void {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}

let turntable = params.has('spin');
document.getElementById('spin')?.addEventListener('click', () => (turntable = !turntable));
renderer.setAnimationLoop((t) => {
  resize();
  if (turntable) {
    const a = t / 4000;
    camera.position.set(Math.sin(a) * 42, 4, Math.cos(a) * 42);
  }
  controls.update();
  rig.updateCanonical(k);
  renderer.render(scene, camera);
});

// Test / console hooks.
Object.assign(window, {
  __viewer: {
    setView,
    async show(productId: string, variantId?: string) {
      const p = catalog.products.find((x) => x.id === productId);
      if (p) {
        panel.selectProduct(p);
        await showProduct(p, variantId);
      }
    },
    setHead(on: boolean) {
      head.visible = on;
      scene.children.forEach((o) => ((o as Mesh).material === proxy ? (o.visible = on) : 0));
    },
    rig,
    renderer,
    get model() {
      return model;
    },
  },
});
document.title += ' (ready)';
