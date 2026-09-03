import type { ShapeObject, StrokeCommand, TextObject } from '../../shared/doc';
import { WORLD_MAX, WORLD_MIN } from '../../shared/doc';
import { clampObjectToWorld } from '../actions/objectActions';
import { computeDirtyRect, drawStroke } from '../paint/paintBuffer';
import { useStore } from '../state/store';
import { useToolDefaults } from '../state/toolDefaults';

/**
 * The drawing tools (CLAUDE.md §10).
 *
 * Brush and eraser paint into the §6 raster buffer. Rect, ellipse and text
 * create SceneObjects, which means they render through `buildScene` like
 * everything else and need no preview of their own.
 */

function newId(): string {
  return crypto.randomUUID();
}

function clampToWorld(value: number): number {
  return Math.min(Math.max(value, WORLD_MIN), WORLD_MAX);
}

export interface Point {
  x: number;
  y: number;
}

export interface DrawGesture {
  move(point: Point, modifiers: { alt: boolean; shift: boolean }): void;
  end(point: Point, modifiers: { alt: boolean; shift: boolean }): void;
  cancel(): void;
}

/* -------------------------------------------------------------------------- */
/* Brush and eraser (§6, §10)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Points are interpolated between pointer events so a fast stroke does not gap
 * (§10). The spacing is in world units and deliberately finer than a stroke
 * width, so even a thin brush stays continuous.
 */
const MAX_STEP = 2;

function interpolate(from: Point, to: Point): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= MAX_STEP) return [to];

  const steps = Math.ceil(distance / MAX_STEP);
  const points: Point[] = [];
  for (let i = 1; i <= steps; i += 1) {
    points.push({ x: from.x + (dx * i) / steps, y: from.y + (dy * i) / steps });
  }
  return points;
}

