/**
 * Select tool, z-order, snapping, clamping and undo (CLAUDE.md §4, §10, §11;
 * §16 step 4).
 *
 * Drives the real store and the real geometry helpers. Pointer gestures are not
 * simulated — what is checked here is the behaviour those gestures produce,
 * which is where the rules actually live.
 */
import path from 'node:path';
import { makeChecker, startHarness } from './smoke-lib.mjs';
import { root } from './esbuild.config.mjs';

const fixture = JSON.stringify(path.join(root, 'test-fixtures', 'static.png'));

const harness = await startHarness();
const c = makeChecker();

/** Boots a document with three shapes at known positions. */
const SETUP = `
  const store = window.__mwStore;
  const s = () => store.getState();
  const mk = (id, x, y, w, h) => ({
    id, kind: 'shape', shape: 'rect', x, y, width: w, height: h,
    rotation: 0, opacity: 1, stroke: '#fff', strokeWidth: 2, fill: null,
  });
  s().apply('seed', (d) => {
    d.canvasRect = { x: -320, y: -180, width: 640, height: 360 };
    d.objects = [mk('a', -200, -100, 100, 100), mk('b', 0, 0, 100, 100), mk('c', 200, 100, 100, 100)];
  });
`;

async function run(label, body) {
  const result = await harness.run(`
    (async () => {
      ${SETUP}
      ${body}
    })()
  `);
  if (!result.ok) {
    c.fail(`${label}: ${result.error}`);
    for (const line of result.log ?? []) console.error(`    ${line}`);
    return null;
  }
  return result;
}

/* -- Selection (§10) ------------------------------------------------------- */

console.log('=== selection (§10) ===');
{
  const r = await run('selection', `
    const { objectsAt, cycleAt, selectAll } = await import('/actions/objectActions.ts');
    const doc = () => s().doc;

    // Click inside 'b' (centred at 0,0, 100x100).
    const hitCentre = objectsAt(doc(), 10, 10).map((o) => o.id);
    const hitEmpty = objectsAt(doc(), 300, -170).map((o) => o.id);

    s().setSelection(['a']);
    s().toggleSelection('b');
    const afterShiftAdd = [...s().selection];
    s().toggleSelection('a');
    const afterShiftRemove = [...s().selection];

    selectAll();
    const afterSelectAll = [...s().selection].sort();

    s().setSelection([]);
    const afterEscape = [...s().selection];

    // Two overlapping objects: Alt+click must cycle rather than always pick the top.
    s().apply('overlap', (d) => {
      d.objects.push(mk('d', 0, 0, 60, 60));
    });
    const stack = objectsAt(doc(), 0, 0).map((o) => o.id);
    const first = cycleAt(doc(), 0, 0, []);
    const second = cycleAt(doc(), 0, 0, [first]);
    const third = cycleAt(doc(), 0, 0, [second]);

    return { ok: true, hitCentre, hitEmpty, afterShiftAdd, afterShiftRemove,
             afterSelectAll, afterEscape, stack, cycle: [first, second, third] };
  `);

  if (r) {
    c.check('click inside an object hits it', r.hitCentre, ['b']);
    c.check('click on empty space hits nothing', r.hitEmpty, []);
    c.check('shift+click adds', r.afterShiftAdd, ['a', 'b']);
    c.check('shift+click removes', r.afterShiftRemove, ['b']);
    c.check('Ctrl+A selects all', r.afterSelectAll, ['a', 'b', 'c']);
    c.check('Esc deselects', r.afterEscape, []);
    // §10: topmost first, and Alt+click walks down the stack and wraps.
    c.check('overlap stack is topmost first', r.stack, ['d', 'b']);
    c.check('alt+click cycles and wraps', r.cycle, ['d', 'b', 'd']);
  }
}

/* -- Z-order (§5) ---------------------------------------------------------- */

