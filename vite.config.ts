import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Renderer only. The main and preload bundles are built by esbuild in scripts/.
export default defineConfig({
  root: 'src/renderer',
  // Relative asset URLs: the packaged renderer is loaded over file://, not http.
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    target: 'chrome152',
    sourcemap: true,
  },
  server: { port: 5273, strictPort: true },
  clearScreen: false,
});
