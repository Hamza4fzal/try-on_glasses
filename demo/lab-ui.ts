/**
 * Shared developer panel for the fitting lab and the 3D fit preview: product + colour pickers,
 * live calibration sliders, debug toggles, and calibration export (the JSON that goes into the
 * catalogue now and into WooCommerce product meta later).
 *
 * Calibration edits are remembered per product in localStorage (dev convenience only).
 */
import {
  CALIBRATION_LIMITS,
  calibrationToJSON,
  sanitizeCalibration,
  type Calibration,
  type Catalog,
  type ProductConfig,
  type ProductVariant,
} from '../src/product/catalog';

export interface LabPanelHandlers {
  onProduct(p: ProductConfig): void;
  onVariant(v: ProductVariant): void;
  onCalibration(c: Calibration): void;
}

interface SliderDef {
  label: string;
  get(c: Calibration): number;
  set(c: Calibration, v: number): void;
  range: readonly [number, number];
  step: number;
  unit?: string;
}

const AXES = ['x', 'y', 'z'] as const;

const SLIDERS: SliderDef[] = [
  { label: 'Scale', get: (c) => c.scale, set: (c, v) => (c.scale = v), range: CALIBRATION_LIMITS.scale, step: 0.005 },
  ...AXES.map((a, i): SliderDef => ({
    label: `Offset ${a}`,
    get: (c) => c.offsetMm[i],
    set: (c, v) => (c.offsetMm[i] = v),
    range: CALIBRATION_LIMITS.offsetMm,
    step: 0.1,
    unit: 'mm',
  })),
  ...AXES.map((a, i): SliderDef => ({
    label: ['Tilt (pantoscopic)', 'Yaw', 'Roll'][i] + ` ${a}`,
    get: (c) => c.rotationDeg[i],
    set: (c, v) => (c.rotationDeg[i] = v),
    range: CALIBRATION_LIMITS.rotationDeg,
    step: 0.1,
    unit: '°',
  })),
  { label: 'Bridge position', get: (c) => c.bridgeAlignment, set: (c, v) => (c.bridgeAlignment = v), range: CALIBRATION_LIMITS.bridgeAlignment, step: 0.01 },
  { label: 'Temple spread', get: (c) => c.templeSpreadDeg, set: (c, v) => (c.templeSpreadDeg = v), range: CALIBRATION_LIMITS.templeSpreadDeg, step: 0.1, unit: '°' },
  { label: 'Temple droop', get: (c) => c.templeDroopDeg, set: (c, v) => (c.templeDroopDeg = v), range: CALIBRATION_LIMITS.templeDroopDeg, step: 0.1, unit: '°' },
  { label: 'Face-width adaptation', get: (c) => c.faceWidthAdaptation, set: (c, v) => (c.faceWidthAdaptation = v), range: CALIBRATION_LIMITS.faceWidthAdaptation, step: 0.01 },
];

const storageKey = (id: string) => `vto.calibration.${id}`;

function loadStored(id: string): Calibration | null {
  try {
    const s = localStorage.getItem(storageKey(id));
    return s ? sanitizeCalibration(JSON.parse(s)) : null;
  } catch {
    return null;
  }
}

function store(id: string, c: Calibration | null): void {
  try {
    if (c) localStorage.setItem(storageKey(id), JSON.stringify(c));
    else localStorage.removeItem(storageKey(id));
  } catch {
    /* storage unavailable: fine */
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const k of kids) e.append(k);
  return e;
}

export class LabPanel {
  product: ProductConfig;
  variant: ProductVariant | undefined;
  calibration: Calibration;
  readonly root: HTMLElement;
  private readonly productSelect: HTMLSelectElement;
  private readonly swatches: HTMLElement;
  private readonly sliderRows: { def: SliderDef; input: HTMLInputElement; out: HTMLOutputElement }[] = [];
  private readonly autoFit: HTMLInputElement;
  private readonly json: HTMLTextAreaElement;
  private readonly info: HTMLElement;
  readonly debugBox: HTMLElement;

