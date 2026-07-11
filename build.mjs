import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('public', 'dist', { recursive: true });
cpSync('THIRD_PARTY_NOTICES.md', 'dist/THIRD_PARTY_NOTICES.md');
mkdirSync('dist/ort', { recursive: true });
for (const asset of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  cpSync(`node_modules/onnxruntime-web/dist/${asset}`, `dist/ort/${asset}`);
}

const options = {
  entryPoints: {
    background: 'src/background.ts',
    popup: 'src/popup.ts',
    content: 'src/content.ts',
    offscreen: 'src/offscreen/main.ts',
    worklet: 'src/offscreen/worklet.ts',
    'vad-worker': 'src/offscreen/vad-worker.ts',
    'vad-capture-worklet': 'src/offscreen/vad-capture-worklet.ts'
  },
  bundle: true,
  outdir: 'dist',
  format: 'iife',
  // Muss public/manifest.json::minimum_chrome_version entsprechen.
  target: 'chrome116',
  sourcemap: false,
  logLevel: 'info'
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
