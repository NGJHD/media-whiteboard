import { useEffect, useState } from 'react';
import type {
  LayerId,
  MediaObject,
  SceneObject,
  ShapeObject,
  TextAlign,
  TextObject,
} from '../../shared/doc';
import { clearPaint } from '../actions/canvasActions';
import { clampObjectToWorld } from '../actions/objectActions';
import { useStore, type Tool } from '../state/store';
import { useToolDefaults } from '../state/toolDefaults';
import { IconAlignCenter, IconAlignLeft, IconAlignRight } from './icons';

/**
 * §9 options section. One strip, four states, in this precedence:
 *
 * 0. A text is open in the in-place editor -> that text's own properties.
 * 1. A drawing tool is active -> that tool's creation options, which become the
 *    defaults for the next object drawn.
 * 2. Select with a selection -> the properties of the selected object(s),
 *    live-editable, one undo entry per edit.
 * 3. Select with nothing selected -> empty.
 *
 * State 0 comes first because placing a text switches back to Select with
 * nothing selected (§10), so on states 1-3 alone the row would empty at the
 * exact moment the user started typing — leaving the font, size and colour of
 * the text being written as the one thing on screen that could not be changed.
 *
 * It is the only part of the top bar that scrolls: at the 1280 px minimum window
 * width the Text tool's controls are wider than the space left over, and the
 * canvas settings and tool buttons to its left must never move.
 */
