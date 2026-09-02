/**
 * Preview-loop behaviour (CLAUDE.md §4, §11).
 *
 * Two things the export tests cannot see, because they live in the live
 * requestAnimationFrame loop rather than in `buildScene`:
 *
 *   1. A dropped file has to appear *without* anything else changing. The loop
 *      only redraws when the frame index, the document or an outstanding decode
 *      has moved, and the bitmap lands after the last "still missing" pass — so
 *      the run has to survive one extra draw or the image stays invisible until
 *      it is nudged.
 *   2. The canvas is always fitted (§4). There is no zoom and no pan, so every
 *      route to a new canvasRect or viewport size has to end in a refit.
 *
 * The first is checked from a screenshot of the real window: whether a Konva
 * layer actually painted is not observable from the store.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureLargeClip, makeChecker, startHarness, workDir } from './smoke-lib.mjs';
import { root } from './esbuild.config.mjs';

const ffmpeg = path.join(root, 'resources', 'bin', 'ffmpeg.exe');
const fixture = JSON.stringify(path.join(root, 'test-fixtures', 'static.png'));

/** The fixture is a #3366cc field with an orange box; either proves it drew. */
const BLUE = [51, 102, 204];

const harness = await startHarness();
const c = makeChecker();

function pixelReader(file) {
  const meta = JSON.parse(
    execFileSync(
      path.join(root, 'resources', 'bin', 'ffprobe.exe'),
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file],
      { encoding: 'utf8' },
    ),
  ).streams[0];

  const raw = execFileSync(
    ffmpeg,
    ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-frames:v', '1', '-'],
    { maxBuffer: 256 * 1024 * 1024 },
  );

  return {
    width: meta.width,
    height: meta.height,
    at(x, y) {
      const i = (y * meta.width + x) * 4;
      return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
    },
  };
}

const near = (actual, expected, tolerance = 14) =>
  expected.every((v, i) => Math.abs(actual[i] - v) <= tolerance);

/* -- 1. A dropped image is visible without being touched (§11) ------------- */

console.log('\n=== a dropped image draws itself (§11) ===');
{
  const shot = path.join(workDir, 'preview-first-draw.png');
  fs.rmSync(shot, { force: true });

  const result = await harness.run(
    `
    (async () => {
      const { importFiles } = await import('/media/importMedia.ts');
      const store = window.__mwStore;

      /** Resolves once nothing has touched the document for a while. */
      const settle = async (quietMs = 400) => {
        let last = -1;
        for (;;) {
          const revision = store.getState().revision;
          if (revision === last) return revision;
          last = revision;
          await new Promise((r) => setTimeout(r, quietMs));
        }
      };

      // Fill the canvas with the image so the centre pixel is unambiguous, and
      // do it before the import so nothing after it touches the document.
      store.getState().apply('setup', (d) => {
        d.canvasRect = { x: -320, y: -180, width: 640, height: 360 };
        d.background = { transparent: false, color: '#000000' };
      });
      await settle();

      await importFiles([${fixture}], { x: 0, y: 0 });
      await window.__mwIdle();

      // From here on nothing changes the store. The only thing that can put the
      // image on screen is the loop noticing its own last draw was incomplete.
      const revision = await settle();
      await new Promise((r) => setTimeout(r, 800));

      return { ok: true, quiet: store.getState().revision === revision };
    })()
  `,
    { env: { MW_SMOKE_SHOT: shot } },
  );

  if (!result.ok) {
    c.fail(`run failed: ${result.error}`);
  } else if (!fs.existsSync(shot)) {
    c.fail('no screenshot was captured');
  } else {
    const px = pixelReader(shot);
    // The viewport sits between the two bars; its centre is the canvas centre.
    const centre = px.at(Math.floor(px.width / 2), Math.floor(px.height / 2));
    c.truthy('nothing else redrew the document', result.quiet);
    c.truthy(
      'the image is on screen without being touched',
      near(centre, BLUE),
      `rgba(${centre.join(',')})`,
    );
  }
}

/* -- 2. The canvas is always fitted (§4) ----------------------------------- */

