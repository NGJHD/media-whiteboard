import { create } from 'zustand';
import { applyPatches, enablePatches, produce, produceWithPatches, type Patch } from 'immer';
import type { Doc, LayerId, Rect, SceneObject, TextObject } from '../../shared/doc';
import { createEmptyDoc } from '../../shared/doc';
import { PROJECT_SCHEMA_VERSION, PROJECT_EXTENSION } from '../../shared/ipc';
import { EXTENSION_PATTERN } from '../../shared/formats';
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

/**
 * One in-flight background decode (§7). The object is already on the canvas;
 * this drives the non-blocking bar that says the rest of its frames are coming.
 */
export interface ImportJob {
  cacheKey: string;
  /** File name, for the bar's label. */
  name: string;
  readyFrames: number;
  totalFrames: number;
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
  /** The text object being edited in place, if any (§10). */
  editingTextId: LayerId | null;
  /**
   * A text object that has been placed but not yet committed (§10).
   *
   * It is deliberately **not** in `doc.objects`: an in-progress text is not yet
   * an edit, and putting it in the document is what made a cancelled text leave
   * an undo entry behind and a real one take two. It lands in the document as a
   * single 'Add text' entry when the editor commits with content, and simply
   * disappears when it does not.
   *
   * Nothing else can reach it while it exists — the editor holds focus, and
   * anything that would touch the object blurs the textarea and commits first.
   */
  pendingText: TextObject | null;
  /** Path of the open project, so Ctrl+S can suggest it again (§13). */
  projectPath: string | null;
  /** Background decodes still running (§7). Empty when nothing is loading. */
  imports: ImportJob[];

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

  apply(label: string, recipe: (draft: Doc) => void): void;
  /** Merges into the previous entry when the label matches — for drags and sliders. */
  applyMerged(label: string, recipe: (draft: Doc) => void): void;
  /**
   * Changes the document **without** an undo entry.
   *
   * Only for facts the app discovers about the document rather than edits the
   * user made: a background decode reporting its true frame count, the output
   * path seeded at startup. Undoing those would mean reverting to a number that
   * was never right. It must never move or remove an object — the undo stack's
   * patches address objects by array index.
   */
  mutate(recipe: (draft: Doc) => void): void;
  undo(): void;
  redo(): void;

  setTool(tool: Tool): void;
  setSelection(ids: LayerId[]): void;
  toggleSelection(id: LayerId): void;
  setView(view: Partial<ViewTransform>): void;
  setViewport(size: { width: number; height: number }): void;
  fitToWindow(): void;
  setPreviewFrame(frame: number): void;
  /**
   * Forces a viewport redraw without a document change. Live brush strokes paint
   * straight into the §6 buffer for feedback, and that buffer is not part of the
   * document, so nothing else would tell the render loop to look again.
   */
  bumpRevision(): void;

  beginImport(job: ImportJob): void;
  updateImport(cacheKey: string, readyFrames: number, totalFrames: number): void;
  endImport(cacheKey: string): void;

  toast(kind: Toast['kind'], message: string, detail?: string): void;
  dismissToast(id: number): void;
  setFonts(fonts: string[]): void;
  setEditingText(id: LayerId | null): void;
  /** Opens the editor on a text object that is not in the document yet (§10). */
  setPendingText(object: TextObject | null): void;
  saveProject(): Promise<void>;
  openProject(): Promise<void>;

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
  editingTextId: null,
  pendingText: null,
  projectPath: null,
  imports: [],
  undoStack: [],
  redoStack: [],
  previewFrame: 0,
  revision: 0,

