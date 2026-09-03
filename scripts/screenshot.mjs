/**
 * Captures the real window to PNGs, one per tool.
 *
 * A development aid, not a test. §9's top bar has to fit every tool's options
 * into one row at the 1280 px minimum, and that is the kind of claim only a
 * picture settles — the smoke scripts are what assert behaviour.
 *
 * Usage: node scripts/screenshot.mjs [outDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { startHarness } from './smoke-lib.mjs';
import { root } from './esbuild.config.mjs';

const outDir = process.argv[2] ?? path.join(root, 'resources', '.download', 'shots');
fs.mkdirSync(outDir, { recursive: true });

const f = (n) => JSON.stringify(path.join(root, 'test-fixtures', n));
const harness = await startHarness();

/** A scene worth looking at: media, a shape and some text. */
const scene = `
  const { importFiles } = await import('/media/importMedia.ts');
  const store = window.__mwStore;

  await importFiles([${f('static.png')}], { x: -220, y: -60 });
  await importFiles([${f('anim-10fps-2s.gif')}], { x: 300, y: 120 });
  await window.__mwIdle();

  store.getState().apply('scene', (d) => {
    d.objects.push({
      id: 'demo-rect', kind: 'shape', shape: 'rect',
      x: -300, y: 220, width: 240, height: 120, rotation: 0, opacity: 1,
      stroke: '#ff3b30', strokeWidth: 6, fill: null,
    });
    d.objects.push({
      id: 'demo-text', kind: 'text',
      x: 140, y: -250, width: 400, height: 64, rotation: 0, opacity: 1,
      text: 'Media Whiteboard', fontFamily: 'Segoe UI', fontSize: 56,
      fontStyle: 'bold', color: '#ff3b30', outline: null, shadow: null,
      boxWidth: 400,
    });
  });
`;

/** [name, activation, window size]. The narrow cases are the ones that matter. */
const cases = [
  ['text-1280', `store.getState().setTool('text');`, '1280x720'],
  ['select-text-1280', `store.getState().setTool('select'); store.getState().setSelection(['demo-text']);`, '1280x720'],
  ['select-empty', `store.getState().setTool('select'); store.getState().setSelection([]);`],
  ['select-shape', `store.getState().setTool('select'); store.getState().setSelection(['demo-rect']);`],
  ['select-text', `store.getState().setTool('select'); store.getState().setSelection(['demo-text']);`],
  ['brush', `store.getState().setTool('brush');`],
  ['eraser', `store.getState().setTool('eraser');`],
  ['text', `store.getState().setTool('text');`],
  ['rect', `store.getState().setTool('rect');`],
  // §10 in-place editing: one box, grown to fit three lines, no transformer.
  ['text-editing', `
    store.getState().setTool('select');
    store.getState().setSelection(['demo-text']);
    store.getState().setEditingText('demo-text');
    await new Promise((r) => setTimeout(r, 200));
    const ta = document.querySelector('textarea.text-editor');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    // Joined rather than written as an escape: this source goes through a
    // template literal on its way to the renderer, which resolves the escape
    // into a real newline and breaks the quoted string it sits inside.
    setter.call(ta, ['Media Whiteboard', 'second line', 'third line'].join(String.fromCharCode(10)));
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  `],
  // §9: a selected media layer shows its source size and aspect-locked W/H.
  ['select-media', `
    store.getState().setTool('select');
    const media = store.getState().doc.objects.find((o) => o.kind === 'media');
    store.getState().setSelection([media.id]);
  `],
  // §9 placeholders: an empty document, and a layer whose frames have not
  // arrived. The pending layer is faked with a cache key that matches nothing,
  // because a real decode is over before a screenshot can catch it.
  ['empty-canvas', `
    store.getState().setTool('select');
    store.getState().apply('clear', (d) => {
      d.objects = [];
      d.paint = { strokes: [], dirtyRect: null };
    });
  `],
  ['loading-layer', `
    store.getState().setTool('select');
    store.getState().apply('pending', (d) => {
      d.objects = [{
        id: 'pending', kind: 'media', x: -180, y: 0, width: 420, height: 300,
        rotation: 0, opacity: 1,
        sourcePath: ['C:', 'clips', 'trim.mkv'].join(String.fromCharCode(92)),
        cacheKey: 'abcdef0123456789', frameCount: 120,
        frameDurationsMs: new Array(120).fill(16.7),
        nativeWidth: 1080, nativeHeight: 2520,
      }];
    });
    store.getState().setSelection(['pending']);
  `],
  // §7's non-blocking decode bars. Driven directly: the fixtures decode far too
  // fast to catch one in flight.
  ['loading', `
    store.getState().setTool('select');
    store.getState().setSelection([]);
    store.getState().beginImport({ cacheKey: 'aaaaaaaaaaaaaaaa', name: 'holiday-clip.mkv', readyFrames: 412, totalFrames: 1020 });
    store.getState().beginImport({ cacheKey: 'bbbbbbbbbbbbbbbb', name: 'loop.gif', readyFrames: 6, totalFrames: 60 });
  `],
];

for (const [name, activate, size] of cases) {
  const shot = path.join(outDir, `${name}.png`);
  fs.rmSync(shot, { force: true });

  const result = await harness.run(
    `
    (async () => {
      ${scene}
      ${activate}
      // One frame for the rAF loop to redraw and React to commit the bar.
      await new Promise((r) => setTimeout(r, 400));
      return { ok: true, tool: store.getState().tool };
    })()
  `,
    { env: { MW_SMOKE_SHOT: shot, ...(size ? { MW_SMOKE_SIZE: size } : {}) } },
  );

  console.log(`${name}: ${result.ok ? `ok (${result.tool})` : `FAILED ${result.error}`} -> ${shot}`);
}

await harness.stop();
