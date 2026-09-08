/**
 * Format availability as the document changes
 * (docs/superpowers/specs/2026-09-08-mp4-png-output-formats.md §6).
 *
 * The stale-selection fallback is the part worth testing through the real store:
 * a layer can be added or removed by a drop, a delete, an undo or a project
 * load, and the correction has to happen for all of them.
 */
import path from 'node:path';
import { makeChecker, startHarness } from './smoke-lib.mjs';
import { root } from './esbuild.config.mjs';

const harness = await startHarness();
const c = makeChecker();

// See the note in smoke-formats.mjs: src/shared is outside Vite's root, so it
// has to be reached through /@fs/ rather than a '..' specifier.
const shared = (name) => `/@fs/${path.join(root, 'src/shared', name).split(path.sep).join('/')}`;

console.log('=== Stale format falls back (§6) ===');
{
  const r = await harness.run(`
    (async () => {
      const { useStore } = await import('/state/store.ts');
      const f = await import('${shared('formats.ts')}');

      const animated = {
        id: 'anim', kind: 'media', x: 0, y: 0, width: 10, height: 10,
        rotation: 0, opacity: 1, sourcePath: 'C:/x.gif', cacheKey: '0'.repeat(16),
        frameCount: 4, frameDurationsMs: [100, 100, 100, 100],
        nativeWidth: 10, nativeHeight: 10,
      };

      const s = useStore.getState();
      const wait = () => new Promise((r) => setTimeout(r, 150));

      // An animated document may select MP4.
      s.mutate((d) => { d.objects = [animated]; d.format = 'mp4'; d.outputPath = 'C:/out/a.mp4'; });
      await wait();
      const keptMp4 = useStore.getState().doc.format;

      // Removing the last animated layer must take MP4 away — and the
      // correction must not add an undo entry of its own (§6: it is a mutate,
      // not an apply, so undo reaches the state before the user's delete).
      useStore.getState().apply('Delete', (d) => { d.objects = []; });
      const undoDepthAfterDelete = useStore.getState().undoStack.length;
      await wait();
      const afterDelete = useStore.getState().doc;
      const undoDepthAfterFallback = useStore.getState().undoStack.length;

      // A static document may select PNG.
      useStore.getState().mutate((d) => { d.format = 'png'; d.outputPath = 'C:/out/a.png'; });
      await wait();
      const keptPng = useStore.getState().doc.format;

      // Adding an animated layer must take PNG away.
      useStore.getState().apply('Add', (d) => { d.objects = [animated]; });
      await wait();
      const afterAdd = useStore.getState().doc;

      return {
        ok: true,
        keptMp4,
        keptPng,
        afterDeleteFormat: afterDelete.format,
        afterDeleteExt: afterDelete.outputPath.slice(afterDelete.outputPath.lastIndexOf('.')),
        afterAddFormat: afterAdd.format,
        afterAddExt: afterAdd.outputPath.slice(afterAdd.outputPath.lastIndexOf('.')),
        fallback: f.FALLBACK_FORMAT,
        undoDepthAfterDelete,
        undoDepthAfterFallback,
      };
    })()
  `);

  if (!r.ok) c.fail(`format fallback: ${r.error}`);
  else {
    c.check('mp4 survives on an animated document', r.keptMp4, 'mp4');
    c.check('png survives on a static document', r.keptPng, 'png');
    c.check('mp4 falls back when animation goes', r.afterDeleteFormat, 'webp');
    c.check('and the extension follows', r.afterDeleteExt, '.webp');
    c.check('png falls back when animation arrives', r.afterAddFormat, 'webp');
    c.check('and the extension follows', r.afterAddExt, '.webp');
    // §6: the app correcting itself is not an edit the user steps back through.
    c.check(
      'the fallback adds no undo entry',
      r.undoDepthAfterFallback,
      r.undoDepthAfterDelete,
    );
  }
}

