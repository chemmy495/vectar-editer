// Build script: bundles the Electron main process, the preload script and the
// renderer UI with esbuild. Run with `--watch` to rebuild on change.
import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  target: 'es2022',
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
};

const targets = [
  {
    ...common,
    entryPoints: [resolve(root, 'src/main/main.ts')],
    outfile: resolve(root, 'dist/main/main.js'),
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  },
  {
    ...common,
    entryPoints: [resolve(root, 'src/main/preload.ts')],
    outfile: resolve(root, 'dist/main/preload.js'),
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  },
  {
    ...common,
    entryPoints: [resolve(root, 'src/renderer/main.ts')],
    outfile: resolve(root, 'dist/renderer/main.js'),
    platform: 'browser',
    format: 'iife',
  },
];

async function copyStatic() {
  await mkdir(resolve(root, 'dist/renderer'), { recursive: true });
  for (const file of ['index.html', 'styles.css']) {
    await cp(resolve(root, 'src/renderer', file), resolve(root, 'dist/renderer', file));
  }
}

if (watch) {
  await copyStatic();
  const contexts = await Promise.all(targets.map((t) => context(t)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('[build] watching for changes...');
} else {
  await rm(resolve(root, 'dist'), { recursive: true, force: true });
  await Promise.all(targets.map((t) => build(t)));
  await copyStatic();
  console.log('[build] done');
}