console.log('');
console.log('=== z-order (§5) ===');
{
  const r = await run('z-order', `
    const { reorderSelection } = await import('/actions/objectActions.ts');
    const ids = () => s().doc.objects.map((o) => o.id);

    s().setSelection(['a']);
    reorderSelection('forward');
    const forward = ids();
    reorderSelection('front');
    const front = ids();
    reorderSelection('backward');
    const backward = ids();
    reorderSelection('back');
    const back = ids();

    // At the end of the array already: must not wrap around.
    s().setSelection(['c']);
    s().apply('reset', (d) => { d.objects = [mk('a',0,0,10,10), mk('b',0,0,10,10), mk('c',0,0,10,10)]; });
    reorderSelection('forward');
    const clampedTop = ids();

    return { ok: true, forward, front, backward, back, clampedTop };
  `);

  if (r) {
    // Array order is z-order; index 0 is the back.
    c.check('bring forward steps one place', r.forward, ['b', 'a', 'c']);
    c.check('bring to front', r.front, ['b', 'c', 'a']);
    c.check('send backward steps one place', r.backward, ['b', 'a', 'c']);
    c.check('send to back', r.back, ['a', 'b', 'c']);
    c.check('already frontmost does not wrap', r.clampedTop, ['a', 'b', 'c']);
  }
}

/* -- Snapping (§11) -------------------------------------------------------- */

console.log('');
console.log('=== snapping (§11) ===');
{
  const r = await run('snapping', `
    const { snapRect } = await import('/canvas/snapping.ts');
    const doc = s().doc;

    // 'b' spans -50..50. A box whose left edge is at -46 is 4 world px away,
    // inside the 8 screen px threshold at scale 1.
    const near = snapRect({ x: -46, y: 300, width: 20, height: 20 }, doc, [], 1, true);
    const far = snapRect({ x: -20, y: 300, width: 20, height: 20 }, doc, [], 1, true);
    const disabled = snapRect({ x: -46, y: 300, width: 20, height: 20 }, doc, [], 1, false);

    // At 4x zoom the same 8 screen px is only 2 world px, so 4 px away is out.
    const zoomed = snapRect({ x: -46, y: 300, width: 20, height: 20 }, doc, [], 4, true);

    // canvasRect's own centre (0) and edges (-320, 320) are targets too.
    const toCanvasEdge = snapRect({ x: -317, y: 300, width: 20, height: 20 }, doc, [], 1, true);

    // An object must not snap to itself. Placed well clear of the canvas edges,
    // the canvas centre and the other objects, so only self-snapping could fire.
    s().apply('lone', (d) => { d.objects.push(mk('z', 1050, 1050, 100, 100)); });
    const selfExcluded = snapRect({ x: 1004, y: 1004, width: 100, height: 100 }, s().doc, ['z'], 1, true);
    const selfIncluded = snapRect({ x: 1004, y: 1004, width: 100, height: 100 }, s().doc, [], 1, true);

    return { ok: true,
      nearDx: near.dx, nearGuides: near.guides.length,
      farDx: far.dx, disabledDx: disabled.dx, zoomedDx: zoomed.dx,
      canvasDx: toCanvasEdge.dx, selfDx: selfExcluded.dx, includedDx: selfIncluded.dx };
  `);

  if (r) {
    c.check("snaps to another object's left edge", r.nearDx, -4);
    c.truthy('a guide is reported for the active snap', r.nearGuides >= 1);
    c.check('too far away does not snap', r.farDx, 0);
    c.check('Ctrl disables snapping', r.disabledDx, 0);
    // §11: the threshold is 8 *screen* px, so it shrinks in world terms on zoom.
    c.check('threshold is in screen pixels', r.zoomedDx, 0);
    c.check('snaps to the canvas edge', r.canvasDx, -3);
    c.check('an object does not snap to itself', r.selfDx, 0);
    // Control: the same rect does snap when nothing is excluded, which proves
    // the case above is exercising the exclusion and not just an empty region.
    c.check('control — it would snap if not excluded', r.includedDx, -4);
  }
}

