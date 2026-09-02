/**
 * Media import, decode and disk cache (CLAUDE.md §7, §16 step 3).
 *
 * Exercises the real ffprobe/ffmpeg path through the real IPC bridge: accepted
 * formats decode and land in the cache with correct metadata, rejections are
 * refused without adding a layer, and a second import of the same file is a
 * cache hit rather than a re-decode.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeChecker, startHarness, workDir } from './smoke-lib.mjs';
import { root } from './esbuild.config.mjs';

const fixtures = path.join(root, 'test-fixtures');
const f = (name) => path.join(fixtures, name).replace(/\\/g, '\\\\');

const harness = await startHarness();
const c = makeChecker();

/* -- 1. A static PNG imports, is centred at the drop point, and fits ------- */

console.log('\n=== static PNG ===');
{
  const result = await harness.run(`
    (async () => {
      const store = window.__mwStore;
      const { importFiles } = await import('/media/importMedia.ts');
      await importFiles(['${f('static.png')}'], { x: 0, y: 0 });
      await window.__mwIdle();
      const s = store.getState();
      const obj = s.doc.objects[0];
      return {
        ok: true,
        objects: s.doc.objects.length,
        kind: obj && obj.kind,
        frameCount: obj && obj.frameCount,
        nativeWidth: obj && obj.nativeWidth,
        nativeHeight: obj && obj.nativeHeight,
        width: obj && Math.round(obj.width),
        height: obj && Math.round(obj.height),
        x: obj && obj.x,
        y: obj && obj.y,
        cacheKey: obj && obj.cacheKey,
        toasts: s.toasts.map((t) => t.message),
      };
    })()
  `);

  if (!result.ok) {
    c.fail(`import failed: ${result.error}`);
    for (const line of result.log ?? []) console.error(`    ${line}`);
  } else {
    c.check('objects added', result.objects, 1);
    c.check('kind', result.kind, 'media');
    c.check('frameCount (static)', result.frameCount, 1);
    c.check('native size', [result.nativeWidth, result.nativeHeight], [640, 360]);
    // 640x360 fits inside the default 1280x720 canvas, so it must not be scaled.
    c.check('placed at native size', [result.width, result.height], [640, 360]);
    c.check('centred on the drop point', [result.x, result.y], [0, 0]);
    c.truthy('cacheKey is 16 hex chars', /^[a-f0-9]{16}$/.test(result.cacheKey ?? ''));
    c.check('no toasts', result.toasts, []);
  }
}

/* -- 2. An animated GIF keeps its native timing ---------------------------- */

console.log('\n=== animated GIF (10 fps, 2 s) ===');
{
  const result = await harness.run(`
    (async () => {
      const store = window.__mwStore;
      const { importFiles } = await import('/media/importMedia.ts');
      const timing = await import('/scene/timing.ts');
      await importFiles(['${f('anim-10fps-2s.gif')}'], { x: 0, y: 0 });
      await window.__mwIdle();
      const s = store.getState();
      const obj = s.doc.objects[0];
      const plan = timing.planLoop(s.doc);
      return {
        ok: true,
        frameCount: obj && obj.frameCount,
        durations: obj && [...new Set(obj.frameDurationsMs)],
        effectiveFps: obj && Math.round(timing.effectiveFps(obj)),
        autoFps: timing.autoFps(s.doc),
        planFrames: plan.frameCount,
        planFps: plan.fps,
        isStatic: plan.isStatic,
      };
    })()
  `);

  if (!result.ok) {
    c.fail(`import failed: ${result.error}`);
    for (const line of result.log ?? []) console.error(`    ${line}`);
  } else {
    c.check('frameCount', result.frameCount, 20);
    c.check('uniform 100 ms frames', result.durations, [100]);
    c.check('effective fps', result.effectiveFps, 10);
    // §8.0: Auto resolves to the highest effective source rate, rounded up.
    c.check('Auto resolves to 10', result.autoFps, 10);
    c.check('not static', result.isStatic, false);
    // §8.1: 2 s at 10 fps is exactly 20 output frames.
    c.check('loop length', [result.planFrames, result.planFps], [20, 10]);
  }
}

/* -- 3. Two layers whose cycles fit inside the cap take the LCM ------------ */

