import type { Rect } from '../../shared/doc';
import { MAX_CANVAS_DIMENSION, clampRectToWorld, objectBounds, unionRect } from '../../shared/doc';
import { replay } from '../paint/paintBuffer';
import { useStore } from '../state/store';

/**
 * §4 Trim to fit: sets canvasRect to the exact union bounding box of all visible
 * content — media, shapes, text, and the painted dirty rect. No padding is
 * added. It may expand as well as shrink, and it is one undoable action.
 *
 * It cannot produce an out-of-bounds rect, because it is the union of content
 * that is itself already in bounds.
 */
export function trimToFit(): void {
  const store = useStore.getState();
  const { doc } = store;

  let bounds: Rect | null = null;
  for (const obj of doc.objects) {
    bounds = unionRect(bounds, objectBounds(obj));
  }
  bounds = unionRect(bounds, doc.paint.dirtyRect);

  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    store.toast('info', 'Nothing to trim to — the canvas is empty.');
    return;
  }

  // The union can still exceed the §4 dimension cap if content is spread wide.
  if (bounds.width > MAX_CANVAS_DIMENSION || bounds.height > MAX_CANVAS_DIMENSION) {
    store.toast(
      'error',
      `Content spans ${Math.round(bounds.width)}x${Math.round(bounds.height)}, ` +
        `which is larger than the ${MAX_CANVAS_DIMENSION} px limit.`,
    );
    return;
  }

  const next = clampRectToWorld({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  });

  store.apply('Trim to fit', (draft) => {
    draft.canvasRect = next;
  });
  useStore.getState().fitToWindow();
}

/**
 * §6/§10: wipes the whole paint layer in one undoable step.
 *
 * The eraser is a stroke tool, so clearing the layer is a different action, not
 * a very large eraser — and it has to go through the document rather than the
 * buffer, or undo would replay strokes that were supposed to be gone.
 */
export function clearPaint(): void {
  const store = useStore.getState();
  if (store.doc.paint.strokes.length === 0) return;

  store.apply('Clear drawing', (draft) => {
    draft.paint.strokes = [];
    draft.paint.dirtyRect = null;
  });
  replay(useStore.getState().doc.paint);
  useStore.getState().bumpRevision();
}