  constructor(
    container: HTMLElement,
    readonly catalog: Catalog,
    private readonly handlers: LabPanelHandlers,
  ) {
    const enabled = catalog.products.filter((p) => p.enabled);
    if (!enabled.length) throw new Error('No enabled products in the catalogue');
    const fromUrl = new URLSearchParams(location.search).get('product');
    this.product = enabled.find((p) => p.id === fromUrl) ?? enabled[0];
    this.calibration = loadStored(this.product.id) ?? structuredClone(this.product.calibration);

    this.productSelect = el('select', { className: 'lab-select', ariaLabel: 'Product' });
    for (const p of enabled) this.productSelect.append(el('option', { value: p.id, textContent: `${p.name}${p.sku ? ` · ${p.sku}` : ''}` }));
    this.productSelect.value = this.product.id;
    this.productSelect.addEventListener('change', () => {
      const p = enabled.find((x) => x.id === this.productSelect.value);
      if (p) this.selectProduct(p);
    });

    this.swatches = el('div', { className: 'lab-swatches' });
    this.info = el('div', { className: 'lab-info' });

    const sliders = el('div', { className: 'lab-sliders' });
    for (const def of SLIDERS) {
      const input = el('input', { type: 'range', min: String(def.range[0]), max: String(def.range[1]), step: String(def.step) });
      const out = el('output');
      input.addEventListener('input', () => {
        def.set(this.calibration, Number(input.value));
        this.changed();
      });
      input.addEventListener('dblclick', () => {
        const d = sanitizeCalibration({});
        def.set(this.calibration, def.get(d));
        this.changed();
      });
      sliders.append(el('label', { className: 'lab-row' }, el('span', { textContent: def.label }), input, out));
      this.sliderRows.push({ def, input, out });
    }
    this.autoFit = el('input', { type: 'checkbox' });
    this.autoFit.addEventListener('change', () => {
      this.calibration.templeAutoFit = this.autoFit.checked;
      this.changed();
    });
    sliders.append(el('label', { className: 'lab-check' }, this.autoFit, 'Auto-fit temples to ears'));

    this.json = el('textarea', { className: 'lab-json', readOnly: true, rows: 11, spellcheck: false });
    const copy = el('button', { className: 'lab-btn', textContent: 'Copy calibration JSON' });
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(this.json.value);
        copy.textContent = 'Copied';
      } catch {
        this.json.select();
        copy.textContent = 'Select + copy manually';
      }
      setTimeout(() => (copy.textContent = 'Copy calibration JSON'), 1500);
    });
    const reset = el('button', { className: 'lab-btn', textContent: 'Reset to catalogue' });
    reset.addEventListener('click', () => {
      this.calibration = structuredClone(this.product.calibration);
      store(this.product.id, null);
      this.changed(false);
    });

    this.debugBox = el('div', { className: 'lab-debug' });

    this.root = el(
      'aside',
      { className: 'lab-panel' },
      el('details', { open: true }, el('summary', { textContent: 'Product' }), this.productSelect, this.swatches, this.info),
      el('details', { open: false }, el('summary', { textContent: 'Calibration' }), sliders, el('div', { className: 'lab-btns' }, reset, copy), this.json),
      el('details', { open: false }, el('summary', { textContent: 'Debug' }), this.debugBox),
    );
    container.append(this.root);
    this.renderSwatches();
    this.syncInputs();
  }

  /** Adds a debug checkbox. */
  addToggle(label: string, initial: boolean, onChange: (on: boolean) => void): HTMLInputElement {
    const box = el('input', { type: 'checkbox', checked: initial });
    box.addEventListener('change', () => onChange(box.checked));
    this.debugBox.append(el('label', { className: 'lab-check' }, box, label));
    return box;
  }

  addSelect(label: string, options: string[], initial: string, onChange: (value: string) => void): HTMLSelectElement {
    const sel = el('select', {}, ...options.map((o) => el('option', { value: o, textContent: o, selected: o === initial })));
    sel.addEventListener('change', () => onChange(sel.value));
    this.debugBox.append(el('label', { className: 'lab-row' }, el('span', { textContent: label }), sel));
    return sel;
  }

  setInfo(text: string): void {
    this.info.textContent = text;
  }

  selectProduct(p: ProductConfig): void {
    this.product = p;
    this.productSelect.value = p.id;
    this.calibration = loadStored(p.id) ?? structuredClone(p.calibration);
    this.variant = undefined;
    this.renderSwatches();
    this.syncInputs();
    this.handlers.onProduct(p);
  }

  selectVariant(v: ProductVariant): void {
    this.variant = v;
    for (const b of this.swatches.querySelectorAll('button')) b.classList.toggle('on', b.dataset.id === v.id);
    this.handlers.onVariant(v);
  }

  /** The variant to show first for the current product. */
  initialVariant(): ProductVariant | undefined {
    return this.product.variants.find((v) => v.id === this.product.defaultVariant) ?? this.product.variants[0];
  }

  private renderSwatches(): void {
    this.swatches.replaceChildren();
    const initial = this.initialVariant();
    for (const v of this.product.variants) {
      const b = el('button', { className: 'lab-swatch', title: v.label, ariaLabel: v.label });
      b.dataset.id = v.id;
      b.style.setProperty('--swatch', v.swatch);
      b.classList.toggle('on', v.id === initial?.id);
      b.addEventListener('click', () => this.selectVariant(v));
      this.swatches.append(b);
    }
    this.variant = initial;
  }

  private changed(persist = true): void {
    if (persist) store(this.product.id, this.calibration);
    this.syncInputs();
    this.handlers.onCalibration(this.calibration);
  }

  private syncInputs(): void {
    for (const { def, input, out } of this.sliderRows) {
      const v = def.get(this.calibration);
      input.value = String(v);
      out.textContent = `${v.toFixed(def.step < 0.01 ? 3 : def.step < 0.1 ? 2 : 1)}${def.unit ?? ''}`;
    }
    this.autoFit.checked = this.calibration.templeAutoFit;
    this.json.value = calibrationToJSON(this.calibration);
  }
}
