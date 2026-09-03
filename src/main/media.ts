import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { binaries } from './ffmpeg';
import { MAX_SOURCE_SECONDS, PREVIEW_PROXY_SHORT_SIDE, previewProxySize } from '../shared/doc';
import {
  MEDIA_META_VERSION,
  type ImportResult,
  type MediaMeta,
  type MediaProgress,
} from '../shared/ipc';

const execFileAsync = promisify(execFile);

/**
 * Media import, decode and the disk frame cache (CLAUDE.md §7).
 *
 * Sources are decoded at their native frame rate, never at outputFps, so
 * changing the fps dropdown never invalidates the cache — resampling happens at
 * render time (§8).
 *
 * Import is two-phase. Phase one probes and produces a single frame, and that is
 * all `importMedia` waits for: a drop must be manipulable straight away, not
 * after a 30 s video has been transcoded. Phase two decodes the rest in the
 * background and reports progress, so the UI can show a non-blocking bar per
 * pending item.
 *
 * **Cached frames are PNG, and a static source is not re-encoded at all.**
 * Measured on this machine, at 1080x2520: lossless WebP costs 38 s per 40
 * frames, PNG 0.9 s — a 17 s clip took roughly sixteen minutes to import and now
 * takes eight seconds. A single 3456x5184 JPEG took eleven seconds to re-encode
 * as lossless WebP and one second as PNG; copying it costs neither. Both formats
 * are lossless, so nothing about output fidelity changes — only the size of the
 * cache, which already has an LRU cap.
 */

/** §7 accepted inputs. Anything else is rejected with a toast. */
export const ACCEPTED_EXTENSIONS = [
  '.gif', '.webp', '.png', '.jpg', '.jpeg', '.bmp',
  '.mp4', '.mov', '.webm', '.mkv', '.avi',
];

const STATIC_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.bmp']);

/**
 * Formats Chromium decodes natively, so a single-frame source of one of these
 * can be **copied** into the cache rather than transcoded. `createImageBitmap`
 * in the renderer does the decoding either way; running the pixels through
 * ffmpeg first only buys a different container, at the cost of the slowest step
 * in the whole import.
 */
const DIRECTLY_RENDERABLE = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.gif']);

/** What a decoded animated frame is written as. See the note at the top. */
const FRAME_EXTENSION = '.png';

/** §7: reduced-resolution preview frames live in their own subdirectory. */
const PROXY_DIR = 'proxy';

export function proxyDir(cacheDir: string, key: string): string {
  return path.join(entryDir(cacheDir, key), PROXY_DIR);
}

/**
 * `scale` targeting the **short** side, whichever it is. A portrait clip's short
 * side is its width and a landscape clip's is its height, so a fixed `-1:N`
 * would shrink one of them far past the target.
 */
function proxyScaleFilter(): string {
  const n = String(PREVIEW_PROXY_SHORT_SIDE);
  return `scale='if(gt(iw,ih),-1,${n})':'if(gt(iw,ih),${n},-1)'`;
}

/**
 * Formats whose frames carry individually meaningful delays, so the timings have
 * to be read from the frames themselves. Everything else is a video container:
 * ffprobe's `avg_frame_rate` describes it accurately, and asking for
 * `-show_frames` there means decoding the whole file just to learn its duration
 * — the single biggest cost in a drop.
 */
const PER_FRAME_TIMING_EXTENSIONS = new Set(['.gif', '.webp']);

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
  r_frame_rate?: string;
  codec_name?: string;
  nb_frames?: string;
  tags?: Record<string, string>;
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
 * The rule applies **only to GIF and animated WebP**, which is where the
 * malformed-delay convention comes from. Applying it to video was a bug: a
 * 59.94 fps clip has a perfectly legitimate 16.68 ms per frame, and rewriting
 * every one of those to 100 ms made a 17 s file measure 102 s and be rejected by
 * the §7 duration limit.
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

/** "23.976", "30000/1001" and "0/0" all appear here. Only the last is useless. */
function parseRational(value: string | undefined): number {
  if (!value) return 0;
  const [num, den] = value.split('/');
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  return n / d;
}

