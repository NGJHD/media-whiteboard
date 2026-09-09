/**
 * End-to-end smoke test for the export pipe (CLAUDE.md §16 step 2).
 *
 * Runs a real export through the real transport: renderer canvas -> MessagePort
 * transfer -> main -> ffmpeg -> file on disk. Then verifies with ffprobe that the
 * result is actually an animation with the expected frame count and dimensions,
 * because ffmpeg exiting 0 does not by itself prove the file loops.
 *
 * Usage: node scripts/smoke-export.mjs [all|webp|gif|mp4|png|webp,mp4]
 *   MW_W / MW_H / MW_FPS / MW_FRAMES / MW_QUALITY override the case defaults.
 */
import { context as esbuildContext } from 'esbuild';
import { createServer } from 'vite';
import electronPath from 'electron';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { bundles, root } from './esbuild.config.mjs';

const which = process.argv[2] ?? 'all';

const outDir = path.join(root, 'resources', '.download', 'smoke');
fs.mkdirSync(outDir, { recursive: true });

const ffprobe = path.join(root, 'resources', 'bin', 'ffprobe.exe');
const ffmpeg = path.join(root, 'resources', 'bin', 'ffmpeg.exe');

// Overridable so the same harness can measure throughput at a realistic canvas
// size, and so the size estimate can be calibrated per quality.
const num = (name, fallback) => Number(process.env[name] ?? fallback);
const W = num('MW_W', 320);
const H = num('MW_H', 180);
const QUALITY = process.env.MW_QUALITY ?? 'high';

/**
 * ffprobe's codec name per format, and the dimensions to expect back.
 *
 * MP4 is the only format whose output may differ from the canvas: H.264 needs
 * even dimensions, and the spec pads rather than crops
 * (docs/superpowers/specs/2026-09-08-mp4-png-output-formats.md §3). The odd case
 * exists to prove the pad, because ffmpeg's default behaviour is to silently
 * crop instead.
 */
const FORMATS = {
  // ffprobe reports the animated WebP decoder as webp_anim, not webp.
  webp: { codec: 'webp_anim', frames: num('MW_FRAMES', 30) },
  gif: { codec: 'gif', frames: num('MW_FRAMES', 30) },
  mp4: { codec: 'h264', frames: num('MW_FRAMES', 30) },
  png: { codec: 'png', frames: 1 },
};

const even = (n) => n + (n % 2);

const formats = which === 'all' ? Object.keys(FORMATS) : which.split(',');

const CASES = [];
for (const format of formats) {
  const spec = FORMATS[format];
  if (!spec) throw new Error(`Unknown format "${format}". Try: ${Object.keys(FORMATS).join(', ')}`);
  CASES.push({
    format,
    codec: spec.codec,
    width: W,
    height: H,
    expectWidth: format === 'mp4' ? even(W) : W,
    expectHeight: format === 'mp4' ? even(H) : H,
    fps: num('MW_FPS', 25),
    frameCount: spec.frames,
    expectFrames: spec.frames,
    quality: QUALITY,
    outputPath: path.join(outDir, `smoke.${format}`),
  });
}

// §3: an odd canvas must gain a pixel, not lose one. Only MP4 constrains this.
if (formats.includes('mp4')) {
  CASES.push({
    format: 'mp4',
    codec: 'h264',
    width: 321,
    height: 181,
    expectWidth: 322,
    expectHeight: 182,
    fps: 25,
    frameCount: 10,
    expectFrames: 10,
    quality: QUALITY,
    outputPath: path.join(outDir, 'smoke-odd.mp4'),
    label: 'mp4 (odd canvas)',
  });

  // encoder.ts's mp4Filters() `-filter_complex` branch (composite over black,
  // then discard alpha) only runs when the document has transparency. It is
  // otherwise untested here — the base mp4 case above never sets `transparent`,
  // so it only ever exercises the `-vf` branch. Exercise the alpha-composited
  // branch directly: __mwProbe leaves the right half of the frame fully
  // transparent (gradientProbe.ts), and this asserts that region decodes to
  // black rather than keeping the gradient colour alpha was supposed to hide.
  CASES.push({
    format: 'mp4',
    codec: 'h264',
    width: W,
    height: H,
    expectWidth: even(W),
    expectHeight: even(H),
    fps: num('MW_FPS', 25),
    frameCount: 10,
    expectFrames: 10,
    quality: QUALITY,
    outputPath: path.join(outDir, 'smoke-transparent.mp4'),
    label: 'mp4 (transparent)',
    transparent: true,
  });
}

// Pick any free port: vite.config.ts pins 5273 with strictPort for dev, and the
// smoke test must not collide with a dev server the developer already has open.
const server = await createServer({ server: { port: 0, strictPort: false } });
await server.listen();
const url = server.resolvedUrls?.local?.[0];

const contexts = await Promise.all(
  bundles('development').map((cfg) => esbuildContext({ ...cfg, logLevel: 'warning' })),
);
await Promise.all(contexts.map((c) => c.rebuild()));

let failures = 0;

