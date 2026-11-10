import { EngineError, TryOnEngine, type EngineErrorCode } from '../app/try-on-engine';
import type { GuidanceHint } from '../app/guidance';
import { CameraError } from '../camera/camera-controller';
import type { ProductConfig } from '../product/catalog';
import type { RenderQuality } from '../render/glasses-model';
import type { DelegatePreference } from '../tracking/face-tracker';
import css from './try-on-modal.css?inline';
import { fill, mergeStrings, permissionHelpKey, type DeepPartial, type ErrorKey, type Strings } from './strings';

export type TryOnState = 'closed' | 'intro' | 'waiting' | 'loading' | 'live' | 'photo' | 'paused' | 'error';

export interface TryOnEvent {
  type: 'open' | 'start' | 'live' | 'variant' | 'product' | 'photo' | 'error' | 'close';
  productId?: string;
  variantId?: string;
  code?: string;
}

export interface TryOnModalOptions {
  products: ProductConfig[];
  /** Base URL containing mediapipe/ (ends with /). */
  assetBase: string;
  quality?: RenderQuality | 'auto';
  delegate?: DelegatePreference;
  /** Show the "More frames" strip (default: when there is more than one product). */
  browse?: boolean;
  strings?: DeepPartial<Strings>;
  /**
   * UI events for the store's analytics. Carries only product/variant ids and error codes —
   * never images, video or face data.
   */
  onEvent?: (e: TryOnEvent) => void;
  /** Test hook: keep the WebGL drawing buffer (pixel reads outside the render task). */
  preserveDrawingBuffer?: boolean;
}

const ICON = {
  close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  glasses:
    '<svg width="38" height="38" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 22c0-2 1-3 3-3h11c2 0 3 1 3 3v3c0 4-3 7-7 7h-3c-4 0-7-3-7-7z"/><path d="M27 22c0-2 1-3 3-3h11c2 0 3 1 3 3v3c0 4-3 7-7 7h-3c-4 0-7-3-7-7z"/><path d="M21 22c1.5-1.4 4.5-1.4 6 0"/><path d="M4 21l-1-5M44 21l1-5"/></svg>',
  camera: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.6l1.4-2h7l1.4 2h1.6A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><circle cx="12" cy="13" r="3.6"/></svg>',
  lock: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>',
  lockSmall: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>',
  sun: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>',
  alert: '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.4v.1"/></svg>',
  pause: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M9 7v10M15 7v10"/></svg>',
  cameraBig: '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.6l1.4-2h7l1.4 2h1.6A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><circle cx="12" cy="13" r="3.6"/></svg>',
  download: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/></svg>',
  share: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V4M8 8l4-4 4 4M6 12v6.5A1.5 1.5 0 0 0 7.5 20h9a1.5 1.5 0 0 0 1.5-1.5V12"/></svg>',
};

/**
 * The customer-facing "TRY ON VIRTUALLY" modal.
 *
 * Flow: intro (what happens, privacy) → [Start camera, user gesture] → browser permission prompt →
 * loading → live try-on (colours, other frames, photo) → close. Every failure maps to a clear
 * message with a way forward. Closing, or the page going to the background, stops the camera.
 *
 * Accessibility: role=dialog + aria-modal, focus moved in and trapped, Esc closes, focus returns
 * to the opener, live region for hints, swatches are a radio group with arrow-key support.
 */
export class TryOnModal {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly s: Strings;
  private engine: TryOnEngine | null = null;
  private stateValue: TryOnState = 'closed';
  private product: ProductConfig | null = null;
  private variantId: string | null = null;
  private opener: HTMLElement | null = null;
  private session = 0;
  private modelPromise: Promise<void> | null = null;
  private photoUrl: string | null = null;
  private photoBlob: Blob | null = null;
  private lastError: { key: ErrorKey; retry: (() => void) | null } | null = null;
  private prevOverflow = '';
  private resizeObs: ResizeObserver | null = null;

  private readonly $ = <T extends Element = HTMLElement>(sel: string) => this.root.querySelector(sel) as T;

