/**
 * Pointer-driven interaction (CLAUDE.md §10, §11).
 *
 * Drives the real stage with synthetic pointer events. These are the parts of
 * the tools that cannot be exercised through the store, because they only go
 * wrong across a *sequence* of events: a Transformer that measures each step
 * against ground its own last step moved, a snap that leaves the handles behind,
 * a click whose default action steals focus back a beat later.
 */
import { makeChecker, startHarness } from './smoke-lib.mjs';

const harness = await startHarness();
const c = makeChecker();

/** Shared preamble: a deterministic document, and pointer plumbing. */
const preamble = `
  const store = window.__mwStore;
  const s = () => store.getState();
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const shape = (id, x, y, w, h) => ({
    id, kind: 'shape', shape: 'rect', x, y, width: w, height: h,
    rotation: 0, opacity: 1, stroke: '#ff3b30', strokeWidth: 2, fill: null,
  });

  // Konva binds its pointer handling to the stage content div.
  const content = () => document.querySelector('.viewport .konvajs-content') ?? document.querySelector('.viewport > div');

  function send(type, x, y, extra = {}) {
    const el = content();
    const box = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window, button: 0, buttons: type === 'mouseup' ? 0 : 1,
      clientX: box.left + x, clientY: box.top + y, ...extra,
    }));
  }

  /** World -> viewport pixels, the same mapping the interaction layer uses. */
  const toScreen = (wx, wy) => {
    const v = s().view;
    return { x: wx * v.scale + v.offsetX, y: wy * v.scale + v.offsetY };
  };
`;

/* -- 1. Dragging a corner resizes, and keeps resizing (§10) ---------------- */

console.log('\n=== corner drag resizes the object (§10) ===');
{
  const result = await harness.run(`
    (async () => {
      ${preamble}
      s().apply('setup', (d) => {
        d.canvasRect = { x: -400, y: -300, width: 800, height: 600 };
        d.objects = [shape('a', 0, 0, 200, 200)];
      });
      s().setTool('select');
      s().setSelection(['a']);
      await frame();
      await frame();

      // The bottom-right anchor sits on the object's bottom-right corner.
      const corner = toScreen(100, 100);
      const scale = s().view.scale;

      send('mousedown', corner.x, corner.y);
      await frame();

      // Several steps, because one step cannot tell a working gesture from one
      // that resets its own frame of reference between events.
      const steps = 6;
      const totalWorld = 100;
      for (let i = 1; i <= steps; i += 1) {
        const grow = (totalWorld * i) / steps;
        send('mousemove', corner.x + grow * scale, corner.y + grow * scale);
        await frame();
      }
      send('mouseup', corner.x + totalWorld * scale, corner.y + totalWorld * scale);
      await frame();

      const a = s().doc.objects[0];
      return {
        ok: true,
        width: Math.round(a.width),
        height: Math.round(a.height),
        x: Math.round(a.x),
        y: Math.round(a.y),
        entries: s().undoStack.filter((e) => e.label.startsWith('Transform')).length,
      };
    })()
  `);

  if (!result.ok) {
    c.fail(`run failed: ${result.error}`);
    for (const line of result.log ?? []) console.error(`    ${line}`);
  } else {
    // 200 -> 300 in both axes, anchored at the top-left corner, so the centre
    // moves by half the growth. A gesture that resets its own scale each event
    // lands back near 200 (no growth) or overshoots wildly.
    c.check('the object grew by the drag', [result.width, result.height], [300, 300]);
    c.check('it grew away from the anchored corner', [result.x, result.y], [50, 50]);
    c.check('the whole drag is one undo entry', result.entries, 1);
  }
}

/* -- 2. A snapped drag takes the handles with it (§11) --------------------- */

console.log('\n=== a snapped drag moves the handles too (§11) ===');
{
  const result = await harness.run(`
    (async () => {
      ${preamble}
      s().apply('setup', (d) => {
        d.canvasRect = { x: -400, y: -300, width: 800, height: 600 };
        // 'b' is the snap target; 'a' is dragged to just short of aligning.
        d.objects = [shape('a', 0, 0, 100, 100), shape('b', 200, 0, 100, 100)];
      });
      s().setTool('select');
      s().setSelection(['a']);
      await frame();
      await frame();

      const scale = s().view.scale;
      const from = toScreen(0, 0);
      // Land 4 world px short of centre-y alignment: inside the 8 screen px
      // threshold, so the snap has to close the gap.
      const dyWorld = 4;

      send('mousedown', from.x, from.y);
      await frame();
      send('mousemove', from.x + 60 * scale, from.y + dyWorld * scale);
      await frame();

      const a = s().doc.objects.find((o) => o.id === 'a');
      const dragging = { x: a.x, y: a.y };
      // Where the transform box is drawn, read back off the interaction layer.
      const boxTop = window.__mwProxyRect('a');

      send('mouseup', from.x + 60 * scale, from.y + dyWorld * scale);
      await frame();

      return {
        ok: true,
        snappedY: Math.round(dragging.y * 1000) / 1000,
        boxCentreY: boxTop ? Math.round(((boxTop.y - s().view.offsetY) / scale) * 1000) / 1000 : null,
      };
    })()
  `);

  if (!result.ok) {
    c.fail(`run failed: ${result.error}`);
    for (const line of result.log ?? []) console.error(`    ${line}`);
  } else {
    // The snap pulls the object back to y = 0, aligned with 'b'.
    c.check('the object snapped to the target', result.snappedY, 0);
    c.check('and the handle box came with it', result.boxCentreY, result.snappedY);
  }
}

