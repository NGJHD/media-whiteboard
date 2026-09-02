import type { Doc, LayerId, SceneObject } from '../../shared/doc';
import { WORLD_MAX, WORLD_MIN, objectBounds } from '../../shared/doc';
import { useStore } from '../state/store';

/**
 * Object-level commands (CLAUDE.md §10, §11).
 *
 * Z-order is the `objects` array order and is exposed only through the
 * right-click menu — there is no layer panel (§5, §17).
 */

function newId(): string {
  return crypto.randomUUID();
}

/** §4: an object's bounding box is hard clamped to the world. */
export function clampObjectToWorld(obj: SceneObject): void {
  const bounds = objectBounds(obj);
  const clampedX = Math.min(Math.max(bounds.x, WORLD_MIN), WORLD_MAX - bounds.width);
  const clampedY = Math.min(Math.max(bounds.y, WORLD_MIN), WORLD_MAX - bounds.height);
  obj.x += clampedX - bounds.x;
  obj.y += clampedY - bounds.y;
}

export function deleteSelection(): void {
  const { selection, apply, setSelection } = useStore.getState();
  if (selection.length === 0) return;
  apply('Delete', (draft) => {
    draft.objects = draft.objects.filter((o) => !selection.includes(o.id));
  });
  setSelection([]);
}

/** §11: nudge by 1 px, or 10 with Shift. One undo entry per key press. */
export function nudgeSelection(dx: number, dy: number): void {
  const { selection, apply } = useStore.getState();
  if (selection.length === 0) return;
  apply('Nudge', (draft) => {
    for (const obj of draft.objects) {
      if (!selection.includes(obj.id)) continue;
      obj.x += dx;
      obj.y += dy;
      clampObjectToWorld(obj);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Z-order (§5)                                                               */
/* -------------------------------------------------------------------------- */

type ZMove = 'front' | 'forward' | 'backward' | 'back';

export function reorderSelection(move: ZMove): void {
  const { selection, apply } = useStore.getState();
  if (selection.length === 0) return;

  apply(`Z-order: ${move}`, (draft) => {
    const selected = draft.objects.filter((o) => selection.includes(o.id));
    const rest = draft.objects.filter((o) => !selection.includes(o.id));

    switch (move) {
      case 'front':
        draft.objects = [...rest, ...selected];
        return;
      case 'back':
        draft.objects = [...selected, ...rest];
        return;
      default:
        break;
    }

    // Step one place, preserving the relative order of the selection and
    // stopping at the ends rather than wrapping.
    const indices = draft.objects
      .map((o, i) => (selection.includes(o.id) ? i : -1))
      .filter((i) => i >= 0);

    if (move === 'forward') {
      // Walk from the top so members do not leapfrog each other.
      for (let i = indices.length - 1; i >= 0; i -= 1) {
        const from = indices[i]!;
        const to = from + 1;
        if (to >= draft.objects.length) continue;
        if (selection.includes(draft.objects[to]!.id)) continue;
        [draft.objects[from], draft.objects[to]] = [draft.objects[to]!, draft.objects[from]!];
      }
    } else {
      for (let i = 0; i < indices.length; i += 1) {
        const from = indices[i]!;
        const to = from - 1;
        if (to < 0) continue;
        if (selection.includes(draft.objects[to]!.id)) continue;
        [draft.objects[from], draft.objects[to]] = [draft.objects[to]!, draft.objects[from]!];
      }
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Clipboard and duplication (§11)                                            */
/* -------------------------------------------------------------------------- */

/** In-app clipboard. The OS clipboard only carries images (§11, Ctrl+V). */
let clipboard: SceneObject[] = [];

export function copySelection(): void {
  const objects = useStore.getState().selectedObjects();
  if (objects.length === 0) return;
  clipboard = objects.map((o) => structuredClone(o));
}

export function hasClipboard(): boolean {
  return clipboard.length > 0;
}

/** §11: paste offset by 10, 10. */
export function pasteClipboard(): void {
  if (clipboard.length === 0) return;
  const { apply, setSelection } = useStore.getState();
  const copies = clipboard.map((o) => ({ ...structuredClone(o), id: newId(), x: o.x + 10, y: o.y + 10 }));
  for (const copy of copies) clampObjectToWorld(copy);

  apply('Paste', (draft) => {
    draft.objects.push(...copies);
  });
  setSelection(copies.map((o) => o.id));
}

export function duplicateSelection(): void {
  const objects = useStore.getState().selectedObjects();
  if (objects.length === 0) return;
  const { apply, setSelection } = useStore.getState();

  const copies = objects.map((o) => ({ ...structuredClone(o), id: newId(), x: o.x + 10, y: o.y + 10 }));
  for (const copy of copies) clampObjectToWorld(copy);

  apply('Duplicate', (draft) => {
    draft.objects.push(...copies);
  });
  setSelection(copies.map((o) => o.id));
}

export function selectAll(): void {
  const { doc, setSelection } = useStore.getState();
  setSelection(doc.objects.filter((o) => !o.locked).map((o) => o.id));
}

/* -------------------------------------------------------------------------- */
/* Hit testing (§10)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Objects under a world point, topmost first. Alt+click cycles through this
 * list, which is the only way to reach a fully covered object (§10).
 */
export function objectsAt(doc: Doc, x: number, y: number): SceneObject[] {
  const hits: SceneObject[] = [];
  for (const obj of doc.objects) {
    if (obj.locked) continue;
    if (containsPoint(obj, x, y)) hits.push(obj);
  }
  return hits.reverse();
}

/** Point-in-object, in the object's own unrotated frame. */
export function containsPoint(obj: SceneObject, x: number, y: number): boolean {
  const rad = (-obj.rotation * Math.PI) / 180;
  const dx = x - obj.x;
  const dy = y - obj.y;
  const localX = dx * Math.cos(rad) - dy * Math.sin(rad);
  const localY = dx * Math.sin(rad) + dy * Math.cos(rad);
  const halfW = (obj.kind === 'text' ? obj.boxWidth : obj.width) / 2;
  const halfH = obj.height / 2;
  return Math.abs(localX) <= halfW && Math.abs(localY) <= halfH;
}

/** Next object in the stack under the cursor, given what is already selected. */
export function cycleAt(doc: Doc, x: number, y: number, current: LayerId[]): LayerId | null {
  const hits = objectsAt(doc, x, y);
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0]!.id;

  const index = hits.findIndex((o) => current.includes(o.id));
  return hits[(index + 1) % hits.length]!.id;
}
