import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The UI builds into public/, which the API server serves. Assets are never inlined (the CSP allows only 'self').
export default defineConfig({
  root: 'ui',
  plugins: [react()],
  build: { outDir: '../public', emptyOutDir: true, assetsInlineLimit: 0, sourcemap: false },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3100', '/healthz': 'http://127.0.0.1:3100' } },
});
