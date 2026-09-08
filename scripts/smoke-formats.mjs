/**
 * The output format registry
 * (docs/superpowers/specs/2026-09-08-mp4-png-output-formats.md §6).
 *
 * Availability is the part with real consequences — it drives which options the
 * dropdown offers and whether a stale selection has to fall back — so it is
 * checked against both document states rather than by inspection.
 */
import path from 'node:path';
import { makeChecker, startHarness } from './smoke-lib.mjs';
import { root } from './esbuild.config.mjs';

const harness = await startHarness();
const c = makeChecker();

/**
 * Vite's root is src/renderer, so a renderer module is '/scene/timing.ts' but
 * anything in src/shared is outside the root and must go through /@fs/. A
 * '/../shared/x.ts' specifier does NOT work — the browser normalises the '..'
 * away and asks for '/shared/x.ts', which 404s.
 */
const shared = (name) => `/@fs/${path.join(root, 'src/shared', name).split(path.sep).join('/')}`;

console.log('=== Format registry ===');
{
  const r = await harness.run(`
    (async () => {
      const f = await import('${shared('formats.ts')}');
      const ids = (isStatic) =>
        f.FORMATS.filter((s) => f.isFormatAvailable(s.id, isStatic)).map((s) => s.id);
      return {
        ok: true,
        all: f.FORMATS.map((s) => s.id),
        animated: ids(false),
        static: ids(true),
        fallback: f.FALLBACK_FORMAT,
        fallbackAlwaysOk: f.isFormatAvailable(f.FALLBACK_FORMAT, true)
                       && f.isFormatAvailable(f.FALLBACK_FORMAT, false),
        quality: f.FORMATS.filter((s) => s.supportsQuality).map((s) => s.id),
        alpha: f.FORMATS.filter((s) => s.supportsAlpha).map((s) => s.id),
        // Every unavailable-somewhere format must be able to say why.
        reasons: f.FORMATS.filter((s) => s.availability !== 'always')
                          .every((s) => typeof s.requirement === 'string' && s.requirement.length > 0),
        swapUp: f.withExtension('C:\\\\out\\\\clip.webp', 'mp4'),
        swapDown: f.withExtension('C:\\\\out\\\\clip2.mp4', 'png'),
        swapNoExt: f.withExtension('C:\\\\out\\\\clip', 'gif'),
      };
    })()
  `);

  if (!r.ok) c.fail(`format registry: ${r.error}`);
  else {
    c.check('four formats', r.all, ['webp', 'gif', 'mp4', 'png']);
    // §6: MP4 needs motion, PNG needs the absence of it.
    c.check('animated document offers', r.animated, ['webp', 'gif', 'mp4']);
    c.check('static document offers', r.static, ['webp', 'gif', 'png']);
    c.check('fallback is webp', r.fallback, 'webp');
    c.truthy('fallback is available in both states', r.fallbackAlwaysOk);
    // §7: PNG is lossless, so it takes no quality setting.
    c.check('quality applies to', r.quality, ['webp', 'gif', 'mp4']);
    // §4: MP4 is the only format with no alpha at all.
    c.check('alpha carried by', r.alpha, ['webp', 'gif', 'png']);
    c.truthy('every conditional format states its requirement', r.reasons);
    c.check('extension swap', r.swapUp, 'C:\\out\\clip.mp4');
    c.check('extension swap keeps digits', r.swapDown, 'C:\\out\\clip2.png');
    c.check('extension added when absent', r.swapNoExt, 'C:\\out\\clip.gif');
  }
}

await harness.stop();
console.log(c.failures === 0 ? '\nAll format smoke tests passed.' : `\n${c.failures} failed.`);
process.exit(c.failures === 0 ? 0 : 1);
