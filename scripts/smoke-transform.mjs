/**
 * Pointer-driven interaction (CLAUDE.md §10, §11).
 *
 * Drives the real stage with synthetic pointer events. These are the parts of
 * the tools that cannot be exercised through the store, because they only go
 * wrong across a *sequence* of events: a Transformer that measures each step
 * against ground its own last step moved, a snap that leaves the handles behind,
 * a click whose default action steals focus back a beat later.
 */
import path from 'node:path';
import { makeChecker, startHarness } from './smoke-lib.mjs';
import { root } from './esbuild.config.mjs';

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

  const media = (id, x, y, w, h) => ({
    id, kind: 'media', x, y, width: w, height: h, rotation: 0, opacity: 1,
    sourcePath: 'C:/clips/a.mkv', cacheKey: 'abcdef0123456789',
    frameCount: 60, frameDurationsMs: new Array(60).fill(16.7),
    nativeWidth: w * 4, nativeHeight: h * 4,
  });

  // The interaction layer tracks Shift from window key events, not from the
  // mouse event, so a resize needs both and a rotate needs this one.
  const holdShift = (down) =>
    window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {
      key: 'Shift', shiftKey: down, bubbles: true,
    }));

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

/* -- 5. Right-clicking empty canvas gets the canvas menu (§11) -------------- */

console.log('');
console.log('=== right-click on empty canvas (§11) ===');
{
  const result = await harness.run(`
    (async () => {
      ${preamble}
      s().apply('setup', (d) => {
        d.canvasRect = { x: -400, y: -300, width: 800, height: 600 };
        d.objects = [shape('a', -200, -150, 100, 100)];
      });
      s().setTool('select');
      await frame();

      const items = () =>
        [...document.querySelectorAll('.context-menu button')].map((b) => b.textContent.trim());

      function rightClick(wx, wy) {
        const el = content();
        const box = el.getBoundingClientRect();
        const p = toScreen(wx, wy);
        el.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, view: window, button: 2,
          clientX: box.left + p.x, clientY: box.top + p.y,
        }));
      }

      // With something selected, right-click far away from it.
      s().setSelection(['a']);
      await frame();
      rightClick(250, 200);
      await new Promise((r) => setTimeout(r, 200));
      const onEmpty = { menu: items(), selection: s().selection.length };

      // And on the object itself.
      rightClick(-200, -150);
      await new Promise((r) => setTimeout(r, 200));
      const onObject = { menu: items(), selection: s().selection.slice() };

      return { ok: true, onEmpty, onObject };
    })()
  `);

  if (!result.ok) {
    c.fail(`run failed: ${result.error}`);
    for (const line of result.log ?? []) console.error(`    ${line}`);
  } else {
    // A right-click never reaches the mousedown handler that deselects, so
    // without deselecting here the menu belonged to an object nowhere near the
    // cursor — Delete and the z-order moves, on empty canvas.
    c.check('empty canvas gets Paste and Select All', result.onEmpty.menu, ['Paste', 'Select All']);
    c.check('and the selection is dropped', result.onEmpty.selection, 0);
    c.check('an object gets Delete and the z-order moves', result.onObject.menu, [
      'Delete', 'Bring Forward', 'Send Backward', 'Bring to Front', 'Send to Back',
    ]);
    c.check('and is selected by the right-click', result.onObject.selection, ['a']);
  }
}

/* -- 6. Corners only, and they hold the aspect ratio (§10) ----------------- */

console.log('');
console.log('=== corner-only resize handles (§10) ===');
{
  const result = await harness.run(`
    (async () => {
      ${preamble}
      s().apply('setup', (d) => {
        d.canvasRect = { x: -400, y: -300, width: 800, height: 600 };
        d.objects = [
          shape('a', 0, 0, 200, 100),
          { id: 't', kind: 'text', x: 250, y: 200, width: 200, height: 40,
            rotation: 0, opacity: 1, text: 'hi', fontFamily: 'Segoe UI',
            fontSize: 30, fontStyle: 'normal', color: '#fff',
            outline: null, shadow: null, boxWidth: 200 },
        ];
      });
      s().setTool('select');

      s().setSelection(['a']);
      await frame();
      await frame();
      const single = window.__mwAnchors();

      s().setSelection(['t']);
      await frame();
      await frame();
      const text = window.__mwAnchors();

      s().setSelection(['a', 't']);
      await frame();
      await frame();
      const group = window.__mwAnchors();

      // And the ratio actually holds through a corner drag.
      s().setSelection(['a']);
      await frame();
      await frame();
      const scale = s().view.scale;
      const corner = toScreen(100, 50);
      send('mousedown', corner.x, corner.y);
      await frame();
      for (let i = 1; i <= 5; i += 1) {
        send('mousemove', corner.x + 20 * i * scale, corner.y + 4 * i * scale);
        await frame();
      }
      send('mouseup', corner.x + 100 * scale, corner.y + 20 * scale);
      await frame();

      const a = s().doc.objects.find((o) => o.id === 'a');
      return {
        ok: true,
        single, text, group,
        grew: a.width > 210,
        ratio: Math.round((a.width / a.height) * 1000) / 1000,
      };
    })()
  `);

  if (!result.ok) {
    c.fail(`run failed: ${result.error}`);
    for (const line of result.log ?? []) console.error(`    ${line}`);
  } else {
    const corners = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
    // An edge handle can only change one dimension, so its whole purpose is to
    // distort — against the source's own aspect ratio, for media.
    c.check('a single object offers corners only', result.single, corners);
    c.check('so does text', result.text, corners);
    c.check('so does a group', result.group, corners);
    c.truthy('the drag actually resized', result.grew);
    // Dragged 100 across and only 20 down; the ratio is what decides the rest.
    c.check('the 2:1 ratio survived a lopsided drag', result.ratio, 2);
  }
}

