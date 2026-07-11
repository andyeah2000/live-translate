import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('public', 'dist', { recursive: true });

const options = {
  entryPoints: {
    background: 'src/background.ts',
    popup: 'src/popup.ts',
    content: 'src/content.ts',
    offscreen: 'src/offscreen/main.ts',
    worklet: 'src/offscreen/worklet.ts'
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
