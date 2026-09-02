import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Main and preload are bundled to CJS. Preload must be CJS to load under
 * contextIsolation without extra flags, and keeping main the same avoids two
 * module systems in one process tree.
 *
 * `electron` is external: it is resolved from the runtime, not bundled.
 */
export function bundles(mode) {
  const shared = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    sourcemap: true,
    minify: mode === 'production',
    define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
    logLevel: 'info',
  };

  return [
    {
      ...shared,
      entryPoints: [path.join(root, 'src/main/index.ts')],
      outfile: path.join(root, 'dist/main/index.cjs'),
    },
    {
      ...shared,
      entryPoints: [path.join(root, 'src/preload/index.ts')],
      outfile: path.join(root, 'dist/preload/index.cjs'),
    },
  ];
}

export { root };
