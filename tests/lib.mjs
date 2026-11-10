// Shared helpers for the headless-Chrome test scripts.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
    join(process.env.PROGRAMFILES ?? '', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] ?? '', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] ?? '', 'Microsoft/Edge/Application/msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('Chrome/Edge not found; set CHROME_PATH');
  return found;
}

/** Starts the Vite dev server and a headless Chrome (software WebGL). */
export async function startEnv({ port = 5199 } = {}) {
  const server = await createServer({ logLevel: 'error', server: { port, strictPort: false, host: '127.0.0.1' } });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-first-run'],
  });
  return {
    url,
    browser,
    async close() {
      await browser.close();
      await server.close();
    },
  };
}

/** Logs page errors/console errors and collects them for assertions. */
export function watchErrors(page, label) {
  const errors = [];
  page.on('pageerror', (e) => {
    errors.push(e.message);
    console.error(`[${label} pageerror]`, e.message);
  });
  page.on('console', (m) => {
    // MediaPipe's wasm logs its INFO lines through console.error.
    if (m.type() === 'error' && !/^INFO:/.test(m.text())) {
      errors.push(m.text());
      console.error(`[${label} console]`, m.text());
    }
  });
  return errors;
}

/**
 * Replaces getUserMedia with a canvas stream of test-assets/portrait.jpg (optionally drifting),
 * and records every stream so tests can assert all tracks were stopped.
 */
export function stubCameraScript({ drift = 0 } = {}) {
  return `(() => {
    const streams = [];
    window.__streams = streams;
    navigator.mediaDevices.getUserMedia = async () => {
      const img = new Image();
      img.src = '/test-assets/portrait.jpg';
      await img.decode();
      const c = document.createElement('canvas');
      c.width = 1280; c.height = 720;
      const ctx = c.getContext('2d');
      let t = 0;
      const draw = () => {
        ctx.fillStyle = '#6b6259';
        ctx.fillRect(0, 0, 1280, 720);
        ctx.drawImage(img, 640 - 400 * 1.15 + ${drift} * Math.sin(t / 20), 360 - 200 * 1.15, 820 * 1.15, 1024 * 1.15);
        t++;
      };
      draw();
      setInterval(draw, 33);
      const s = c.captureStream(30);
      streams.push(s);
      return s;
    };
  })();`;
}
