/**
 * Opens the real app with a small scene loaded, and holds it open.
 *
 * A development aid for looking at the thing, not a test — the smoke scripts are
 * what actually assert behaviour.
 *
 * Usage: node scripts/preview-app.mjs [seconds]
 */
import path from 'node:path';
import { startHarness } from './smoke-lib.mjs';
import { root } from './esbuild.config.mjs';

const holdSeconds = Number(process.argv[2] ?? 25);
const f = (n) => JSON.stringify(path.join(root, 'test-fixtures', n));

const harness = await startHarness();

const expr = `
  (async () => {
    const { importFiles } = await import('/media/importMedia.ts');
    const store = window.__mwStore;

    await importFiles([${f('static.png')}], { x: -260, y: -120 });
    await importFiles([${f('anim-10fps-2s.gif')}], { x: 300, y: 140 });

    store.getState().apply('preview shapes', (d) => {
      d.objects.push({
        id: 'demo-rect', kind: 'shape', shape: 'rect',
        x: -300, y: 200, width: 220, height: 110, rotation: 0, opacity: 1,
        stroke: '#f2b544', strokeWidth: 6, fill: null,
      });
      d.objects.push({
        id: 'demo-text', kind: 'text',
        x: 120, y: -250, width: 380, height: 60, rotation: 0, opacity: 1,
        text: 'Media Whiteboard', fontFamily: 'Segoe UI', fontSize: 54,
        fontStyle: 'bold', underline: false, align: 'left',
        color: '#1b1d21', outline: null, shadow: null,
        boxWidth: 380,
      });
    });

    // Select one object so the Transformer handles are on screen.
    store.getState().setSelection(['demo-rect']);

    await new Promise((r) => setTimeout(r, ${holdSeconds * 1000}));
    return { ok: true, objects: store.getState().doc.objects.length };
  })()
`;

const result = await harness.run(expr, { timeoutMs: (holdSeconds + 40) * 1000 });
console.log('PREVIEW', JSON.stringify(result));
await harness.stop();
process.exit(0);
