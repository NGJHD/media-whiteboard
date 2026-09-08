import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { binaries } from './ffmpeg';
import type { EncodeRequest, ExportPhase } from '../shared/ipc';

/**
 * The export encoder (CLAUDE.md §12).
 *
 * WebP is one pass: raw RGBA goes straight down ffmpeg's stdin.
 *
 * GIF is three: the render loop writes raw frames to a scratch file, then
 * palettegen reads it, then paletteuse reads it again. palettegen must see every
 * frame before paletteuse can write the first one, and the render loop can only
 * produce the stream once — so the frames have to land somewhere. §12 requires
 * that somewhere to be disk, where the size can be bounds-checked, rather than
 * ffmpeg's RAM.
 */

const BYTES_PER_PIXEL = 4; // rgba

export interface EncoderEvents {
  onPhase(phase: ExportPhase, progress: number): void;
}

/** Last lines of stderr, for the §14 error toast. */
class StderrTail {
  private lines: string[] = [];
  private partial = '';

  attach(stream: NodeJS.ReadableStream): void {
    stream.on('data', (chunk: Buffer) => {
      this.partial += chunk.toString('utf8');
      const parts = this.partial.split(/\r?\n|\r/);
      this.partial = parts.pop() ?? '';
      for (const line of parts) {
        if (line.trim().length === 0) continue;
        this.lines.push(line);
        if (this.lines.length > 40) this.lines.shift();
      }
    });
  }

  tail(n = 10): string {
    return this.lines.slice(-n).join('\n');
  }
}

function webpQuality(request: EncodeRequest): string[] {
  // §12: webp q:v 50/75/90; gif maps quality to dither instead.
  const q = { low: '50', medium: '75', high: '90' }[request.quality];
  return ['-q:v', q];
}

/**
 * H.264 rate control (spec §7). CRF is constant-quality, so file size varies
 * with content rather than being targeted — which is the point.
 *
 * These match the sibling project Video Trim & Crop, deliberately: two apps by
 * the same author that both say "High" should mean the same thing by it.
 */
const H264_QUALITY = {
  high: { crf: '17', preset: 'slow' },
  medium: { crf: '20', preset: 'medium' },
  low: { crf: '23', preset: 'fast' },
} as const;

/**
 * libwebp advertises bgra, yuv420p and yuva420p, and left alone ffmpeg
 * negotiates an alpha-carrying format for an rgba input. Stating it explicitly
 * pins that rather than trusting the negotiation to keep choosing well, and lets
 * an opaque document drop the alpha plane it does not use — measurably smaller
 * files for the common case.
 */
function webpPixelFormat(request: EncodeRequest): string[] {
  return ['-pix_fmt', request.transparent ? 'yuva420p' : 'yuv420p'];
}

function dither(request: EncodeRequest): string {
  return { low: 'none', medium: 'bayer', high: 'sierra2_4a' }[request.quality];
}

