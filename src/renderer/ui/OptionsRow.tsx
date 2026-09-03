import { useEffect, useState } from 'react';
import type { MediaObject, SceneObject, ShapeObject, TextObject } from '../../shared/doc';
import { clearPaint } from '../actions/canvasActions';
import { clampObjectToWorld } from '../actions/objectActions';
import { useStore, type Tool } from '../state/store';
import { useToolDefaults } from '../state/toolDefaults';

/**
 * §9 options section. One strip, three states, in this precedence:
 *
 * 1. A drawing tool is active -> that tool's creation options, which become the
 *    defaults for the next object drawn.
 * 2. Select with a selection -> the properties of the selected object(s),
 *    live-editable, one undo entry per edit.
 * 3. Select with nothing selected -> empty.
 *
 * It is the only part of the top bar that scrolls: at the 1280 px minimum window
 * width the Text tool's controls are wider than the space left over, and the
 * canvas settings and tool buttons to its left must never move.
 */
export function OptionsRow() {
  const tool = useStore((s) => s.tool);
  const selection = useStore((s) => s.selection);
  const doc = useStore((s) => s.doc);

  if (tool !== 'select') return <ToolOptions />;

  const selected = doc.objects.filter((o) => selection.includes(o.id));
  if (!hasOptions('select', selected)) return <div className="options" />;

  return <SelectionProperties objects={selected} />;
}

/**
 * Whether the options section has anything in it.
 *
 * The top bar needs this to decide whether to draw the divider that separates
 * the tools from the options — a divider with nothing after it reads as a
 * mistake. Shared rather than re-derived there, because the three states above
 * are the definition and two copies of them would drift.
 */
export function hasOptions(tool: Tool, selected: SceneObject[]): boolean {
  if (tool !== 'select') return true;
  if (selected.length === 0) return false;
  // A mix of kinds has nothing in common (§9).
  const kinds = new Set(selected.map((o) => o.kind));
  if (kinds.size !== 1) return false;
  // Media's only controls are its own size, which is per-object — two selected
  // at once have no shared answer.
  if (selected[0]!.kind === 'media') return selected.length === 1;
  return true;
}

/* -------------------------------------------------------------------------- */
/* 1. Tool creation options                                                   */
/* -------------------------------------------------------------------------- */

