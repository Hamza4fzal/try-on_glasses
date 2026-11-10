/**
 * Public entry point of the virtual try-on.
 *
 *   const vto = await createVirtualTryOn({ catalogUrl: '/products.json', assetBase: '/vto/' });
 *   vto.bindButtons();            // any <button data-vto-product="aria" data-vto-variant="black">
 *   vto.open('aria', { variantId: 'black' });
 *
 * The WordPress plugin will call this with the catalogue built from WooCommerce product meta.
 */
import { loadCatalog, sanitizeProduct, type ProductConfig } from './product/catalog';
import { TryOnModal, type TryOnModalOptions } from './ui/try-on-modal';

export type { ProductConfig } from './product/catalog';
export type { TryOnEvent, TryOnState } from './ui/try-on-modal';

export interface VirtualTryOnOptions extends Omit<TryOnModalOptions, 'products'> {
  /** URL of a catalogue JSON ({ products: [...] }). */
  catalogUrl?: string;
  /** Or the raw catalogue products (sanitised here; URLs resolved against `baseUrl`). */
  products?: unknown[];
  baseUrl?: string;
}

export class VirtualTryOn {
  private readonly modal: TryOnModal;
  private bound: { root: Document | HTMLElement; fn: (e: Event) => void } | null = null;

  constructor(
    readonly products: ProductConfig[],
    opts: Omit<TryOnModalOptions, 'products'>,
  ) {
    this.modal = new TryOnModal({ ...opts, products });
  }

  get state() {
    return this.modal.state;
  }

  /** Opens the try-on for a product (call from a click handler). */
  open(productId: string, options?: { variantId?: string; opener?: HTMLElement | null }): Promise<void> {
    return this.modal.open(productId, options);
  }

  close(): void {
    this.modal.close();
  }

  /** Clicks on `[data-vto-product]` (optionally `data-vto-variant`) inside `root` open the try-on. */
  bindButtons(root: Document | HTMLElement = document): void {
    this.unbindButtons();
    const fn = (e: Event) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-vto-product]');
      if (!el || !root.contains(el)) return;
      e.preventDefault();
      void this.open(el.dataset.vtoProduct!, { variantId: el.dataset.vtoVariant, opener: el });
    };
    root.addEventListener('click', fn);
    this.bound = { root, fn };
  }

  unbindButtons(): void {
    this.bound?.root.removeEventListener('click', this.bound.fn);
    this.bound = null;
  }

  /** Internal handle for diagnostics and tests. */
  get _modal(): TryOnModal {
    return this.modal;
  }

  destroy(): void {
    this.unbindButtons();
    this.modal.destroy();
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
  return new VirtualTryOn(products, rest);
}
