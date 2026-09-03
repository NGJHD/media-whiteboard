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

  useEffect(() => {
    if (!object) return;
    setValue(object.text);
    setInitial(object.text);
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
      onBlur={() => commit(value)}
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
        lineHeight: 1.2,
        color: object.color,
        transform: `rotate(${object.rotation}deg)`,
        transformOrigin: 'center',
      }}
    />
  );
}
