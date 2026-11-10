import { resolve } from 'node:path';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// `vite --mode https` serves over HTTPS with a self-signed certificate so phones on the same
// network can use the camera (browsers only allow getUserMedia on HTTPS or localhost).
export default defineConfig(({ mode }) => ({
  // Relative base so the built bundle can later be served from a WordPress plugin directory.
  base: './',
  plugins: mode === 'https' ? [basicSsl()] : [],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        tracking: resolve(__dirname, 'demo/tracking.html'),
        tryon: resolve(__dirname, 'demo/tryon.html'),
        viewer: resolve(__dirname, 'demo/viewer.html'),
      },
    },
  },
}));
