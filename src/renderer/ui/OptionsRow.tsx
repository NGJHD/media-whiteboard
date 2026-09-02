import type { SceneObject, ShapeObject, TextObject } from '../../shared/doc';
import { useStore } from '../state/store';
import { useToolDefaults } from '../state/toolDefaults';

/**
 * §9 options row. One row, three states, in this precedence:
 *
 * 1. A drawing tool is active -> that tool's creation options, which become the
 *    defaults for the next object drawn.
 * 2. Select with a selection -> the properties of the selected object(s),
 *    live-editable, one undo entry per edit.
 * 3. Select with nothing selected -> empty.
 */
export function OptionsRow() {
  const tool = useStore((s) => s.tool);
  const selection = useStore((s) => s.selection);
  const doc = useStore((s) => s.doc);

  if (tool !== 'select') return <ToolOptions />;

  const selected = doc.objects.filter((o) => selection.includes(o.id));
  if (selected.length === 0) return <div className="topbar-row options" />;

  return <SelectionProperties objects={selected} />;
}

/* -------------------------------------------------------------------------- */
/* 1. Tool creation options                                                   */
/* -------------------------------------------------------------------------- */

function ToolOptions() {
  const tool = useStore((s) => s.tool);
  const defaults = useToolDefaults();

  if (tool === 'brush' || tool === 'eraser') {
    return (
      <div className="topbar-row options">
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
        <label className="field wide">
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
      </div>
    );
  }

  if (tool === 'rect' || tool === 'ellipse') {
    return (
      <div className="topbar-row options">
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
      <div className="topbar-row options">
        <FontPicker value={defaults.fontFamily} onChange={(v) => defaults.set({ fontFamily: v })} />
        <label className="field">
          Size
          <input
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

  return <div className="topbar-row options" />;
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

  const kinds = new Set(objects.map((o) => o.kind));
  const opacity = shared(objects, (o) => o.opacity);

  const opacityControl = (
    <label className="field wide">
      Opacity
      <input
        type="range"
        min={0}
        max={100}
        value={opacity === null ? 100 : Math.round(opacity * 100)}
        onChange={(e) => {
          const value = Number(e.target.value) / 100;
          useStore.getState().applyMerged('Opacity', (draft) => {
            for (const obj of draft.objects) {
              if (ids.includes(obj.id)) obj.opacity = value;
            }
          });
        }}
      />
      <span className="num">{opacity === null ? '—' : `${Math.round(opacity * 100)}%`}</span>
    </label>
  );

  // Mixed kinds -> opacity only (§9).
  if (kinds.size > 1) return <div className="topbar-row options">{opacityControl}</div>;

  const kind = objects[0]!.kind;

  if (kind === 'media') {
    return <div className="topbar-row options">{opacityControl}</div>;
  }

  if (kind === 'shape') {
    const shapes = objects as ShapeObject[];
    const stroke = shared(shapes, (o) => (o as ShapeObject).stroke);
    const strokeWidth = shared(shapes, (o) => (o as ShapeObject).strokeWidth);
    const fill = shared(shapes, (o) => (o as ShapeObject).fill);
    const noFill = shared(shapes, (o) => (o as ShapeObject).fill === null);

    return (
      <div className="topbar-row options">
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
        {opacityControl}
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
    <div className="topbar-row options">
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
      {opacityControl}
    </div>
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
      <select value={value} onChange={(e) => onChange(e.target.value)}>
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
