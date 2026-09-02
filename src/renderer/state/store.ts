import { create } from 'zustand';
import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer';
import type { Doc, LayerId, Rect, SceneObject } from '../../shared/doc';
import { createEmptyDoc } from '../../shared/doc';
import { computeDirtyRect, replay } from '../paint/paintBuffer';

enablePatches();

/**
 * Application state (CLAUDE.md §5, §11).
 *
 * Undo is an inverse-command stack, as §11 requires, implemented with Immer
 * patches: every mutation records the patch that made it and the patch that
 * reverses it. That is genuinely an inverse command, not a snapshot, so paint
 * stroke lists and large object arrays are not duplicated per undo step.
 */

const UNDO_DEPTH = 100;

export type Tool = 'select' | 'brush' | 'eraser' | 'text' | 'rect' | 'ellipse';

interface HistoryEntry {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  /** Paint needs a buffer replay after undo/redo; objects do not. */
  touchesPaint: boolean;
}

export interface Toast {
  id: number;
  kind: 'error' | 'info' | 'warn';
  message: string;
  detail?: string;
}

export interface ViewTransform {
  scale: number;
  /** Screen-space translation applied after scaling. */
  offsetX: number;
  offsetY: number;
}

interface State {
  doc: Doc;
  tool: Tool;
  selection: LayerId[];
  view: ViewTransform;
  viewport: { width: number; height: number };
  toasts: Toast[];
  /** System font families (§10). Empty until enumeration finishes. */
  fonts: string[];

  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];

  /** Advances continuously in preview; also the export frame cursor (§11). */
  previewFrame: number;

  /**
   * Bumped by anything that changes what the viewport should draw. The preview
   * loop redraws when either this or the output frame index has moved, so a
   * static document costs one scene build rather than sixty a second.
   */
  revision: number;

  apply(label: string, recipe: (draft: Doc) => void, options?: { touchesPaint?: boolean }): void;
  /** Merges into the previous entry when the label matches — for drags and sliders. */
  applyMerged(label: string, recipe: (draft: Doc) => void): void;
  undo(): void;
  redo(): void;

  setTool(tool: Tool): void;
  setSelection(ids: LayerId[]): void;
  toggleSelection(id: LayerId): void;
  setView(view: Partial<ViewTransform>): void;
  setViewport(size: { width: number; height: number }): void;
  fitToWindow(): void;
  setPreviewFrame(frame: number): void;

  toast(kind: Toast['kind'], message: string, detail?: string): void;
  dismissToast(id: number): void;
  setFonts(fonts: string[]): void;

  selectedObjects(): SceneObject[];
}

let toastId = 0;

/** Patch paths tell us whether the paint buffer has to be replayed. */
function patchesTouchPaint(patches: Patch[]): boolean {
  return patches.some((p) => p.path[0] === 'paint');
}