  constructor(private readonly opts: TryOnModalOptions) {
    this.s = mergeStrings(opts.strings);
    this.host = document.createElement('vto-modal');
    this.host.hidden = true;
    this.root = this.host.attachShadow({ mode: 'open' });
    this.root.innerHTML = `<style>${css}</style>${this.template()}`;
    this.bind();
  }

  get state(): TryOnState {
    return this.stateValue;
  }

  /** The engine (created on first open). Exposed for diagnostics and tests. */
  get tryOnEngine(): TryOnEngine | null {
    return this.engine;
  }

  // ================================================================== public API

  async open(productId: string, options: { variantId?: string; opener?: HTMLElement | null } = {}): Promise<void> {
    const product = this.opts.products.find((p) => p.id === productId && p.enabled);
    if (!product) throw new Error(`Unknown product "${productId}"`);
    this.opener = options.opener ?? (document.activeElement as HTMLElement | null);
    if (!this.host.isConnected) document.body.append(this.host);
    const wasClosed = this.stateValue === 'closed';
    this.host.hidden = false;
    if (wasClosed) {
      this.session++;
      this.prevOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      document.addEventListener('keydown', this.onKey, true);
      document.addEventListener('visibilitychange', this.onVisibility);
      this.emit({ type: 'open', productId });
    }
    this.setProduct(product, options.variantId ?? null);

    if (!this.engine && !this.createEngine()) return;
    this.engine!.preloadTracking().catch(() => undefined); // surfaced when the customer starts
    this.loadModel();
    if (wasClosed || this.stateValue === 'error') this.show('intro');
  }

  close(): void {
    if (this.stateValue === 'closed') return;
    this.session++;
    this.engine?.stop();
    this.clearPhoto();
    this.stateValue = 'closed';
    this.host.hidden = true;
    document.documentElement.style.overflow = this.prevOverflow;
    document.removeEventListener('keydown', this.onKey, true);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.emit({ type: 'close', productId: this.product?.id });
    const o = this.opener;
    this.opener = null;
    if (o?.isConnected) o.focus({ preventScroll: true });
  }

  /** Frees everything (camera, GPU, tracking). The modal can't be reopened afterwards. */
  destroy(): void {
    this.close();
    this.resizeObs?.disconnect();
    this.engine?.dispose();
    this.engine = null;
    this.host.remove();
  }

  // ================================================================== engine

  private createEngine(): boolean {
    const canvas = this.$<HTMLCanvasElement>('.gl');
    try {
      this.engine = new TryOnEngine(canvas, {
        assetBase: this.opts.assetBase,
        quality: this.opts.quality ?? 'auto',
        delegate: this.opts.delegate,
        preserveDrawingBuffer: this.opts.preserveDrawingBuffer,
      });
    } catch (err) {
      this.fail(err, null);
      return false;
    }
    const e = this.engine;
    e.guidance.onChange = (h) => this.showHint(h);
    e.camera.onInterrupted = () => {
      e.stop();
      this.fail(new CameraError('interrupted', 'camera stopped'), () => void this.start());
    };
    e.view.onContextLost = () => {
      e.stop();
      this.lastError = null;
      this.showError('context-lost', () => this.rebuildEngine());
    };
    this.resizeObs ??= new ResizeObserver(() => {
      this.engine?.view.resize();
      if (this.engine && !this.engine.running && this.stateValue === 'photo') this.engine.renderStill();
    });
    this.resizeObs.observe(this.$('.stage'));
    return true;
  }

  /** After a WebGL context loss: new canvas + engine (the old context may never come back). */
  private rebuildEngine(): void {
    this.engine?.dispose();
    this.engine = null;
    const old = this.$<HTMLCanvasElement>('.gl');
    const fresh = document.createElement('canvas');
    fresh.className = 'gl';
    old.replaceWith(fresh);
    if (!this.createEngine()) return;
    this.modelPromise = null;
    this.loadModel();
    void this.start();
  }