function ToolOptions() {
  const tool = useStore((s) => s.tool);
  const hasPaint = useStore((s) => s.doc.paint.strokes.length > 0);
  const defaults = useToolDefaults();

  if (tool === 'brush' || tool === 'eraser') {
    return (
      <div className="options">
        {tool === 'brush' ? (
          <label className="field">
            Colour
            <input
              type="color"
              className="swatch"
              value={defaults.brushColor}
              onChange={(e) => defaults.set({ brushColor: e.target.value })}
            />
          </label>
        ) : null}
        <label className="field slider">
          Size
          <input
            type="range"
            min={1}
            max={200}
            value={tool === 'brush' ? defaults.brushSize : defaults.eraserSize}
            onChange={(e) =>
              defaults.set(
                tool === 'brush'
                  ? { brushSize: Number(e.target.value) }
                  : { eraserSize: Number(e.target.value) },
              )
            }
          />
          <span className="num">{tool === 'brush' ? defaults.brushSize : defaults.eraserSize}</span>
        </label>
        {/* The eraser is a stroke tool (§6), so wiping the layer is a separate
            action rather than a very large eraser. One undo entry. */}
        {tool === 'eraser' ? (
          <button disabled={!hasPaint} onClick={() => clearPaint()}>
            Clear all drawing
          </button>
        ) : null}
      </div>
    );
  }

  if (tool === 'rect' || tool === 'ellipse') {
    return (
      <div className="options">
        <label className="field">
          Stroke
          <input
            type="color"
            className="swatch"
            value={defaults.stroke}
            onChange={(e) => defaults.set({ stroke: e.target.value })}
          />
        </label>
        <label className="field">
          Width
          <input
            className="tiny"
            type="number"
            min={0}
            max={200}
            value={defaults.strokeWidth}
            onChange={(e) => defaults.set({ strokeWidth: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          Fill
          <input
            type="color"
            className="swatch"
            value={defaults.fill ?? '#ffffff'}
            disabled={defaults.fill === null}
            onChange={(e) => defaults.set({ fill: e.target.value })}
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={defaults.fill === null}
            onChange={(e) => defaults.set({ fill: e.target.checked ? null : '#ffffff' })}
          />
          No fill
        </label>
      </div>
    );
  }

  if (tool === 'text') {
    return (
      <div className="options">
        <FontPicker value={defaults.fontFamily} onChange={(v) => defaults.set({ fontFamily: v })} />
        <label className="field">
          Size
          <input
            className="tiny"
            type="number"
            min={4}
            max={512}
            value={defaults.fontSize}
            onChange={(e) => defaults.set({ fontSize: Number(e.target.value) })}
          />
        </label>
        <StyleToggles
          style={defaults.fontStyle}
          onChange={(fontStyle) => defaults.set({ fontStyle })}
        />
        <label className="field">
          Colour
          <input
            type="color"
            className="swatch"
            value={defaults.textColor}
            onChange={(e) => defaults.set({ textColor: e.target.value })}
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={defaults.outline !== null}
            onChange={(e) => defaults.set({ outline: e.target.checked ? { color: '#000000', width: 2 } : null })}
          />
          Outline
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={defaults.shadow !== null}
            onChange={(e) =>
              defaults.set({
                shadow: e.target.checked
                  ? { color: '#000000', blur: 6, offsetX: 2, offsetY: 2 }
                  : null,
              })
            }
          />
          Shadow
        </label>
      </div>
    );
  }

  return <div className="options" />;
}

/* -------------------------------------------------------------------------- */
/* 2. Selection properties                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A control whose value differs across the selection renders indeterminate;
 * setting it applies that value to every member as a single undo entry (§9).
 */
function shared<T>(objects: SceneObject[], read: (o: SceneObject) => T): T | null {
  if (objects.length === 0) return null;
  const first = read(objects[0]!);
  return objects.every((o) => Object.is(read(o), first)) ? first : null;
}

function SelectionProperties({ objects }: { objects: SceneObject[] }) {
  const apply = useStore((s) => s.apply);
  const ids = objects.map((o) => o.id);

  function update(label: string, mutate: (obj: SceneObject) => void) {
    apply(label, (draft) => {
      for (const obj of draft.objects) {
        if (ids.includes(obj.id)) mutate(obj);
      }
    });
  }

  const kind = objects[0]!.kind;

  if (kind === 'media') {
    return (
      <div className="options">
        <MediaSize object={objects[0] as MediaObject} />
      </div>
    );
  }

  if (kind === 'shape') {
    const shapes = objects as ShapeObject[];
    const stroke = shared(shapes, (o) => (o as ShapeObject).stroke);
    const strokeWidth = shared(shapes, (o) => (o as ShapeObject).strokeWidth);
    const fill = shared(shapes, (o) => (o as ShapeObject).fill);
    const noFill = shared(shapes, (o) => (o as ShapeObject).fill === null);

    return (
      <div className="options">
        <label className="field">
          Stroke
          <input
            type="color"
            className="swatch"
            value={stroke ?? '#000000'}
            onChange={(e) => {
              const v = e.target.value;
              update('Stroke colour', (o) => {
                if (o.kind === 'shape') o.stroke = v;
              });
            }}
          />
        </label>
        <label className="field">
          Width
          <input
            className="tiny"
            type="number"
            min={0}
            max={200}
            value={strokeWidth ?? ''}
            placeholder="—"
            onChange={(e) => {
              const v = Number(e.target.value);
              update('Stroke width', (o) => {
                if (o.kind === 'shape') o.strokeWidth = v;
              });
            }}
          />
        </label>
        <label className="field">
          Fill
          <input
            type="color"
            className="swatch"
            value={fill ?? '#ffffff'}
            disabled={noFill === true}
            onChange={(e) => {
              const v = e.target.value;
              update('Fill colour', (o) => {
                if (o.kind === 'shape') o.fill = v;
              });
            }}
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            ref={(el) => {
              if (el) el.indeterminate = noFill === null;
            }}
            checked={noFill === true}
            onChange={(e) => {
              const off = e.target.checked;
              update('Fill', (o) => {
                if (o.kind === 'shape') o.fill = off ? null : '#ffffff';
              });
            }}
          />
          No fill
        </label>
      </div>
    );
  }

  const texts = objects as TextObject[];
  const fontFamily = shared(texts, (o) => (o as TextObject).fontFamily);
  const fontSize = shared(texts, (o) => (o as TextObject).fontSize);
  const fontStyle = shared(texts, (o) => (o as TextObject).fontStyle);
  const color = shared(texts, (o) => (o as TextObject).color);
  const hasOutline = shared(texts, (o) => (o as TextObject).outline !== null);
  const hasShadow = shared(texts, (o) => (o as TextObject).shadow !== null);

  return (
    <div className="options">
      <FontPicker
        value={fontFamily ?? ''}
        onChange={(v) =>
          update('Font', (o) => {
            if (o.kind === 'text') o.fontFamily = v;
          })
        }
      />
      <label className="field">
        Size
        <input
          className="tiny"
          type="number"
          min={4}
          max={512}
          value={fontSize ?? ''}
          placeholder="—"
          onChange={(e) => {
            const v = Number(e.target.value);
            update('Font size', (o) => {
              if (o.kind === 'text') o.fontSize = v;
            });
          }}
        />
      </label>
      <StyleToggles
        style={fontStyle ?? ''}
        onChange={(v) =>
          update('Font style', (o) => {
            if (o.kind === 'text') o.fontStyle = v;
          })
        }
      />
      <label className="field">
        Colour
        <input
          type="color"
          className="swatch"
          value={color ?? '#000000'}
          onChange={(e) => {
            const v = e.target.value;
            update('Text colour', (o) => {
              if (o.kind === 'text') o.color = v;
            });
          }}
        />
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          ref={(el) => {
            if (el) el.indeterminate = hasOutline === null;
          }}
          checked={hasOutline === true}
          onChange={(e) => {
            const on = e.target.checked;
            update('Outline', (o) => {
              if (o.kind === 'text') o.outline = on ? { color: '#000000', width: 2 } : null;
            });
          }}
        />
        Outline
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          ref={(el) => {
            if (el) el.indeterminate = hasShadow === null;
          }}
          checked={hasShadow === true}
          onChange={(e) => {
            const on = e.target.checked;
            update('Shadow', (o) => {
              if (o.kind === 'text') {
                o.shadow = on ? { color: '#000000', blur: 6, offsetX: 2, offsetY: 2 } : null;
              }
            });
          }}
        />
        Shadow
      </label>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Media size (§9)                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The layer's size on the canvas, alongside the size of the source it came from.
 *
 * Aspect-locked to the **source**, not to whatever the layer happens to be now:
 * typing a width sets the height that keeps the media undistorted, which is the
 * point of being able to type it. Matches the corner-only handles (§10) — there
 * is deliberately no way to distort media by accident.
 */
function MediaSize({ object }: { object: MediaObject }) {
  const apply = useStore((s) => s.apply);
  const ratio = object.nativeWidth / object.nativeHeight;

  const [width, setWidth] = useState(String(Math.round(object.width)));
  const [height, setHeight] = useState(String(Math.round(object.height)));

  useEffect(() => {
    setWidth(String(Math.round(object.width)));
    setHeight(String(Math.round(object.height)));
  }, [object.id, object.width, object.height]);

  function reset() {
    setWidth(String(Math.round(object.width)));
    setHeight(String(Math.round(object.height)));
  }

  function commit(axis: 'width' | 'height') {
    const typed = Number(axis === 'width' ? width : height);
    if (!Number.isFinite(typed) || typed < 1) {
      reset();
      return;
    }

    const next =
      axis === 'width'
        ? { width: typed, height: typed / ratio }
        : { width: typed * ratio, height: typed };

    apply('Resize media', (draft) => {
      const target = draft.objects.find((o) => o.id === object.id);
      if (target?.kind !== 'media') return;
      target.width = next.width;
      target.height = next.height;
      // §4: the layer stays inside the world however it was typed.
      clampObjectToWorld(target);
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>, axis: 'width' | 'height') {
    if (e.key === 'Enter') commit(axis);
    if (e.key === 'Escape') reset();
  }

  return (
    <>
      <span className="field muted-note">
        Source {object.nativeWidth} × {object.nativeHeight}
      </span>
      <label className="field">
        W
        <input
          className="dim"
          value={width}
          inputMode="numeric"
          onChange={(e) => setWidth(e.target.value)}
          onBlur={() => commit('width')}
          onKeyDown={(e) => onKeyDown(e, 'width')}
        />
      </label>
      <label className="field">
        H
        <input
          className="dim"
          value={height}
          inputMode="numeric"
          onChange={(e) => setHeight(e.target.value)}
          onBlur={() => commit('height')}
          onKeyDown={(e) => onKeyDown(e, 'height')}
        />
      </label>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Shared controls                                                            */
/* -------------------------------------------------------------------------- */

function StyleToggles({ style, onChange }: { style: string; onChange(v: string): void }) {
  const bold = style.includes('bold');
  const italic = style.includes('italic');

  function build(nextBold: boolean, nextItalic: boolean): string {
    const parts = [nextBold ? 'bold' : '', nextItalic ? 'italic' : ''].filter(Boolean);
    return parts.length === 0 ? 'normal' : parts.join(' ');
  }

  return (
    <div className="toggles">
      <button
        className={bold ? 'toggle active' : 'toggle'}
        style={{ fontWeight: 700 }}
        onClick={() => onChange(build(!bold, italic))}
        title="Bold"
      >
        B
      </button>
      <button
        className={italic ? 'toggle active' : 'toggle'}
        style={{ fontStyle: 'italic' }}
        onClick={() => onChange(build(bold, !italic))}
        title="Italic"
      >
        I
      </button>
    </div>
  );
}

function FontPicker({ value, onChange }: { value: string; onChange(v: string): void }) {
  const fonts = useStore((s) => s.fonts);
  return (
    <label className="field">
      Font
      <select className="font-picker" value={value} onChange={(e) => onChange(e.target.value)}>
        {value === '' ? <option value="">—</option> : null}
        {fonts.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
    </label>
  );
}