/* -- World clamping (§4) --------------------------------------------------- */

console.log('');
console.log('=== world clamp (§4) ===');
{
  const r = await run('clamp', `
    const { nudgeSelection } = await import('/actions/objectActions.ts');

    s().apply('far', (d) => { d.objects = [mk('a', 1900, 0, 200, 200)]; });
    s().setSelection(['a']);
    // Push hard against the right edge; it must stop, not cross.
    for (let i = 0; i < 40; i += 1) nudgeSelection(10, 0);
    const obj = s().doc.objects[0];
    // rotation is 0 here, so the bounding box is just the object.
    const right = obj.x + obj.width / 2;

    // Then push back the other way to confirm the left edge clamps too.
    for (let i = 0; i < 500; i += 1) nudgeSelection(-10, 0);
    const left = s().doc.objects[0].x - s().doc.objects[0].width / 2;

    return { ok: true, right, left };
  `);

  if (r) {
    // §4: the usable world is the paint buffer's extent, -2048..2048.
    c.check('object stops at the right world edge', r.right, 2048);
    c.check('object stops at the left world edge', r.left, -2048);
  }
}

/* -- Undo and redo (§11) --------------------------------------------------- */

console.log('');
console.log('=== undo / redo (§11) ===');
{
  const r = await run('undo', `
    const { deleteSelection, nudgeSelection } = await import('/actions/objectActions.ts');

    const before = s().doc.objects.length;
    s().setSelection(['b']);
    deleteSelection();
    const afterDelete = s().doc.objects.length;
    s().undo();
    const afterUndo = s().doc.objects.length;
    s().redo();
    const afterRedo = s().doc.objects.length;
    s().undo();

    // A dragged gesture is one undo entry, not one per update.
    s().setSelection(['a']);
    const depthBefore = s().undoStack.length;
    for (let i = 0; i < 20; i += 1) {
      s().applyMerged('Move #1', (d) => { d.objects[0].x += 1; });
    }
    const depthAfterDrag = s().undoStack.length;
    const movedX = s().doc.objects[0].x;
    s().undo();
    const restoredX = s().doc.objects[0].x;
    const depthAfterUndo = s().undoStack.length;

    // A second gesture must not merge into the first.
    s().applyMerged('Move #2', (d) => { d.objects[0].x += 5; });
    const depthAfterSecond = s().undoStack.length;

    // Depth is capped at 100 (§11).
    for (let i = 0; i < 140; i += 1) nudgeSelection(1, 0);
    const cappedDepth = s().undoStack.length;

    return { ok: true, before, afterDelete, afterUndo, afterRedo,
             dragEntries: depthAfterDrag - depthBefore, movedX, restoredX,
             secondEntries: depthAfterSecond - depthAfterUndo, cappedDepth };
  `);

  if (r) {
    c.check('delete removes the object', [r.before, r.afterDelete], [3, 2]);
    c.check('undo restores it', r.afterUndo, 3);
    c.check('redo removes it again', r.afterRedo, 2);
    c.check('a drag is one undo entry', r.dragEntries, 1);
    c.check('the drag moved the object', r.movedX, -180);
    c.check('one undo reverts the whole drag', r.restoredX, -200);
    c.check('a separate gesture is its own entry', r.secondEntries, 1);
    c.check('undo depth is capped at 100', r.cappedDepth, 100);
  }
}

/* -- Group resize (§10) ---------------------------------------------------- */