/** Matroska writes its duration as a `DURATION` tag: "00:00:17.014000000". */
function parseTimecode(value: string | undefined): number {
  if (!value) return 0;
  const parts = value.split(':').map(Number);
  if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p))) return 0;
  return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
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
  const perFrameTiming = PER_FRAME_TIMING_EXTENSIONS.has(ext);

  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_streams',
    '-show_format',
    ...(isStatic || !perFrameTiming
      ? []
      : ['-show_frames', '-show_entries', 'frame=best_effort_timestamp_time,duration_time']),
    '-of', 'json',
    sourcePath,
  ];

  // A 30 s 60 fps source yields 1800 frame entries; the default 1 MB buffer is
  // not enough for that JSON.
  const { stdout } = await execFileAsync(ffprobe, args, { maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as {
    streams?: ProbeStream[];
    frames?: ProbeFrame[];
    format?: { duration?: string };
  };

  const stream = parsed.streams?.[0];
  if (!stream || !stream.width || !stream.height) {
    throw new Error('No video stream found — the file may be corrupt or unsupported.');
  }

  // Matroska carries no per-stream duration, so a stream-only read returns 0 and
  // every duration check downstream is wrong. Try every place it can live.
  const durationSeconds =
    [
      Number(stream.duration),
      Number(parsed.format?.duration),
      parseTimecode(stream.tags?.DURATION ?? stream.tags?.duration),
    ].find((v) => Number.isFinite(v) && v > 0) ?? 0;

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

  if (perFrameTiming) {
    const frames = parsed.frames ?? [];
    const durations = normaliseDurations(durationsFromFrames(frames, durationSeconds));

    if (durations.length === 0) {
      throw new Error('Could not read any frames — the file may be corrupt.');
    }

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

  // Video container: uniform timing at the declared rate. §8.1 samples by
  // nearest frame at whole output frames, so per-packet jitter in a VFR source
  // cannot change which frame is picked.
  const fps = parseRational(stream.avg_frame_rate) || parseRational(stream.r_frame_rate);
  if (fps <= 0) {
    throw new Error('Could not read the frame rate — the file may be corrupt.');
  }

  const declaredFrames = Number(stream.nb_frames);
  const frameCount = Math.max(
    1,
    Number.isFinite(declaredFrames) && declaredFrames > 0
      ? Math.round(declaredFrames)
      : Math.round(durationSeconds * fps),
  );

  const perFrameMs = Math.round((1000 / fps) * 1000) / 1000;

  return {
    width: stream.width,
    height: stream.height,
    durationSeconds: durationSeconds || (frameCount * perFrameMs) / 1000,
    frameDurationsMs: new Array<number>(frameCount).fill(perFrameMs),
    frameCount,
    codec: stream.codec_name ?? ext.slice(1),
  };
}

function entryDir(cacheDir: string, key: string): string {
  return path.join(cacheDir, key);
}

/**
 * Where phase one writes its single frame. It sits beside the entry directory
 * rather than inside it, so the atomic publish of the full decode is unaffected
 * and `readMeta` can never mistake it for a complete entry.
 */
export function firstFramePath(cacheDir: string, key: string): string {
  return path.join(cacheDir, `${key}.first${FRAME_EXTENSION}`);
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
    const frames = files.filter((f) => f.endsWith(meta.frameExt)).length;
    if (frames !== meta.frameCount) return null;

    // The proxy set is derived from the same rule the renderer uses, so an entry
    // missing the proxies it should have — or holding them at a size the rule no
    // longer asks for — would leave the preview drawing the wrong thing or
    // nothing at all. Treat either as a miss.
    const wanted = previewProxySize(meta.nativeWidth, meta.nativeHeight, meta.frameCount);
    const wantedShortSide = wanted ? PREVIEW_PROXY_SHORT_SIDE : null;
    if (meta.proxyShortSide !== wantedShortSide) return null;
    if (wanted) {
      const proxies = await fsp.readdir(proxyDir(cacheDir, key)).catch(() => [] as string[]);
      if (proxies.filter((f) => f.endsWith(FRAME_EXTENSION)).length !== meta.frameCount) {
        return null;
      }
    }

    return { ...meta, complete: true, readyFrames: meta.frameCount };
  } catch {
    return null;
  }
}

function decodeErrorMessage(stderr: string): string {
  const tail = stderr.trim().split(/\r?\n/).slice(-6).join('\n');
  return `Could not decode this file.${tail ? `\n${tail}` : ''}`;
}

/**
 * PNG at zlib level 1. Level 1 is both the fastest of the useful settings and,
 * measured here, the smallest — level 0 stores raw and quadruples the entry for
 * no speed gain. Still lossless, which is all §7 actually requires of the cache.
 */
function frameEncoder(): string[] {
  return ['-c:v', 'png', '-compression_level', '1'];
}

/**
 * Phase one: one frame, as fast as ffmpeg can produce it. This is what the drop
 * waits on, so it must never scan the whole file.
 */
async function decodeFirstFrame(
  sourcePath: string,
  outFile: string,
  proxy: boolean,
): Promise<void> {
  const { ffmpeg } = binaries();
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  try {
    await execFileAsync(
      ffmpeg,
      [
        '-y', '-i', sourcePath, '-an', '-frames:v', '1',
        // At proxy size when that is what the preview will ask for: this frame
        // exists only to stand in until the full decode publishes.
        ...(proxy ? ['-vf', proxyScaleFilter()] : []),
        ...frameEncoder(),
        outFile,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (err) {
    throw new Error(decodeErrorMessage((err as { stderr?: string }).stderr ?? ''));
  }
}

/* -------------------------------------------------------------------------- */
/* Background decode (§7)                                                     */
/* -------------------------------------------------------------------------- */

/** Decodes still running, so a second drop of the same file joins rather than races. */
const running = new Map<string, Promise<void>>();
/** Keyed so a single entry can be cancelled without touching the others. */
const processes = new Map<string, ChildProcess>();
/** Keys whose decode was abandoned on purpose, so it is not reported as failed. */
const cancelled = new Set<string>();

export type ProgressSink = (progress: MediaProgress) => void;

/**
 * Decodes to a lossless frame sequence in the cache (§7).
 *
 * `-progress pipe:1` is what makes the non-blocking progress bar possible:
 * ffmpeg reports `frame=N` as it goes, which is exactly the number of frames
 * already written.
 */
async function decodeAll(
  key: string,
  sourcePath: string,
  dir: string,
  isStatic: boolean,
  proxy: { width: number; height: number } | null,
  onFrames: (n: number) => void,
): Promise<void> {
  const { ffmpeg } = binaries();
  const tmp = `${dir}.partial`;

  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(tmp, { recursive: true });
  if (proxy) await fsp.mkdir(path.join(tmp, PROXY_DIR), { recursive: true });

  const args = [
    '-y',
    '-i', sourcePath,
    // §17: strip audio from every source.
    '-an',
    ...(isStatic ? ['-frames:v', '1'] : ['-fps_mode', 'passthrough']),
    ...frameEncoder(),
    '-nostats',
    '-progress', 'pipe:1',
    path.join(tmp, `%06d${FRAME_EXTENSION}`),
    // A second output on the same pass rather than a second run: the source is
    // decoded once and scaled twice. Measured on a 17 s 1080x2520 clip this
    // costs about 19% (8.5 s to 10.2 s) against roughly doubling it by running
    // a second command. `-progress` still counts source frames, so the bar is
    // unaffected.
    ...(proxy
      ? ['-vf', proxyScaleFilter(), ...frameEncoder(), path.join(tmp, PROXY_DIR, `%06d${FRAME_EXTENSION}`)]
      : []),
  ];

  const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  processes.set(key, proc);

  let stderr = '';
  proc.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4000);
  });

  let pending = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const match = /^frame=\s*(\d+)/.exec(line);
      if (match) onFrames(Number(match[1]));
    }
  });

  let code: number | null;
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      proc.once('error', reject);
      proc.once('close', resolve);
    });
  } finally {
    if (processes.get(key) === proc) processes.delete(key);
  }

  if (cancelled.has(key)) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw new CancelledError();
  }

  if (code !== 0) {
    await fsp.rm(tmp, { recursive: true, force: true });
    throw new Error(decodeErrorMessage(stderr));
  }

  // Publish atomically: a half-written entry must never look complete to a
  // later run, which only checks that the frame count matches meta.json.
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.rename(tmp, dir);
}

