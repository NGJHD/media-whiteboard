import { useEffect, useState } from 'react';
import { MAX_CANVAS_DIMENSION, WORLD_MAX, WORLD_MIN, clampRectToWorld } from '../../shared/doc';
import { useStore, type Tool } from '../state/store';
import { OptionsRow } from './OptionsRow';
import { trimToFit } from '../actions/canvasActions';

const TOOLS: Array<{ id: Tool; label: string; hint: string }> = [
  { id: 'select', label: 'Select', hint: 'V' },
  { id: 'brush', label: 'Brush', hint: 'B' },
  { id: 'eraser', label: 'Eraser', hint: 'E' },
  { id: 'text', label: 'Text', hint: 'T' },
  { id: 'rect', label: 'Rect', hint: 'R' },
  { id: 'ellipse', label: 'Ellipse', hint: 'O' },
];

/**
 * §9 top bar: canvas size, trim to fit, background, the tool row, and the
 * options row.
 */
export function TopBar() {
  const doc = useStore((s) => s.doc);
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const apply = useStore((s) => s.apply);

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
    apply('Resize canvas', (draft) => {
      draft.canvasRect = clampRectToWorld(next);
    });
  }

  return (
    <header className="topbar">
      <div className="topbar-row">
        <label className="field">
          W
          <input
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
            value={height}
            onChange={(e) => setHeight(e.target.value)}
            onBlur={commitSize}
            onKeyDown={(e) => e.key === 'Enter' && commitSize()}
            inputMode="numeric"
          />
        </label>

        <button onClick={() => trimToFit()}>Trim to fit</button>

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
          className="ghost"
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
          Add media…
        </button>

        {error ? <span className="inline-error">{error}</span> : null}
      </div>

      <div className="topbar-row tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={tool === t.id ? 'tool active' : 'tool'}
            onClick={() => setTool(t.id)}
            title={`${t.label} (${t.hint})`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <OptionsRow />
    </header>
  );
}
