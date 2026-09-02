import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  deleteSelection,
  hasClipboard,
  pasteClipboard,
  reorderSelection,
  selectAll,
} from '../actions/objectActions';
import { useStore } from '../state/store';

export interface MenuState {
  /** Position within the viewport, in screen pixels. */
  x: number;
  y: number;
  world: { x: number; y: number };
  onObject: boolean;
}

/**
 * §11 context menu.
 *
 * On an object: Delete · — · Bring Forward / Send Backward / Bring to Front /
 * Send to Back — the one-step moves first, because they are the ones reached
 * for repeatedly.
 *
 * On empty canvas: Paste · Select All. There is no "Fit to window": the canvas
 * is always fitted (§4), so it would be a no-op.
 */
export function ContextMenu({ state, onClose }: { state: MenuState; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const selection = useStore((s) => s.selection);
  const objects = useStore((s) => s.doc.objects);

  // Flipped into view once the menu has been measured. Until then it is placed
  // at the cursor and hidden, so a menu opened near the bottom edge is never
  // painted half off-screen before it moves.
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent) return;

    const margin = 6;
    const { width, height } = el.getBoundingClientRect();
    const maxX = parent.clientWidth - width - margin;
    const maxY = parent.clientHeight - height - margin;

    // Prefer flipping to the other side of the cursor, as a menu should; only
    // clamp when even the flipped position does not fit.
    const left = state.x > maxX ? Math.max(margin, state.x - width) : state.x;
    const top = state.y > maxY ? Math.max(margin, state.y - height) : state.y;

    setPlacement({ left: Math.min(left, Math.max(margin, maxX)), top: Math.min(top, Math.max(margin, maxY)) });
  }, [state.x, state.y, selection.length, state.onObject]);

  useEffect(() => {
    const dismiss = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onEscape = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    // Capture, so the click that dismisses does not also land on the canvas.
    window.addEventListener('mousedown', dismiss, true);
    window.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('mousedown', dismiss, true);
      window.removeEventListener('keydown', onEscape);
    };
  }, [onClose]);

  const selected = objects.filter((o) => selection.includes(o.id));

  function run(fn: () => void) {
    fn();
    onClose();
  }

  return (
    <div
      ref={ref}
      className="context-menu"
      style={{
        left: placement?.left ?? state.x,
        top: placement?.top ?? state.y,
        visibility: placement ? 'visible' : 'hidden',
      }}
    >
      {state.onObject && selected.length > 0 ? (
        <>
          <button onClick={() => run(deleteSelection)}>Delete</button>
          <hr />
          <button onClick={() => run(() => reorderSelection('forward'))}>Bring Forward</button>
          <button onClick={() => run(() => reorderSelection('backward'))}>Send Backward</button>
          <button onClick={() => run(() => reorderSelection('front'))}>Bring to Front</button>
          <button onClick={() => run(() => reorderSelection('back'))}>Send to Back</button>
        </>
      ) : (
        <>
          <button disabled={!hasClipboard()} onClick={() => run(pasteClipboard)}>
            Paste
          </button>
          <button onClick={() => run(selectAll)}>Select All</button>
        </>
      )}
    </div>
  );
}
