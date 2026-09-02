import {
  copySelection,
  deleteSelection,
  duplicateSelection,
  nudgeSelection,
  pasteClipboard,
  selectAll,
} from '../actions/objectActions';
import { useStore, type Tool } from './store';

/**
 * Global shortcuts (CLAUDE.md §11).
 *
 * `Space`+drag panning and `Ctrl`+wheel zoom live in the Viewport, next to the
 * pointer state they need.
 */

const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  b: 'brush',
  e: 'eraser',
  t: 'text',
  r: 'rect',
  o: 'ellipse',
};

/** True when the user is typing, so shortcuts must not steal the key. */
function inTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
}

export function installShortcuts(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    const state = useStore.getState();
    const ctrl = event.ctrlKey || event.metaKey;

    // Esc still works from a text field: it cancels the edit (§11).
    if (event.key === 'Escape') {
      if (state.editingTextId) {
        state.setEditingText(null);
      } else if (state.selection.length > 0) {
        state.setSelection([]);
      }
      return;
    }

    if (inTextField(event.target)) return;

    if (ctrl) {
      switch (event.key.toLowerCase()) {
        case 'z':
          event.preventDefault();
          if (event.shiftKey) state.redo();
          else state.undo();
          return;
        case 'y':
          event.preventDefault();
          state.redo();
          return;
        case 'c':
          event.preventDefault();
          copySelection();
          return;
        case 'v':
          event.preventDefault();
          void pasteFromClipboard();
          return;
        case 'd':
          event.preventDefault();
          duplicateSelection();
          return;
        case 'a':
          event.preventDefault();
          selectAll();
          return;
        case 's':
          event.preventDefault();
          void state.saveProject();
          return;
        case 'o':
          event.preventDefault();
          void state.openProject();
          return;
        case '0':
          event.preventDefault();
          state.fitToWindow();
          return;
        default:
          return;
      }
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      deleteSelection();
      return;
    }

    // §11: 1 px, or 10 with Shift.
    const step = event.shiftKey ? 10 : 1;
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        nudgeSelection(-step, 0);
        return;
      case 'ArrowRight':
        event.preventDefault();
        nudgeSelection(step, 0);
        return;
      case 'ArrowUp':
        event.preventDefault();
        nudgeSelection(0, -step);
        return;
      case 'ArrowDown':
        event.preventDefault();
        nudgeSelection(0, step);
        return;
      default:
        break;
    }

    const tool = TOOL_KEYS[event.key.toLowerCase()];
    if (tool) state.setTool(tool);
  };

  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}

/**
 * §11: Ctrl+V pastes objects, or an image from the OS clipboard.
 *
 * Objects win when the in-app clipboard has something, because that is what the
 * user most recently copied *in this app*; an image on the OS clipboard may be
 * arbitrarily old and was not put there with this document in mind.
 */
async function pasteFromClipboard(): Promise<void> {
  const { hasClipboard } = await import('../actions/objectActions');
  if (hasClipboard()) {
    pasteClipboard();
    return;
  }
  await pasteImageFromClipboard();
}

async function pasteImageFromClipboard(): Promise<void> {
  const store = useStore.getState();
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (!type) continue;

      const blob = await item.getType(type);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const result = await window.api.importClipboardImage(Array.from(bytes), type);
      if (!result.ok) {
        store.toast('error', result.error);
        return;
      }

      const { importMetaAsObject } = await import('../media/importMedia');
      const { canvasRect } = useStore.getState().doc;
      importMetaAsObject(result.meta, {
        x: canvasRect.x + canvasRect.width / 2,
        y: canvasRect.y + canvasRect.height / 2,
      });
      return;
    }
    store.toast('info', 'No image on the clipboard.');
  } catch (err) {
    store.toast('error', `Could not read the clipboard: ${err instanceof Error ? err.message : err}`);
  }
}
