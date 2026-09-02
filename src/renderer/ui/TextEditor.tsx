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
 * The Konva text node is hidden while editing, otherwise the two would
 * double-draw on top of each other.
 */
export function TextEditor() {
  const editingId = useStore((s) => s.editingTextId);
  const objects = useStore((s) => s.doc.objects);
  const view = useStore((s) => s.view);
  const ref = useRef<HTMLTextAreaElement>(null);

  const object = objects.find((o) => o.id === editingId && o.kind === 'text') as
    | TextObject
    | undefined;

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

  if (!object) return null;

  // §10: height is always auto-computed from the wrapped result, so the editor
  // measures itself and writes that back rather than imposing a height.
  function commit(next: string) {
    const store = useStore.getState();
    const height = ref.current?.scrollHeight ?? object!.height;

    if (next.trim().length === 0) {
      // An empty text object would be invisible and unselectable.
      store.apply('Add text', (draft) => {
        draft.objects = draft.objects.filter((o) => o.id !== object!.id);
      });
      store.setSelection([]);
    } else {
      store.apply('Edit text', (draft) => {
        const target = draft.objects.find((o) => o.id === object!.id);
        if (target?.kind !== 'text') return;
        target.text = next;
        target.height = height / view.scale;
      });
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
