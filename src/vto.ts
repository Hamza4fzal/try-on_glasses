/**
 * Public entry point of the virtual try-on.
 *
 *   const vto = await createVirtualTryOn({ catalogUrl: '/products.json', assetBase: '/vto/' });
 *   vto.bindButtons();            // any <button data-vto-product="aria" data-vto-variant="black">
 *   vto.open('aria', { variantId: 'black' });
 *
 * This module is deliberately tiny (catalogue + button wiring, a few KB). Everything heavy loads
 * on demand, in stages, so product pages stay fast:
 *   1. intent (pointer over / focus / touch on a try-on button): the modal UI and the engine
 *      JavaScript (three.js + MediaPipe runtime) are prefetched;
 *   2. open: the modal shows at once; face tracking (wasm + model) and the frame's 3D model
 *      download while the customer reads the intro;
 *   3. "Start camera": the camera is requested immediately (same click), the rest is awaited.
 *
 * The WordPress plugin will call this with the catalogue built from WooCommerce product meta.
 */
import { loadCatalog, sanitizeProduct, type ProductConfig } from './product/catalog';
import type { TryOnEvent, TryOnModal, TryOnModalOptions, TryOnState } from './ui/try-on-modal';

export type { ProductConfig } from './product/catalog';
export type { TryOnEvent, TryOnState } from './ui/try-on-modal';

export type PreloadStrategy = 'intent' | 'idle' | 'none';

export interface VirtualTryOnOptions extends Omit<TryOnModalOptions, 'products'> {
  /** URL of a catalogue JSON ({ products: [...] }). */
  catalogUrl?: string;
  /** Or the raw catalogue products (sanitised here; URLs resolved against `baseUrl`). */
  products?: unknown[];
  baseUrl?: string;
  /**
   * When to download the try-on JavaScript before the first click:
   * 'intent' (default) on hover / focus / touch of a try-on button, 'idle' once the page is idle,
   * 'none' only when opened. Camera, face tracking and 3D models are never preloaded by this.
   */
  preload?: PreloadStrategy;
}

type ModalModule = typeof import('./ui/try-on-modal');
let modalModule: Promise<ModalModule> | null = null;

function loadModalModule(): Promise<ModalModule> {
  modalModule ??= import('./ui/try-on-modal').catch((err) => {
    modalModule = null; // allow a retry on the next click
    throw err;
  });
  return modalModule;
}

const BUTTON = '[data-vto-product]';

export class VirtualTryOn {
  private modal: TryOnModal | null = null;
  private modalPromise: Promise<TryOnModal> | null = null;
  private bound: { root: Document | HTMLElement; click: (e: Event) => void; intent: (e: Event) => void } | null = null;
  private destroyed = false;

  constructor(
    readonly products: ProductConfig[],
    private readonly opts: Omit<TryOnModalOptions, 'products'> & { preload?: PreloadStrategy },
  ) {
    if (opts.preload === 'idle') {
      const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
      const go = () => this.prefetch();
      if (idle) idle(go, { timeout: 4000 });
      else setTimeout(go, 2000);
    }
  }

  get state(): TryOnState {
    return this.modal?.state ?? 'closed';
  }

  /** Downloads the try-on JavaScript (modal + engine) without opening anything. */
  prefetch(): void {
    if (this.destroyed) return;
    loadModalModule()
      .then((m) => m.loadEngineModule())
      .catch(() => undefined); // a real open() retries and reports
  }

  /** Opens the try-on for a product (call from a click handler). */
  async open(productId: string, options: { variantId?: string; opener?: HTMLElement | null } = {}): Promise<void> {
    const opener = options.opener ?? (document.activeElement as HTMLElement | null);
    opener?.setAttribute('aria-busy', 'true');
    try {
      const modal = await this.getModal();
      await modal.open(productId, { ...options, opener });
    } catch (err) {
      console.error('[vto] the try-on could not be opened', err);
      this.emit({ type: 'error', productId, code: 'load-failed' });
      throw err;
    } finally {
      opener?.removeAttribute('aria-busy');
    }
  }

  close(): void {
    this.modal?.close();
  }

  /** Clicks on `[data-vto-product]` (optionally `data-vto-variant`) inside `root` open the try-on. */
  bindButtons(root: Document | HTMLElement = document): void {
    this.unbindButtons();
    const target = (e: Event) => {
      const el = (e.target as Element | null)?.closest?.<HTMLElement>(BUTTON);
      return el && root.contains(el) ? el : null;
    };
    const click = (e: Event) => {
      const el = target(e);
      if (!el) return;
      e.preventDefault();
      this.open(el.dataset.vtoProduct!, { variantId: el.dataset.vtoVariant, opener: el }).catch(() => undefined);
    };
    const intent = (e: Event) => {
      if (this.opts.preload !== 'none' && target(e)) this.prefetch();
    };
    root.addEventListener('click', click);
    for (const type of ['pointerover', 'focusin', 'touchstart']) root.addEventListener(type, intent, { passive: true });
    this.bound = { root, click, intent };
  }

  unbindButtons(): void {
    const b = this.bound;
    if (!b) return;
    b.root.removeEventListener('click', b.click);
    for (const type of ['pointerover', 'focusin', 'touchstart']) b.root.removeEventListener(type, b.intent);
    this.bound = null;
  }

  /** Internal handle for diagnostics and tests (null until first opened). */
  get _modal(): TryOnModal | null {
    return this.modal;
  }

  destroy(): void {
    this.destroyed = true;
    this.unbindButtons();
    this.modal?.destroy();
    this.modal = null;
  }

  private getModal(): Promise<TryOnModal> {
    if (this.destroyed) return Promise.reject(new Error('The try-on was destroyed'));
    if (this.modal) return Promise.resolve(this.modal);
    this.modalPromise ??= loadModalModule()
      .then((m) => {
        if (this.destroyed) throw new Error('The try-on was destroyed');
        this.modal ??= new m.TryOnModal({ ...this.opts, products: this.products });
        void m.loadEngineModule().catch(() => undefined); // start the engine download right away
        return this.modal;
      })
      .finally(() => {
        this.modalPromise = null;
      });
    return this.modalPromise;
  }

  private emit(e: TryOnEvent): void {
    try {
      this.opts.onEvent?.(e);
    } catch (err) {
      console.error('[vto] onEvent handler failed', err);
    }
  }
}

export async function createVirtualTryOn(opts: VirtualTryOnOptions): Promise<VirtualTryOn> {
  const { catalogUrl, products: raw, baseUrl, ...rest } = opts;
  let products: ProductConfig[];
  if (catalogUrl) {
    products = (await loadCatalog(catalogUrl)).products;
  } else {
    const base = new URL(baseUrl ?? location.href, location.href);
    products = (raw ?? [])
      .map(sanitizeProduct)
      .filter((p): p is ProductConfig => !!p)
      .map((p) => ({ ...p, model: new URL(p.model, base).href, image: p.image && new URL(p.image, base).href }));
  }
  return new VirtualTryOn(products, { preload: 'intent', ...rest });
}
