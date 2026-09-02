import type { EncodeRequest, ExportPhase, ExportResult } from '../../shared/ipc';
import { openExport } from './channel';

/**
 * CLAUDE.md §16 step 2: a hardcoded animated gradient encoded to a real looping
 * file, to prove the ffmpeg pipe before any scene rendering exists.
 *
 * This is deliberately not Konva — the point is to exercise the transport and the
 * encoder in isolation, so that when step 6 wires the real scene in, a failure is
 * unambiguously in the scene and not in the pipe.
 *
 * It does follow the §12 loop shape exactly: draw, read pixels, transfer, await
 * the ack, yield to the event loop.
 */

export interface ProbeOptions {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  format: 'webp' | 'gif';
  quality: 'low' | 'medium' | 'high';
  outputPath: string;
  onProgress?(phase: ExportPhase, progress: number): void;
  signal?: AbortSignal;
}

function drawGradientFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  t: number,
): void {
  // t is 0..1 over exactly one loop, so frame 0 and frame N are continuous.
  const angle = t * Math.PI * 2;

  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, `hsl(${(t * 360).toFixed(1)} 85% 55%)`);
  gradient.addColorStop(1, `hsl(${((t * 360 + 140) % 360).toFixed(1)} 85% 35%)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // An orbiting disc, so a dropped or misordered frame is obvious by eye.
  const radius = Math.min(width, height) * 0.18;
  const orbit = Math.min(width, height) * 0.28;
  ctx.beginPath();
  ctx.arc(
    width / 2 + Math.cos(angle) * orbit,
    height / 2 + Math.sin(angle) * orbit,
    radius,
    0,
    Math.PI * 2,
  );
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fill();

  ctx.font = `600 ${Math.round(Math.min(width, height) * 0.09)}px "Segoe UI", system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Media Whiteboard', width / 2, height / 2);
}

export async function encodeGradient(options: ProbeOptions): Promise<ExportResult> {
  const { width, height, fps, frameCount, format, quality, outputPath } = options;

  const request: EncodeRequest = {
    width,
    height,
    fps,
    frameCount,
    format,
    quality,
    outputPath,
    // The probe draws an opaque gradient; it is exercising the pipe, not alpha.
    transparent: false,
  };

  // §12: text metrics differ if fonts are not settled before the first frame.
  await document.fonts.ready;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not get a 2D context for the export canvas');

  const handle = await openExport(request, { onProgress: options.onProgress });

  try {
    for (let i = 0; i < frameCount; i += 1) {
      if (options.signal?.aborted) return await handle.cancel();

      drawGradientFrame(ctx, width, height, i / frameCount);

      // getImageData returns a fresh buffer each call, so transferring it is safe.
      const { data } = ctx.getImageData(0, 0, width, height);
      await handle.sendFrame(i, data.buffer as ArrayBuffer);

      // §3: without this the progress bar never repaints and Cancel is dead.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    return await handle.finish();
  } catch (err) {
    await handle.cancel().catch(() => {});
    throw err;
  }
}
