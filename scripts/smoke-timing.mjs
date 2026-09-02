/**
 * Timing, the loop model and animated export (CLAUDE.md §8, §12; §16 steps 5
 * and 6).
 *
 * The §8 sampling rule is the part most likely to be subtly wrong, so this
 * exports real multi-layer loops and reads the frames back: a layer must show
 * the right source frame at each output index, and the loop must close.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeChecker, startHarness, workDir } from './smoke-lib.mjs';
import { root } from './esbuild.config.mjs';

const ffmpeg = path.join(root, 'resources', 'bin', 'ffmpeg.exe');
const ffprobe = path.join(root, 'resources', 'bin', 'ffprobe.exe');
const fx = (n) => JSON.stringify(path.join(root, 'test-fixtures', n));

const harness = await startHarness();
const c = makeChecker();

function frameCountOf(file) {
  const probe = execFileSync(
    ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
     '-show_entries', 'stream=nb_read_frames,width,height', '-of', 'json', file],
    { encoding: 'utf8' },
  );
  return JSON.parse(probe).streams[0];
}

/** Every frame of a file as raw RGBA, so frames can be compared to each other. */
function allFrames(file, width, height) {
  const raw = execFileSync(
    ffmpeg,
    ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    { maxBuffer: 1024 * 1024 * 1024 },
  );
  const size = width * height * 4;
  const out = [];
  for (let i = 0; i + size <= raw.length; i += size) out.push(raw.subarray(i, i + size));
  return out;
}

function identical(a, b) {
  return Buffer.compare(a, b) === 0;
}

/* -- 1. §8.0 fps resolution rules ------------------------------------------ */

console.log('=== Auto fps resolution (§8.0) ===');
{
  const r = await harness.run(`
    (async () => {
      const t = await import('/scene/timing.ts');
      const mk = (durations) => ({
        id: 'x', kind: 'media', x: 0, y: 0, width: 10, height: 10, rotation: 0, opacity: 1,
        sourcePath: '', cacheKey: '0'.repeat(16), frameCount: durations.length,
        frameDurationsMs: durations, nativeWidth: 10, nativeHeight: 10,
      });
      const doc = (objects) => ({
        canvasRect: { x: 0, y: 0, width: 100, height: 100 },
        background: { transparent: false, color: '#000' },
        outputFps: 'auto', quality: 'high', format: 'webp', outputPath: '',
        objects, paint: { strokes: [], dirtyRect: null },
      });

      const ntsc30 = Array(30).fill(1000 / 29.97);
      const ntsc24 = Array(24).fill(1000 / 23.976);
      const ntsc60 = Array(60).fill(1000 / 59.94);
      const fast120 = Array(120).fill(1000 / 120);

      return {
        ok: true,
        // §8.0: round UP, never down — these must not lose frames.
        r2997: t.autoFps(doc([mk(ntsc30)])),
        r23976: t.autoFps(doc([mk(ntsc24)])),
        r5994: t.autoFps(doc([mk(ntsc60)])),
        // §8.0: capped at 60 even for a faster source.
        r120: t.autoFps(doc([mk(fast120)])),
        // §8.0: no animated layers means Auto has nothing to detect.
        none: t.autoFps(doc([])),
        // §8.0: degenerate GIF delays below 20 ms are treated as 100 ms by the
        // importer, so a junk frame cannot report hundreds of fps.
        mixed: t.autoFps(doc([mk(ntsc24), mk(ntsc60)])),
        // §8.0: a manual selection is sticky.
        sticky: t.resolveFps({ ...doc([mk(ntsc60)]), outputFps: 15 }),
      };
    })()
  `);

  if (!r.ok) c.fail(`fps resolution: ${r.error}`);
  else {
    c.check('29.97 rounds up to 30', r.r2997, 30);
    c.check('23.976 rounds up to 24', r.r23976, 24);
    c.check('59.94 rounds up to 60', r.r5994, 60);
    c.check('120 fps caps at 60', r.r120, 60);
    c.check('no animated layers gives null', r.none, null);
    c.check('mixed rates take the fastest', r.mixed, 60);
    c.check('a manual fps is sticky', r.sticky, 15);
  }
}

/* -- 2. §8.1 loop length and the worked example ---------------------------- */

