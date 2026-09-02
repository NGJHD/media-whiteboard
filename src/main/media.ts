import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { binaries } from './ffmpeg';
import { MAX_SOURCE_SECONDS } from '../shared/doc';
import { MEDIA_META_VERSION, type ImportResult, type MediaMeta } from '../shared/ipc';

const execFileAsync = promisify(execFile);

/**
 * Media import, decode and the disk frame cache (CLAUDE.md §7).
 *
 * Sources are decoded at their native frame rate, never at outputFps, so
 * changing the fps dropdown never invalidates the cache — resampling happens at
 * render time (§8).
 */

/** §7 accepted inputs. Anything else is rejected with a toast. */
export const ACCEPTED_EXTENSIONS = [
  '.gif', '.webp', '.png', '.jpg', '.jpeg', '.bmp',
  '.mp4', '.mov', '.webm', '.mkv', '.avi',
];

const STATIC_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.bmp']);

/** §7: sha256(sourcePath + mtimeMs + fileSize), truncated to 16 hex chars. */
async function cacheKeyFor(sourcePath: string): Promise<string> {
  const stat = await fsp.stat(sourcePath);
  return createHash('sha256')
    .update(`${sourcePath}${stat.mtimeMs}${stat.size}`)
    .digest('hex')
    .slice(0, 16);
}

interface ProbeStream {
  width?: number;
  height?: number;
  duration?: string;
  avg_frame_rate?: string;
  codec_name?: string;
  nb_frames?: string;
}

interface ProbeFrame {
  best_effort_timestamp_time?: string;
  duration_time?: string;
}

/**
 * §8.0: any frameDurationMs below 20 is treated as 100 ms, matching browser
 * behaviour for malformed GIFs. Without this a single junk frame reports several
 * hundred fps and drags Auto up with it.
 *
 * Durations are also rounded to 0.001 ms. They come from differencing decimal
 * second timestamps, which leaves float noise: a uniform 10 fps GIF yields
 * 99.99999999999987 ms, so its effective rate is 10.0000000000001 fps, and
 * §8.0's round-up rule dutifully promotes that to the next dropdown value of 12.
 * Three decimals is far finer than any real frame timing (29.97 fps is 33.367 ms)
 * while being coarse enough to erase the noise.
 */
function normaliseDurations(durations: number[]): number[] {
  return durations.map((d) => (d < 20 ? 100 : Math.round(d * 1000) / 1000));
}

/**
 * Per-frame timings from packet timestamps. `duration_time` is absent or wrong on
 * some containers, so the timestamp deltas are the primary source and
 * duration_time is only the fallback for the final frame.
 */
function durationsFromFrames(frames: ProbeFrame[], totalSeconds: number): number[] {
  const times = frames
    .map((f) => Number(f.best_effort_timestamp_time))
    .filter((t) => Number.isFinite(t));

  if (times.length === 0) return [];
  if (times.length === 1) return [Math.max(totalSeconds, 0.1) * 1000];

  const out: number[] = [];
  for (let i = 0; i < times.length - 1; i += 1) {
    out.push((times[i + 1]! - times[i]!) * 1000);
  }

  // The last frame has no successor. Prefer its declared duration; otherwise
  // fall back to the stream duration, then to repeating the previous frame.
  const lastDeclared = Number(frames[frames.length - 1]?.duration_time);
  if (Number.isFinite(lastDeclared) && lastDeclared > 0) {
    out.push(lastDeclared * 1000);
  } else {
    const remaining = totalSeconds * 1000 - times[times.length - 1]! * 1000;
    out.push(remaining > 0 ? remaining : (out[out.length - 1] ?? 100));
  }

  return out;
}

export interface ProbeInfo {
  width: number;
  height: number;
  durationSeconds: number;
  frameDurationsMs: number[];
  frameCount: number;
  codec: string;
}