console.log('\n=== Format dropdown reflects availability in the DOM (§6) ===');
{
  const r = await harness.run(`
    (async () => {
      const { useStore } = await import('/state/store.ts');
      const wait = () => new Promise((r) => setTimeout(r, 150));

      // Empty document: no animated layer, so MP4 must be disabled and the
      // info affordance beside the dropdown must be present.
      useStore.getState().mutate((d) => { d.objects = []; });
      await wait();

      const mp4Option = document.querySelector('select option[value="mp4"]');
      const hint = document.querySelector('.field-hint');

      return {
        ok: true,
        mp4Present: mp4Option != null,
        mp4Disabled: mp4Option ? mp4Option.disabled : null,
        hintPresent: hint != null,
      };
    })()
  `);

  if (!r.ok) c.fail(`dropdown DOM state: ${r.error}`);
  else {
    c.truthy('the mp4 option exists in the DOM', r.mp4Present);
    c.check('mp4 is disabled with no animated layer', r.mp4Disabled, true);
    c.truthy('the info affordance beside the dropdown is present', r.hintPresent);
  }
}

console.log('\n=== Quality control disables for PNG (§7) ===');
{
  const r = await harness.run(`
    (async () => {
      const { useStore } = await import('/state/store.ts');
      const wait = () => new Promise((r) => setTimeout(r, 150));

      // PNG is only offered on a static document.
      useStore.getState().mutate((d) => {
        d.objects = [];
        d.format = 'png';
        d.outputPath = 'C:/out/a.png';
      });
      await wait();

      // Find the Quality <select> by its options rather than a class name that
      // isn't guaranteed — its option values are the tell.
      const selects = [...document.querySelectorAll('select')];
      const qualitySelect = selects.find((s) =>
        [...s.options].map((o) => o.value).join(',') === 'low,medium,high',
      );

      return {
        ok: true,
        found: qualitySelect != null,
        disabled: qualitySelect ? qualitySelect.disabled : null,
      };
    })()
  `);

  if (!r.ok) c.fail(`quality control state: ${r.error}`);
  else {
    c.truthy('the quality select is found', r.found);
    c.check('quality is disabled when PNG is selected', r.disabled, true);
  }
}

console.log('\n=== MP4 transparency warning fires once (§4/§12) ===');
{
  const r = await harness.run(`
    (async () => {
      const { useStore } = await import('/state/store.ts');
      const wait = () => new Promise((r) => setTimeout(r, 150));

      const animated = {
        id: 'anim2', kind: 'media', x: 0, y: 0, width: 10, height: 10,
        rotation: 0, opacity: 1, sourcePath: 'C:/x.gif', cacheKey: '1'.repeat(16),
        frameCount: 4, frameDurationsMs: [100, 100, 100, 100],
        nativeWidth: 10, nativeHeight: 10,
      };

      // An animated, transparent document: MP4 is selectable, and selecting it
      // with a transparent background should warn.
      useStore.getState().mutate((d) => {
        d.objects = [animated];
        d.format = 'webp';
        d.outputPath = 'C:/out/a.webp';
        d.background = { transparent: true, color: '#000000' };
      });
      await wait();

      const formatSelect = [...document.querySelectorAll('select')].find((s) =>
        [...s.options].some((o) => o.value === 'mp4'),
      );
      if (!formatSelect) return { ok: false, error: 'format select not found' };

      const countWarnings = () =>
        useStore.getState().toasts.filter((t) => /transparen/i.test(t.message)).length;

      const setNative = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype, 'value',
      ).set;

      // Select MP4 once.
      setNative.call(formatSelect, 'mp4');
      formatSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await wait();
      const afterFirst = countWarnings();

      // Select it again — same target value, dispatched again, exercising the
      // same onChange handler a second time.
      setNative.call(formatSelect, 'mp4');
      formatSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await wait();
      const afterSecond = countWarnings();

      return { ok: true, afterFirst, afterSecond };
    })()
  `);

  if (!r.ok) c.fail(`mp4 transparency warning: ${r.error}`);
  else {
    c.check('the warning fires once on first selection', r.afterFirst, 1);
    c.check('and not again on a second selection', r.afterSecond, 1);
  }
}

await harness.stop();
console.log(c.failures === 0 ? '\nAll output-UI smoke tests passed.' : `\n${c.failures} failed.`);
process.exit(c.failures === 0 ? 0 : 1);
