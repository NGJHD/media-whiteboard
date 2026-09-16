import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TextObject } from '../../shared/doc';
import { useStore, worldToScreen } from '../state/store';

/**
 * In-place text editing (CLAUDE.md §10).
 *
 * A positioned DOM `<textarea>` overlaid on the canvas and styled to match, so
 * what the user types looks like what will be rendered. Commit on blur or
 * `Ctrl+Enter`; cancel on `Esc`.
 *
 * The Konva text node is hidden while editing, and so are the selection outline
 * and the transform handles — otherwise the editor's own box and the selection
 * box sit on top of each other at different sizes, which reads as two nested
 * rectangles rather than one thing being edited.
 *
 * The box **grows downward** as lines are added. A textarea that scrolls would
 * hide what was just typed, and the height is auto-computed from the wrapped
 * result anyway (§10) — so the editor measures its own content every keystroke
 * and matches its height to it.
 *
 * "Click away" is a pointer landing outside both the editor and the options row
 * (§9 shows the text's own properties while this is open). Blur alone is not
 * that: reaching for the font picker or the colour swatch moves focus out of the
 * textarea without meaning to finish the text, and committing there would close
 * the editor on the way to restyling it.
 */
export function TextEditor() {
  const editingId = useStore((s) => s.editingTextId);
  const objects = useStore((s) => s.doc.objects);
  const pendingText = useStore((s) => s.pendingText);
  const view = useStore((s) => s.view);
  const ref = useRef<HTMLTextAreaElement>(null);

  // A newly placed text is not in the document yet (§10, store.pendingText), so
  // it is edited straight out of that slot and only lands on commit.
  const pending = pendingText?.id === editingId ? pendingText : null;
  const object =
    pending ??
    (objects.find((o) => o.id === editingId && o.kind === 'text') as TextObject | undefined);

  const [value, setValue] = useState('');
  const [initial, setInitial] = useState('');
  // The pointer-outside listener below and a blur can both land on the same
  // gesture; the second one would commit an object that is already gone.
  const done = useRef(false);
  const commitRef = useRef<(next: string) => void>(() => {});

  useEffect(() => {
    if (!object) return;
    setValue(object.text);
    setInitial(object.text);
    done.current = false;
  }, [object?.id]);

  useLayoutEffect(() => {
    if (!object || !ref.current) return;
    ref.current.focus();
    ref.current.select();
  }, [object?.id]);

  // Grow to fit the content. `auto` first, so the box can shrink again when a
  // line is deleted rather than only ever getting taller.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value, view.scale, object?.fontSize, object?.boxWidth, object?.fontFamily]);

  // Once focus has gone to a control in the options row the textarea will not
  // blur again, so the click that finishes the text has to be caught directly.
  // Capture phase and `pointerdown`, both so that this runs before the canvas
  // turns the same press into a selection.
  useEffect(() => {
    if (!object) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (ref.current && (target === ref.current || ref.current.contains(target))) return;
      if (target.closest?.('.options')) return;
      commitRef.current(value);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [object?.id, value]);

  if (!object) return null;

  /**
   * §10: height is always auto-computed from the wrapped result, so the editor
   * measures itself and writes that back rather than imposing a height.
   *
   * The **top** edge is what stays put. The model stores a centre, so writing a
   * taller height without moving the centre would shift the finished text up by
   * half of whatever was added — it would jump the moment the editor closed,
   * away from where it was being typed.
   *
   * Exactly one undo entry comes out of this, or none:
   *
   * - a **new** text with content is pushed as a single `Add text`;
   * - a new text with nothing in it was never in the document, so cancelling it
   *   writes no entry at all — there is nothing to undo, and offering one meant
   *   the next Ctrl+Z did nothing visible;
   * - an **existing** text is one `Edit text`, or one `Delete text` when it has
   *   been emptied.
   */
  function commit(next: string) {
    if (done.current) return;
    done.current = true;
    const store = useStore.getState();
    const measured = ref.current?.scrollHeight;
    const height = measured ? measured / view.scale : object!.height;
    const top = object!.y - object!.height / 2;
    // An empty text object would be invisible and unselectable.
    const hasContent = next.trim().length > 0;

    if (pending) {
      if (hasContent) {
        const finished: TextObject = { ...pending, text: next, height, y: top + height / 2 };
        store.apply('Add text', (draft) => {
          draft.objects.push(finished);
        });
        store.setSelection([finished.id]);
      }
      // Clears the pending slot too, whether or not it was kept.
      store.setEditingText(null);
      return;
    }

    if (hasContent) {
      store.apply('Edit text', (draft) => {
        const target = draft.objects.find((o) => o.id === object!.id);
        if (target?.kind !== 'text') return;
        target.text = next;
        target.height = height;
        target.y = top + height / 2;
      });
    } else {
      store.apply('Delete text', (draft) => {
        draft.objects = draft.objects.filter((o) => o.id !== object!.id);
      });
      store.setSelection([]);
    }
    store.setEditingText(null);
  }

  commitRef.current = commit;

  const topLeft = worldToScreen(
    view,
    object.x - object.boxWidth / 2,
    object.y - object.height / 2,
  );

  return (
    <textarea
      ref={ref}
      className="text-editor"
      value={value}
      spellCheck={false}
      rows={1}
      onChange={(e) => setValue(e.target.value)}
      onBlur={(e) => {
        // Focus moving into the options row is the user restyling this very
        // text, not leaving it. The editor stays open, unfocused, until the
        // pointer lands somewhere that really does end it.
        const next = e.relatedTarget as HTMLElement | null;
        if (next?.closest?.('.options')) return;
        commit(value);
      }}
      onKeyDown={(e) => {
        // Enter inserts a newline: text is multi-line (§10).
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          commit(value);
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          commit(initial);
        }
      }}
      style={{
        left: topLeft.x,
        top: topLeft.y,
        width: object.boxWidth * view.scale,
        // Styled to match the rendered result, so editing is WYSIWYG.
        fontFamily: object.fontFamily,
        fontSize: object.fontSize * view.scale,
        fontWeight: object.fontStyle.includes('bold') ? 700 : 400,
        fontStyle: object.fontStyle.includes('italic') ? 'italic' : 'normal',
        textDecoration: object.underline ? 'underline' : 'none',
        textAlign: object.align,
        lineHeight: 1.2,
        color: object.color,
        transform: `rotate(${object.rotation}deg)`,
        transformOrigin: 'center',
      }}
    />
  );
}
