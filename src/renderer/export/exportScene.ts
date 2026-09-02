import Konva from 'konva';
import type { Doc } from '../../shared/doc';
import type { EncodeRequest, ExportPhase, ExportResult } from '../../shared/ipc';
import { load } from '../media/bitmapCache';
import { buildScene, framesNeededAt } from '../scene/buildScene';
import { planLoop } from '../scene/timing';
import { openExport } from './channel';

/**
 * The real export loop (CLAUDE.md §12).
 *
 * Runs in the same renderer as the preview. §12 blocks the UI during export
 * anyway, so a hidden BrowserWindow would only force the document across a
 * process boundary and the scene to be rebuilt on the other side.
 *
 * The export stage differs from the preview stage only in geometry — see the
 * table in §3. Both call `buildScene`, so pixel equivalence is structural.
 */

export interface ExportOptions {
  doc: Doc;
  onProgress?(phase: ExportPhase, progress: number): void;
  signal?: AbortSignal;
}

export async function exportDocument({ doc, onProgress, signal }: ExportOptions): Promise<ExportResult> {
  const plan = planLoop(doc);
  const { canvasRect } = doc;
  const width = Math.round(canvasRect.width);
  const height = Math.round(canvasRect.height);

  const request: EncodeRequest = {
    width,
    height,
    fps: plan.fps,
    // §12 step 3: zero animated layers means a single frame and fps is ignored.
    frameCount: plan.isStatic ? 1 : plan.frameCount,
    format: doc.format,
    quality: doc.quality,
    outputPath: doc.outputPath,
  };

  // §12 step 2: text metrics differ if fonts are not settled before frame one.
  await document.fonts.ready;

  // A detached container: the export stage must not be laid out or composited.
  const container = document.createElement('div');
  container.style.position = 'absolute';
  container.style.left = '-99999px';
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  document.body.appendChild(container);

  // §3: scale 1, pixelRatio 1, content offset -canvasRect.x/y.
  const previousPixelRatio = Konva.pixelRatio;
  Konva.pixelRatio = 1;

  const stage = new Konva.Stage({ container, width, height });
  const layer = new Konva.Layer({ listening: false });
  stage.add(layer);

  const handle = await openExport(request, { onProgress });

  try {
    for (let i = 0; i < request.frameCount; i += 1) {
      if (signal?.aborted) return await handle.cancel();

      // §3: bitmaps must already be decoded — stage.draw() is synchronous and
      // would silently render a blank node otherwise.
      const needed = framesNeededAt(doc, i);
      await Promise.all(needed.map((f) => load(f.cacheKey, f.index)));

      layer.destroyChildren();
      const group = buildScene(doc, i, { clipToCanvas: true });
      group.position({ x: -canvasRect.x, y: -canvasRect.y });
      layer.add(group);
      stage.draw();

      const canvas = layer.getCanvas()._canvas as HTMLCanvasElement;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Export layer has no 2D context');
      const { data } = ctx.getImageData(0, 0, width, height);

      await handle.sendFrame(i, data.buffer as ArrayBuffer);

      // §3: yield, or the progress bar never repaints and Cancel is dead.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    return await handle.finish();
  } catch (err) {
    await handle.cancel().catch(() => {});
    throw err;
  } finally {
    stage.destroy();
    container.remove();
    Konva.pixelRatio = previousPixelRatio;
  }
}

/**
 * §12: an estimated output size shown before export starts. Animated WebP grows
 * fast, and a 651-frame loop is not obviously a large file until it is one.
 *
 * Encoding a real sample would be accurate but costs seconds; these
 * bytes-per-pixel figures come from measured output of this encoder at each
 * quality and are labelled as rough in the UI.
 */
export function estimateBytes(doc: Doc): number {
  const plan = planLoop(doc);
  const pixels = doc.canvasRect.width * doc.canvasRect.height;
  const frames = plan.isStatic ? 1 : plan.frameCount;

  const perPixel =
    doc.format === 'gif'
      ? 0.45
      : { low: 0.035, medium: 0.06, high: 0.12 }[doc.quality];

  // Inter-frame compression means later frames cost far less than the first.
  return Math.round(pixels * perPixel * (1 + (frames - 1) * 0.55));
}
