import { useEffect, useRef } from 'react';
import {
  deleteSelection,
  duplicateSelection,
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
 * On an object: Delete · Duplicate · — · Bring to Front / Forward / Backward /
 * to Back · — · Opacity slider · Properties…
 *
 * On empty canvas: Paste · Select All · Fit to window.
 *
 * Properties… opens the same controls the options row already shows for a
 * selection (§9), so it exists for discoverability rather than as the only route.
 */
export function ContextMenu({ state, onClose }: { state: MenuState; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const selection = useStore((s) => s.selection);
  const objects = useStore((s) => s.doc.objects);

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
  const sharedOpacity =
    selected.length > 0 && selected.every((o) => o.opacity === selected[0]!.opacity)
      ? selected[0]!.opacity
      : null;

  function run(fn: () => void) {
    fn();
    onClose();
  }

  return (
    <div ref={ref} className="context-menu" style={{ left: state.x, top: state.y }}>
      {state.onObject && selected.length > 0 ? (
        <>
          <button onClick={() => run(deleteSelection)}>Delete</button>
          <button onClick={() => run(duplicateSelection)}>Duplicate</button>
          <hr />
          <button onClick={() => run(() => reorderSelection('front'))}>Bring to Front</button>
          <button onClick={() => run(() => reorderSelection('forward'))}>Bring Forward</button>
          <button onClick={() => run(() => reorderSelection('backward'))}>Send Backward</button>
          <button onClick={() => run(() => reorderSelection('back'))}>Send to Back</button>
          <hr />
          <label className="menu-slider">
            Opacity
            <input
              type="range"
              min={0}
              max={100}
              value={sharedOpacity === null ? 100 : Math.round(sharedOpacity * 100)}
              onChange={(e) => {
                const value = Number(e.target.value) / 100;
                useStore.getState().applyMerged('Opacity', (draft) => {
                  for (const obj of draft.objects) {
                    if (selection.includes(obj.id)) obj.opacity = value;
                  }
                });
              }}
            />
          </label>
          <button
            onClick={() =>
              run(() => {
                // The options row already shows exactly these controls; make sure
                // it is the one on screen rather than duplicating them here.
                useStore.getState().setTool('select');
              })
            }
          >
            Properties…
          </button>
        </>
      ) : (
        <>
          <button disabled={!hasClipboard()} onClick={() => run(pasteClipboard)}>
            Paste
          </button>
          <button onClick={() => run(selectAll)}>Select All</button>
          <button onClick={() => run(() => useStore.getState().fitToWindow())}>Fit to window</button>
        </>
      )}
    </div>
  );
}
