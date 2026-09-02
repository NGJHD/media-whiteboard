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

function quality(request: EncodeRequest): string[] {
  // §12: webp q:v 50/75/90; gif maps quality to dither instead.
  const q = { low: '50', medium: '75', high: '90' }[request.quality];
  return ['-q:v', q];
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
    const args = [
      ...inputArgs(this.request, 'pipe:0'),
      '-c:v', 'libwebp_anim',
      '-loop', '0', // §8: infinite
      ...quality(this.request),
      this.request.outputPath,
    ];

    const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.proc = proc;
    this.pipe = proc.stdin;
    this.stderr.attach(proc.stderr);
    proc.stdin.on('error', () => {
      // ffmpeg exiting early closes the pipe; the exit code is the real error.
    });
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

    this.events.onPhase('palette', 0.8);
    await this.run(ffmpeg, [
      ...inputArgs(this.request, this.scratchPath),
      '-vf', 'palettegen=reserve_transparent=1',
      this.palettePath,
    ]);

    this.events.onPhase('encoding', 0.9);
    await this.run(ffmpeg, [
      ...inputArgs(this.request, this.scratchPath),
      '-i', this.palettePath,
      '-lavfi', `paletteuse=dither=${dither(this.request)}`,
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
