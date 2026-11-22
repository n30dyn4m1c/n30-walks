import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the same build works on a web server AND inside the
// Capacitor native shell (which serves files from the app bundle).
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      // MapLibre is ~1 MB; keep it in its own long-cached chunk.
      output: { manualChunks: { maplibre: ['maplibre-gl'] } },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
} as any);