  private loadModel(): void {
    const e = this.engine;
    const p = this.product;
    if (!e || !p) return;
    if (e.product === p && this.modelPromise) {
      if (this.variantId && e.variant?.id !== this.variantId) void e.setVariant(this.variantId);
      return;
    }
    const promise = e.loadProduct(p, this.variantId ?? undefined);
    this.modelPromise = promise;
    promise.catch(() => {
      if (this.modelPromise === promise) this.modelPromise = null; // retry on next start
    });
  }

  // ================================================================== flow

  /** "Start camera": must run inside the click handler (user gesture → permission prompt). */
  private async start(): Promise<void> {
    const e = this.engine;
    if (!e || !this.product) return;
    const session = this.session;
    const stale = () => session !== this.session || this.stateValue === 'closed';
    this.emit({ type: 'start', productId: this.product.id });
    // Only show "Allow camera access" if the browser actually stops to ask.
    const askTimer = setTimeout(() => !stale() && this.show('waiting'), 350);
    try {
      await e.startCamera();
    } catch (err) {
      clearTimeout(askTimer);
      e.stop();
      if (!stale()) this.fail(err, () => void this.start());
      return;
    }
    clearTimeout(askTimer);
    if (stale()) return e.stop();
    this.$('.gl').classList.toggle('mirror', e.mirrored);
    try {
      if (!e.trackingReady || !this.modelPromise || e.product !== this.product) {
        this.show('loading', this.s.loading);
        if (!this.modelPromise) this.loadModel();
      }
      await Promise.all([e.preloadTracking(), this.modelPromise]);
    } catch (err) {
      e.stop();
      if (!stale()) this.fail(err, () => void this.start());
      return;
    }
    if (stale()) return e.stop();
    e.startTracking();
    this.show('live');
    this.emit({ type: 'live', productId: this.product.id, variantId: e.variant?.id });
  }

  private async takePhoto(): Promise<void> {
    const e = this.engine;
    if (!e || this.stateValue !== 'live') return;
    const shutter = this.$<HTMLButtonElement>('.shutter');
    shutter.disabled = true;
    const flash = this.$('.flash');
    flash.classList.remove('go');
    void flash.offsetWidth;
    flash.classList.add('go');
    try {
      const blob = await e.capture('image/jpeg', 0.92);
      if (this.stateValue !== 'live') return;
      this.clearPhoto();
      this.photoBlob = blob;
      this.photoUrl = URL.createObjectURL(blob);
      e.pauseTracking();
      const img = this.$<HTMLImageElement>('.photo img');
      img.src = this.photoUrl;
      img.alt = `${this.product?.name ?? ''} — ${this.s.photoTitle}`;
      const a = this.$<HTMLAnchorElement>('.save');
      a.href = this.photoUrl;
      a.download = `${slug(this.product?.name ?? 'try-on')}-try-on.jpg`;
      const file = new File([blob], a.download, { type: blob.type });
      this.$<HTMLButtonElement>('.share').hidden = !(navigator.canShare?.({ files: [file] }) ?? false);
      this.show('photo');
      this.emit({ type: 'photo', productId: this.product?.id, variantId: e.variant?.id });
    } catch {
      this.showHint(null, this.s.photoFailed);
    } finally {
      shutter.disabled = false;
    }
  }

  private async sharePhoto(): Promise<void> {
    if (!this.photoBlob) return;
    const name = this.$<HTMLAnchorElement>('.save').download;
    try {
      await navigator.share({ files: [new File([this.photoBlob], name, { type: this.photoBlob.type })], title: this.product?.name });
    } catch {
      /* cancelled by the customer, or not allowed: nothing to do */
    }
  }

  private backToLive(): void {
    this.clearPhoto();
    const e = this.engine;
    if (e?.camera.active) {
      e.startTracking();
      this.show('live');
    } else {
      void this.start();
    }
  }

  private clearPhoto(): void {
    if (this.photoUrl) URL.revokeObjectURL(this.photoUrl);
    this.photoUrl = null;
    this.photoBlob = null;
    const img = this.root.querySelector<HTMLImageElement>('.photo img');
    if (img) img.removeAttribute('src');
  }