export function OptionsRow() {
  const tool = useStore((s) => s.tool);
  const selection = useStore((s) => s.selection);
  const editingTextId = useStore((s) => s.editingTextId);
  const doc = useStore((s) => s.doc);

  if (editingTextId !== null) return <EditingTextProperties id={editingTextId} />;

  if (tool !== 'select') return <ToolOptions />;

  const selected = doc.objects.filter((o) => selection.includes(o.id));
  if (!hasOptions('select', selected, false)) return <div className="options" />;

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
export function hasOptions(
  tool: Tool,
  selected: SceneObject[],
  editingText: boolean,
): boolean {
  if (editingText) return true;
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
        <TextControls
          values={{
            fontFamily: defaults.fontFamily,
            fontSize: defaults.fontSize,
            fontStyle: defaults.fontStyle,
            underline: defaults.underline,
            align: defaults.align,
            color: defaults.textColor,
            outline: defaults.outline !== null,
            shadow: defaults.shadow !== null,
          }}
          onChange={(patch) => {
            // The defaults store spells the text colour `textColor`, because it
            // also holds a brush colour and a stroke colour.
            const { color, ...rest } = patch;
            defaults.set(color === undefined ? rest : { ...rest, textColor: color });
          }}
        />
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

  return (
    <div className="options">
      <TextControls
        values={{
          fontFamily: shared(texts, (o) => (o as TextObject).fontFamily),
          fontSize: shared(texts, (o) => (o as TextObject).fontSize),
          fontStyle: shared(texts, (o) => (o as TextObject).fontStyle),
          underline: shared(texts, (o) => (o as TextObject).underline),
          align: shared(texts, (o) => (o as TextObject).align),
          color: shared(texts, (o) => (o as TextObject).color),
          outline: shared(texts, (o) => (o as TextObject).outline !== null),
          shadow: shared(texts, (o) => (o as TextObject).shadow !== null),
        }}
        onChange={(patch, label) => {
          update(label, (o) => {
            if (o.kind === 'text') Object.assign(o, patch);
          });
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 0. The text being edited in place (§9 precedence, §10)                     */
/* -------------------------------------------------------------------------- */

/**
 * The properties of the text the in-place editor is open on.
 *
 * A freshly placed text is not in the document yet — it is `pendingText` until
 * it commits with content (§10) — so an edit to it cannot be an undo entry:
 * the whole insertion is one `Add text` or nothing at all. An existing text
 * being re-edited is an ordinary document object and behaves like any other
 * selection, one undo entry per control.
 */
function EditingTextProperties({ id }: { id: LayerId }) {
  const pending = useStore((s) => (s.pendingText?.id === id ? s.pendingText : null));
  const existing = useStore((s) => s.doc.objects.find((o) => o.id === id));
  const object = pending ?? (existing?.kind === 'text' ? existing : null);

  if (!object) return <div className="options" />;

  return (
    <div className="options">
      <TextControls
        values={{
          fontFamily: object.fontFamily,
          fontSize: object.fontSize,
          fontStyle: object.fontStyle,
          underline: object.underline,
          align: object.align,
          color: object.color,
          outline: object.outline !== null,
          shadow: object.shadow !== null,
        }}
        onChange={(patch, label) => {
          const store = useStore.getState();
          // Read the pending text back rather than patching the copy this
          // render closed over: two presses land inside one render often
          // enough — underline then centre — and the second would carry the
          // object as it was before the first.
          const current = store.pendingText?.id === id ? store.pendingText : null;
          if (current) {
            store.setPendingText({ ...current, ...patch });
            return;
          }
          store.apply(label, (draft) => {
            const target = draft.objects.find((o) => o.id === id);
            if (target?.kind === 'text') Object.assign(target, patch);
          });
        }}
      />
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

/**
 * Every text control, in one place.
 *
 * The three states that show them — the Text tool's defaults, a selection, and
 * the text being edited in place — differ only in where the change lands, so
 * they hand this a patch sink rather than a copy of the row. A `null` value is
 * indeterminate: several objects are selected and they disagree (§9).
 *
 * `label` is the undo entry the change should make where one is made at all;
 * the defaults store and a pending text ignore it.
 */
interface TextStyleValues {
  fontFamily: string | null;
  fontSize: number | null;
  fontStyle: string | null;
  underline: boolean | null;
  align: TextAlign | null;
  color: string | null;
  outline: boolean | null;
  shadow: boolean | null;
}

type TextStylePatch = Partial<
  Pick<
    TextObject,
    'fontFamily' | 'fontSize' | 'fontStyle' | 'underline' | 'align' | 'color' | 'outline' | 'shadow'
  >
>;

const ALIGNMENTS: Array<{ value: TextAlign; label: string; icon: React.ReactNode }> = [
  { value: 'left', label: 'Align left', icon: <IconAlignLeft /> },
  { value: 'center', label: 'Align centre', icon: <IconAlignCenter /> },
  { value: 'right', label: 'Align right', icon: <IconAlignRight /> },
];

function TextControls({
  values,
  onChange,
}: {
  values: TextStyleValues;
  onChange(patch: TextStylePatch, label: string): void;
}) {
  const bold = values.fontStyle?.includes('bold') ?? false;
  const italic = values.fontStyle?.includes('italic') ?? false;

  function styleString(nextBold: boolean, nextItalic: boolean): string {
    const parts = [nextBold ? 'bold' : '', nextItalic ? 'italic' : ''].filter(Boolean);
    return parts.length === 0 ? 'normal' : parts.join(' ');
  }

  return (
    <>
      <FontPicker
        value={values.fontFamily ?? ''}
        onChange={(v) => onChange({ fontFamily: v }, 'Font')}
      />
      <label className="field">
        Size
        <input
          className="tiny"
          type="number"
          min={4}
          max={512}
          value={values.fontSize ?? ''}
          placeholder="—"
          onChange={(e) => onChange({ fontSize: Number(e.target.value) }, 'Font size')}
        />
      </label>

      <div className="toggles">
        <Toggle
          active={bold}
          label="Bold"
          onClick={() => onChange({ fontStyle: styleString(!bold, italic) }, 'Font style')}
        >
          <span style={{ fontWeight: 700 }}>B</span>
        </Toggle>
        <Toggle
          active={italic}
          label="Italic"
          onClick={() => onChange({ fontStyle: styleString(bold, !italic) }, 'Font style')}
        >
          <span style={{ fontStyle: 'italic' }}>I</span>
        </Toggle>
        <Toggle
          active={values.underline === true}
          label="Underline"
          onClick={() => onChange({ underline: values.underline !== true }, 'Underline')}
        >
          <span style={{ textDecoration: 'underline' }}>U</span>
        </Toggle>
      </div>

      <div className="toggles">
        {ALIGNMENTS.map((a) => (
          <Toggle
            key={a.value}
            active={values.align === a.value}
            label={a.label}
            onClick={() => onChange({ align: a.value }, 'Text alignment')}
          >
            {a.icon}
          </Toggle>
        ))}
      </div>

      <label className="field">
        Colour
        <input
          type="color"
          className="swatch"
          value={values.color ?? '#000000'}
          onChange={(e) => onChange({ color: e.target.value }, 'Text colour')}
        />
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          ref={(el) => {
            if (el) el.indeterminate = values.outline === null;
          }}
          checked={values.outline === true}
          onChange={(e) =>
            onChange({ outline: e.target.checked ? { color: '#000000', width: 2 } : null }, 'Outline')
          }
        />
        Outline
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          ref={(el) => {
            if (el) el.indeterminate = values.shadow === null;
          }}
          checked={values.shadow === true}
          onChange={(e) =>
            onChange(
              {
                shadow: e.target.checked
                  ? { color: '#000000', blur: 6, offsetX: 2, offsetY: 2 }
                  : null,
              },
              'Shadow',
            )
          }
        />
        Shadow
      </label>
    </>
  );
}

/**
 * A square on/off button in the options row.
 *
 * It refuses focus on mousedown, which is what lets these be pressed while the
 * in-place text editor is open: the textarea commits when it loses focus (§10),
 * so a button that took focus would close the editor it was meant to restyle.
 */
function Toggle({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={active ? 'toggle active' : 'toggle'}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      {children}
    </button>
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
