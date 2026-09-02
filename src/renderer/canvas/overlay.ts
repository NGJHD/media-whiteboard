import Konva from 'konva';
import type { Doc, Rect } from '../../shared/doc';
import { objectBounds } from '../../shared/doc';
import type { ViewTransform } from '../state/store';

/**
 * Preview-only chrome (CLAUDE.md §3, §9).
 *
 * Nothing drawn here may affect output pixels. Everything that does belongs in
 * `buildScene`, which export also calls. Checkerboard, out-of-canvas grey,
 * selection handles and snap guides all live on this layer and only this layer.
 */

const CHECKER_SIZE = 10;
const CHECKER_LIGHT = '#3a3f47';
const CHECKER_DARK = '#31353c';
const OUTSIDE_GREY = '#16181b';

let checkerPattern: HTMLCanvasElement | null = null;

function checkerboard(): HTMLCanvasElement {
  if (checkerPattern) return checkerPattern;
  const canvas = document.createElement('canvas');
  canvas.width = CHECKER_SIZE * 2;
  canvas.height = CHECKER_SIZE * 2;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = CHECKER_LIGHT;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = CHECKER_DARK;
  ctx.fillRect(0, 0, CHECKER_SIZE, CHECKER_SIZE);
  ctx.fillRect(CHECKER_SIZE, CHECKER_SIZE, CHECKER_SIZE, CHECKER_SIZE);
  checkerPattern = canvas;
  return canvas;
}

export interface SnapGuide {
  orientation: 'v' | 'h';
  /** World coordinate of the guide line. */
  position: number;
}

export interface OverlayState {
  doc: Doc;
  view: ViewTransform;
  viewport: { width: number; height: number };
  selection: string[];
  snapGuides?: SnapGuide[];
  marquee?: Rect | null;
  /** Suppressed from the selection outline: its editor is the box (§10). */
  editingTextId?: string | null;
}

function toScreen(view: ViewTransform, rect: Rect): Rect {
  return {
    x: rect.x * view.scale + view.offsetX,
    y: rect.y * view.scale + view.offsetY,
    width: rect.width * view.scale,
    height: rect.height * view.scale,
  };
}

export function drawOverlay(layer: Konva.Layer, state: OverlayState): void {
  layer.destroyChildren();

  const { doc, view, viewport, selection } = state;
  const canvas = toScreen(view, doc.canvasRect);

  // 1. Flat neutral grey outside canvasRect, so the boundary is unambiguous (§9).
  //    Drawn as four bands rather than a full-cover rect with a hole, which
  //    would need a clip and cost a save/restore per frame.
  const bands: Rect[] = [
    { x: 0, y: 0, width: viewport.width, height: Math.max(0, canvas.y) },
    {
      x: 0,
      y: canvas.y + canvas.height,
      width: viewport.width,
      height: Math.max(0, viewport.height - (canvas.y + canvas.height)),
    },
    { x: 0, y: canvas.y, width: Math.max(0, canvas.x), height: canvas.height },
    {
      x: canvas.x + canvas.width,
      y: canvas.y,
      width: Math.max(0, viewport.width - (canvas.x + canvas.width)),
      height: canvas.height,
    },
  ];
  for (const band of bands) {
    if (band.width <= 0 || band.height <= 0) continue;
    layer.add(new Konva.Rect({ ...band, fill: OUTSIDE_GREY, listening: false }));
  }

  // 2. Checkerboard *under* the content when the background is transparent.
  //    buildScene draws nothing for a transparent background, so this shows
  //    through without ever being composited into the export.
  if (doc.background.transparent) {
    layer.add(
      new Konva.Rect({
        ...canvas,
        // Konva types this as HTMLImageElement, but it accepts any
        // CanvasImageSource; a generated pattern canvas avoids shipping an asset.
        fillPatternImage: checkerboard() as unknown as HTMLImageElement,
        fillPatternRepeat: 'repeat',
        listening: false,
      }),
    );
    layer.moveToBottom();
  }

  // 3. Canvas boundary.
  layer.add(
    new Konva.Rect({
      ...canvas,
      stroke: '#5a626e',
      strokeWidth: 1,
      listening: false,
    }),
  );

  // 4. Selection outlines and handles.
  const selected = doc.objects.filter(
    (o) => selection.includes(o.id) && o.id !== state.editingTextId,
  );
  for (const obj of selected) {
    const bounds = toScreen(view, objectBounds(obj));
    layer.add(
      new Konva.Rect({
        ...bounds,
        stroke: '#6ea8fe',
        strokeWidth: 1.5,
        dash: selected.length > 1 ? [4, 3] : undefined,
        listening: false,
      }),
    );
  }

  // 5. Snap guides (§11).
  for (const guide of state.snapGuides ?? []) {
    const isVertical = guide.orientation === 'v';
    const screenPos = isVertical
      ? guide.position * view.scale + view.offsetX
      : guide.position * view.scale + view.offsetY;
    layer.add(
      new Konva.Line({
        points: isVertical
          ? [screenPos, 0, screenPos, viewport.height]
          : [0, screenPos, viewport.width, screenPos],
        stroke: '#f2b544',
        strokeWidth: 1,
        listening: false,
      }),
    );
  }

  // 6. Rubber-band marquee (§10).
  if (state.marquee) {
    const rect = toScreen(view, state.marquee);
    layer.add(
      new Konva.Rect({
        ...rect,
        stroke: '#6ea8fe',
        strokeWidth: 1,
        dash: [4, 3],
        fill: 'rgba(110,168,254,0.12)',
        listening: false,
      }),
    );
  }
}
