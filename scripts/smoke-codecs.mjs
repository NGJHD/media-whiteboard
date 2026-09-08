/**
 * Asserts the bundled ffmpeg is the build this project expects: GPL, with
 * libx264 for MP4 (docs/superpowers/specs/2026-09-08-mp4-png-output-formats.md
 * §2) and libwebp for WebP, and without any nonfree component.
 *
 * Cheap and dependency-free, so it can run before the Electron smoke tests.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { root } from './esbuild.config.mjs';

const ffmpeg = path.join(root, 'resources', 'bin', 'ffmpeg.exe');

const version = execFileSync(ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8' });
const config = version.split('\n').find((l) => l.startsWith('configuration:')) ?? '';
const encoders = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' });

let failures = 0;
const check = (label, pass) => {
  if (!pass) failures += 1;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}`);
};

check('configured --enable-gpl', config.includes('--enable-gpl'));
check('configured --enable-libx264', config.includes('--enable-libx264'));
check('configured --enable-libwebp', config.includes('--enable-libwebp'));
check('NOT configured --enable-nonfree', !config.includes('--enable-nonfree'));
check('libx264 encoder present', encoders.includes('libx264'));
check('libwebp_anim encoder present', encoders.includes('libwebp_anim'));
check('native gif encoder present', /^\s*V\S*\s+gif\s/m.test(encoders));
check('native png encoder present', /^\s*V\S*\s+png\s/m.test(encoders));

console.log(failures === 0 ? '\nCodec checks passed.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