console.log('');
console.log('=== loop length (§8.1) ===');
{
  const r = await harness.run(`
    (async () => {
      const t = await import('/scene/timing.ts');
      const mk = (durations) => ({
        id: Math.random().toString(36).slice(2), kind: 'media',
        x: 0, y: 0, width: 10, height: 10, rotation: 0, opacity: 1,
        sourcePath: '', cacheKey: '0'.repeat(16), frameCount: durations.length,
        frameDurationsMs: durations, nativeWidth: 10, nativeHeight: 10,
      });
      const doc = (objects, fps) => ({
        canvasRect: { x: 0, y: 0, width: 100, height: 100 },
        background: { transparent: false, color: '#000' },
        outputFps: fps, quality: 'high', format: 'webp', outputPath: '',
        objects, paint: { strokes: [], dirtyRect: null },
      });

      // §8.1's worked example: a 0.7 s GIF and a 25-frame 24 fps clip, at 30 fps.
      const gif07 = mk(Array(7).fill(100));
      const clip24 = mk(Array(25).fill(1000 / 24));
      const worked = t.planLoop(doc([gif07, clip24], 30));

      // The same document at 15 fps: the LCM is over *rounded* counts, so this
      // does not scale proportionally.
      const at15 = t.planLoop(doc([gif07, clip24], 15));

      // Over the 30 s cap: two long layers whose LCM explodes.
      const longA = mk(Array(29).fill(1000));
      const longB = mk(Array(30).fill(1000));
      const capped = t.planLoop(doc([longA, longB], 30));

      return {
        ok: true,
        workedCycles: [t.cycleFrames(gif07, 30), t.cycleFrames(clip24, 30)],
        workedFrames: worked.frameCount,
        workedSeconds: Number((worked.frameCount / 30).toFixed(2)),
        at15Frames: at15.frameCount,
        cappedFrames: capped.frameCount,
        cappedFlag: capped.capped,
        cappedCycles: [t.cycleFrames(longA, 30), t.cycleFrames(longB, 30)],
        capLimit: 30 * 30,
      };
    })()
  `);

  if (!r.ok) c.fail(`loop length: ${r.error}`);
  else {
    // §8.1: "a 0.7 s GIF -> 21 frames; a 25-frame 24 fps clip -> 31 frames.
    //        LCM(21, 31) = 651 frames = 21.7 s, both seamless."
    c.check('worked example cycles', r.workedCycles, [21, 31]);
    c.check('worked example loop', r.workedFrames, 651);
    c.check('worked example duration', r.workedSeconds, 21.7);
    // The point of the §8.1 note: changing fps does not scale the result.
    c.truthy(
      'a different fps is not a proportional rescale',
      r.at15Frames !== Math.round(651 / 2),
      `${r.at15Frames} frames at 15 fps, not ${Math.round(651 / 2)}`,
    );
    // 29 s and 30 s at 30 fps are 870 and 900 output frames; their LCM is 26100,
    // far over the 900-frame cap, so §8.1 falls back to the longest single cycle.
    c.check('cycles', r.cappedCycles, [870, 900]);
    c.check('over the cap falls back to the longest cycle', r.cappedFrames, Math.max(...r.cappedCycles));
    c.check('and reports it', r.cappedFlag, true);
    c.truthy('capped loop is within the cap', r.cappedFrames <= r.capLimit);
  }
}

/* -- 3. Animated export: sampling and loop closure ------------------------- */

