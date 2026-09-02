import fs from 'node:fs';
import path from 'node:path';
import { startHarness, workDir } from './smoke-lib.mjs';
import { root } from './esbuild.config.mjs';

const f = (n) => JSON.stringify(path.join(root, 'test-fixtures', n));
const marker = path.join(workDir, 'visual-ready.txt');
fs.rmSync(marker, { force: true });

const harness = await startHarness();

// Writing the marker from the renderer would need fs access it does not have, so
// main writes it: MW_SMOKE_OUT is only written at the very end, and the point of
// the marker is to signal that the window is up and populated *before* that.
const expr = `
  (async () => {
    const { importFiles } = await import('/media/importMedia.ts');
    await importFiles([${f('static.png')}], { x: -260, y: -120 });
    await importFiles([${f('anim-10fps-2s.gif')}], { x: 300, y: 140 });
    window.__mwStore.getState().setSelection([]);
    console.log('MW_VISUAL_READY');
    await new Promise((r) => setTimeout(r, 25000));
    return { ok: true, objects: window.__mwStore.getState().doc.objects.length };
  })()
`;

const result = await harness.run(expr, { timeoutMs: 70000 });
console.log('VISUAL', JSON.stringify(result));
await harness.stop();
process.exit(0);