/* -- 7. Resizing snaps, and the handles come with it (§11) ----------------- */

console.log('');
console.log('=== resize snapping (§11) ===');
{
  const result = await harness.run(`
    (async () => {
      ${preamble}
      s().apply('setup', (d) => {
        d.canvasRect = { x: -400, y: -300, width: 800, height: 600 };
        // 'b' sits with its left edge at x = 150; 'a' is grown towards it.
        d.objects = [shape('a', 0, 0, 100, 100), shape('b', 200, 0, 100, 100)];
      });
      s().setTool('select');
      s().setSelection(['a']);
      await frame();
      await frame();

      const scale = s().view.scale;
      const corner = toScreen(50, 50);
      // Stop 4 world px short of b's left edge — inside the 8 screen px
      // threshold, so the snap has to close the gap.
      const target = toScreen(146, 146);

      send('mousedown', corner.x, corner.y);
      await frame();
      send('mousemove', target.x, target.y);
      await frame();

      const a = s().doc.objects.find((o) => o.id === 'a');
      const right = a.x + a.width / 2;
      const box = window.__mwProxyRect('a');

      send('mouseup', target.x, target.y);
      await frame();

      return {
        ok: true,
        right: Math.round(right * 1000) / 1000,
        width: Math.round(a.width * 1000) / 1000,
        height: Math.round(a.height * 1000) / 1000,
        boxCentreX: box ? Math.round(((box.x - s().view.offsetX) / scale) * 1000) / 1000 : null,
        objCentreX: Math.round(a.x * 1000) / 1000,
      };
    })()
  `);

  if (!result.ok) {
    c.fail(`run failed: ${result.error}`);
    for (const line of result.log ?? []) console.error(`    ${line}`);
  } else {
    // Snapped from 146 onto b's left edge at 150, so the anchored corner at
    // -50 gives a width of exactly 200 — and the ratio carries it to height.
    c.check('the dragged edge landed on the target', result.right, 150);
    c.check('width follows from the snapped corner', result.width, 200);
    c.check('and height from the aspect ratio', result.height, 200);
    c.check('the handles are on the snapped box', result.boxCentreX, result.objCentreX);
  }
}

/* -- 8. Typed media size stays on the source ratio (§9) -------------------- */

console.log('');
console.log('=== media W/H fields (§9) ===');
{
  const fixture = JSON.stringify(path.join(root, 'test-fixtures', 'static.png'));
  const result = await harness.run(`
    (async () => {
      ${preamble}
      const { importFiles } = await import('/media/importMedia.ts');
      await importFiles([${fixture}], { x: 0, y: 0 });
      await window.__mwIdle();
      const id = s().doc.objects[0].id;
      s().setTool('select');
      s().setSelection([id]);
      await frame();
      await new Promise((r) => setTimeout(r, 150));

      const fields = [...document.querySelectorAll('.options input.dim')];
      const note = document.querySelector('.options .muted-note');

      // React owns these inputs, so a plain .value assignment is invisible to
      // it — go through the native setter and let it hear the input event.
      // Commit with Enter rather than a synthetic blur: React delegates onBlur
      // from the focusout event, so a dispatched blur never reaches it.
      // (No backticks in here — this whole script is a template literal.)
      const type = (el, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
          .set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      };

      const before = s().doc.objects[0];
      type(fields[0], '320');
      await new Promise((r) => setTimeout(r, 120));
      const afterWidth = { ...s().doc.objects[0] };

      type(fields[1], '90');
      await new Promise((r) => setTimeout(r, 120));
      const afterHeight = { ...s().doc.objects[0] };

      return {
        ok: true,
        fieldCount: fields.length,
        note: note ? note.textContent.trim() : null,
        native: [before.nativeWidth, before.nativeHeight],
        placed: [Math.round(before.width), Math.round(before.height)],
        afterWidth: [Math.round(afterWidth.width), Math.round(afterWidth.height)],
        afterHeight: [Math.round(afterHeight.width), Math.round(afterHeight.height)],
      };
    })()
  `);

  if (!result.ok) {
    c.fail(`run failed: ${result.error}`);
    for (const line of result.log ?? []) console.error(`    ${line}`);
  } else {
    c.check('two size fields', result.fieldCount, 2);
    c.check('the source size is shown', result.note, 'Source 640 × 360');
    // §7 places a drop inside half the canvas: 640x360 inside 640x360 exactly.
    c.check('placed at half the canvas', result.placed, [640, 360]);
    // 640x360 is 16:9, so a typed width picks the height and vice versa.
    c.check('typing a width sets the height', result.afterWidth, [320, 180]);
    c.check('typing a height sets the width', result.afterHeight, [160, 90]);
  }
}

