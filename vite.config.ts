import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the built bundle can later be served from a WordPress plugin directory.
  base: './',
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        tracking: resolve(__dirname, 'demo/tracking.html'),
      },
    },
  },
});