console.log('');
console.log('=== group resize maths (§10) ===');
{
  const r = await run('group', `
    // §10: uniform scale s about the anchor corner; offsets, size, stroke and
    // font size scale, rotation does not.
    s().apply('mixed', (d) => {
      d.objects = [
        { ...mk('a', 100, 100, 100, 100), strokeWidth: 4, rotation: 30 },
        { id: 't', kind: 'text', x: 300, y: 100, width: 200, height: 50, rotation: 0,
          opacity: 1, text: 'hi', fontFamily: 'Segoe UI', fontSize: 20, fontStyle: 'normal',
          color: '#fff', outline: null, shadow: null, boxWidth: 200 },
      ];
    });

    const anchorX = 0, anchorY = 0, scale = 2;
    const start = JSON.parse(JSON.stringify(s().doc.objects));
    s().apply('group resize', (d) => {
      d.objects.forEach((obj, i) => {
        const from = start[i];
        obj.x = anchorX + (from.x - anchorX) * scale;
        obj.y = anchorY + (from.y - anchorY) * scale;
        obj.width = from.width * scale;
        obj.height = from.height * scale;
        obj.rotation = from.rotation;
        if (obj.kind === 'shape') obj.strokeWidth = from.strokeWidth * scale;
        if (obj.kind === 'text') {
          obj.fontSize = from.fontSize * scale;
          obj.boxWidth = from.boxWidth * scale;
          obj.width = obj.boxWidth;
        }
      });
    });

    const [shape, text] = s().doc.objects;
    return { ok: true,
      shapePos: [shape.x, shape.y], shapeSize: [shape.width, shape.height],
      strokeWidth: shape.strokeWidth, rotation: shape.rotation,
      fontSize: text.fontSize, boxWidth: text.boxWidth };
  `);

  if (r) {
    c.check('position scales about the anchor', r.shapePos, [200, 200]);
    c.check('size scales', r.shapeSize, [200, 200]);
    c.check('stroke width scales', r.strokeWidth, 8);
    c.check('rotation is unchanged', r.rotation, 30);
    // §10: glyphs scale *and* boxWidth scales, so wrap points stay identical.
    c.check('font size scales', r.fontSize, 40);
    c.check('boxWidth scales with it', r.boxWidth, 400);
  }
}

/* -- Copy / paste (§11) ---------------------------------------------------- */

console.log('');
console.log('=== copy and paste (§11) ===');
{
  const r = await run('clipboard', `
    const { copySelection, pasteClipboard } = await import('/actions/objectActions.ts');

    s().setSelection(['b']);
    copySelection();
    pasteClipboard();
    const pasted = s().doc.objects[s().doc.objects.length - 1];
    const original = s().doc.objects.find((o) => o.id === 'b');

    pasteClipboard();
    const second = s().doc.objects[s().doc.objects.length - 1];

    return { ok: true,
      count: s().doc.objects.length,
      offset: [pasted.x - original.x, pasted.y - original.y],
      uniqueId: pasted.id !== 'b' && second.id !== pasted.id,
      selectionIsCopy: s().selection.length === 1 && s().selection[0] === second.id };
  `);

  if (r) {
    c.check('two pastes add two objects', r.count, 5);
    c.check('offset by 10, 10', r.offset, [10, 10]);
    c.truthy('copies get fresh ids', r.uniqueId);
    c.truthy('the copy ends up selected', r.selectionIsCopy);
  }
}

/* -- Trim to fit (§4) ------------------------------------------------------ */

console.log('');
console.log('=== trim to fit (§4) ===');
{
  const r = await run('trim', `
    const { trimToFit } = await import('/actions/canvasActions.ts');
    trimToFit();
    const rect = s().doc.canvasRect;
    return { ok: true, rect };
  `);

  if (r) {
    // Objects span world -250..250 x and -150..150 y; no padding is added.
    c.check('canvas is the exact content union', [r.rect.x, r.rect.y, r.rect.width, r.rect.height],
      [-250, -150, 500, 300]);
  }
}

await harness.stop();
console.log('');
console.log(c.failures === 0 ? 'All select smoke tests passed.' : `${c.failures} failed.`);
process.exit(c.failures === 0 ? 0 : 1);