console.log('');
console.log('=== two layers, LCM loop (§8.1) ===');
{
  const result = await harness.run(`
    (async () => {
      const store = window.__mwStore;
      const { importFiles } = await import('/media/importMedia.ts');
      const timing = await import('/scene/timing.ts');
      await importFiles(['${f('anim-10fps-2s.gif')}', '${f('anim-10fps-1s.gif')}'], { x: 0, y: 0 });
      await window.__mwIdle();
      const s = store.getState();
      const plan = timing.planLoop(s.doc);
      return {
        ok: true,
        layers: s.doc.objects.length,
        autoFps: timing.autoFps(s.doc),
        cycles: s.doc.objects.map((o) => timing.cycleFrames(o, plan.fps)),
        frames: plan.frameCount,
        capped: plan.capped,
      };
    })()
  `);

  if (!result.ok) {
    c.fail(`import failed: ${result.error}`);
    for (const line of result.log ?? []) console.error(`    ${line}`);
  } else {
    c.check('both layers imported', result.layers, 2);
    c.check('Auto stays at 10', result.autoFps, 10);
    // 2 s and 1 s at 10 fps quantise to 20 and 10 output frames.
    c.check('cycles in whole output frames', result.cycles, [20, 10]);
    c.check('loop is their LCM', result.frames, 20);
    c.check('not capped', result.capped, false);
  }
}

/* -- 3b. Mismatched rates: the §8.1 rule, whichever branch it takes -------- */

console.log('');
console.log('=== mismatched rates, cap rule (§8.1) ===');
{
  const result = await harness.run(`
    (async () => {
      const store = window.__mwStore;
      const { importFiles } = await import('/media/importMedia.ts');
      const timing = await import('/scene/timing.ts');
      await importFiles(['${f('anim-10fps-2s.gif')}', '${f('anim-25fps-1.5s.webm')}'], { x: 0, y: 0 });
      await window.__mwIdle();
      const s = store.getState();
      const plan = timing.planLoop(s.doc);
      return {
        ok: true,
        autoFps: timing.autoFps(s.doc),
        fps: plan.fps,
        cycles: s.doc.objects.map((o) => timing.cycleFrames(o, plan.fps)),
        frames: plan.frameCount,
        capped: plan.capped,
        capFrames: timing.LOOP_CAP_SECONDS * plan.fps,
      };
    })()
  `);

  if (!result.ok) {
    c.fail(`import failed: ${result.error}`);
    for (const line of result.log ?? []) console.error(`    ${line}`);
  } else {
    // The fastest layer is 25 fps, and §8.0 must not inflate that to 30.
    c.check('Auto picks the fastest layer exactly', result.autoFps, 25);

    const gcd = (x, y) => (y === 0 ? x : gcd(y, x % y));
    const [a, b] = result.cycles;
    const rawLcm = (a / gcd(a, b)) * b;

    // Assert the rule rather than a magic number: over the cap, the loop becomes
    // the longest single cycle and the user is warned; under it, the plain LCM.
    if (rawLcm > result.capFrames) {
      c.check('capped flag set', result.capped, true);
      c.check('capped loop is the longest cycle', result.frames, Math.max(a, b));
      c.truthy('capped loop is within the 30 s cap', result.frames <= result.capFrames,
        `${result.frames} frames <= ${result.capFrames}`);
    } else {
      c.check('capped flag clear', result.capped, false);
      c.check('loop is the LCM', result.frames, rawLcm);
    }
  }
}

/* -- 4. Rejections: too long, and unsupported ------------------------------ */

console.log('\n=== rejections (§7, §14) ===');
{
  const result = await harness.run(`
    (async () => {
      const store = window.__mwStore;
      const { importFiles } = await import('/media/importMedia.ts');
      await importFiles(
        ['${f('too-long-40s.webm')}', '${f('nope.xyz')}', '${f('missing.png')}'],
        { x: 0, y: 0 },
      );
      const s = store.getState();
      return { ok: true, objects: s.doc.objects.length, toasts: s.toasts.map((t) => t.message) };
    })()
  `);

  if (!result.ok) {
    c.fail(`run failed: ${result.error}`);
  } else {
    // §7: ignore the file, do not add a layer. §14: a toast, never a crash.
    c.check('no layers added', result.objects, 0);
    c.check('one toast per rejected file', result.toasts.length, 3);
    c.truthy(
      'the 30 s rule is named in the message',
      result.toasts.some((t) => t.includes('30s')),
      result.toasts.find((t) => t.includes('30s')) ?? '',
    );
    c.truthy(
      'unsupported type is reported',
      result.toasts.some((t) => t.toLowerCase().includes('unsupported')),
    );
    c.truthy(
      'missing file is reported',
      result.toasts.some((t) => t.toLowerCase().includes('not found')),
    );
  }
}

/* -- 5. The disk cache is real and reused ---------------------------------- */

