/**
 * Fetches the pinned GPL ffmpeg build into resources/bin/ (see
 * docs/superpowers/specs/2026-09-08-mp4-png-output-formats.md §2 for why GPL).
 *
 * The binaries are not committed: they are ~110 MB each, above GitHub's 100 MB
 * hard file limit. This runs at build time; the packaged app ships them via
 * electron-builder extraResources, so an end user never fetches anything.
 *
 * Everything here is checksum-verified, and the extracted ffmpeg is re-inspected
 * for its licence flags before it is accepted.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const binDir = path.join(root, 'resources', 'bin');
const downloadDir = path.join(root, 'resources', '.download');

const build = JSON.parse(fs.readFileSync(path.join(scriptDir, 'ffmpeg-build.json'), 'utf8'));

const WANTED = ['ffmpeg.exe', 'ffprobe.exe'];

/** Configure flags that would change this project's license obligations. */
const FORBIDDEN_FLAGS = ['--enable-nonfree'];
/**
 * Required. `--enable-gpl` and `--enable-libx264` are deliberate: MP4 output
 * needs CRF, CRF needs libx264, libx264 is GPL. libopenh264 in the LGPL build
 * has no CRF and no way to gain one. See
 * docs/superpowers/specs/2026-09-08-mp4-png-output-formats.md §2.
 *
 * `--enable-libwebp` is not optional either: without it §12 cannot encode WebP,
 * and not every build includes it.
 */
const REQUIRED_FLAGS = ['--enable-gpl', '--enable-libx264', '--enable-libwebp'];

function sha256(file) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function have(name) {
  const file = path.join(binDir, name);
  if (!fs.existsSync(file)) return false;
  return sha256(file) === build.binaries[name];
}

async function download(url, dest) {
  process.stdout.write(`  downloading ${path.basename(dest)} … `);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  await fsp.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  const mb = (fs.statSync(dest).size / 1e6).toFixed(1);
  console.log(`${mb} MB`);
}

/**
 * Windows ships bsdtar as tar.exe, which reads zips and is far faster than
 * Expand-Archive on a 140 MB archive. Expand-Archive is the fallback.
 */
function extract(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  try {
    execFileSync('tar.exe', ['-xf', zip, '-C', dest], { stdio: 'pipe' });
  } catch {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`],
      { stdio: 'pipe' },
    );
  }
}

function findBinary(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findBinary(full, name);
      if (hit) return hit;
    } else if (entry.name.toLowerCase() === name) {
      return full;
    }
  }
  return null;
}

/**
 * Re-verify the licensing of what actually landed on disk, not what the pin file
 * claims. A wrong URL or a swapped asset would otherwise ship a build that is
 * not GPL, lacks libx264 or libwebp, or is nonfree.
 */
function verifyLicense(ffmpegExe) {
  const out = execFileSync(ffmpegExe, ['-hide_banner', '-version'], { encoding: 'utf8' });
  const configLine = out.split('\n').find((l) => l.startsWith('configuration:')) ?? '';

  const violations = FORBIDDEN_FLAGS.filter((f) => configLine.includes(f));
  if (violations.length > 0) {
    throw new Error(
      `Refusing this ffmpeg build: it was configured with ${violations.join(', ')}. ` +
        `A nonfree component cannot be redistributed at all.`,
    );
  }

  const missing = REQUIRED_FLAGS.filter((f) => !configLine.includes(f));
  if (missing.length > 0) {
    throw new Error(
      `Refusing this ffmpeg build: missing ${missing.join(', ')}. ` +
        `This project pins the GPL build for libx264 (MP4/CRF) and needs ` +
        `libwebp for WebP. An LGPL build has neither x264 nor any CRF-capable ` +
        `H.264 encoder.`,
    );
  }

  const encoders = execFileSync(ffmpegExe, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  for (const enc of ['libwebp_anim', 'libwebp', 'libx264']) {
    if (!encoders.includes(enc)) throw new Error(`Refusing this ffmpeg build: no ${enc} encoder.`);
  }
  if (!/^\s*V\S*\s+gif\s/m.test(encoders)) {
    throw new Error('Refusing this ffmpeg build: no native gif encoder.');
  }
  if (!/^\s*V\S*\s+png\s/m.test(encoders)) {
    throw new Error('Refusing this ffmpeg build: no native png encoder.');
  }

  console.log('  verified: GPL build, libx264 + libwebp present, nothing nonfree');
}

async function main() {
  fs.mkdirSync(binDir, { recursive: true });

  if (WANTED.every(have)) {
    console.log(`ffmpeg ${build.version} already present and verified.`);
    return;
  }

  console.log(`Fetching ffmpeg ${build.version} (${build.license})`);
  fs.mkdirSync(downloadDir, { recursive: true });
  const zip = path.join(downloadDir, build.asset);

  if (!fs.existsSync(zip) || sha256(zip) !== build.zipSha256) {
    await download(build.url, zip);
  } else {
    console.log('  using cached download');
  }

  const actual = sha256(zip);
  if (actual !== build.zipSha256) {
    throw new Error(
      `Checksum mismatch for ${build.asset}\n  expected ${build.zipSha256}\n  actual   ${actual}`,
    );
  }
  console.log('  sha256 ok');

  const staging = path.join(downloadDir, 'extract');
  await fsp.rm(staging, { recursive: true, force: true });
  extract(zip, staging);

  for (const name of WANTED) {
    const found = findBinary(staging, name);
    if (!found) throw new Error(`${name} not found inside ${build.asset}`);
    if (name === 'ffmpeg.exe') verifyLicense(found);
    await fsp.copyFile(found, path.join(binDir, name));
  }

  for (const name of WANTED) {
    const got = sha256(path.join(binDir, name));
    if (got !== build.binaries[name]) {
      throw new Error(`Checksum mismatch for ${name}\n  expected ${build.binaries[name]}\n  actual   ${got}`);
    }
  }

  await fsp.rm(staging, { recursive: true, force: true });
  console.log(`ffmpeg ${build.version} installed to resources/bin/`);
}

await main();