/* -- 3. Clicking with the Text tool leaves an editor open (§10) ------------ */

console.log('\n=== the Text tool opens an editor and keeps it (§10) ===');
{
  const result = await harness.run(`
    (async () => {
      ${preamble}
      s().apply('setup', (d) => {
        d.canvasRect = { x: -400, y: -300, width: 800, height: 600 };
        d.objects = [];
      });
      s().setTool('text');
      await frame();

      const at = toScreen(0, 0);
      send('mousedown', at.x, at.y);
      await frame();
      send('mouseup', at.x, at.y);
      // A beat, not a frame: anything that tears the editor down does so after
      // the event has finished dispatching.
      await new Promise((r) => setTimeout(r, 300));

      const editor = document.querySelector('textarea.text-editor');
      return {
        ok: true,
        objects: s().doc.objects.length,
        editing: s().editingTextId !== null,
        editorOnScreen: Boolean(editor),
        editorFocused: editor ? document.activeElement === editor : false,
        tool: s().tool,
      };
    })()
  `);

  if (!result.ok) {
    c.fail(`run failed: ${result.error}`);
    for (const line of result.log ?? []) console.error(`    ${line}`);
  } else {
    // Note what this can and cannot see. The reported failure was that the
    // mousedown's *default action* pulled focus off the editor, which committed
    // an empty string and deleted the object — so the tool appeared to do
    // nothing. A dispatched event is untrusted and runs no default action, so
    // that specific steal is not reproducible here; the handler's
    // `preventDefault` is what stops it. What this does pin is everything
    // around it: the object is created, the editor mounts, takes focus, and is
    // still there once the dust settles.
    c.check('a text object was created', result.objects, 1);
    c.truthy('it is still being edited', result.editing);
    c.truthy('the in-place editor is on screen', result.editorOnScreen);
    c.truthy('and has keyboard focus', result.editorFocused);
    c.check('placing text returns to Select', result.tool, 'select');
  }
}

/* -- 4. Double-clicking a text object opens it for editing (§10) ----------- */

console.log('');
console.log('=== double-click edits text (§10) ===');
{
  const result = await harness.run(`
    (async () => {
      ${preamble}
      s().apply('setup', (d) => {
        d.canvasRect = { x: -400, y: -300, width: 800, height: 600 };
        d.objects = [{
          id: 't', kind: 'text', x: 0, y: 0, width: 300, height: 60,
          rotation: 0, opacity: 1, text: 'edit me', fontFamily: 'Segoe UI',
          fontSize: 40, fontStyle: 'normal', color: '#ff3b30',
          outline: null, shadow: null, boxWidth: 300,
        }];
      });
      s().setTool('select');
      s().setSelection([]);
      await frame();
      await frame();

      // Konva synthesises its own dblclick from two click pairs inside its
      // double-click window, so a bare DOM 'dblclick' would never reach it.
      const at = toScreen(0, 0);
      for (let i = 0; i < 2; i += 1) {
        send('mousedown', at.x, at.y);
        send('mouseup', at.x, at.y);
        await frame();
      }
      await new Promise((r) => setTimeout(r, 250));

      const editor = document.querySelector('textarea.text-editor');
      return {
        ok: true,
        editing: s().editingTextId,
        editorOnScreen: Boolean(editor),
        editorValue: editor ? editor.value : null,
        objects: s().doc.objects.length,
      };
    })()
  `);

  if (!result.ok) {
    c.fail(`run failed: ${result.error}`);
    for (const line of result.log ?? []) console.error(`    ${line}`);
  } else {
    c.check('the text object is being edited', result.editing, 't');
    c.truthy('the in-place editor is on screen', result.editorOnScreen);
    c.check('preloaded with the existing text', result.editorValue, 'edit me');
    c.check('and nothing was created or destroyed', result.objects, 1);
  }
}

await harness.stop();
console.log(c.failures === 0 ? '\nAll interaction smoke tests passed.' : `\n${c.failures} failed.`);
process.exit(c.failures === 0 ? 0 : 1);
