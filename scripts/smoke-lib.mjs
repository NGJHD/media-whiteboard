/**
 * Shared harness for the renderer smoke tests.
 *
 * Boots the real app in dev mode, evaluates an expression in the renderer, and
 * returns what it resolved to. Results travel through a file, not stdout: an
 * Electron GUI process on Windows does not reliably attach to a parent console,
 * so a piped console.log is lost and every failure looks like a hang.
 */
import { context as esbuildContext } from 'esbuild';
import { createServer } from 'vite';
import electronPath from 'electron';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { bundles, root } from './esbuild.config.mjs';

export const workDir = path.join(root, 'resources', '.download', 'smoke');
fs.mkdirSync(workDir, { recursive: true });

export async function startHarness() {
  // Any free port: vite.config.ts pins 5273 with strictPort for dev, and a smoke
  // run must not collide with a dev server the developer already has open.
  const server = await createServer({ server: { port: 0, strictPort: false } });
  await server.listen();
  const url = server.resolvedUrls?.local?.[0];
  if (!url) throw new Error('Vite dev server did not report a local URL');

  const contexts = await Promise.all(
    bundles('development').map((cfg) => esbuildContext({ ...cfg, logLevel: 'warning' })),
  );
  await Promise.all(contexts.map((c) => c.rebuild()));

  return {
    /** Runs one expression in a fresh app instance and returns its result. */
    run(expression, { timeoutMs = 120_000, env = {} } = {}) {
      return new Promise((resolve) => {
        const resultPath = path.join(workDir, `result-${process.pid}-${Date.now()}.json`);
        fs.rmSync(resultPath, { force: true });

        const child = spawn(electronPath, [path.join(root, 'dist/main/index.cjs')], {
          env: {
            ...process.env,
            ...env,
            VITE_DEV_SERVER_URL: url,
            MW_SMOKE: expression,
            MW_SMOKE_OUT: resultPath,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let out = '';
        let err = '';
        child.stdout.on('data', (d) => (out += d.toString()));
        child.stderr.on('data', (d) => (err += d.toString()));
        const output = () => [out.trim(), err.trim()].filter(Boolean).join('\n') || '(no output)';

        const timer = setTimeout(() => {
          child.kill();
          resolve({ ok: false, error: `timed out after ${timeoutMs}ms`, detail: output() });
        }, timeoutMs);

        child.on('exit', () => {
          clearTimeout(timer);
          if (!fs.existsSync(resultPath)) {
            resolve({ ok: false, error: 'app produced no result', detail: output() });
            return;
          }
          try {
            resolve(JSON.parse(fs.readFileSync(resultPath, 'utf8')));
          } catch (e) {
            resolve({ ok: false, error: `unparsable result: ${e.message}`, detail: output() });
          } finally {
            fs.rmSync(resultPath, { force: true });
          }
        });
      });
    },

    async stop() {
      await Promise.all(contexts.map((c) => c.dispose()));
      await server.close();
    },
  };
}

/** Minimal assertion helpers so each smoke script reads as a checklist. */
export function makeChecker() {
  let failures = 0;
  return {
    check(label, actual, expected) {
      const pass = JSON.stringify(actual) === JSON.stringify(expected);
      if (!pass) failures += 1;
      console.log(
        `  ${pass ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual)}` +
          (pass ? '' : ` (expected ${JSON.stringify(expected)})`),
      );
      return pass;
    },
    truthy(label, value, note = '') {
      const pass = Boolean(value);
      if (!pass) failures += 1;
      console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}${note ? ` — ${note}` : ''}`);
      return pass;
    },
    fail(label) {
      failures += 1;
      console.error(`  FAIL ${label}`);
    },
    get failures() {
      return failures;
    },
  };
}

/**
 * A clip big enough to matter, generated on demand into the smoke work
 * directory rather than committed.
 *
 * Two tests need one, for the same reason: every fixture in `test-fixtures` is
 * small enough to decode instantly and to sit entirely in the §7 in-memory
 * budget, so neither a decode that is still running nor a cache under real
 * eviction pressure can be observed with them.
 *
 * The dimensions are the point, not the length. At 2560x1440 a decoded frame is
 * ~14.7 MB, so only about 34 of these 480 fit in the 512 MB budget — the preview
 * misses on almost every frame, which is the state the reported freeze needed.
 * A 1920x1080 clip fits ~64 frames and the prefetch keeps up, so it never
 * reproduces.
 *
 * mjpeg because it decodes fast — the cost under test is the PNG encode and
 * the renderer's bitmap churn, not this.
 */
export function ensureLargeClip() {
  const file = path.join(workDir, 'large-clip.avi');
  if (fs.existsSync(file)) return file;
  execFileSync(path.join(root, 'resources', 'bin', 'ffmpeg.exe'), [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=2560x1440:rate=60:duration=8',
    '-c:v', 'mjpeg', '-q:v', '3',
    file,
  ]);
  return file;
}

/**
 * A small animated clip that qualifies for preview proxies (§7): its short side
 * is over twice the 320 px target, so the decode writes a `proxy/` set beside
 * the native frames. Square and short, so exporting all of it is cheap.
 */
export function ensureProxyClip() {
  const file = path.join(workDir, 'proxy-clip.avi');
  if (fs.existsSync(file)) return file;
  execFileSync(path.join(root, 'resources', 'bin', 'ffmpeg.exe'), [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=800x800:rate=10:duration=2',
    '-c:v', 'mjpeg', '-q:v', '2',
    file,
  ]);
  return file;
}