export const useStore = create<State>((set, get) => ({
  doc: createEmptyDoc(''),
  tool: 'select',
  selection: [],
  view: { scale: 1, offsetX: 0, offsetY: 0 },
  viewport: { width: 0, height: 0 },
  toasts: [],
  fonts: [],
  undoStack: [],
  redoStack: [],
  previewFrame: 0,
  revision: 0,

  apply(label, recipe, options) {
    const state = get();
    const [next, patches, inverse] = produceWithPatches(state.doc, recipe);
    if (patches.length === 0) return;

    const touchesPaint = options?.touchesPaint ?? patchesTouchPaint(patches);
    const undoStack = [...state.undoStack, { label, patches, inverse, touchesPaint }];
    if (undoStack.length > UNDO_DEPTH) undoStack.shift();

    // Any new edit invalidates the redo branch.
    set({ doc: next, undoStack, redoStack: [], revision: state.revision + 1 });
  },

  /**
   * Coalesces a continuous gesture into one undo entry. A drag emits dozens of
   * updates a second; §11 expects one undo step for the whole move, not dozens.
   */
  applyMerged(label, recipe) {
    const state = get();
    const [next, patches, inverse] = produceWithPatches(state.doc, recipe);
    if (patches.length === 0) return;

    const last = state.undoStack[state.undoStack.length - 1];
    if (last && last.label === label) {
      const merged: HistoryEntry = {
        label,
        patches: [...last.patches, ...patches],
        // Inverses must unwind newest-first.
        inverse: [...inverse, ...last.inverse],
        touchesPaint: last.touchesPaint || patchesTouchPaint(patches),
      };
      const undoStack = [...state.undoStack.slice(0, -1), merged];
      set({ doc: next, undoStack, redoStack: [], revision: state.revision + 1 });
      return;
    }

    get().apply(label, recipe);
  },

  undo() {
    const state = get();
    const entry = state.undoStack[state.undoStack.length - 1];
    if (!entry) return;

    const doc = applyPatches(state.doc, entry.inverse);
    if (entry.touchesPaint) replay(doc.paint);

    set({
      doc,
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, entry],
      selection: state.selection.filter((id) => doc.objects.some((o) => o.id === id)),
      revision: state.revision + 1,
    });
  },

  redo() {
    const state = get();
    const entry = state.redoStack[state.redoStack.length - 1];
    if (!entry) return;

    const doc = applyPatches(state.doc, entry.patches);
    if (entry.touchesPaint) replay(doc.paint);

    set({
      doc,
      redoStack: state.redoStack.slice(0, -1),
      undoStack: [...state.undoStack, entry],
      selection: state.selection.filter((id) => doc.objects.some((o) => o.id === id)),
      revision: state.revision + 1,
    });
  },

  setTool(tool) {
    // §9: the options row shows tool options or selection properties, never
    // both, so switching to a drawing tool drops the selection.
    set({
      tool,
      selection: tool === 'select' ? get().selection : [],
      revision: get().revision + 1,
    });
  },

  setSelection(selection) {
    set({ selection, revision: get().revision + 1 });
  },

  toggleSelection(id) {
    const selection = get().selection;
    set({
      selection: selection.includes(id)
        ? selection.filter((s) => s !== id)
        : [...selection, id],
      revision: get().revision + 1,
    });
  },

  setView(view) {
    set({ view: { ...get().view, ...view }, revision: get().revision + 1 });
  },

  setViewport(viewport) {
    set({ viewport, revision: get().revision + 1 });
  },

  /** §4: auto-fit canvasRect into the viewport. */
  fitToWindow() {
    const { doc, viewport } = get();
    if (viewport.width === 0 || viewport.height === 0) return;

    const margin = 48;
    const scale = Math.min(
      (viewport.width - margin) / doc.canvasRect.width,
      (viewport.height - margin) / doc.canvasRect.height,
      4,
    );
    const centreX = doc.canvasRect.x + doc.canvasRect.width / 2;
    const centreY = doc.canvasRect.y + doc.canvasRect.height / 2;

    set({
      view: {
        scale,
        offsetX: viewport.width / 2 - centreX * scale,
        offsetY: viewport.height / 2 - centreY * scale,
      },
      revision: get().revision + 1,
    });
  },

  setPreviewFrame(previewFrame) {
    set({ previewFrame });
  },

  toast(kind, message, detail) {
    const toast: Toast = { id: (toastId += 1), kind, message, detail };
    set({ toasts: [...get().toasts, toast] });
    // Errors stay until dismissed; §14 wants them readable, not flashed.
    if (kind !== 'error') {
      setTimeout(() => get().dismissToast(toast.id), 4500);
    }
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  setFonts(fonts) {
    set({ fonts });
  },

  selectedObjects() {
    const { doc, selection } = get();
    return doc.objects.filter((o) => selection.includes(o.id));
  },
}));

/* -------------------------------------------------------------------------- */
/* Coordinate helpers                                                         */
/* -------------------------------------------------------------------------- */

export function screenToWorld(view: ViewTransform, x: number, y: number): { x: number; y: number } {
  return { x: (x - view.offsetX) / view.scale, y: (y - view.offsetY) / view.scale };
}

export function worldToScreen(view: ViewTransform, x: number, y: number): { x: number; y: number } {
  return { x: x * view.scale + view.offsetX, y: y * view.scale + view.offsetY };
}

/** Recomputes the paint dirty rect after a stroke list change (§6). */
export function refreshDirtyRect(doc: Doc): Rect | null {
  return computeDirtyRect(doc.paint.strokes);
}
