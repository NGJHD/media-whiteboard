/**
 * Scene rendering and export geometry (CLAUDE.md §3, §4, §12; §16 steps 3 and 6).
 *
 * Renders real documents through the real export path and reads the resulting
 * pixels back with ffmpeg. This is what proves `buildScene` actually draws — a
 * screenshot proves only that a window exists, and "ffmpeg exited 0" proves only
 * that bytes were written.
 *
 * It also pins the §4 coordinate model: objects have world coordinates and do not
 * move when canvasRect changes; canvasRect is the window onto the world.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeChecker, startHarness, workDir } from './smoke-lib.mjs';
import { root } from './esbuild.config.mjs';

const ffmpeg = path.join(root, 'resources', 'bin', 'ffmpeg.exe');
const fixture = JSON.stringify(path.join(root, 'test-fixtures', 'static.png'));

/** The fixture is a 640x360 #3366cc field with an orange box at 100,60 200x120. */
const BLUE = [51, 102, 204];
const ORANGE = [255, 165, 0];
const BLACK = [0, 0, 0];

const harness = await startHarness();
const c = makeChecker();

/** Decodes an image to raw RGBA and returns a pixel reader. */
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

/** Tolerant compare: WebP at q90 is lossy, so exact equality is the wrong test. */
function near(actual, expected, tolerance = 12) {
  return expected.every((v, i) => Math.abs(actual[i] - v) <= tolerance);
}

function describe(rgba) {
  return `rgba(${rgba.join(',')})`;
}

async function renderDoc(label, script, out, width, height) {
  fs.rmSync(out, { force: true });
  const result = await harness.run(`
    (async () => {
      const { importFiles } = await import('/media/importMedia.ts');
      const { exportDocument } = await import('/export/exportScene.ts');
      // NB: __mwStore is the zustand hook itself, so actions live on getState().
      // Calling store.apply(...) would reach Function.prototype.apply instead.
      const store = window.__mwStore;
      ${script}
      const res = await exportDocument({ doc: store.getState().doc });
      return { ok: res.ok, bytes: res.bytes, error: res.error };
    })()
  `);
  if (!result.ok) {
    c.fail(`${label}: ${result.error}`);
    for (const line of result.log ?? []) console.error(`    ${line}`);
    return null;
  }
  if (!fs.existsSync(out)) {
    c.fail(`${label}: no output file`);
    return null;
  }
  return pixels(out, width, height);
}

/* -- 1. Media fills the canvas exactly ------------------------------------- */

console.log('=== media rendered into the export (§3) ===');
{
  const out = path.join(workDir, 'scene-fill.webp');
  const at = await renderDoc(
    'fill',
    `
      await importFiles([${fixture}], { x: 0, y: 0 });
      store.getState().apply('setup', (d) => {
        d.canvasRect = { x: -320, y: -180, width: 640, height: 360 };
        d.background = { transparent: false, color: '#000000' };
        d.outputPath = ${JSON.stringify(out)};
        d.format = 'webp';
        d.objects[0].x = 0;
        d.objects[0].y = 0;
        d.objects[0].width = 640;
        d.objects[0].height = 360;
      });
    `,
    out,
    640,
    360,
  );

  if (at) {
    // The image covers the canvas, so no background must be visible anywhere.
    c.truthy('top-left is the image field', near(at(8, 8), BLUE), describe(at(8, 8)));
    c.truthy('bottom-right is the image field', near(at(630, 350), BLUE), describe(at(630, 350)));
    // The orange box sits at 100,60 to 300,180 in image space, which here is
    // also canvas space because the image exactly fills the canvas.
    c.truthy('orange box is where it should be', near(at(200, 120), ORANGE), describe(at(200, 120)));
    c.truthy('just outside the box is not orange', !near(at(90, 120), ORANGE), describe(at(90, 120)));
    c.truthy('opaque', at(200, 120)[3] === 255, `alpha ${at(200, 120)[3]}`);
  }
}

/* -- 2. Background shows around a smaller object --------------------------- */

console.log('');
console.log('=== background and object placement (§3, §5) ===');
{
  const out = path.join(workDir, 'scene-inset.webp');
  const at = await renderDoc(
    'inset',
    `
      await importFiles([${fixture}], { x: 0, y: 0 });
      store.getState().apply('setup', (d) => {
        d.canvasRect = { x: -320, y: -180, width: 640, height: 360 };
        d.background = { transparent: false, color: '#000000' };
        d.outputPath = ${JSON.stringify(out)};
        d.format = 'webp';
        // A 320x180 object centred on the world origin: it occupies the middle
        // quarter of the canvas, leaving black on all four sides.
        d.objects[0].x = 0;
        d.objects[0].y = 0;
        d.objects[0].width = 320;
        d.objects[0].height = 180;
      });
    `,
    out,
    640,
    360,
  );

  if (at) {
    c.truthy('corner is background', near(at(8, 8), BLACK), describe(at(8, 8)));
    c.truthy('centre is the image', near(at(320, 180), BLUE, 30), describe(at(320, 180)));
    // Object spans canvas x 160..480, y 90..270. Just outside must be background.
    c.truthy('left of the object is background', near(at(150, 180), BLACK), describe(at(150, 180)));
    c.truthy('right of the object is background', near(at(490, 180), BLACK), describe(at(490, 180)));
    c.truthy('inside the object is not background', !near(at(170, 180), BLACK), describe(at(170, 180)));
  }
}

/* -- 3. Objects do not move when canvasRect moves (§4) --------------------- */