/** Thrown when a decode was abandoned deliberately; never surfaced as an error. */
class CancelledError extends Error {
  constructor() {
    super('decode cancelled');
  }
}

/** Kills any decode still running, so quitting leaves no orphan ffmpeg. */
export function stopDecodes(): void {
  for (const [key, proc] of processes) {
    cancelled.add(key);
    proc.kill();
  }
  processes.clear();
}

/**
 * Abandons one entry's background decode (§7).
 *
 * Deleting the layer that a decode is feeding makes the rest of that decode
 * pointless: it is minutes of CPU and up to a gigabyte of disk spent on frames
 * nothing will ask for. The partial output goes with it, so the next drop of the
 * same file starts clean rather than resuming into a half-written directory.
 */
export async function cancelDecode(cacheDir: string, key: string): Promise<void> {
  if (!running.has(key) && !processes.has(key)) return;
  cancelled.add(key);
  processes.get(key)?.kill();
  processes.delete(key);

  await running.get(key)?.catch(() => {});
  await fsp.rm(`${entryDir(cacheDir, key)}.partial`, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(firstFramePath(cacheDir, key), { force: true }).catch(() => {});
  cancelled.delete(key);
}

export interface ImportOptions {
  cacheDir: string;
  sourcePath: string;
  onProgress?: ProgressSink;
}

export async function importMedia({
  cacheDir,
  sourcePath,
  onProgress,
}: ImportOptions): Promise<ImportResult> {
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

  // A static source is one frame either way, so there is nothing to defer — and
  // if the renderer can decode the file as it stands, there is nothing to encode
  // either. This is the difference between a large JPEG appearing instantly and
  // appearing eleven seconds later.
  if (info.frameCount === 1) {
    try {
      if (DIRECTLY_RENDERABLE.has(ext)) {
        await copyAsSingleFrame(sourcePath, dir, ext);
        return finalise(cacheDir, key, sourcePath, info, ext);
      }
      // A still never gets a proxy (§7), so there is nothing to scale here.
      await decodeAll(key, sourcePath, dir, true, null, () => {});
    } catch (err) {
      return {
        ok: false,
        error: `${path.basename(sourcePath)}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return finalise(cacheDir, key, sourcePath, info, FRAME_EXTENSION);
  }

  const proxy = previewProxySize(info.width, info.height, info.frameCount);

  // Phase one: enough to place the object and let the user work with it.
  try {
    await decodeFirstFrame(sourcePath, firstFramePath(cacheDir, key), proxy !== null);
  } catch (err) {
    return {
      ok: false,
      error: `${path.basename(sourcePath)}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Phase two, in the background. The renderer already has a usable object.
  startBackgroundDecode(cacheDir, key, sourcePath, info, proxy, onProgress);

  return {
    ok: true,
    meta: {
      metaVersion: MEDIA_META_VERSION,
      cacheKey: key,
      sourcePath,
      frameCount: info.frameCount,
      frameDurationsMs: info.frameDurationsMs,
      nativeWidth: info.width,
      nativeHeight: info.height,
      frameExt: FRAME_EXTENSION,
      proxyShortSide: proxy ? PREVIEW_PROXY_SHORT_SIDE : null,
      complete: false,
      readyFrames: 1,
    },
  };
}

/**
 * Publishes a single-frame entry by copying the source in, under the same
 * atomic rename the decoder uses so a half-copied entry can never look complete.
 */
async function copyAsSingleFrame(sourcePath: string, dir: string, ext: string): Promise<void> {
  const tmp = `${dir}.partial`;
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(tmp, { recursive: true });
  await fsp.copyFile(sourcePath, path.join(tmp, `000001${ext}`));
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.rename(tmp, dir);
}

function startBackgroundDecode(
  cacheDir: string,
  key: string,
  sourcePath: string,
  info: ProbeInfo,
  proxy: { width: number; height: number } | null,
  onProgress?: ProgressSink,
): void {
  if (running.has(key)) return;

  const report = (progress: MediaProgress) => onProgress?.(progress);

  const task = (async () => {
    try {
      await decodeAll(key, sourcePath, entryDir(cacheDir, key), false, proxy, (frames) => {
        report({
          cacheKey: key,
          readyFrames: Math.min(frames, info.frameCount),
          totalFrames: info.frameCount,
          done: false,
          meta: null,
          error: null,
        });
      });

      const result = await finalise(cacheDir, key, sourcePath, info, FRAME_EXTENSION);
      await fsp.rm(firstFramePath(cacheDir, key), { force: true }).catch(() => {});

      report(
        result.ok
          ? {
              cacheKey: key,
              readyFrames: result.meta.frameCount,
              totalFrames: result.meta.frameCount,
              done: true,
              meta: result.meta,
              error: null,
            }
          : {
              cacheKey: key,
              readyFrames: 1,
              totalFrames: info.frameCount,
              done: true,
              meta: null,
              error: result.error,
            },
      );
    } catch (err) {
      // A cancelled decode is a thing the user asked for, not a failure to
      // report. The renderer has already dropped the job that named it.
      if (err instanceof CancelledError) return;
      report({
        cacheKey: key,
        readyFrames: 1,
        totalFrames: info.frameCount,
        done: true,
        meta: null,
        error: `${path.basename(sourcePath)}: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      running.delete(key);
    }
  })();

  running.set(key, task);
}

/** Writes meta.json once the frames are on disk, and returns the final meta. */
async function finalise(
  cacheDir: string,
  key: string,
  sourcePath: string,
  info: ProbeInfo,
  frameExt: string,
): Promise<ImportResult> {
  const proxy = previewProxySize(info.width, info.height, info.frameCount);
  const dir = entryDir(cacheDir, key);

  // ffmpeg decides how many frames actually came out; trust that over the probe.
  const files = (await fsp.readdir(dir)).filter((f) => f.endsWith(frameExt)).sort();
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
    frameExt,
    proxyShortSide: proxy ? PREVIEW_PROXY_SHORT_SIDE : null,
    complete: true,
    readyFrames: files.length,
  };

  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  return { ok: true, meta };
}

/** Frame files are served to the renderer by index. */
export function framePath(cacheDir: string, key: string, index: number, ext: string): string {
  return path.join(entryDir(cacheDir, key), `${String(index + 1).padStart(6, '0')}${ext}`);
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

/**
 * Clears the leftovers of an interrupted decode: `<key>.partial` directories and
 * `<key>.first.*` frames whose entry has since been published. Killing the
 * app mid-decode is ordinary, and neither file is ever picked up again.
 */
export async function sweepPartials(cacheDir: string): Promise<void> {
  const names = await fsp.readdir(cacheDir).catch(() => [] as string[]);
  for (const name of names) {
    if (name.endsWith('.partial')) {
      await fsp.rm(path.join(cacheDir, name), { recursive: true, force: true }).catch(() => {});
      continue;
    }
    if (!name.includes('.first.')) continue;
    // A first frame is only live while its entry is still being decoded, and no
    // decode survives a restart.
    await fsp.rm(path.join(cacheDir, name), { force: true }).catch(() => {});
  }
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
  // Phase-one frames live beside the entries, so a clear has to sweep them too.
  for (const name of await fsp.readdir(cacheDir).catch(() => [] as string[])) {
    if (!name.includes('.first.')) continue;
    await fsp.rm(path.join(cacheDir, name), { force: true }).catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */
/* Clipboard images (§11)                                                     */
/* -------------------------------------------------------------------------- */

const CLIPBOARD_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
};

/**
 * Writes clipboard bytes to a file so the ordinary §7 import path handles them,
 * rather than growing a second decode route that could drift from the first.
 *
 * The file lives in the cache directory and is named by content hash, so pasting
 * the same image twice reuses the cache entry instead of decoding again.
 */
export async function importClipboardImage(
  cacheDir: string,
  bytes: Buffer,
  mimeType: string,
  onProgress?: ProgressSink,
): Promise<ImportResult> {
  const ext = CLIPBOARD_EXTENSIONS[mimeType];
  if (!ext) return { ok: false, error: `Clipboard image type ${mimeType} is not supported.` };

  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const dir = path.join(cacheDir, 'pasted');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${hash}${ext}`);

  try {
    await fsp.writeFile(file, bytes, { flag: 'wx' });
  } catch (err) {
    // EEXIST just means this image was pasted before; anything else is real.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      return { ok: false, error: `Could not stage the clipboard image: ${String(err)}` };
    }
  }

  return importMedia({ cacheDir, sourcePath: file, onProgress });
}
