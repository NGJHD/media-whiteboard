/**
 * The pure half of the updater (UPDATE_BUTTON.md §3, §5, §6 step 7).
 *
 * `src/shared/version.ts` is deliberately free of Electron, fs and fetch so it
 * can be exercised without launching the app — these are exactly the comparisons
 * that go wrong when done as strings, and the ones that decide whether the app
 * offers to replace itself. Everything else in the updater has a side effect and
 * is tested for real, against a live GitHub release (§8).
 *
 * The module is TypeScript, so esbuild — already a dev dependency — transpiles
 * it to a temp .mjs first rather than adding a TS runtime to the toolchain.
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './esbuild.config.mjs';

const out = path.join(os.tmpdir(), `mw-version-test-${process.pid}.mjs`);

await build({
  entryPoints: [path.join(root, 'src/shared/version.ts')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'warning',
});

const { parseVersion, compareVersions, isNewer, sameVersion, pickReleaseAsset } = await import(
  pathToFileURL(out).href
);

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    console.error(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ok   ${label}`);
  }
}

console.log('parseVersion');
check('plain', parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3 });
check('v prefix', parseVersion('v0.1.2'), { major: 0, minor: 1, patch: 2 });
check('prerelease suffix ignored', parseVersion('v2.0.0-beta.1'), { major: 2, minor: 0, patch: 0 });
check('two components rejected', parseVersion('1.2'), null);
check('garbage rejected', parseVersion('latest'), null);
check('null rejected', parseVersion(null), null);

console.log('compareVersions');
check('equal', compareVersions(parseVersion('1.2.3'), parseVersion('1.2.3')), 0);
check('patch', compareVersions(parseVersion('1.2.4'), parseVersion('1.2.3')), 1);
check('minor beats patch', compareVersions(parseVersion('1.3.0'), parseVersion('1.2.99')), 1);
check('major beats minor', compareVersions(parseVersion('2.0.0'), parseVersion('1.99.99')), 1);

console.log('isNewer');
// The whole reason this file exists: "1.10.0" > "1.9.0" is false as strings.
check('1.10.0 over 1.9.0', isNewer('v1.10.0', '1.9.0'), true);
check('same is not newer', isNewer('v0.1.2', '0.1.2'), false);
check('older is not newer', isNewer('v0.1.1', '0.1.2'), false);
check('the shipping case', isNewer('v0.2.0', '0.1.2'), true);
// §5: an unparseable tag must answer *not newer* — never offer an update that
// cannot be reasoned about.
check('unparseable tag', isNewer('nightly', '0.1.2'), false);
check('missing tag', isNewer('', '0.1.2'), false);

console.log('sameVersion');
check('tag against asar', sameVersion('v0.2.0', '0.2.0'), true);
check('mismatch is a hard stop', sameVersion('v0.2.0', '0.1.2'), false);
check('unknown is not a match', sameVersion(null, '0.2.0'), false);

console.log('pickReleaseAsset');
const suffix = '-win-x64.zip';
const real = { name: 'MediaWhiteboard-0.2.0-win-x64.zip', url: 'https://github.com/x/y/z.zip', size: 260_000_000 };
check('the shipping asset', pickReleaseAsset([real], suffix), real);
check(
  'ignores companions',
  pickReleaseAsset([{ name: 'notes.md', url: 'u', size: 12 }, real], suffix),
  real,
);
check('empty release', pickReleaseAsset([], suffix), null);
check('missing assets', pickReleaseAsset(null, suffix), null);
check('zero-byte asset skipped', pickReleaseAsset([{ ...real, size: 0 }], suffix), null);
check(
  'ambiguous suffix match refuses to guess',
  pickReleaseAsset([real, { ...real, name: 'Other-0.2.0-win-x64.zip' }], suffix),
  null,
);
check(
  'a lone zip under another name is accepted',
  pickReleaseAsset([{ name: 'app.zip', url: 'u', size: 10 }], suffix),
  { name: 'app.zip', url: 'u', size: 10 },
);
check(
  'two unsuffixed zips refuse to guess',
  pickReleaseAsset([{ name: 'a.zip', url: 'u', size: 10 }, { name: 'b.zip', url: 'u', size: 10 }], suffix),
  null,
);

fs.rmSync(out, { force: true });
fs.rmSync(`${out}.map`, { force: true });

if (failures > 0) {
  console.error(`\n${failures} failed.`);
  process.exit(1);
}
console.log('\nsmoke:update passed.');