export function beginStroke(start: Point, tool: 'brush' | 'eraser'): DrawGesture {
  const defaults = useToolDefaults.getState();
  const size = tool === 'brush' ? defaults.brushSize : defaults.eraserSize;
  const color = defaults.brushColor;

  const points: number[] = [clampToWorld(start.x), clampToWorld(start.y)];
  let last: Point = { x: clampToWorld(start.x), y: clampToWorld(start.y) };

  // Paint the initial dot immediately, so a tap leaves a mark.
  drawStroke({ tool, points: [...points], color, size, timestamp: Date.now() });
  useStore.getState().bumpRevision();

  /** Paints only the newest segment; repainting the whole path would be O(n^2). */
  function paintSegment(from: Point, to: Point): void {
    drawStroke({
      tool,
      points: [from.x, from.y, to.x, to.y],
      color,
      size,
      timestamp: Date.now(),
    });
  }

  function extend(point: Point): void {
    const target = { x: clampToWorld(point.x), y: clampToWorld(point.y) };
    for (const step of interpolate(last, target)) {
      points.push(step.x, step.y);
      paintSegment(last, step);
      last = step;
    }
    useStore.getState().bumpRevision();
  }

  function commit(): void {
    const stroke: StrokeCommand = { tool, points: [...points], color, size, timestamp: Date.now() };
    // The buffer already holds this stroke, so committing draws nothing extra.
    // The entry must still be marked as touching paint, though: that flag is
    // what makes undo and redo replay the buffer (§6). Suppressing it leaves
    // undone strokes on screen even though they are gone from the document.
    useStore.getState().apply('Paint', (draft) => {
      draft.paint.strokes.push(stroke);
      draft.paint.dirtyRect = computeDirtyRect(draft.paint.strokes);
    });
  }

  return {
    move: (point) => extend(point),
    end(point) {
      extend(point);
      commit();
    },
    cancel() {
      // Nothing was committed to the document, so replaying restores the buffer.
      const { doc } = useStore.getState();
      void import('../paint/paintBuffer').then((m) => {
        m.replay(doc.paint);
        useStore.getState().bumpRevision();
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Rect and ellipse (§10)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Drag to draw. **Shift** constrains to a square or a perfect circle (§10).
 *
 * The object is created up front and resized during the drag through
 * `applyMerged`, so it renders through `buildScene` like any other object and
 * the whole gesture is one undo entry.
 */
export function beginShape(start: Point, shape: 'rect' | 'ellipse'): DrawGesture {
  const defaults = useToolDefaults.getState();
  const id = newId();
  const origin = { x: clampToWorld(start.x), y: clampToWorld(start.y) };
  const label = `Draw ${shape} ${id}`;
  let created = false;

  function geometry(point: Point, constrain: boolean) {
    const to = { x: clampToWorld(point.x), y: clampToWorld(point.y) };
    let width = to.x - origin.x;
    let height = to.y - origin.y;

    if (constrain) {
      const side = Math.max(Math.abs(width), Math.abs(height));
      width = Math.sign(width || 1) * side;
      height = Math.sign(height || 1) * side;
    }

    return {
      x: origin.x + width / 2,
      y: origin.y + height / 2,
      width: Math.abs(width),
      height: Math.abs(height),
    };
  }

  function update(point: Point, constrain: boolean): void {
    const g = geometry(point, constrain);

    useStore.getState().applyMerged(label, (draft) => {
      let object = draft.objects.find((o) => o.id === id) as ShapeObject | undefined;
      if (!object) {
        object = {
          id,
          kind: 'shape',
          shape,
          x: g.x,
          y: g.y,
          width: g.width,
          height: g.height,
          rotation: 0,
          opacity: 1,
          stroke: defaults.stroke,
          strokeWidth: defaults.strokeWidth,
          fill: defaults.fill,
        };
        draft.objects.push(object);
        return;
      }
      object.x = g.x;
      object.y = g.y;
      object.width = g.width;
      object.height = g.height;
    });
    created = true;
  }

  return {
    move: (point, modifiers) => update(point, modifiers.shift),
    end(point, modifiers) {
      update(point, modifiers.shift);

      const store = useStore.getState();
      const object = store.doc.objects.find((o) => o.id === id);
      // A click without a drag leaves a zero-size shape; drop it rather than
      // littering the document with something invisible.
      if (!object || object.width < 2 || object.height < 2) {
        store.apply(label, (draft) => {
          draft.objects = draft.objects.filter((o) => o.id !== id);
        });
        return;
      }
      store.setTool('select');
      store.setSelection([id]);
    },
    cancel() {
      if (!created) return;
      useStore.getState().apply(label, (draft) => {
        draft.objects = draft.objects.filter((o) => o.id !== id);
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Text (§10)                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Click to place, then edit in place. The editor is a DOM textarea overlay.
 *
 * The click sets the box's **left** edge, not its centre — the caret appears
 * where the pointer was and the text runs to the right of it, which is what
 * clicking to type means everywhere else. The model stores a centre (§5), so
 * that is half a box width to the right of the click.
 *
 * Nothing is added to the document here: the object is `pendingText` until it
 * commits with content, so a text that is placed and then clicked away from
 * leaves no trace and a real one costs exactly one undo entry.
 */
export function placeText(at: Point): TextObject {
  const defaults = useToolDefaults.getState();
  const boxWidth = 320;

  const object: TextObject = {
    id: newId(),
    kind: 'text',
    x: clampToWorld(at.x + boxWidth / 2),
    y: clampToWorld(at.y),
    width: boxWidth,
    height: defaults.fontSize * 1.2,
    rotation: 0,
    opacity: 1,
    text: '',
    fontFamily: defaults.fontFamily,
    fontSize: defaults.fontSize,
    fontStyle: defaults.fontStyle,
    color: defaults.textColor,
    outline: defaults.outline,
    shadow: defaults.shadow,
    boxWidth,
  };
  clampObjectToWorld(object);

  const store = useStore.getState();
  // §10: back to Select, so the finished text can be moved immediately. Nothing
  // is selected yet — there is no object to select until the editor commits.
  store.setTool('select');
  store.setSelection([]);
  store.setPendingText(object);
  store.setEditingText(object.id);

  return object;
}
