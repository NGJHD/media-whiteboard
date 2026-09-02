import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { bundles, root } from './esbuild.config.mjs';

await rm(path.join(root, 'dist'), { recursive: true, force: true });

await Promise.all(bundles('production').map((cfg) => esbuild(cfg)));
await viteBuild();

console.log('\nBuilt dist/main, dist/preload, dist/renderer.');