  private async switchProduct(p: ProductConfig): Promise<void> {
    if (p === this.product) return;
    this.setProduct(p, null);
    this.emit({ type: 'product', productId: p.id });
    const busy = this.$('.busy');
    busy.querySelector('span')!.textContent = fill(this.s.loadingFrame, p.name);
    busy.hidden = false;
    this.loadModel();
    try {
      await this.modelPromise;
    } catch {
      if (this.product === p) this.showHint(null, this.s.frameFailed);
    } finally {
      if (this.product === p) busy.hidden = true;
    }
  }

  private async selectVariant(id: string): Promise<void> {
    if (!this.product) return;
    this.variantId = id;
    this.renderSwatches();
    this.emit({ type: 'variant', productId: this.product.id, variantId: id });
    if (this.engine?.product === this.product) await this.engine.setVariant(id);
  }

  // ================================================================== errors

  private fail(err: unknown, retry: (() => void) | null): void {
    const code: EngineErrorCode = err instanceof EngineError || err instanceof CameraError ? err.code : 'unknown';
    // Camera problems are the customer's environment, not bugs: warn; anything else is an error.
    if (err instanceof CameraError) console.warn('[vto]', err.code, err.message);
    else console.error('[vto]', err);
    // Problems that a retry can't fix in this browser.
    const final = code === 'insecure-context' || code === 'unsupported' || code === 'webgl-unavailable';
    this.showError(code, final ? null : retry);
  }

  private showError(key: ErrorKey, retry: (() => void) | null): void {
    this.lastError = { key, retry };
    const m = this.s.errors[key];
    const panel = this.$('[data-panel="error"]');
    panel.querySelector('h3')!.textContent = m.title;
    panel.querySelector('.msg')!.textContent = m.body;
    const help = panel.querySelector<HTMLElement>('.help')!;
    help.hidden = key !== 'permission-denied';
    help.textContent = this.s.permissionHelp[permissionHelpKey()];
    panel.querySelector<HTMLButtonElement>('.retry')!.hidden = !retry;
    this.show('error');
    this.emit({ type: 'error', productId: this.product?.id, code: key });
  }

  // ================================================================== rendering the UI

  private show(state: Exclude<TryOnState, 'closed'>, loadingText?: string): void {
    this.stateValue = state;
    const stage = this.$('.stage');
    stage.dataset.state = state;
    for (const p of this.root.querySelectorAll<HTMLElement>('[data-panel]')) p.hidden = p.dataset.panel !== state;
    this.$('.controls').hidden = state !== 'live';
    this.$('.photo').hidden = state !== 'photo';
    this.$('.busy').hidden = true;
    if (state !== 'live') this.showHint(null);
    if (loadingText) this.$('[data-panel="loading"] .msg').textContent = loadingText;
    const focus: Record<string, string> = {
      intro: '.start',
      waiting: '[data-panel="waiting"] .cancel',
      error: this.lastError?.retry ? '.retry' : '[data-panel="error"] .dismiss',
      paused: '.resume',
      live: '.shutter',
      photo: '.save',
      loading: '.close',
    };
    queueMicrotask(() => this.$<HTMLElement>(focus[state])?.focus({ preventScroll: true }));
  }

  private showHint(hint: GuidanceHint, text?: string): void {
    const el = this.$('.hint');
    const msg = text ?? (hint ? this.s.hints[hint] : '');
    if (msg) el.textContent = msg;
    el.classList.toggle('show', !!msg && (this.stateValue === 'live' || !!text));
    if (text) setTimeout(() => el.classList.remove('show'), 3200);
  }

  private setProduct(p: ProductConfig, variantId: string | null): void {
    this.product = p;
    this.variantId = p.variants.some((v) => v.id === variantId) ? variantId : p.defaultVariant ?? p.variants[0]?.id ?? null;
    this.$('.title-name').textContent = p.name;
    this.$('.price').textContent = p.price ?? '';
    this.$('[data-panel="intro"] h3').textContent = fill(this.s.introTitle, p.name);
    this.renderSwatches();
    this.renderFrames();
  }