  apply(label, recipe) {
    const state = get();
    const [next, patches, inverse] = produceWithPatches(state.doc, recipe);
    if (patches.length === 0) return;

    const touchesPaint = patchesTouchPaint(patches);
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

  mutate(recipe) {
    const state = get();
    const next = produce(state.doc, recipe);
    if (next === state.doc) return;
    set({ doc: next, revision: state.revision + 1 });
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

  /**
   * §4: fit canvasRect into the viewport.
   *
   * This is the *only* view transform the app has. There is no manual zoom and
   * no pan, so the Viewport re-runs this whenever canvasRect or the viewport
   * size changes — a window resize, a W/H edit, a trim, an undo, a project
   * load. Anything that could leave the canvas mis-framed goes through the same
   * one place rather than each caller remembering to refit.
   */
  fitToWindow() {
    const { doc, viewport } = get();
    if (viewport.width === 0 || viewport.height === 0) return;

    const margin = 40;
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

  bumpRevision() {
    set({ revision: get().revision + 1 });
  },

  beginImport(job) {
    const rest = get().imports.filter((i) => i.cacheKey !== job.cacheKey);
    set({ imports: [...rest, job] });
  },

  updateImport(cacheKey, readyFrames, totalFrames) {
    const imports = get().imports;
    if (!imports.some((i) => i.cacheKey === cacheKey)) return;
    set({
      imports: imports.map((i) =>
        i.cacheKey === cacheKey ? { ...i, readyFrames, totalFrames } : i,
      ),
    });
  },

  endImport(cacheKey) {
    set({ imports: get().imports.filter((i) => i.cacheKey !== cacheKey) });
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

  setEditingText(editingTextId) {
    // A pending text belongs to the editor that was open. Closing that editor by
    // any route — commit, Esc, the global shortcut in keyboard.ts — drops it, so
    // an uncommitted object can never outlive its own editor.
    const { pendingText } = get();
    const stillPending = pendingText && pendingText.id === editingTextId ? pendingText : null;
    set({ editingTextId, pendingText: stillPending, revision: get().revision + 1 });
  },

  setPendingText(pendingText) {
    set({ pendingText, revision: get().revision + 1 });
  },

  /**
   * §13: the full Doc plus the paint stroke list and absolute source paths,
   * with a schemaVersion from day one.
   */
  async saveProject() {
    const state = get();
    const suggested =
      state.projectPath ??
      state.doc.outputPath.replace(EXTENSION_PATTERN, '') + `.${PROJECT_EXTENSION}`;

    try {
      const saved = await window.api.saveProject(
        { schemaVersion: PROJECT_SCHEMA_VERSION, doc: state.doc },
        suggested,
      );
      if (!saved) return;
      set({ projectPath: saved });
      get().toast('info', `Saved ${saved}`);
    } catch (err) {
      get().toast('error', `Could not save: ${err instanceof Error ? err.message : String(err)}`);
    }
  },

  async openProject() {
    const result = await window.api.openProject();
    if (!result.ok) {
      if (!result.cancelled && result.error) get().toast('error', result.error);
      return;
    }

    if (result.data.schemaVersion > PROJECT_SCHEMA_VERSION) {
      get().toast(
        'error',
        `That project was written by a newer version (schema ${result.data.schemaVersion}).`,
      );
      return;
    }

    const doc = result.data.doc as Doc;

    // §13: drop layers whose source has vanished, with one summary warning.
    // Never prompt for relocation, never block the load.
    const sources = doc.objects.filter((o) => o.kind === 'media').map((o) => o.sourcePath);
    const missing = new Set(await window.api.checkSources(sources));
    const kept = doc.objects.filter((o) => o.kind !== 'media' || !missing.has(o.sourcePath));

    // §10: a referenced font that is not installed falls back to the default.
    const available = get().fonts;
    const missingFonts = new Set<string>();
    for (const obj of kept) {
      if (obj.kind !== 'text') continue;
      if (available.length > 0 && !available.includes(obj.fontFamily)) {
        missingFonts.add(obj.fontFamily);
        obj.fontFamily = available.includes('Segoe UI') ? 'Segoe UI' : (available[0] ?? obj.fontFamily);
      }
    }

    const loaded: Doc = { ...doc, objects: kept };

    set({
      doc: loaded,
      projectPath: result.path,
      selection: [],
      editingTextId: null,
      pendingText: null,
      undoStack: [],
      redoStack: [],
      revision: get().revision + 1,
    });
    replay(loaded.paint);
    get().fitToWindow();

    // §13: one summary warning listing every dropped file, not one each.
    if (missing.size > 0) {
      get().toast(
        'warn',
        `${missing.size} layer${missing.size === 1 ? '' : 's'} dropped — source file missing.`,
        [...missing].join('\n'),
      );
    }
    if (missingFonts.size > 0) {
      get().toast(
        'warn',
        `Missing font${missingFonts.size === 1 ? '' : 's'}, using the default.`,
        [...missingFonts].join('\n'),
      );
    }
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
