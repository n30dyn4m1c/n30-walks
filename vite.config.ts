import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * After the build, write the list of output files and a hash of their contents
 * into dist/sw.js, so the service worker precaches the whole app (including the
 * lazily loaded Studio chunk) and every deploy gets a fresh cache name.
 */
function precacheManifest(): Plugin {
  let outDir = 'dist';
  return {
    name: 'stride-precache-manifest',
    apply: 'build',
    configResolved(c) { outDir = resolve(c.root, c.build.outDir); },
    closeBundle() {
      const swPath = join(outDir, 'sw.js');
      const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
        .flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
      const files = walk(outDir)
        .filter((f) => f !== swPath && !f.endsWith('.map'))
        .map((f) => relative(outDir, f).split(sep).join('/'))
        .sort();
      const hash = createHash('sha256');
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      const version = hash.digest('hex').slice(0, 12);
      const sw = readFileSync(swPath, 'utf8')
        .replace(/const VERSION = .*?; \/\*__VERSION__\*\//, `const VERSION = ${JSON.stringify(version)};`)
        .replace(/const PRECACHE = .*?; \/\*__PRECACHE__\*\//, `const PRECACHE = ${JSON.stringify(files)};`);
      if (!sw.includes(version) || sw.includes('__PRECACHE__')) throw new Error('precacheManifest: markers not found in sw.js');
      writeFileSync(swPath, sw);
    },
  };
}

// Relative base so the same build works on a web server AND inside the
// Capacitor native shell (which serves files from the app bundle).
export default defineConfig({
  base: './',
  plugins: [react(), precacheManifest()],
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
