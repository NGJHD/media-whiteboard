/**
 * Annotation tools: shapes, text, brush, eraser (CLAUDE.md §6, §10; §16 step 9).
 *
 * The paint layer's rules are the ones worth proving with real pixels: it is
 * raster rather than objects, it draws above everything, and the eraser affects
 * only that buffer — never media, shapes, text or the background.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeChecker, startHarness, workDir } from './smoke-lib.mjs';
import { root } from './esbuild.config.mjs';

const ffmpeg = path.join(root, 'resources', 'bin', 'ffmpeg.exe');
const fixture = JSON.stringify(path.join(root, 'test-fixtures', 'static.png'));

const harness = await startHarness();
const c = makeChecker();

function pixels(file, width, height) {
  const raw = execFileSync(
    ffmpeg,
    ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    { maxBuffer: 512 * 1024 * 1024 },
  );
  return (x, y) => {
    const i = (y * width + x) * 4;
    return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
  };
}

const near = (a, b, t = 14) => b.every((v, i) => Math.abs(a[i] - v) <= t);
const show = (p) => `rgba(${p.join(',')})`;

const RED = [255, 0, 0];
const BLUE = [51, 102, 204];
const WHITE = [255, 255, 255];

/* -- 1. Shapes and text become SceneObjects (§10) -------------------------- */

console.log('=== shape and text creation (§10) ===');
{
  const r = await harness.run(`
    (async () => {
      const { beginShape, placeText } = await import('/canvas/drawTools.ts');
      const { useToolDefaults } = await import('/state/toolDefaults.ts');
      const store = window.__mwStore;
      const s = () => store.getState();

      useToolDefaults.getState().set({ stroke: '#00ff00', strokeWidth: 5, fill: null });

      // Drag from (0,0) to (200,100): a rect centred at (100,50), 200x100.
      // Many move events, which must still collapse to a single undo entry.
      const undoBefore = s().undoStack.length;
      const rect = beginShape({ x: 0, y: 0 }, 'rect');
      for (let i = 1; i <= 12; i += 1) {
        rect.move({ x: 200 * i / 12, y: 100 * i / 12 }, { alt: false, shift: false });
      }
      rect.end({ x: 200, y: 100 }, { alt: false, shift: false });
      const undoEntriesForDrag = s().undoStack.length - undoBefore;
      const drawn = s().doc.objects[s().doc.objects.length - 1];

      // Shift constrains to a square (§10): the longer axis wins.
      const sq = beginShape({ x: 0, y: 0 }, 'ellipse');
      sq.move({ x: 150, y: 40 }, { alt: false, shift: true });
      sq.end({ x: 150, y: 40 }, { alt: false, shift: true });
      const square = s().doc.objects[s().doc.objects.length - 1];

      // A click with no drag must not leave an invisible zero-size object.
      const countBefore = s().doc.objects.length;
      const tap = beginShape({ x: 500, y: 500 }, 'rect');
      tap.end({ x: 500, y: 500 }, { alt: false, shift: false });
      const countAfterTap = s().doc.objects.length;

      // Text is placed and opens for editing.
      useToolDefaults.getState().set({ fontSize: 40, textColor: '#123456' });
      const text = placeText({ x: -100, y: -100 });

      return { ok: true,
        kind: drawn.kind, shape: drawn.shape,
        centre: [drawn.x, drawn.y], size: [drawn.width, drawn.height],
        stroke: drawn.stroke, strokeWidth: drawn.strokeWidth, fill: drawn.fill,
        squareSize: [square.width, square.height], squareKind: square.shape,
        undoEntriesForDrag,
        countBefore, countAfterTap,
        textKind: text.kind, textSize: text.fontSize, textColor: text.color,
        editing: s().editingTextId === text.id,
        toolAfter: s().tool,
      };
    })()
  `);

  if (!r.ok) {
    c.fail(`creation: ${r.error}`);
    for (const line of r.log ?? []) console.error(`    ${line}`);
  } else {
    c.check('a shape object is created', [r.kind, r.shape], ['shape', 'rect']);
    c.check('centred between the drag endpoints', r.centre, [100, 50]);
    c.check('sized to the drag', r.size, [200, 100]);
    // §9: the tool's options become the defaults for the next object drawn.
    c.check('tool defaults are applied', [r.stroke, r.strokeWidth, r.fill], ['#00ff00', 5, null]);
    // §10: Shift constrains to a square / perfect circle.
    c.check('Shift constrains to a square', r.squareSize, [150, 150]);
    c.check('ellipse kind is kept', r.squareKind, 'ellipse');
    c.check('the whole drag is one undo entry', r.undoEntriesForDrag, 1);
    c.check('a click without a drag creates nothing', r.countAfterTap, r.countBefore);
    c.check('text uses the tool defaults', [r.textKind, r.textSize, r.textColor],
      ['text', 40, '#123456']);
    c.truthy('text opens for editing in place', r.editing);
    // §9 precedence: after drawing, Select is active so the new object's
    // properties are what the options row shows.
    c.check('drawing switches back to Select', r.toolAfter, 'select');
  }
}