  private renderSwatches(): void {
    const p = this.product;
    const box = this.$('.swatches');
    box.textContent = '';
    if (!p) return;
    const current = p.variants.find((v) => v.id === this.variantId);
    this.$('.colour-label strong').textContent = current?.label ?? '';
    this.$('.colour').hidden = p.variants.length === 0;
    for (const v of p.variants) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(v.id === this.variantId));
      b.setAttribute('aria-label', v.label);
      b.title = v.label;
      b.tabIndex = v.id === this.variantId ? 0 : -1;
      b.style.setProperty('--c', v.swatch);
      b.dataset.variant = v.id;
      box.append(b);
    }
  }

  private renderFrames(): void {
    const list = this.opts.products.filter((p) => p.enabled);
    const show = (this.opts.browse ?? list.length > 1) && list.length > 1;
    const wrap = this.$('.frames-wrap');
    wrap.hidden = !show;
    if (!show) return;
    const box = this.$('.frames');
    box.textContent = '';
    for (const p of list) {
      const b = document.createElement('button');
      b.className = 'frame-chip';
      b.setAttribute('aria-pressed', String(p === this.product));
      b.dataset.product = p.id;
      if (p.image) {
        const img = document.createElement('img');
        img.src = p.image;
        img.alt = '';
        img.loading = 'lazy';
        b.append(img);
      }
      b.append(p.name);
      box.append(b);
    }
  }

  private template(): string {
    const s = this.s;
    const esc = escapeHtml;
    return `
<div class="backdrop" part="backdrop"></div>
<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="vto-title" part="dialog">
  <div class="stage" data-state="intro">
    <canvas class="gl"></canvas>

    <section class="panel" data-panel="intro">
      <div class="card">
        <div class="art">${ICON.glasses}</div>
        <h3></h3>
        <ul class="points">
          <li>${ICON.camera}<span>${esc(s.introLive)}</span></li>
          <li>${ICON.lock}<span>${esc(s.introPrivate)}</span></li>
          <li>${ICON.sun}<span class="muted">${esc(s.introTips)}</span></li>
        </ul>
        <button class="btn primary start">${esc(s.start)}</button>
        <p class="fine">${esc(s.permissionNote)}</p>
      </div>
    </section>

    <section class="panel" data-panel="waiting" hidden>
      <div class="card" role="status">
        <div class="art">${ICON.cameraBig}</div>
        <h3>${esc(s.waitingTitle)}</h3>
        <p>${esc(s.waitingBody)}</p>
        <div class="actions"><button class="btn secondary cancel">${esc(s.cancel)}</button></div>
      </div>
    </section>

    <section class="panel" data-panel="loading" hidden>
      <div class="card" role="status"><div class="spinner"></div><p class="msg">${esc(s.loading)}</p></div>
    </section>

    <section class="panel" data-panel="error" hidden>
      <div class="card" role="alert">
        <div class="art">${ICON.alert}</div>
        <h3></h3>
        <p class="msg"></p>
        <p class="help" hidden></p>
        <div class="actions">
          <button class="btn primary retry">${esc(s.retry)}</button>
          <button class="btn secondary dismiss">${esc(s.closeButton)}</button>
        </div>
      </div>
    </section>

    <section class="panel" data-panel="paused" hidden>
      <div class="card">
        <div class="art">${ICON.pause}</div>
        <h3>${esc(s.pausedTitle)}</h3>
        <p>${esc(s.pausedBody)}</p>
        <div class="actions"><button class="btn primary resume">${esc(s.resume)}</button></div>
      </div>
    </section>

    <div class="busy" role="status" hidden><div class="spinner"></div><span></span></div>
    <div class="hint" aria-live="polite"></div>
    <div class="flash"></div>

    <div class="controls" hidden>
      <div class="left">
        <div class="colour">
          <div class="colour-label">${esc(s.colour)}: <strong></strong></div>
          <div class="swatches" role="radiogroup" aria-label="${esc(s.colour)}"></div>
        </div>
      </div>
      <button class="shutter" aria-label="${esc(s.takePhoto)}" title="${esc(s.takePhoto)}"></button>
      <div class="right">
        <div class="frames-wrap" hidden>
          <div class="frames-label">${esc(s.moreFrames)}</div>
          <div class="frames" role="group" aria-label="${esc(s.moreFrames)}"></div>
        </div>
        <span class="badge">${ICON.lockSmall}${esc(s.privacyBadge)}</span>
      </div>
    </div>

    <div class="photo" hidden>
      <img alt="" />
      <div class="bar">
        <p class="note">${esc(s.photoNote)}</p>
        <button class="btn secondary back">${esc(s.retake)}</button>
        <button class="btn secondary share" hidden>${ICON.share}${esc(s.share)}</button>
        <a class="btn primary save" href="#">${ICON.download}${esc(s.download)}</a>
      </div>
    </div>
  </div>

  <header class="top">
    <div>
      <span class="eyebrow">${esc(s.eyebrow)}</span>
      <h2 class="title" id="vto-title"><span class="title-name"></span><span class="price"></span></h2>
    </div>
    <button class="icon-btn close" aria-label="${esc(s.close)}">${ICON.close}</button>
  </header>
</div>`;
  }

  private bind(): void {
    const on = (sel: string, fn: (ev: Event) => void) => this.$(sel).addEventListener('click', fn);
    on('.close', () => this.close());
    on('.backdrop', () => this.close());
    on('.start', () => void this.start());
    on('.cancel', () => {
      this.session++;
      this.engine?.stop();
      this.show('intro');
    });
    on('.retry', () => {
      const r = this.lastError?.retry;
      if (r) r();
    });
    on('.dismiss', () => this.close());
    on('.resume', () => void this.start());
    on('.shutter', () => void this.takePhoto());
    on('.back', () => this.backToLive());
    on('.share', () => void this.sharePhoto());
    on('.swatches', (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('.swatch');
      if (b?.dataset.variant) void this.selectVariant(b.dataset.variant);
    });
    on('.frames', (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('.frame-chip');
      const p = this.opts.products.find((x) => x.id === b?.dataset.product);
      if (p) void this.switchProduct(p);
    });
    // Radio-group arrow keys.
    this.$('.swatches').addEventListener('keydown', (ev) => {
      const k = (ev as KeyboardEvent).key;
      const p = this.product;
      if (!p || !['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(k)) return;
      ev.preventDefault();
      const i = p.variants.findIndex((v) => v.id === this.variantId);
      const n = p.variants.length;
      const next = p.variants[(i + (k === 'ArrowRight' || k === 'ArrowDown' ? 1 : n - 1)) % n];
      void this.selectVariant(next.id).then(() => this.$<HTMLElement>(`.swatch[data-variant="${CSS.escape(next.id)}"]`)?.focus());
    });
  }

  private readonly onKey = (ev: KeyboardEvent): void => {
    if (this.stateValue === 'closed') return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      this.close();
      return;
    }
    if (ev.key !== 'Tab') return;
    // Focus trap inside the dialog.
    const items = [...this.root.querySelectorAll<HTMLElement>('button, a[href], [tabindex="0"]')].filter(
      (el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0 && el.getClientRects().length > 0 && !el.closest('[hidden]'),
    );
    if (!items.length) return;
    const active = this.root.activeElement as HTMLElement | null;
    const i = active ? items.indexOf(active) : -1;
    const next = ev.shiftKey ? (i <= 0 ? items[items.length - 1] : items[i - 1]) : i === -1 || i === items.length - 1 ? items[0] : items[i + 1];
    ev.preventDefault();
    next.focus();
  };

  private readonly onVisibility = (): void => {
    if (!document.hidden || !this.engine) return;
    // Privacy + battery: never keep the camera on in a background tab.
    if (this.stateValue === 'live' || this.stateValue === 'waiting' || this.stateValue === 'loading') {
      this.session++;
      this.engine.stop();
      this.show('paused');
    } else if (this.stateValue === 'photo') {
      this.engine.stop(); // keep the photo; "Back to try-on" restarts the camera
    }
  };

  private emit(e: TryOnEvent): void {
    try {
      this.opts.onEvent?.(e);
    } catch (err) {
      console.error('[vto] onEvent handler failed', err);
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'try-on';
}