console.log('\n=== the canvas is always fitted (§4) ===');
{
  const result = await harness.run(`
    (async () => {
      const store = window.__mwStore;
      const settle = () => new Promise((r) => setTimeout(r, 260));

      await settle();
      const start = { ...store.getState().view };

      // A width/height edit.
      store.getState().apply('resize', (d) => {
        d.canvasRect = { ...d.canvasRect, width: 640, height: 360 };
      });
      await settle();
      const afterResize = { ...store.getState().view };

      // Undo puts the old size back; the fit has to follow that too.
      store.getState().undo();
      await settle();
      const afterUndo = { ...store.getState().view };

      const { viewport, doc } = store.getState();
      const v = store.getState().view;
      const rect = doc.canvasRect;
      const centredX = Math.abs(rect.x * v.scale + v.offsetX + (rect.width * v.scale) / 2 - viewport.width / 2);
      const centredY = Math.abs(rect.y * v.scale + v.offsetY + (rect.height * v.scale) / 2 - viewport.height / 2);

      return {
        ok: true,
        start, afterResize, afterUndo,
        fitsWidth: rect.width * v.scale <= viewport.width,
        fitsHeight: rect.height * v.scale <= viewport.height,
        centred: Math.max(centredX, centredY),
      };
    })()
  `);

  if (!result.ok) {
    c.fail(`run failed: ${result.error}`);
  } else {
    c.truthy(
      'a size change refits on its own',
      result.afterResize.scale !== result.start.scale,
      `${result.start.scale} -> ${result.afterResize.scale}`,
    );
    c.truthy(
      'undoing the size change refits back',
      Math.abs(result.afterUndo.scale - result.start.scale) < 1e-6,
      `${result.afterUndo.scale} vs ${result.start.scale}`,
    );
    c.truthy('the canvas fits horizontally', result.fitsWidth);
    c.truthy('the canvas fits vertically', result.fitsHeight);
    c.truthy('and stays centred', result.centred < 1, `${result.centred.toFixed(2)} px off`);
  }
}

/* -- 3. The suggested output path is always free (§12) --------------------- */

console.log('\n=== the suggested output name is free (§12) ===');
{
  const dir = path.join(workDir, 'unique');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'output.webp'), '');
  fs.writeFileSync(path.join(dir, 'output2.webp'), '');
  fs.writeFileSync(path.join(dir, 'clip2024.gif'), '');

  const d = JSON.stringify(dir);
  const result = await harness.run(`
    (async () => {
      const p = (n) => ${d} + '\\\\' + n;
      return {
        ok: true,
        taken: await window.api.uniqueOutputPath(p('output.webp')),
        free: await window.api.uniqueOutputPath(p('fresh.webp')),
        numbered: await window.api.uniqueOutputPath(p('clip2024.gif')),
      };
    })()
  `);

  if (!result.ok) {
    c.fail(`run failed: ${result.error}`);
  } else {
    c.check('skips past both taken names', path.basename(result.taken), 'output3.webp');
    c.check('leaves a free name alone', path.basename(result.free), 'fresh.webp');
    c.check('continues an existing number run', path.basename(result.numbered), 'clip2025.gif');
  }
}

/* -- 4. Eviction never hands out a closed bitmap (§7) ---------------------- */