/* -- 2. Paint is raster, above everything, and undoes by replay (§6) ------- */

console.log('');
console.log('=== paint layer (§6) ===');
{
  const out = path.join(workDir, 'tools-paint.webp');
  fs.rmSync(out, { force: true });

  const r = await harness.run(`
    (async () => {
      const { importFiles } = await import('/media/importMedia.ts');
      const { exportDocument } = await import('/export/exportScene.ts');
      const { beginStroke } = await import('/canvas/drawTools.ts');
      const { useToolDefaults } = await import('/state/toolDefaults.ts');
      const store = window.__mwStore;
      const s = () => store.getState();

      await importFiles([${fixture}], { x: 0, y: 0 });
      s().apply('setup', (d) => {
        d.canvasRect = { x: -160, y: -90, width: 320, height: 180 };
        d.background = { transparent: false, color: '#ffffff' };
        d.outputPath = ${JSON.stringify(out)};
        d.format = 'webp';
        // The image covers the left half of the canvas only.
        d.objects[0].x = -80; d.objects[0].y = 0;
        d.objects[0].width = 160; d.objects[0].height = 180;
      });

      useToolDefaults.getState().set({ brushColor: '#ff0000', brushSize: 24 });

      // One stroke straight across the middle, over image and background alike.
      const brush = beginStroke({ x: -140, y: 0 }, 'brush');
      for (let x = -140; x <= 140; x += 10) brush.move({ x, y: 0 }, { alt: false, shift: false });
      brush.end({ x: 140, y: 0 }, { alt: false, shift: false });

      const strokes = s().doc.paint.strokes.length;
      const dirty = s().doc.paint.dirtyRect;
      // §6: strokes are not objects — they must not appear in the object list.
      const objectCount = s().doc.objects.length;

      const res = await exportDocument({ doc: s().doc });
      return { ok: res.ok, error: res.error, strokes, dirty, objectCount,
               undoEntries: s().undoStack.length };
    })()
  `);

  if (!r.ok) {
    c.fail(`paint: ${r.error}`);
    for (const line of r.log ?? []) console.error(`    ${line}`);
  } else {
    c.check('one stroke recorded', r.strokes, 1);
    c.check('strokes are not objects', r.objectCount, 1);
    c.truthy('a dirty rect is tracked', r.dirty !== null,
      r.dirty ? `x ${Math.round(r.dirty.x)} w ${Math.round(r.dirty.width)}` : 'null');

    const at = pixels(out, 320, 180);
    // §6: paint renders above all media, shapes and text.
    c.truthy('paint covers the image', near(at(60, 90), RED), show(at(60, 90)));
    c.truthy('paint covers the background', near(at(260, 90), RED), show(at(260, 90)));
    // Away from the stroke, image and background are untouched.
    c.truthy('image intact above the stroke', near(at(60, 20), BLUE), show(at(60, 20)));
    c.truthy('background intact above the stroke', near(at(260, 20), WHITE), show(at(260, 20)));
  }
}

/* -- 3. The eraser affects only the paint buffer (§6) ---------------------- */

