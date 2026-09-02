import { useEffect, useState, type ReactNode } from 'react';
import { MAX_CANVAS_DIMENSION, WORLD_MAX, WORLD_MIN, clampRectToWorld } from '../../shared/doc';
import { useStore, type Tool } from '../state/store';
import { hasOptions, OptionsRow } from './OptionsRow';
import { trimToFit } from '../actions/canvasActions';
import {
  IconAddMedia,
  IconBrush,
  IconEllipse,
  IconEraser,
  IconInfo,
  IconRect,
  IconRedo,
  IconSelect,
  IconText,
  IconUndo,
} from './icons';

/**
 * §9 top bar — one row, left to right:
 *
 *   canvas settings | tools (Select, Undo/Redo, Brush, Eraser, Text, Rect,
 *   Ellipse) | the active tool's options | About
 *
 * The options section is the only part that scrolls. Everything to its left is
 * fixed-width and always reachable, so the controls the user aims for do not
 * move when they switch tools.
 */

interface ToolButton {
  id: Tool;
  label: string;
  hint: string;
  icon: ReactNode;
}

const BEFORE_UNDO: ToolButton[] = [
  { id: 'select', label: 'Select', hint: 'V', icon: <IconSelect /> },
];

const AFTER_UNDO: ToolButton[] = [
  { id: 'brush', label: 'Brush', hint: 'B', icon: <IconBrush /> },
  { id: 'eraser', label: 'Eraser', hint: 'E', icon: <IconEraser /> },
  { id: 'text', label: 'Text', hint: 'T', icon: <IconText /> },
  { id: 'rect', label: 'Rectangle', hint: 'R', icon: <IconRect /> },
  { id: 'ellipse', label: 'Ellipse', hint: 'O', icon: <IconEllipse /> },
];

export function TopBar({ onAbout }: { onAbout(): void }) {
  const doc = useStore((s) => s.doc);
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const apply = useStore((s) => s.apply);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.undoStack.length > 0);
  const canRedo = useStore((s) => s.redoStack.length > 0);
  const selection = useStore((s) => s.selection);
  const showOptions = hasOptions(
    tool,
    doc.objects.filter((o) => selection.includes(o.id)),
  );

  // Local text state so a partially typed number does not resize the canvas on
  // every keystroke. Committed on blur or Enter.
  const [width, setWidth] = useState(String(doc.canvasRect.width));
  const [height, setHeight] = useState(String(doc.canvasRect.height));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setWidth(String(Math.round(doc.canvasRect.width)));
    setHeight(String(Math.round(doc.canvasRect.height)));
  }, [doc.canvasRect.width, doc.canvasRect.height]);

  /**
   * §4: reject values above 2560 with an inline message; do not silently clamp.
   * The same message covers a resize that would push an edge outside the world.
   */
  function commitSize() {
    const w = Math.round(Number(width));
    const h = Math.round(Number(height));

    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
      setError('Width and height must be positive numbers.');
      return;
    }
    if (w > MAX_CANVAS_DIMENSION || h > MAX_CANVAS_DIMENSION) {
      setError(`Maximum canvas dimension is ${MAX_CANVAS_DIMENSION} px.`);
      return;
    }

    // Anchored at the top-left (§4), so only the far edges move.
    const next = { ...doc.canvasRect, width: w, height: h };
    if (next.x + w > WORLD_MAX || next.y + h > WORLD_MAX) {
      setError(`That would push the canvas outside the ${WORLD_MIN}..${WORLD_MAX} world bounds.`);
      return;
    }

    setError(null);
    // The viewport refits itself from the new canvasRect (§4) — there is no
    // other view state to keep in step.
    apply('Resize canvas', (draft) => {
      draft.canvasRect = clampRectToWorld(next);
    });
  }

  function toolButton(t: ToolButton) {
    return (
      <button
        key={t.id}
        className={tool === t.id ? 'iconbtn active' : 'iconbtn'}
        onClick={() => setTool(t.id)}
        title={`${t.label} (${t.hint})`}
        aria-label={t.label}
        aria-pressed={tool === t.id}
      >
        {t.icon}
      </button>
    );
  }

  return (
    <header className="topbar">
      <div className="topbar-row">
        <label className="field">
          W
          <input
            className="dim"
            value={width}
            onChange={(e) => setWidth(e.target.value)}
            onBlur={commitSize}
            onKeyDown={(e) => e.key === 'Enter' && commitSize()}
            inputMode="numeric"
          />
        </label>
        <label className="field">
          H
          <input
            className="dim"
            value={height}
            onChange={(e) => setHeight(e.target.value)}
            onBlur={commitSize}
            onKeyDown={(e) => e.key === 'Enter' && commitSize()}
            inputMode="numeric"
          />
        </label>

        <button onClick={() => trimToFit()} title="Shrink or grow the canvas to the exact bounds of the content">
          Trim to fit
        </button>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={doc.background.transparent}
            onChange={(e) => {
              const transparent = e.target.checked;
              apply('Background', (draft) => {
                draft.background.transparent = transparent;
              });
            }}
          />
          Transparent
        </label>

        <input
          type="color"
          className="swatch"
          title="Background colour"
          value={doc.background.color}
          disabled={doc.background.transparent}
          onChange={(e) => {
            const color = e.target.value;
            useStore.getState().applyMerged('Background colour', (draft) => {
              draft.background.color = color;
            });
          }}
        />

        <button
          className="iconbtn"
          title="Add media…"
          aria-label="Add media"
          onClick={() => {
            void window.api.openMediaDialog().then(async (paths) => {
              if (paths.length === 0) return;
              const { importFiles } = await import('../media/importMedia');
              const { canvasRect } = useStore.getState().doc;
              await importFiles(paths, {
                x: canvasRect.x + canvasRect.width / 2,
                y: canvasRect.y + canvasRect.height / 2,
              });
            });
          }}
        >
          <IconAddMedia />
        </button>

        <span className="divider" />

        {BEFORE_UNDO.map(toolButton)}

        <button
          className="iconbtn"
          title="Undo (Ctrl+Z)"
          aria-label="Undo"
          disabled={!canUndo}
          onClick={() => undo()}
        >
          <IconUndo />
        </button>
        <button
          className="iconbtn"
          title="Redo (Ctrl+Shift+Z)"
          aria-label="Redo"
          disabled={!canRedo}
          onClick={() => redo()}
        >
          <IconRedo />
        </button>

        {AFTER_UNDO.map(toolButton)}

        {showOptions ? <span className="divider" /> : null}

        <OptionsRow />

        {error ? <span className="inline-error">{error}</span> : null}

        <button className="iconbtn ghost about-button" onClick={onAbout} title="About, cache and licences">
          <IconInfo />
        </button>
      </div>
    </header>
  );
}