for (const testCase of CASES) {
  fs.rmSync(testCase.outputPath, { force: true });

  const spec = `window.__mwProbe(${JSON.stringify({
    width: testCase.width,
    height: testCase.height,
    fps: testCase.fps,
    frameCount: testCase.frameCount,
    format: testCase.format,
    quality: testCase.quality,
    outputPath: testCase.outputPath,
    transparent: testCase.transparent ?? false,
  })})`;

  process.stdout.write(`\n=== ${testCase.label ?? testCase.format} ===\n`);
  const result = await runOnce(spec);

  if (!result || result.ok !== true) {
    console.error(`  FAIL: ${result?.error ?? 'no result'}`);
    if (result?.detail) console.error(result.detail);
    for (const line of result?.log ?? []) console.error(`    ${line}`);
    failures += 1;
    continue;
  }

  const perFrame = result.elapsedMs / testCase.frameCount;
  const mb = (testCase.width * testCase.height * 4 * testCase.frameCount) / 1e6;
  console.log(
    `  wrote ${(result.bytes / 1024).toFixed(1)} KB in ${result.elapsedMs} ms ` +
      `(${perFrame.toFixed(1)} ms/frame, ${mb.toFixed(0)} MB of raw pixels moved)`,
  );

  if (!verify(testCase)) failures += 1;
  if (testCase.transparent && !verifyTransparentRegion(testCase)) failures += 1;
}

await Promise.all(contexts.map((c) => c.dispose()));
await server.close();

console.log(failures === 0 ? '\nAll export smoke tests passed.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);

function runOnce(spec) {
  return new Promise((resolve) => {
    // An Electron GUI process on Windows does not reliably attach to a parent
    // console, so the result comes back through a file, not stdout.
    const resultPath = path.join(outDir, 'result.json');
    fs.rmSync(resultPath, { force: true });

    const child = spawn(electronPath, [path.join(root, 'dist/main/index.cjs')], {
      env: { ...process.env, VITE_DEV_SERVER_URL: url, MW_SMOKE: spec, MW_SMOKE_OUT: resultPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });

    /** A silent timeout is undebuggable; report whatever the app said. */
    const output = () => [out.trim(), err.trim()].filter(Boolean).join('\n') || '(no output)';

    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: 'timed out after 120s', detail: output() });
    }, 120_000);

    child.on('exit', () => {
      clearTimeout(timer);
      const line = out.split(/\r?\n/).find((l) => l.startsWith('SMOKE_RESULT '));
      if (!line) {
        return resolve({ ok: false, error: 'renderer produced no result', detail: output() });
      }
      try {
        resolve(JSON.parse(line.slice('SMOKE_RESULT '.length)));
      } catch (err) {
        resolve({ ok: false, error: `unparsable result: ${err.message}` });
      }
    });
  });
}

/** ffmpeg exiting 0 does not prove the file animates. Ask ffprobe what landed. */
function verify(testCase) {
  if (!fs.existsSync(testCase.outputPath)) {
    console.error('  FAIL: output file does not exist');
    return false;
  }

  const probe = JSON.parse(
    execFileSync(
      ffprobe,
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-count_frames',
        '-show_entries', 'stream=width,height,nb_read_frames,codec_name',
        '-of', 'json',
        testCase.outputPath,
      ],
      { encoding: 'utf8' },
    ),
  );

  const stream = probe.streams?.[0];
  if (!stream) {
    console.error('  FAIL: ffprobe found no video stream');
    return false;
  }

  const frames = Number(stream.nb_read_frames);
  const checks = [
    ['codec', stream.codec_name, testCase.codec],
    ['width', Number(stream.width), testCase.expectWidth],
    ['height', Number(stream.height), testCase.expectHeight],
    ['frames', frames, testCase.expectFrames],
  ];

  let ok = true;
  for (const [label, actual, expected] of checks) {
    const pass = actual === expected;
    if (!pass) ok = false;
    console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}: ${actual}${pass ? '' : ` (expected ${expected})`}`);
  }
  return ok;
}

/**
 * Guards encoder.ts's `-filter_complex` branch (mp4Filters, transparent case):
 * decodes a 4x4 patch from well inside the right half of the frame — the half
 * gradientProbe.ts leaves fully transparent when `transparent: true` — and
 * asserts it composited to black. A colour other than 0,0,0 there means alpha
 * was dropped instead of composited, which is the exact regression this guards.
 */
function verifyTransparentRegion(testCase) {
  const x = Math.floor(testCase.expectWidth * 0.75);
  const y = Math.floor(testCase.expectHeight / 2);

  const raw = execFileSync(ffmpeg, [
    '-v', 'error',
    '-i', testCase.outputPath,
    '-vf', `crop=4:4:${x}:${y}`,
    '-frames:v', '1',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    '-',
  ]);

  const [r, g, b] = raw;
  const pass = r === 0 && g === 0 && b === 0;
  console.log(
    `  ${pass ? 'ok  ' : 'FAIL'} transparent region RGB: ${r} ${g} ${b}${pass ? '' : ' (expected 0 0 0)'}`,
  );
  return pass;
}