console.log('');
console.log('=== canvasRect is a window onto the world (§4) ===');
{
  const out = path.join(workDir, 'scene-shifted.webp');
  const at = await renderDoc(
    'shifted',
    `
      await importFiles([${fixture}], { x: 0, y: 0 });
      store.getState().apply('setup', (d) => {
        d.background = { transparent: false, color: '#000000' };
        d.outputPath = ${JSON.stringify(out)};
        d.format = 'webp';
        d.objects[0].x = 0;
        d.objects[0].y = 0;
        d.objects[0].width = 320;
        d.objects[0].height = 180;
        // Same object, but the canvas window is shifted 160 px right and 90 down.
        // The object must therefore appear 160/90 further up-left in the output.
        d.canvasRect = { x: -160, y: -90, width: 640, height: 360 };
      });
    `,
    out,
    640,
    360,
  );

  if (at) {
    // World x 160..480 -> canvas x 0..320 after the shift.
    c.truthy('object moved left with the window', !near(at(10, 10), BLACK), describe(at(10, 10)));
    c.truthy('object right edge at ~320', near(at(330, 100), BLACK), describe(at(330, 100)));
    c.truthy('area the window moved onto is background', near(at(600, 300), BLACK), describe(at(600, 300)));
  }
}

/* -- 4. Transparent background really is transparent (§9, §12) ------------- */

console.log('');
console.log('=== transparent background (§12) ===');
{
  const out = path.join(workDir, 'scene-alpha.webp');
  const at = await renderDoc(
    'alpha',
    `
      await importFiles([${fixture}], { x: 0, y: 0 });
      store.getState().apply('setup', (d) => {
        d.canvasRect = { x: -320, y: -180, width: 640, height: 360 };
        d.background = { transparent: true, color: '#000000' };
        d.outputPath = ${JSON.stringify(out)};
        d.format = 'webp';
        d.objects[0].x = 0;
        d.objects[0].y = 0;
        d.objects[0].width = 320;
        d.objects[0].height = 180;
      });
    `,
    out,
    640,
    360,
  );

  if (at) {
    // The checkerboard is viewport chrome and must never reach the output.
    c.truthy('corner is fully transparent', at(8, 8)[3] === 0, `alpha ${at(8, 8)[3]}`);
    c.truthy('object is opaque', at(320, 180)[3] === 255, `alpha ${at(320, 180)[3]}`);
  }
}

/* -- Animated transparency reaches the file, in both formats (§12) --------- */

console.log('');
console.log('=== animated transparent export, both formats (§12) ===');
for (const format of ['webp', 'gif']) {
  const out = path.join(workDir, `scene-alpha-anim.${format}`);
  const at = await renderDoc(
    `alpha-${format}`,
    `
      await importFiles([${JSON.stringify(path.join(root, 'test-fixtures', 'anim-10fps-2s.gif'))}], { x: 0, y: 0 });
      await window.__mwIdle();
      store.getState().apply('setup', (d) => {
        d.canvasRect = { x: -160, y: -90, width: 320, height: 180 };
        d.background = { transparent: true, color: '#ffffff' };
        d.outputPath = ${JSON.stringify(out)};
        d.format = ${JSON.stringify(format)};
        d.objects[0].x = 0;
        d.objects[0].y = 0;
        d.objects[0].width = 100;
        d.objects[0].height = 100;
      });
    `,
    out,
    320,
    180,
  );

  if (at) {
    // Neither encoder may composite the frame onto a background of its own:
    // whatever a viewer chooses to show behind it, the file must carry alpha.
    c.truthy(`${format}: corner is fully transparent`, at(4, 4)[3] === 0, `alpha ${at(4, 4)[3]}`);
    c.truthy(`${format}: the layer is opaque`, at(160, 90)[3] === 255, `alpha ${at(160, 90)[3]}`);
  }
}

/* -- 5. Zero animated layers gives a single-frame file (§12 step 3) -------- */

console.log('');
console.log('=== static output (§12) ===');
{
  const out = path.join(workDir, 'scene-static.webp');
  const result = await harness.run(`
    (async () => {
      const { importFiles } = await import('/media/importMedia.ts');
      const { exportDocument } = await import('/export/exportScene.ts');
      const timing = await import('/scene/timing.ts');
      // NB: __mwStore is the zustand hook itself, so actions live on getState().
      // Calling store.apply(...) would reach Function.prototype.apply instead.
      const store = window.__mwStore;
      await importFiles([${fixture}], { x: 0, y: 0 });
      store.getState().apply('setup', (d) => {
        d.canvasRect = { x: -320, y: -180, width: 320, height: 180 };
        d.outputPath = ${JSON.stringify(out)};
        d.format = 'webp';
        d.outputFps = 30;
      });
      const plan = timing.planLoop(store.getState().doc);
      const res = await exportDocument({ doc: store.getState().doc });
      return { ok: res.ok, isStatic: plan.isStatic, planFrames: plan.frameCount };
    })()
  `);

  if (!result.ok) {
    c.fail(`static export failed: ${result.error}`);
  } else {
    c.check('plan reports static', result.isStatic, true);
    const probe = execFileSync(
      path.join(root, 'resources', 'bin', 'ffprobe.exe'),
      ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
       '-show_entries', 'stream=nb_read_frames,width,height', '-of', 'json', out],
      { encoding: 'utf8' },
    );
    const stream = JSON.parse(probe).streams[0];
    c.check('single frame on disk', Number(stream.nb_read_frames), 1);
    c.check('canvas size honoured', [Number(stream.width), Number(stream.height)], [320, 180]);
  }
}

await harness.stop();
console.log('');
console.log(c.failures === 0 ? 'All scene smoke tests passed.' : `${c.failures} failed.`);
process.exit(c.failures === 0 ? 0 : 1);