/* -- 9. Shift never distorts media, but still snaps its rotation (§10) ------ */

console.log('');
console.log('=== Shift, aspect ratio and rotation (§10) ===');
{
  const result = await harness.run(`
    (async () => {
      ${preamble}

      // Drags a corner with Shift down and reports the resulting w/h ratio.
      const shiftResize = async (ids) => {
        s().setSelection(ids);
        await frame();
        await frame();
        const scale = s().view.scale;
        const start = s().doc.objects.find((o) => o.id === ids[0]);
        const corner = toScreen(start.x + start.width / 2, start.y + start.height / 2);

        holdShift(true);
        send('mousedown', corner.x, corner.y, { shiftKey: true });
        await frame();
        for (let i = 1; i <= 4; i += 1) {
          send('mousemove', corner.x + 40 * i * scale, corner.y + 3 * i * scale, { shiftKey: true });
          await frame();
        }
        send('mouseup', corner.x + 160 * scale, corner.y + 12 * scale, { shiftKey: true });
        holdShift(false);
        await frame();

        const after = s().doc.objects.find((o) => o.id === ids[0]);
        return {
          ratio: Math.round((after.width / after.height) * 100) / 100,
          grew: after.width > start.width + 20,
        };
      };

      // Drags the rotation handle to an angle that is deliberately not a
      // multiple of 15, and reports where it landed.
      const rotate = async (id, withShift) => {
        s().apply('reset rotation', (d) => {
          const o = d.objects.find((x) => x.id === id);
          o.rotation = 0;
        });
        s().setSelection([id]);
        await frame();
        await frame();

        const obj = s().doc.objects.find((o) => o.id === id);
        const scale = s().view.scale;
        const centre = toScreen(obj.x, obj.y);
        // Konva puts the rotater rotateAnchorOffset (50 px) above the top edge.
        const radius = (obj.height / 2) * scale + 50;
        const angle = (17 * Math.PI) / 180;

        if (withShift) holdShift(true);
        send('mousedown', centre.x, centre.y - radius, { shiftKey: withShift });
        await frame();
        for (let i = 1; i <= 3; i += 1) {
          const a = (angle * i) / 3;
          send('mousemove', centre.x + radius * Math.sin(a), centre.y - radius * Math.cos(a),
            { shiftKey: withShift });
          await frame();
        }
        send('mouseup', centre.x + radius * Math.sin(angle), centre.y - radius * Math.cos(angle),
          { shiftKey: withShift });
        if (withShift) holdShift(false);
        await frame();

        return Math.round(s().doc.objects.find((o) => o.id === id).rotation * 100) / 100;
      };

      s().apply('setup', (d) => {
        d.canvasRect = { x: -400, y: -300, width: 800, height: 600 };
        d.objects = [
          media('m', 0, 0, 200, 100),
          shape('r', 0, 0, 200, 100),
          media('m2', 0, 0, 200, 100),
          shape('r2', 250, 200, 60, 60),
        ];
      });
      s().setTool('select');

      const mediaResize = await shiftResize(['m']);
      const shapeResize = await shiftResize(['r']);
      const groupResize = await shiftResize(['m2', 'r2']);

      const snapped = await rotate('m', true);
      const free = await rotate('m', false);

      return { ok: true, mediaResize, shapeResize, groupResize, snapped, free };
    })()
  `);

  if (!result.ok) {
    c.fail(`run failed: ${result.error}`);
    for (const line of result.log ?? []) console.error(`    ${line}`);
  } else {
    c.truthy('the media drag actually resized', result.mediaResize.grew);
    // A source ratio is never right to stretch against, so no gesture does.
    c.check('Shift does not distort media', result.mediaResize.ratio, 2);
    // Shapes keep the §10 escape hatch: they have no source to be wrong about.
    c.truthy(
      'Shift still distorts a shape',
      result.shapeResize.ratio !== 2,
      `ratio ${result.shapeResize.ratio}`,
    );
    // §10 said this already; the shared transformer had been ignoring it.
    c.check('Shift does not distort a group', result.groupResize.ratio, 2);

    c.truthy('the rotation handle rotated the layer', result.snapped !== 0);
    c.check('Shift snaps rotation to 15 degrees', result.snapped % 15, 0);
    c.truthy(
      'and without Shift it does not snap',
      result.free !== 0 && result.free % 15 !== 0,
      `${result.free} degrees`,
    );
  }
}

await harness.stop();
console.log(c.failures === 0 ? '\nAll interaction smoke tests passed.' : `\n${c.failures} failed.`);
process.exit(c.failures === 0 ? 0 : 1);