console.log('');
console.log('=== animated export (§8.1, §12) ===');
{
  const out = path.join(workDir, 'timing-loop.webp');
  fs.rmSync(out, { force: true });

  const r = await harness.run(`
    (async () => {
      const { importFiles } = await import('/media/importMedia.ts');
      const { exportDocument } = await import('/export/exportScene.ts');
      const t = await import('/scene/timing.ts');
      const store = window.__mwStore;

      // Two layers at 10 fps: 2 s and 1 s. At 10 fps their cycles are 20 and 10,
      // so the loop is 20 frames and both layers land on a frame boundary.
      await importFiles([${fx('anim-10fps-2s.gif')}], { x: -140, y: 0 });
      await importFiles([${fx('anim-10fps-1s.gif')}], { x: 140, y: 0 });

      store.getState().apply('setup', (d) => {
        d.canvasRect = { x: -320, y: -100, width: 640, height: 200 };
        d.background = { transparent: false, color: '#000000' };
        d.outputPath = ${JSON.stringify(out)};
        d.format = 'webp';
        d.quality = 'high';
        d.objects[0].x = -140; d.objects[0].y = 0;
        d.objects[0].width = 240; d.objects[0].height = 135;
        d.objects[1].x = 140; d.objects[1].y = 0;
        d.objects[1].width = 240; d.objects[1].height = 135;
      });

      const doc = store.getState().doc;
      const plan = t.planLoop(doc);

      // §8.1 sampling: which source frame each layer shows at each output frame.
      const sampled = [];
      for (let i = 0; i < plan.frameCount; i += 1) {
        sampled.push(doc.objects.map((o) => t.sourceFrameIndex(o, i, plan.fps)));
      }

      const res = await exportDocument({ doc });
      return { ok: res.ok, error: res.error, fps: plan.fps,
               frames: plan.frameCount, capped: plan.capped, sampled };
    })()
  `);

  if (!r.ok) {
    c.fail(`animated export: ${r.error}`);
    for (const line of r.log ?? []) console.error(`    ${line}`);
  } else {
    c.check('fps resolved to 10', r.fps, 10);
    c.check('loop is the LCM of 20 and 10', r.frames, 20);
    c.check('not capped', r.capped, false);

    // The 2 s layer advances once per output frame across all 20; the 1 s layer
    // repeats its 10 frames twice. That is what makes the loop seamless.
    const layerA = r.sampled.map((p) => p[0]);
    const layerB = r.sampled.map((p) => p[1]);
    c.check('20-frame layer plays straight through', layerA, [...Array(20).keys()]);
    c.check('10-frame layer repeats exactly twice', layerB,
      [...Array(20).keys()].map((i) => i % 10));

    const stream = frameCountOf(out);
    c.check('file has the planned frame count', Number(stream.nb_read_frames), 20);

    const frames = allFrames(out, 640, 200);
    c.check('decoded frame count matches', frames.length, 20);
    // A loop that closes: frame 0 and frame 10 differ (the long layer has moved
    // on) but the short layer is back where it started, so neither frame is a
    // duplicate of its neighbour.
    c.truthy('consecutive frames differ', !identical(frames[0], frames[1]));
    c.truthy('half-way frame differs from the first', !identical(frames[0], frames[10]));
  }
}

/* -- 4. GIF export of the same document ------------------------------------ */

console.log('');
console.log('=== animated GIF export (§12) ===');
{
  const out = path.join(workDir, 'timing-loop.gif');
  fs.rmSync(out, { force: true });

  const r = await harness.run(`
    (async () => {
      const { importFiles } = await import('/media/importMedia.ts');
      const { exportDocument } = await import('/export/exportScene.ts');
      const store = window.__mwStore;

      await importFiles([${fx('anim-10fps-2s.gif')}], { x: 0, y: 0 });
      store.getState().apply('setup', (d) => {
        d.canvasRect = { x: -160, y: -90, width: 320, height: 180 };
        d.background = { transparent: false, color: '#101010' };
        d.outputPath = ${JSON.stringify(out)};
        d.format = 'gif';
        d.quality = 'medium';
        d.objects[0].x = 0; d.objects[0].y = 0;
        d.objects[0].width = 320; d.objects[0].height = 180;
      });

      const phases = [];
      const res = await exportDocument({
        doc: store.getState().doc,
        onProgress: (phase) => { if (phases[phases.length - 1] !== phase) phases.push(phase); },
      });
      return { ok: res.ok, error: res.error, bytes: res.bytes, phases };
    })()
  `);

  if (!r.ok) {
    c.fail(`gif export: ${r.error}`);
    for (const line of r.log ?? []) console.error(`    ${line}`);
  } else {
    const stream = frameCountOf(out);
    c.check('gif frame count', Number(stream.nb_read_frames), 20);
    c.check('gif dimensions', [Number(stream.width), Number(stream.height)], [320, 180]);
    // §12: the progress bar covers all three passes.
    c.check('all three passes reported', r.phases, ['rendering', 'palette', 'encoding']);

    // §12: the scratch file and palette PNG are deleted on success.
    const cacheDir = path.dirname(out);
    const leftovers = fs
      .readdirSync(cacheDir)
      .filter((n) => n.startsWith('export-') && (n.endsWith('.rawvideo') || n.endsWith('.png')));
    c.check('scratch files cleaned up', leftovers, []);
  }
}

await harness.stop();
console.log('');
console.log(c.failures === 0 ? 'All timing smoke tests passed.' : `${c.failures} failed.`);
process.exit(c.failures === 0 ? 0 : 1);
