/**
 * Demo storefront: a product page with a "Try on virtually" button, wired exactly the way a store
 * (and later the WordPress plugin) uses the try-on: createVirtualTryOn() + data-vto-* buttons.
 */
import type { ProductConfig } from '../src/product/catalog';
import { createVirtualTryOn } from '../src/vto';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

const COPY: Record<string, { kind: string; desc: string }> = {
  aria: { kind: 'Eyeglasses · Acetate', desc: 'A softened rectangle cut from hand-polished acetate, with a saddle bridge and riveted five-barrel hinges.' },
  mira: { kind: 'Eyeglasses · Acetate', desc: 'A gentle cat-eye with lifted outer corners. Bold from the front, light on the face.' },
  orbit: { kind: 'Eyeglasses · Titanium', desc: 'A round metal frame with adjustable nose pads and slim temples finished in acetate tips.' },
  pilot: { kind: 'Sunglasses · Metal', desc: 'A teardrop aviator with a double bridge and full UV400 lenses in three finishes.' },
};

const vto = await createVirtualTryOn({
  catalogUrl: new URL('../products/products.json', location.href).href,
  assetBase: import.meta.env.BASE_URL,
  quality: (params.get('quality') as 'high' | 'low' | null) ?? 'auto',
  delegate: params.get('delegate') === 'CPU' ? 'CPU' : 'auto',
  preserveDrawingBuffer: params.has('capture'),
  onEvent: (e) => {
    // Analytics hook: ids and codes only — never images or face data.
    if (e.type === 'variant' && e.productId === product.id && e.variantId) selectVariant(e.variantId, false);
    if (params.has('debug')) console.info('[vto event]', e);
  },
});
vto.bindButtons();

const products = vto.products.filter((p) => p.enabled);
let product: ProductConfig = products.find((p) => p.id === params.get('product')) ?? products[0];
let variantId = product.defaultVariant ?? product.variants[0]?.id;

function renderProduct(): void {
  document.title = `${product.name} — Demo store`;
  $('p-name').textContent = product.name;
  $('p-price').textContent = product.price ?? '';
  $('p-kind').textContent = COPY[product.id]?.kind ?? 'Eyewear';
  $('p-desc').textContent = COPY[product.id]?.desc ?? '';
  const f = product.frame;
  $('p-size').textContent = f.lensWidthMm ? `Size ${f.lensWidthMm}□${f.bridgeMm}-${f.templeLengthMm} · lens height ${f.lensHeightMm} mm` : '';
  $('try').dataset.vtoProduct = product.id;
  const box = $('p-swatches');
  box.textContent = '';
  for (const v of product.variants) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', v.label);
    b.title = v.label;
    b.style.setProperty('--c', v.swatch);
    b.dataset.variant = v.id;
    b.addEventListener('click', () => selectVariant(v.id, true));
    box.append(b);
  }
  selectVariant(variantId!, false);
  renderGrid();
}

function selectVariant(id: string, fromPage: boolean): void {
  const v = product.variants.find((x) => x.id === id);
  if (!v) return;
  variantId = id;
  $('p-colour').textContent = v.label;
  for (const b of $('p-swatches').querySelectorAll<HTMLElement>('.swatch')) {
    const on = b.dataset.variant === id;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  $('try').dataset.vtoVariant = id;
  const img = $<HTMLImageElement>('p-image');
  img.src = v.image ?? product.image ?? '';
  img.alt = `${product.name} in ${v.label}`;
  if (fromPage) history.replaceState(null, '', `?product=${product.id}`);
}

function renderGrid(): void {
  const grid = $('grid');
  grid.textContent = '';
  for (const p of products) {
    if (p === product) continue;
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <a class="img" href="?product=${encodeURIComponent(p.id)}"><img alt="" loading="lazy"></a>
      <div class="body">
        <div><h3></h3><p></p></div>
        <button class="try-sm" type="button" data-vto-product="${encodeURIComponent(p.id)}">Try on</button>
      </div>`;
    card.querySelector('img')!.src = p.image ?? '';
    card.querySelector('img')!.alt = p.name;
    card.querySelector('h3')!.textContent = p.name;
    card.querySelector('p')!.textContent = p.price ?? '';
    card.querySelector<HTMLElement>('.try-sm')!.setAttribute('aria-label', `Try on ${p.name} virtually`);
    card.querySelector('a')!.addEventListener('click', (e) => {
      e.preventDefault();
      product = p;
      variantId = p.defaultVariant ?? p.variants[0]?.id;
      history.pushState(null, '', `?product=${p.id}`);
      renderProduct();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    grid.append(card);
  }
}

$('bag').addEventListener('click', () => {
  $('bag').textContent = 'Demo store — no checkout';
});
window.addEventListener('popstate', () => {
  const id = new URLSearchParams(location.search).get('product');
  product = products.find((p) => p.id === id) ?? products[0];
  variantId = product.defaultVariant ?? product.variants[0]?.id;
  renderProduct();
});

renderProduct();
Object.assign(window, { __shop: { vto } });
document.title += ' (ready)';