console.log('');
console.log('=== eviction keeps the fallback frame alive (§7) ===');
{
  const clip = ensureLargeClip();
  const result = await harness.run(
    `
    (async () => {
      const store = window.__mwStore;
      const { importFiles } = await import('/media/importMedia.ts');
      const cache = await import('/media/bitmapCache.ts');

      await importFiles([${JSON.stringify(clip)}], { x: 0, y: 0 });
      await window.__mwIdle();
      const key = store.getState().doc.objects[0].cacheKey;

      // Native frames, not proxies: at 2560x1440 one is ~14.7 MB, so a few
      // dozen fill the 512 MB budget and eviction has to start.
      const first = await cache.load(key, 0, false);
      cache.peek(key, 0, false);           // frame 0 is now this layer's fallback
      const perFrame = first.width * first.height * 4;

      for (let i = 1; i < 60; i += 1) await cache.load(key, i, false);
      const after = cache.stats();

      // An index far past anything loaded, so peekOrLast has to fall back.
      const fallback = cache.peekOrLast(key, 999999, false);

      return {
        ok: true,
        // 60 native frames is well past the budget, so the oldest unprotected
        // one must be gone. Frame 1, not 0 — 0 is the protected fallback.
        pushedMb: Math.round((perFrame * 60) / 1e6),
        budgetMb: Math.round(after.budget / 1e6),
        earlyFrameEvicted: cache.peek(key, 1, false) === null,
        withinBudget: after.bytes <= after.budget,
        fallbackAlive: fallback ? fallback.width > 0 : null,
      };
    })()
  `,
    { timeoutMs: 180_000 },
  );

  if (!result.ok) {
    c.fail(`run failed: ${result.error}`);
    for (const line of result.log ?? []) console.error(`    ${line}`);
  } else {
    c.truthy(
      'the budget forced eviction',
      result.earlyFrameEvicted,
      `pushed ${result.pushedMb} MB through a ${result.budgetMb} MB budget`,
    );
    c.truthy('and the budget held', result.withinBudget);
    // A closed ImageBitmap reports 0x0, and drawing one throws from inside
    // Konva's layer draw — which latches `_waitingForDraw` and kills the canvas
    // for good. Eviction must skip the frame a layer is standing on.
    c.check('the fallback frame is still usable', result.fallbackAlive, true);
  }
}

/* -- 5. The canvas keeps painting under cache pressure (§7, §11) ------------ */

console.log('');
console.log('=== the preview survives cache eviction (§7, §11) ===');
{
  const clip = ensureLargeClip();
  const result = await harness.run(
    `
    (async () => {
      const errors = [];
      window.addEventListener('error', (e) => errors.push(String(e.message)));

      const store = window.__mwStore;
      const { importFiles } = await import('/media/importMedia.ts');

      await importFiles([${JSON.stringify(clip)}], { x: 0, y: 0 });
      await window.__mwIdle();
      store.getState().setSelection([]);

      // A fingerprint of what the content layer actually painted. Whether a
      // Konva layer is still drawing is not observable from the store: the
      // frame index advances either way, because it is set before the draw.
      const fingerprint = () => {
        const c = document.querySelector('.viewport canvas');
        if (!c) return 'no-canvas';
        const d = c.getContext('2d', { willReadFrequently: true })
          .getImageData(0, 0, c.width, c.height).data;
        let h = 0;
        for (let i = 0; i < d.length; i += 4001) h = (h * 31 + d[i]) | 0;
        return String(h);
      };

      const ids = store.getState().doc.objects.map((o) => o.id);
      let previous = fingerprint();
      let dead = 0;

      for (let i = 0; i < 6; i += 1) {
        // The reported trigger: resizing the canvas and shoving things about
        // while a long layer plays. Both drive extra redraws, which is what
        // brings the race forward.
        store.getState().apply('stress resize', (d) => {
          d.canvasRect = { ...d.canvasRect, width: 900 + (i % 5) * 100, height: 500 + (i % 3) * 80 };
        });
        store.getState().applyMerged('stress move ' + i, (d) => {
          for (const o of d.objects) if (ids.includes(o.id)) o.x += i % 2 ? 11 : -11;
        });

        await new Promise((r) => setTimeout(r, 900));
        const now = fingerprint();
        if (now === previous) dead += 1;
        previous = now;
      }

      return { ok: true, dead, errors: [...new Set(errors)].slice(0, 3) };
    })()
  `,
    { timeoutMs: 180_000 },
  );

  if (!result.ok) {
    c.fail(`run failed: ${result.error}`);
    for (const line of result.log ?? []) console.error(`    ${line}`);
  } else {
    // Eviction closing a bitmap a node still points at throws InvalidStateError
    // from inside Konva's layer draw. That leaves the layer's `_waitingForDraw`
    // latched, so the canvas never paints again: media stops animating and
    // dragging an object appears to do nothing.
    c.check('no uncaught errors from the draw', result.errors, []);
    c.check('the canvas repainted every second', result.dead, 0);
  }
}

await harness.stop();
console.log(c.failures === 0 ? '\nAll preview smoke tests passed.' : `\n${c.failures} failed.`);
process.exit(c.failures === 0 ? 0 : 1);
