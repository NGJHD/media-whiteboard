import Konva from 'konva';
import type { Doc, SceneObject, ShapeObject, TextObject, MediaObject } from '../../shared/doc';
import { peek } from '../media/bitmapCache';
import { getPaintCanvas } from '../paint/paintBuffer';
import { resolveFps, sourceFrameIndex } from './timing';

/**
 * THE scene builder (CLAUDE.md §3).
 *
 * > Non-negotiable: this is the only place scene content is constructed. Nothing
 * > that affects output pixels may live in the preview-only overlay layer, and
 * > nothing may be drawn directly to a canvas outside it.
 *
 * Preview and export both call this, so the same Konva version renders the same
 * node tree and pixel equivalence is structural rather than maintained by
 * discipline. The two differ only in stage geometry and overlay chrome — see the
 * table in §3.
 *
 * Returns a content group in **world coordinates** containing, in order:
 * background, every SceneObject, then the paint layer.
 */

export interface BuildOptions {
  /**
   * Export clips to canvasRect and paints the background inside it. Preview
   * draws the background too, but leaves clipping to the viewport chrome so
   * out-of-canvas content stays visible while editing.
   */
  clipToCanvas: boolean;
}

export function buildScene(
  doc: Doc,
  frameIndex: number,
  options: BuildOptions = { clipToCanvas: false },
): Konva.Group {
  const group = new Konva.Group({ listening: false });
  const { canvasRect } = doc;

  if (options.clipToCanvas) {
    group.clip({
      x: canvasRect.x,
      y: canvasRect.y,
      width: canvasRect.width,
      height: canvasRect.height,
    });
  }

  // 1. Background. Transparent means simply not drawing one — the checkerboard
  //    is viewport chrome and must never reach the output.
  if (!doc.background.transparent) {
    group.add(
      new Konva.Rect({
        x: canvasRect.x,
        y: canvasRect.y,
        width: canvasRect.width,
        height: canvasRect.height,
        fill: doc.background.color,
        listening: false,
      }),
    );
  }

  // 2. Objects, in array order (index 0 is the back).
  const fps = resolveFps(doc);
  for (const obj of doc.objects) {
    const node = buildObject(obj, frameIndex, fps);
    if (node) group.add(node);
  }

  // 3. Paint, above everything (§6).
  const paint = getPaintCanvas();
  if (paint) {
    group.add(
      new Konva.Image({
        image: paint.canvas,
        x: paint.originX,
        y: paint.originY,
        width: paint.canvas.width,
        height: paint.canvas.height,
        listening: false,
      }),
    );
  }

  return group;
}

function commonProps(obj: SceneObject) {
  return {
    // Konva positions by top-left plus offset; the model stores centres, so the
    // offset puts the origin at the centre and rotation happens about it.
    x: obj.x,
    y: obj.y,
    offsetX: obj.width / 2,
    offsetY: obj.height / 2,
    width: obj.width,
    height: obj.height,
    rotation: obj.rotation,
    opacity: obj.opacity,
    listening: false,
  };
}

function buildObject(
  obj: SceneObject,
  frameIndex: number,
  fps: number,
): Konva.Shape | null {
  switch (obj.kind) {
    case 'media':
      return buildMedia(obj, frameIndex, fps);
    case 'shape':
      return buildShape(obj);
    case 'text':
      return buildText(obj);
  }
}

function buildMedia(obj: MediaObject, frameIndex: number, fps: number): Konva.Shape | null {
  const sourceIndex = sourceFrameIndex(obj, frameIndex, fps);
  const bitmap = peek(obj.cacheKey, sourceIndex);

  // An undecoded frame draws nothing rather than a blank rectangle — the preview
  // loop will pick it up once the bitmap lands. Export prefetches first (§3), so
  // this branch must not be reachable there.
  if (!bitmap) return null;

  return new Konva.Image({ ...commonProps(obj), image: bitmap });
}

function buildShape(obj: ShapeObject): Konva.Shape {
  const props = {
    ...commonProps(obj),
    stroke: obj.stroke,
    strokeWidth: obj.strokeWidth,
    fill: obj.fill ?? undefined,
  };

  if (obj.shape === 'ellipse') {
    // Konva.Ellipse positions by centre and takes radii, so it needs no offset.
    return new Konva.Ellipse({
      ...props,
      offsetX: 0,
      offsetY: 0,
      radiusX: obj.width / 2,
      radiusY: obj.height / 2,
    });
  }

  return new Konva.Rect(props);
}

function buildText(obj: TextObject): Konva.Shape {
  return new Konva.Text({
    ...commonProps(obj),
    // §10: text reflows within boxWidth and its height is always auto-computed
    // from the wrapped result, so height is never imposed here.
    width: obj.boxWidth,
    height: undefined,
    offsetX: obj.boxWidth / 2,
    offsetY: obj.height / 2,
    text: obj.text,
    fontFamily: obj.fontFamily,
    fontSize: obj.fontSize,
    fontStyle: obj.fontStyle,
    fill: obj.color,
    wrap: 'word',
    lineHeight: 1.2,
    stroke: obj.outline?.color,
    strokeWidth: obj.outline?.width ?? 0,
    // Konva paints the stroke over the glyph by default, which eats thin text.
    fillAfterStrokeEnabled: true,
    shadowColor: obj.shadow?.color,
    shadowBlur: obj.shadow?.blur,
    shadowOffsetX: obj.shadow?.offsetX,
    shadowOffsetY: obj.shadow?.offsetY,
    shadowEnabled: Boolean(obj.shadow),
  });
}

/**
 * Every frame a media layer needs for one output frame. Export uses this to
 * prefetch before drawing, since `stage.draw()` is synchronous and a missing
 * bitmap would render nothing at all.
 */
export function framesNeededAt(doc: Doc, frameIndex: number): Array<{ cacheKey: string; index: number }> {
  const fps = resolveFps(doc);
  const out: Array<{ cacheKey: string; index: number }> = [];
  for (const obj of doc.objects) {
    if (obj.kind !== 'media') continue;
    out.push({ cacheKey: obj.cacheKey, index: sourceFrameIndex(obj, frameIndex, fps) });
  }
  return out;
}