console.log('\n=== disk cache (§7) ===');
{
  const info = await harness.run(`
    (async () => {
      const { importFiles } = await import('/media/importMedia.ts');
      await importFiles(['${f('anim-10fps-2s.gif')}'], { x: 0, y: 0 });
      await window.__mwIdle();
      return { ok: true, ...(await window.api.getCacheInfo()) };
    })()
  `);
  if (!info.ok) {
    c.fail(`cache info failed: ${info.error}`);
  } else {
    c.truthy('cache has entries', info.entries > 0, `${info.entries} entries, ${info.bytes} bytes`);
    c.check('5 GB limit', info.limitBytes, 5 * 1024 * 1024 * 1024);

    const dir = info.dir;
    const keys = fs.readdirSync(dir).filter((n) => /^[a-f0-9]{16}$/.test(n));
    c.truthy('entries are on disk under 16-hex keys', keys.length > 0);

    const withMeta = keys.filter((k) => fs.existsSync(path.join(dir, k, 'meta.json')));
    c.check('every entry has meta.json', withMeta.length, keys.length);

    // Frames are lossless and numbered from 000001. The extension is whatever
    // §7 chose for this entry: PNG for a decode, the source's own container for
    // a static image that was copied in rather than transcoded.
    const sample = withMeta[0];
    if (!sample) {
      c.fail('no cache entry to inspect');
    } else {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, sample, 'meta.json'), 'utf8'));
    const frames = fs.readdirSync(path.join(dir, sample)).filter((n) => n.endsWith(meta.frameExt)).sort();
    c.check('frame files match meta.frameCount', frames.length, meta.frameCount);
    c.check('frames are 1-based, 6 digits', frames[0], `000001${meta.frameExt}`);
    c.check(
      'frameDurationsMs length matches frameCount',
      meta.frameDurationsMs.length,
      meta.frameCount,
    );
    }
  }
}

/* -- 6. Re-importing the same file hits the cache -------------------------- */

console.log('\n=== cache hit on re-import ===');
{
  const result = await harness.run(`
    (async () => {
      const t0 = performance.now();
      const first = await window.api.importMedia('${f('anim-10fps-2s.gif')}');
      const t1 = performance.now();
      const second = await window.api.importMedia('${f('anim-10fps-2s.gif')}');
      const t2 = performance.now();
      await window.__mwIdle();
      return {
        ok: true,
        sameKey: first.ok && second.ok && first.meta.cacheKey === second.meta.cacheKey,
        firstMs: Math.round(t1 - t0),
        secondMs: Math.round(t2 - t1),
      };
    })()
  `);

  if (!result.ok) {
    c.fail(`re-import failed: ${result.error}`);
  } else {
    c.truthy('same cacheKey both times', result.sameKey);
    // The first call here is itself usually a hit from an earlier case, so this
    // only asserts that a hit is fast, not that it beat a cold decode.
    c.truthy(
      'cache hit is fast',
      result.secondMs < 250,
      `${result.firstMs} ms then ${result.secondMs} ms`,
    );
  }
}

/* -- 7. Deleting the layer stops its decode (§7) --------------------------- */

console.log('');
console.log('=== deleting a layer cancels its decode (§7) ===');
{
  // Generated rather than committed: this has to still be decoding when the
  // delete lands, and every fixture in the repo finishes instantly.
  const slow = path.join(workDir, 'slow-decode.avi');
  if (!fs.existsSync(slow)) {
    execFileSync(path.join(root, 'resources', 'bin', 'ffmpeg.exe'), [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=10',
      '-c:v', 'mjpeg', '-q:v', '3',
      slow,
    ]);
  }

  const result = await harness.run(`
    (async () => {
      const store = window.__mwStore;
      const { importFiles } = await import('/media/importMedia.ts');
      const { deleteSelection } = await import('/actions/objectActions.ts');

      // Deliberately NOT awaiting __mwIdle: the point is to interrupt it.
      await importFiles([${JSON.stringify(slow)}], { x: 0, y: 0 });
      const decodingAtStart = store.getState().imports.length;

      // The import leaves the new object selected (§7).
      deleteSelection();
      await new Promise((r) => setTimeout(r, 1200));

      const cache = await window.api.getCacheInfo();
      return {
        ok: true,
        decodingAtStart,
        objects: store.getState().doc.objects.length,
        stillDecoding: store.getState().imports.length,
        cacheDir: cache.dir,
        toasts: store.getState().toasts.map((t) => t.message),
      };
    })()
  `);

  if (!result.ok) {
    c.fail(`run failed: ${result.error}`);
    for (const line of result.log ?? []) console.error(`    ${line}`);
  } else {
    c.check('the decode was still running when the layer went', result.decodingAtStart, 1);
    c.check('the layer is gone', result.objects, 0);
    c.check('and its progress bar with it', result.stillDecoding, 0);
    // A cancellation is something the user asked for, not a failure to report.
    c.check('no error toast', result.toasts, []);

    const leftovers = fs
      .readdirSync(result.cacheDir)
      .filter((n) => n.endsWith('.partial') || n.includes('.first.'));
    c.check('no half-written entry left behind', leftovers, []);
  }
}

await harness.stop();
console.log(c.failures === 0 ? '\nAll import smoke tests passed.' : `\n${c.failures} failed.`);
process.exit(c.failures === 0 ? 0 : 1);
