import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The window's user interface. Loaded from disk by the main process, so all paths are relative.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
});
