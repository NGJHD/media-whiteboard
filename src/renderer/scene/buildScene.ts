import Konva from 'konva';
import type { Doc, LayerId, SceneObject, ShapeObject, TextObject, MediaObject } from '../../shared/doc';
import { previewProxySize } from '../../shared/doc';
import { peekOrLast } from '../media/bitmapCache';
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
  /**
   * Objects to omit. Used only by the preview, for the text object whose
   * in-place editor is currently drawn over it (§10). Export passes nothing:
   * the UI is blocked while it runs, so nothing can be mid-edit.
   */
  hiddenIds?: LayerId[];
  /**
   * Draw animated media from the reduced-resolution preview frames (§7).
   *
   * The one substitution the preview is allowed to make, and it is a
   * substitution of *resolution only* — same node, same geometry, same order.
   * Export must never set this: it reads the native frames, which is what makes
   * the output pixels the ones §3 promises.
   */
  proxies?: boolean;
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
  const hidden = options.hiddenIds;
  const proxies = options.proxies ?? false;
  for (const obj of doc.objects) {
    if (hidden && hidden.includes(obj.id)) continue;
    const node = buildObject(obj, frameIndex, fps, proxies);
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
  proxies: boolean,
): Konva.Shape | null {
  switch (obj.kind) {
    case 'media':
      return buildMedia(obj, frameIndex, fps, proxies);
    case 'shape':
      return buildShape(obj);
    case 'text':
      return buildText(obj);
  }
}

/** True when this layer has preview frames and the caller wants them (§7). */
export function usesProxy(obj: MediaObject, proxies: boolean): boolean {
  return proxies && previewProxySize(obj.nativeWidth, obj.nativeHeight, obj.frameCount) !== null;
}

function buildMedia(
  obj: MediaObject,
  frameIndex: number,
  fps: number,
  proxies: boolean,
): Konva.Shape | null {
  const sourceIndex = sourceFrameIndex(obj, frameIndex, fps);
  // An undecoded frame falls back to the last one this layer drew, and to
  // nothing at all if it has never drawn. Export prefetches every frame it needs
  // before drawing (§3), so it always gets the exact frame and neither branch is
  // reachable there.
  const bitmap = peekOrLast(obj.cacheKey, sourceIndex, usesProxy(obj, proxies));
  if (!bitmap) return null;

  // The node is sized from the model, not from the bitmap, so a proxy draws at
  // exactly the same place and size as the native frame would — softer, never
  // displaced.
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
export function framesNeededAt(
  doc: Doc,
  frameIndex: number,
  proxies = false,
): Array<{ cacheKey: string; index: number; proxy: boolean }> {
  const fps = resolveFps(doc);
  const out: Array<{ cacheKey: string; index: number; proxy: boolean }> = [];
  for (const obj of doc.objects) {
    if (obj.kind !== 'media') continue;
    out.push({
      cacheKey: obj.cacheKey,
      index: sourceFrameIndex(obj, frameIndex, fps),
      proxy: usesProxy(obj, proxies),
    });
  }
  return out;
}