console.log('');
console.log('=== eraser scope (§6) ===');
{
  const out = path.join(workDir, 'tools-erase.webp');
  fs.rmSync(out, { force: true });

  const r = await harness.run(`
    (async () => {
      const { importFiles } = await import('/media/importMedia.ts');
      const { exportDocument } = await import('/export/exportScene.ts');
      const { beginStroke } = await import('/canvas/drawTools.ts');
      const { useToolDefaults } = await import('/state/toolDefaults.ts');
      const store = window.__mwStore;
      const s = () => store.getState();

      await importFiles([${fixture}], { x: 0, y: 0 });
      s().apply('setup', (d) => {
        d.canvasRect = { x: -160, y: -90, width: 320, height: 180 };
        d.background = { transparent: false, color: '#ffffff' };
        d.outputPath = ${JSON.stringify(out)};
        d.format = 'webp';
        d.objects[0].x = -80; d.objects[0].y = 0;
        d.objects[0].width = 160; d.objects[0].height = 180;
      });

      useToolDefaults.getState().set({ brushColor: '#ff0000', brushSize: 24, eraserSize: 40 });

      const brush = beginStroke({ x: -140, y: 0 }, 'brush');
      for (let x = -140; x <= 140; x += 10) brush.move({ x, y: 0 }, { alt: false, shift: false });
      brush.end({ x: 140, y: 0 }, { alt: false, shift: false });

      // Erase the middle of that stroke, crossing both image and background.
      const eraser = beginStroke({ x: -40, y: 0 }, 'eraser');
      for (let x = -40; x <= 40; x += 5) eraser.move({ x, y: 0 }, { alt: false, shift: false });
      eraser.end({ x: 40, y: 0 }, { alt: false, shift: false });

      const res = await exportDocument({ doc: s().doc });
      return { ok: res.ok, error: res.error, strokes: s().doc.paint.strokes.length };
    })()
  `);

  if (!r.ok) {
    c.fail(`eraser: ${r.error}`);
    for (const line of r.log ?? []) console.error(`    ${line}`);
  } else {
    c.check('both strokes recorded', r.strokes, 2);
    const at = pixels(out, 320, 180);
    // Erased region: canvas x 120..200 at y 90. Left of it is still red.
    c.truthy('paint survives outside the erase', near(at(40, 90), RED), show(at(40, 90)));
    // §6: the eraser never affects media — the image shows through again.
    c.truthy('image is revealed, not erased', near(at(130, 90), BLUE), show(at(130, 90)));
    // §6: nor the background.
    c.truthy('background is revealed, not erased', near(at(190, 90), WHITE), show(at(190, 90)));
  }
}

/* -- 4. Undo replays the buffer rather than snapshotting pixels (§6) ------- */

console.log('');
console.log('=== paint undo (§6, §11) ===');
{
  const out = path.join(workDir, 'tools-undo.webp');
  fs.rmSync(out, { force: true });

  const r = await harness.run(`
    (async () => {
      const { exportDocument } = await import('/export/exportScene.ts');
      const { beginStroke } = await import('/canvas/drawTools.ts');
      const { useToolDefaults } = await import('/state/toolDefaults.ts');
      const store = window.__mwStore;
      const s = () => store.getState();

      s().apply('setup', (d) => {
        d.canvasRect = { x: -160, y: -90, width: 320, height: 180 };
        d.background = { transparent: false, color: '#ffffff' };
        d.outputPath = ${JSON.stringify(out)};
        d.format = 'webp';
        d.objects = [];
      });

      useToolDefaults.getState().set({ brushColor: '#ff0000', brushSize: 24 });

      // Two strokes: one high, one low. Undo must remove only the second.
      const a = beginStroke({ x: -140, y: -40 }, 'brush');
      for (let x = -140; x <= 140; x += 10) a.move({ x, y: -40 }, { alt: false, shift: false });
      a.end({ x: 140, y: -40 }, { alt: false, shift: false });

      const b = beginStroke({ x: -140, y: 40 }, 'brush');
      for (let x = -140; x <= 140; x += 10) b.move({ x, y: 40 }, { alt: false, shift: false });
      b.end({ x: 140, y: 40 }, { alt: false, shift: false });

      const afterTwo = s().doc.paint.strokes.length;
      s().undo();
      const afterUndo = s().doc.paint.strokes.length;

      const res = await exportDocument({ doc: s().doc });
      return { ok: res.ok, error: res.error, afterTwo, afterUndo };
    })()
  `);

  if (!r.ok) {
    c.fail(`paint undo: ${r.error}`);
    for (const line of r.log ?? []) console.error(`    ${line}`);
  } else {
    c.check('two strokes then one after undo', [r.afterTwo, r.afterUndo], [2, 1]);
    const at = pixels(out, 320, 180);
    // y -40 world -> canvas y 50; y 40 -> canvas y 130.
    c.truthy('the first stroke survives undo', near(at(160, 50), RED), show(at(160, 50)));
    c.truthy('the undone stroke is gone', near(at(160, 130), WHITE), show(at(160, 130)));
  }
}

await harness.stop();
console.log('');
console.log(c.failures === 0 ? 'All tool smoke tests passed.' : `${c.failures} failed.`);
process.exit(c.failures === 0 ? 0 : 1);
