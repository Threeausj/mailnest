import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function precacheShell() {
  let assets: string[] = [];
  return {
    name: 'mailnest-precache-shell',
    generateBundle(_options: unknown, bundle: Record<string, unknown>) {
      assets = Object.keys(bundle).filter((name) => /^assets\/.*\.(js|css)$/.test(name)).map((name) => `/${name}`).sort();
    },
    closeBundle() {
      const path = fileURLToPath(new URL('./dist/sw.js', import.meta.url));
      const source = readFileSync(path, 'utf8');
      const hash = createHash('sha256').update(source + assets.join('\n')).digest('hex').slice(0, 16);
      writeFileSync(path, source
        .replace("'__MAILNEST_CACHE_VERSION__'", JSON.stringify(`mailnest-shell-${hash}`))
        .replace('/* __MAILNEST_PRECACHE_ASSETS__ */ []', JSON.stringify(assets)));
    },
    apply: 'build' as const,
  };
}

export default defineConfig({
  plugins: [react(), precacheShell()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3001' } },
  build: { sourcemap: false },
});
