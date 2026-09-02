import type { PaintLayer, Rect, StrokeCommand } from '../../shared/doc';
import { PAINT_BUFFER_SIZE, WORLD_MIN, unionRect } from '../../shared/doc';

/**
 * The paint layer (CLAUDE.md §6).
 *
 * One offscreen canvas, fixed at 4096x4096 world pixels, independent of
 * canvasRect. World origin maps to its centre. Because it is fixed-size and
 * independent, resizing the canvas or trimming to fit never resamples or crops
 * paint.
 *
 * Strokes are raster, not objects: not selectable, not individually movable.
 * Undo clears the buffer and replays the remaining commands — pixels are never
 * snapshotted.
 */

export interface PaintCanvas {
  canvas: HTMLCanvasElement;
  /** World coordinate of the buffer's top-left corner. */
  originX: number;
  originY: number;
}

let buffer: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;

function ensure(): CanvasRenderingContext2D {
  if (ctx) return ctx;
  buffer = document.createElement('canvas');
  buffer.width = PAINT_BUFFER_SIZE;
  buffer.height = PAINT_BUFFER_SIZE;
  const context = buffer.getContext('2d');
  if (!context) throw new Error('Could not create the paint buffer context');
  ctx = context;
  return ctx;
}

/** Null until something has actually been painted, so empty docs draw no node. */
export function getPaintCanvas(): PaintCanvas | null {
  if (!buffer || !hasContent) return null;
  return { canvas: buffer, originX: WORLD_MIN, originY: WORLD_MIN };
}

let hasContent = false;

function toBuffer(worldX: number, worldY: number): [number, number] {
  return [worldX - WORLD_MIN, worldY - WORLD_MIN];
}

/** Draws one stroke. The eraser composites destination-out on this buffer only. */
export function drawStroke(stroke: StrokeCommand): void {
  const context = ensure();
  const { points, size, tool } = stroke;
  if (points.length < 2) return;

  context.save();
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = size;
  // §6: the eraser never affects media, shapes, text or background.
  context.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
  context.strokeStyle = tool === 'eraser' ? '#000' : stroke.color;

  context.beginPath();
  const [startX, startY] = toBuffer(points[0]!, points[1]!);
  context.moveTo(startX, startY);

  if (points.length === 2) {
    // A single tap still has to leave a dot.
    context.lineTo(startX + 0.01, startY);
  } else {
    for (let i = 2; i < points.length; i += 2) {
      const [x, y] = toBuffer(points[i]!, points[i + 1]!);
      context.lineTo(x, y);
    }
  }

  context.stroke();
  context.restore();
  hasContent = true;
}

/** §6: bounds of a stroke in world space, inflated by its width. */
export function strokeBounds(stroke: StrokeCommand): Rect | null {
  const { points, size } = stroke;
  if (points.length < 2) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i]!;
    const y = points[i + 1]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  const pad = size / 2;
  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + size,
    height: maxY - minY + size,
  };
}

/** Recomputes the dirty rect from scratch. Trim-to-fit reads it (§4). */
export function computeDirtyRect(strokes: StrokeCommand[]): Rect | null {
  let rect: Rect | null = null;
  for (const stroke of strokes) {
    // Eraser strokes remove paint, so they cannot extend the painted bounds.
    if (stroke.tool === 'eraser') continue;
    rect = unionRect(rect, strokeBounds(stroke));
  }
  return rect;
}

/**
 * §6: undo clears the buffer and replays. Called after any change to the stroke
 * list that is not a plain append.
 */
export function replay(paint: PaintLayer): void {
  const context = ensure();
  context.clearRect(0, 0, PAINT_BUFFER_SIZE, PAINT_BUFFER_SIZE);
  hasContent = false;
  for (const stroke of paint.strokes) drawStroke(stroke);
  hasContent = paint.strokes.length > 0;
}

export function reset(): void {
  if (!ctx) return;
  ctx.clearRect(0, 0, PAINT_BUFFER_SIZE, PAINT_BUFFER_SIZE);
  hasContent = false;
}