export async function probe(sourcePath: string): Promise<ProbeInfo> {
  const { ffprobe } = binaries();
  const ext = path.extname(sourcePath).toLowerCase();
  const isStatic = STATIC_EXTENSIONS.has(ext);

  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_streams',
    ...(isStatic ? [] : ['-show_frames', '-show_entries', 'frame=best_effort_timestamp_time,duration_time']),
    '-of', 'json',
    sourcePath,
  ];

  // A 30 s 60 fps source yields 1800 frame entries; the default 1 MB buffer is
  // not enough for that JSON.
  const { stdout } = await execFileAsync(ffprobe, args, { maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as { streams?: ProbeStream[]; frames?: ProbeFrame[] };

  const stream = parsed.streams?.[0];
  if (!stream || !stream.width || !stream.height) {
    throw new Error('No video stream found — the file may be corrupt or unsupported.');
  }

  const durationSeconds = Number(stream.duration) || 0;

  if (isStatic) {
    return {
      width: stream.width,
      height: stream.height,
      durationSeconds: 0,
      frameDurationsMs: [0],
      frameCount: 1,
      codec: stream.codec_name ?? ext.slice(1),
    };
  }

  const frames = parsed.frames ?? [];
  const durations = normaliseDurations(durationsFromFrames(frames, durationSeconds));

  if (durations.length === 0) {
    throw new Error('Could not read any frames — the file may be corrupt.');
  }

  // A single-frame "animation" (a static WebP, a one-frame GIF) is static.
  const totalMs = durations.reduce((a, b) => a + b, 0);

  return {
    width: stream.width,
    height: stream.height,
    durationSeconds: durationSeconds || totalMs / 1000,
    frameDurationsMs: durations,
    frameCount: durations.length,
    codec: stream.codec_name ?? ext.slice(1),
  };
}

function entryDir(cacheDir: string, key: string): string {
  return path.join(cacheDir, key);
}

async function readMeta(cacheDir: string, key: string): Promise<MediaMeta | null> {
  try {
    const raw = await fsp.readFile(path.join(entryDir(cacheDir, key), 'meta.json'), 'utf8');
    const meta = JSON.parse(raw) as MediaMeta;
    // An entry from an older decoder may hold metadata that no longer means what
    // this build expects, so treat it as a miss and decode again.
    if (meta.metaVersion !== MEDIA_META_VERSION) return null;
    // Trust the entry only if the frames it claims are actually there.
    const files = await fsp.readdir(entryDir(cacheDir, key));
    const frames = files.filter((f) => f.endsWith('.webp')).length;
    return frames === meta.frameCount ? meta : null;
  } catch {
    return null;
  }
}

/**
 * Decodes to a lossless WebP frame sequence in the cache (§7).
 *
 * Note the flag order: `-lossless 1` is a libwebp encoder option and must precede
 * the output file. §7 writes it after, which ffmpeg rejects.
 */
async function decode(sourcePath: string, dir: string, isStatic: boolean): Promise<void> {
  const { ffmpeg } = binaries();
  const tmp = `${dir}.partial`;
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(tmp, { recursive: true });

  const args = [
    '-y',
    '-i', sourcePath,
    // §17: strip audio from every source.
    '-an',
    ...(isStatic ? ['-frames:v', '1'] : ['-fps_mode', 'passthrough']),
    '-c:v', 'libwebp',
    '-lossless', '1',
    path.join(tmp, '%06d.webp'),
  ];

  try {
    await execFileAsync(ffmpeg, args, { maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    await fsp.rm(tmp, { recursive: true, force: true });
    const stderr = (err as { stderr?: string }).stderr ?? '';
    const tail = stderr.trim().split(/\r?\n/).slice(-6).join('\n');
    throw new Error(`Could not decode this file.${tail ? `\n${tail}` : ''}`);
  }

  // Publish atomically: a half-written entry must never look complete to a
  // later run, which only checks that the frame count matches meta.json.
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.rename(tmp, dir);
}

export interface ImportOptions {
  cacheDir: string;
  sourcePath: string;
}

export async function importMedia({ cacheDir, sourcePath }: ImportOptions): Promise<ImportResult> {
  const ext = path.extname(sourcePath).toLowerCase();
  if (!ACCEPTED_EXTENSIONS.includes(ext)) {
    return { ok: false, error: `${path.basename(sourcePath)}: unsupported file type.` };
  }

  try {
    await fsp.access(sourcePath);
  } catch {
    return { ok: false, error: `${path.basename(sourcePath)}: file not found.` };
  }

  let info: ProbeInfo;
  try {
    info = await probe(sourcePath);
  } catch (err) {
    return {
      ok: false,
      error: `${path.basename(sourcePath)}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // §7: reject anything longer than 30 s, before spending time decoding it.
  if (info.durationSeconds > MAX_SOURCE_SECONDS) {
    return {
      ok: false,
      error:
        `${path.basename(sourcePath)} is ${info.durationSeconds.toFixed(1)}s. ` +
        `Sources longer than ${MAX_SOURCE_SECONDS}s are not supported.`,
    };
  }

  const key = await cacheKeyFor(sourcePath);
  const dir = entryDir(cacheDir, key);

  const existing = await readMeta(cacheDir, key);
  if (existing) {
    await touch(dir);
    return { ok: true, meta: existing };
  }

  const isStatic = info.frameCount === 1;
  try {
    await decode(sourcePath, dir, isStatic);
  } catch (err) {
    return {
      ok: false,
      error: `${path.basename(sourcePath)}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ffmpeg decides how many frames actually came out; trust that over the probe.
  const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.webp')).sort();
  if (files.length === 0) {
    await fsp.rm(dir, { recursive: true, force: true });
    return { ok: false, error: `${path.basename(sourcePath)}: produced no frames.` };
  }

  const durations = info.frameDurationsMs.slice(0, files.length);
  while (durations.length < files.length) {
    durations.push(durations[durations.length - 1] ?? 100);
  }

  const meta: MediaMeta = {
    metaVersion: MEDIA_META_VERSION,
    cacheKey: key,
    sourcePath,
    frameCount: files.length,
    frameDurationsMs: files.length === 1 ? [0] : durations,
    nativeWidth: info.width,
    nativeHeight: info.height,
  };

  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  return { ok: true, meta };
}

/** Frame files are served to the renderer by index. */
export function framePath(cacheDir: string, key: string, index: number): string {
  return path.join(entryDir(cacheDir, key), `${String(index + 1).padStart(6, '0')}.webp`);
}

async function touch(dir: string): Promise<void> {
  const now = new Date();
  await fsp.utimes(dir, now, now).catch(() => {});
}

/* -------------------------------------------------------------------------- */
/* Eviction (§7)                                                              */
/* -------------------------------------------------------------------------- */

export const CACHE_LIMIT_BYTES = 5 * 1024 * 1024 * 1024;

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else total += (await fsp.stat(full)).size;
  }
  return total;
}

export interface CacheEntryInfo {
  key: string;
  bytes: number;
  atimeMs: number;
}

export async function listCache(cacheDir: string): Promise<CacheEntryInfo[]> {
  let entries;
  try {
    entries = await fsp.readdir(cacheDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: CacheEntryInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(cacheDir, entry.name);
    try {
      const stat = await fsp.stat(full);
      out.push({ key: entry.name, bytes: await dirSize(full), atimeMs: stat.mtimeMs });
    } catch {
      // entry vanished mid-scan
    }
  }
  return out;
}

export async function cacheSize(cacheDir: string): Promise<number> {
  return (await listCache(cacheDir)).reduce((sum, e) => sum + e.bytes, 0);
}

/** §7: on startup, LRU-evict whole entries until the total is under the cap. */
export async function evictCache(cacheDir: string, limit = CACHE_LIMIT_BYTES): Promise<number> {
  const entries = await listCache(cacheDir);
  let total = entries.reduce((sum, e) => sum + e.bytes, 0);
  if (total <= limit) return 0;

  entries.sort((a, b) => a.atimeMs - b.atimeMs); // oldest first
  let evicted = 0;
  for (const entry of entries) {
    if (total <= limit) break;
    await fsp.rm(path.join(cacheDir, entry.key), { recursive: true, force: true }).catch(() => {});
    total -= entry.bytes;
    evicted += 1;
  }
  return evicted;
}

export async function clearCache(cacheDir: string): Promise<void> {
  for (const entry of await listCache(cacheDir)) {
    await fsp.rm(path.join(cacheDir, entry.key), { recursive: true, force: true }).catch(() => {});
  }
}