function inputArgs(request: EncodeRequest, source: string): string[] {
  return [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${request.width}x${request.height}`,
    '-r', String(request.fps),
    '-i', source,
    // §17: audio is stripped from every source, and nothing here produces any.
    '-an',
  ];
}

/**
 * The MP4 filter chain (spec §3 and §4). Two problems, one pass:
 *
 * 1. H.264 with yuv420p needs even dimensions, and `canvasRect` can be odd.
 *    Left alone ffmpeg does not fail — it silently writes 400x300 for a 401x301
 *    input, losing a row and a column. `pad` adds up to one pixel instead, and
 *    computes the target size itself.
 *
 * 2. rgba -> yuv420p *discards* alpha rather than compositing it, so a
 *    transparent region keeps its underlying RGB at full strength and
 *    anti-aliased edges become hard colour halos. Compositing over black first
 *    is what makes transparency degrade the way a viewer expects.
 *
 * The overlay is only built when there is alpha to flatten; an opaque document
 * already has a background drawn by buildScene and would pay for the pass for
 * nothing.
 */
function mp4Filters(request: EncodeRequest): string[] {
  const pad = 'pad=ceil(iw/2)*2:ceil(ih/2)*2:color=black';

  if (!request.transparent) {
    return ['-vf', `${pad},format=yuv420p`];
  }

  const { width, height, fps } = request;
  return [
    '-filter_complex',
    `color=c=black:s=${width}x${height}:r=${fps}[bg];` +
      `[bg][0:v]overlay=shortest=1,${pad},format=yuv420p`,
  ];
}

export class Encoder {
  /** The process currently running, whichever pass it belongs to. Kill target. */
  private proc: ChildProcess | null = null;
  /** The one-pass WebP encoder's stdin. Null for GIF, which writes to scratch. */
  private pipe: NodeJS.WritableStream | null = null;
  private scratchStream: fs.WriteStream | null = null;
  private stderr = new StderrTail();
  private cancelled = false;
  private framesWritten = 0;

  private readonly scratchPath: string;
  private readonly palettePath: string;

  constructor(
    private readonly request: EncodeRequest,
    private readonly cacheDir: string,
    private readonly events: EncoderEvents,
  ) {
    this.scratchPath = path.join(cacheDir, `export-${process.pid}.rawvideo`);
    this.palettePath = path.join(cacheDir, `export-${process.pid}.png`);
  }

  /** Bytes the GIF scratch file will occupy. §12 requires checking this up front. */
  scratchBytes(): number {
    return this.request.width * this.request.height * BYTES_PER_PIXEL * this.request.frameCount;
  }

  async start(): Promise<void> {
    await fsp.mkdir(this.cacheDir, { recursive: true });
    await fsp.mkdir(path.dirname(this.request.outputPath), { recursive: true });

    if (this.request.format === 'gif') {
      await this.assertDiskSpace();
      this.scratchStream = fs.createWriteStream(this.scratchPath);
      await once(this.scratchStream, 'open');
      return;
    }

    const { ffmpeg } = binaries();
    const args = [...inputArgs(this.request, 'pipe:0'), ...this.encoderArgs()];

    const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.proc = proc;
    this.pipe = proc.stdin;
    this.stderr.attach(proc.stderr);
    proc.stdin.on('error', () => {
      // ffmpeg exiting early closes the pipe; the exit code is the real error.
    });
  }

  /** Output-side arguments for the one-pass formats. GIF never reaches here. */
  private encoderArgs(): string[] {
    const request = this.request;

    if (request.format === 'mp4') {
      const { crf, preset } = H264_QUALITY[request.quality];
      return [
        ...mp4Filters(request),
        '-c:v', 'libx264',
        '-preset', preset,
        '-crf', crf,
        '-profile:v', 'high',
        // Puts the moov atom first so the file starts playing before it has
        // been fully read — the difference between a preview that works in a
        // chat client and one that does not.
        '-movflags', '+faststart',
        // §5: MP4 has no loop flag. Looping is the player's business.
        request.outputPath,
      ];
    }

    return [
      '-c:v', 'libwebp_anim',
      '-loop', '0', // §8: infinite
      ...webpPixelFormat(request),
      ...webpQuality(request),
      request.outputPath,
    ];
  }

  /**
   * §12/§14: refuse rather than fill the user's disk. The scratch file for a long
   * GIF loop is hundreds of MB to a few GB.
   */
  private async assertDiskSpace(): Promise<void> {
    const needed = this.scratchBytes();
    let free: number;
    try {
      const stat = await fsp.statfs(this.cacheDir);
      free = Number(stat.bavail) * Number(stat.bsize);
    } catch {
      return; // cannot tell; let the write fail naturally rather than block export
    }
    // Leave headroom for the palette PNG and the output file itself.
    if (free < needed * 1.1) {
      const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;
      throw new Error(
        `Not enough disk space for the GIF scratch file: needs ${gb(needed)}, ` +
          `${gb(free)} free in ${this.cacheDir}.`,
      );
    }
  }

  /**
   * Writes one RGBA frame. Resolves once the sink has accepted it — the caller
   * must await this before rendering the next frame, which is how §3's stdin
   * backpressure requirement is honoured across the process boundary.
   */
  async writeFrame(frame: Buffer): Promise<void> {
    if (this.cancelled) return;

    const expected = this.request.width * this.request.height * BYTES_PER_PIXEL;
    if (frame.byteLength !== expected) {
      throw new Error(`Frame ${this.framesWritten}: expected ${expected} bytes, got ${frame.byteLength}`);
    }

    const sink = this.request.format === 'gif' ? this.scratchStream : this.pipe;
    if (!sink) throw new Error('Encoder is not started');

    if (!sink.write(frame)) {
      await once(sink, 'drain');
    }

    this.framesWritten += 1;
    const share = this.request.format === 'gif' ? 0.8 : 1;
    this.events.onPhase('rendering', (this.framesWritten / this.request.frameCount) * share);
  }

  async finish(): Promise<void> {
    if (this.cancelled) return;

    if (this.request.format === 'gif') {
      await this.closeScratch();
      await this.runGifPasses();
      await this.cleanupScratch();
      return;
    }

    const proc = this.proc;
    if (!proc || !this.pipe) throw new Error('Encoder is not started');
    this.pipe.end();
    await this.awaitExit(proc, 'ffmpeg');
  }

  private async closeScratch(): Promise<void> {
    const stream = this.scratchStream;
    if (!stream) return;
    stream.end();
    await once(stream, 'close');
    this.scratchStream = null;
  }

  /** §12: palettegen then paletteuse, both reading the scratch file. */
  private async runGifPasses(): Promise<void> {
    const { ffmpeg } = binaries();

    const transparent = this.request.transparent;

    this.events.onPhase('palette', 0.8);
    await this.run(ffmpeg, [
      ...inputArgs(this.request, this.scratchPath),
      // Reserving a palette slot costs one of the 256 colours, so only do it
      // when there is transparency to reserve it for.
      '-vf', `palettegen=reserve_transparent=${transparent ? 1 : 0}`,
      this.palettePath,
    ]);

    this.events.onPhase('encoding', 0.9);
    await this.run(ffmpeg, [
      ...inputArgs(this.request, this.scratchPath),
      '-i', this.palettePath,
      // GIF alpha is 1-bit (§12), so a threshold decides where the cut between
      // transparent and opaque falls. 128 is also paletteuse's default; it is
      // written out so that changing it is a deliberate edit, and so that the
      // opaque path can leave it off entirely.
      '-lavfi', `paletteuse=dither=${dither(this.request)}${transparent ? ':alpha_threshold=128' : ''}`,
      '-loop', '0',
      this.request.outputPath,
    ]);
  }

  private async run(bin: string, args: string[]): Promise<void> {
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = proc;
    this.stderr.attach(proc.stderr);
    await this.awaitExit(proc, path.basename(bin));
  }

  private async awaitExit(proc: ChildProcess, label: string): Promise<void> {
    const [code] = (await once(proc, 'close')) as [number | null];
    if (this.cancelled) return;
    if (code !== 0) {
      // §14: surface the last ~10 lines of stderr, not a bare exit code.
      const err = new Error(`${label} exited with code ${code}`) as Error & { detail?: string };
      err.detail = this.stderr.tail(10);
      throw err;
    }
  }

  /** §12: kill ffmpeg, delete the partial output, and clean up scratch. */
  async cancel(): Promise<void> {
    this.cancelled = true;
    this.proc?.kill();
    this.scratchStream?.destroy();
    this.scratchStream = null;
    await this.cleanupScratch();
    await fsp.rm(this.request.outputPath, { force: true }).catch(() => {});
  }

  async cleanupScratch(): Promise<void> {
    await fsp.rm(this.scratchPath, { force: true }).catch(() => {});
    await fsp.rm(this.palettePath, { force: true }).catch(() => {});
  }
}
