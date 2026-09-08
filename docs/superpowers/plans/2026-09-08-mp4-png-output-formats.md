# MP4 + PNG Output Formats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MP4 (H.264, CRF-controlled) and PNG (single-frame, lossless) to the export format dropdown, switching the bundled ffmpeg from an LGPL build to a GPL build so `libx264` and its CRF rate control are available.

**Architecture:** A new `src/shared/formats.ts` becomes the single table describing every output format — label, extension, when it is available, whether it takes a quality setting, whether it carries alpha. Main's save dialog, the renderer's dropdown, the project-file namer and the encoder all read from it instead of hardcoding `webp|gif`. `src/main/encoder.ts` gains two new branches alongside the existing WebP (one-pass) and GIF (three-pass) paths; MP4 is one-pass like WebP, PNG is one-pass and one-frame. Nothing in `buildScene` or the render loop changes — the pixels handed to ffmpeg are identical, only the encoding of them differs.

**Tech Stack:** Electron 44, React 19, TypeScript 5.9, Konva 10, Zustand 5 + Immer 11, bundled ffmpeg (BtbN win64 **GPL** build, `libx264`).

**Spec:** `docs/superpowers/specs/2026-09-08-mp4-png-output-formats.md`

## Global Constraints

Copied from `CLAUDE.md`; every task's requirements implicitly include these.

- **Portable Windows 11 x64.** No installer, no admin rights, no registry writes, no writes outside the app folder (except §7's temp fallback). ffmpeg is invoked by absolute path via `binaries()` in `src/main/ffmpeg.ts`, never from `PATH`.
- **Pin exact versions** in `package.json`. No `^`, no `~`.
- **No native Node modules.** Not `sharp`, not `canvas`, nothing needing `node-gyp`.
- **`contextIsolation: true`, `nodeIntegration: false`.** All main-process capability crosses the typed preload bridge in `src/preload/index.ts`.
- **`buildScene` is the only place scene content is constructed.** This work must not touch it. Preview and export pixel equivalence is structural and stays that way.
- **`apply(label, recipe)` creates an undo entry; `mutate(recipe)` does not.** The app correcting its own state is a `mutate`. A user edit is an `apply`.
- **Every failure is a toast plus a no-op** (`CLAUDE.md` §14), never a crash and never silent. ffmpeg failures surface the last ~10 lines of stderr in an expandable detail.
- **The suggested output path is always one that does not exist** (`uniquePath` in `src/main/settings.ts`, exposed as `window.api.uniqueOutputPath`). Re-apply it whenever the extension changes.
- **`canvasRect` is capped at 2560 px** per axis and may be any value up to that, odd included.

---

### Task 1: Swap the bundled ffmpeg to the GPL build

The whole feature rests on `libx264` being present, so this lands first and alone. Nothing else in the plan can be tested until `resources/bin/ffmpeg.exe` is a GPL build.

**Files:**
- Modify: `scripts/ffmpeg-build.json` (whole file)
- Modify: `scripts/fetch-ffmpeg.mjs:28-31` (flag constants), `:84-116` (`verifyLicense`)
- Modify: `THIRD-PARTY-NOTICES.md` (the FFmpeg section)
- Modify: `LICENSE.ffmpeg.txt` (replaced with the GPL v3 text from the archive)
- Modify: `electron-builder.yml` (no change expected — `extraFiles` already lists `LICENSE.ffmpeg.txt`; verify)

**Interfaces:**
- Consumes: nothing.
- Produces: a `resources/bin/ffmpeg.exe` whose `-encoders` output contains `libx264` and `png`, and whose `configuration:` line contains `--enable-gpl --enable-libx264`. Every later task depends on this.

- [ ] **Step 1: Write the failing test**

Add a licence/encoder assertion script. Create `scripts/smoke-codecs.mjs`:

```js
/**
 * Asserts the bundled ffmpeg is the build this project expects: GPL, with
 * libx264 for MP4 (docs/superpowers/specs/2026-09-08-mp4-png-output-formats.md
 * §2) and libwebp for WebP, and without any nonfree component.
 *
 * Cheap and dependency-free, so it can run before the Electron smoke tests.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { root } from './esbuild.config.mjs';

const ffmpeg = path.join(root, 'resources', 'bin', 'ffmpeg.exe');

const version = execFileSync(ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8' });
const config = version.split('\n').find((l) => l.startsWith('configuration:')) ?? '';
const encoders = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' });

let failures = 0;
const check = (label, pass) => {
  if (!pass) failures += 1;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}`);
};

check('configured --enable-gpl', config.includes('--enable-gpl'));
check('configured --enable-libx264', config.includes('--enable-libx264'));
check('configured --enable-libwebp', config.includes('--enable-libwebp'));
check('NOT configured --enable-nonfree', !config.includes('--enable-nonfree'));
check('libx264 encoder present', encoders.includes('libx264'));
check('libwebp_anim encoder present', encoders.includes('libwebp_anim'));
check('native gif encoder present', /^\s*V\S*\s+gif\s/m.test(encoders));
check('native png encoder present', /^\s*V\S*\s+png\s/m.test(encoders));

console.log(failures === 0 ? '\nCodec checks passed.' : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
```

Register it in `package.json` scripts, and add it to the front of the `smoke` chain:

```json
"smoke:codecs": "node scripts/smoke-codecs.mjs",
"smoke": "npm run smoke:codecs && npm run smoke:update && npm run smoke:export && npm run smoke:import && npm run smoke:scene && npm run smoke:select && npm run smoke:timing && npm run smoke:tools && npm run smoke:transform && npm run smoke:preview",
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run smoke:codecs`
Expected: FAIL on `configured --enable-gpl`, `configured --enable-libx264` and `libx264 encoder present`. The current binary is the LGPL build, which has `--disable-libx264`.

- [ ] **Step 3: Compute the checksums for the GPL asset**

The GPL asset lives at the same BtbN release and the same upstream commit as the LGPL one currently pinned, so only the licence surface changes. Its checksums cannot be known without downloading it — compute them:

```sh
node -e "
const {createHash}=require('crypto');const fs=require('fs');const path=require('path');
const {execFileSync}=require('child_process');
const url='https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-01-13-13/ffmpeg-n9.0.1-11-ge47273f4d9-win64-gpl-9.0.zip';
const dir='resources/.download';
const zip=path.join(dir,'gpl.zip');
const ex=path.join(dir,'gplx');
(async()=>{
  fs.mkdirSync(dir,{recursive:true});
  const buf=Buffer.from(await (await fetch(url,{redirect:'follow'})).arrayBuffer());
  fs.writeFileSync(zip,buf);
  console.log('zipSha256      ', createHash('sha256').update(buf).digest('hex'));
  fs.rmSync(ex,{recursive:true,force:true});
  fs.mkdirSync(ex,{recursive:true});
  execFileSync('tar.exe',['-xf',zip,'-C',ex]);
  const find=(d,n)=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){
    const f=path.join(d,e.name);
    if(e.isDirectory()){const h=find(f,n);if(h)return h;}
    else if(e.name.toLowerCase()===n)return f;} return null;};
  for(const n of ['ffmpeg.exe','ffprobe.exe']){
    const f=find(ex,n);
    console.log(n.padEnd(15), createHash('sha256').update(fs.readFileSync(f)).digest('hex'));
  }
  const lic=find(ex,'license.txt');
  if(lic){fs.copyFileSync(lic,'LICENSE.ffmpeg.txt');console.log('copied LICENSE.txt ->  LICENSE.ffmpeg.txt');}
  else console.log('WARNING: no LICENSE.txt in the archive — fetch GPL v3 from https://www.gnu.org/licenses/gpl-3.0.txt');
})();
"
```

Confirm the licence text that landed is GPL, not LGPL:

```sh
head -3 LICENSE.ffmpeg.txt
```

Expected: `GNU GENERAL PUBLIC LICENSE` / `Version 3, 29 June 2007`. If it says *LESSER*, the wrong file was copied — fetch `https://www.gnu.org/licenses/gpl-3.0.txt` instead.

Keep the three hashes printed above; Step 4 uses them.

- [ ] **Step 4: Repoint the pin file**

Replace `scripts/ffmpeg-build.json` entirely, substituting the three hashes from Step 3:

```json
{
  "_comment": [
    "The pinned ffmpeg build. Do not point this at BtbN's 'latest' tag: that tag",
    "is rolling and its assets are replaced in place, so it cannot be pinned.",
    "'autobuild-*' tags are immutable.",
    "",
    "This is the GPL build, deliberately. See",
    "docs/superpowers/specs/2026-09-08-mp4-png-output-formats.md §2: MP4 output",
    "with a CRF quality dropdown needs libx264, libx264 is GPL, and libopenh264",
    "(BSD, in the LGPL build) implements no CRF at all.",
    "",
    "This project's own source stays MIT. ffmpeg is spawned as a separate",
    "process and never linked, so the GPL does not reach into src/. The binaries",
    "remain GPL and carry their obligations — see THIRD-PARTY-NOTICES.md.",
    "",
    "Same release and same upstream commit as the LGPL build this replaced; only",
    "the asset changed.",
    "",
    "To move to a newer build: change the fields below, then re-run",
    "scripts/fetch-ffmpeg.mjs, which refuses any build that is not GPL, lacks",
    "libx264 or libwebp, or carries a nonfree component."
  ],
  "release": "autobuild-2026-09-01-13-13",
  "version": "n9.0.1-11-ge47273f4d9-20260901",
  "license": "GPL-3.0-or-later",
  "asset": "ffmpeg-n9.0.1-11-ge47273f4d9-win64-gpl-9.0.zip",
  "url": "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-01-13-13/ffmpeg-n9.0.1-11-ge47273f4d9-win64-gpl-9.0.zip",
  "sourceUrl": "https://github.com/BtbN/FFmpeg-Builds",
  "upstreamSourceUrl": "https://github.com/FFmpeg/FFmpeg/tree/e47273f4d9",
  "zipSha256": "<zipSha256 from Step 3>",
  "binaries": {
    "ffmpeg.exe": "<ffmpeg.exe hash from Step 3>",
    "ffprobe.exe": "<ffprobe.exe hash from Step 3>"
  }
}
```

- [ ] **Step 5: Invert the licence check in the fetch script**

In `scripts/fetch-ffmpeg.mjs`, replace the two flag constants (currently at lines 28-31):

```js
/** Configure flags that would change this project's license obligations. */
const FORBIDDEN_FLAGS = ['--enable-nonfree'];
/**
 * Required. `--enable-gpl` and `--enable-libx264` are deliberate: MP4 output
 * needs CRF, CRF needs libx264, libx264 is GPL. libopenh264 in the LGPL build
 * has no CRF and no way to gain one. See
 * docs/superpowers/specs/2026-09-08-mp4-png-output-formats.md §2.
 *
 * `--enable-libwebp` is not optional either: without it §12 cannot encode WebP,
 * and not every build includes it.
 */
const REQUIRED_FLAGS = ['--enable-gpl', '--enable-libx264', '--enable-libwebp'];
```

Then rewrite the two error messages and the encoder assertions inside `verifyLicense`:

```js
  const violations = FORBIDDEN_FLAGS.filter((f) => configLine.includes(f));
  if (violations.length > 0) {
    throw new Error(
      `Refusing this ffmpeg build: it was configured with ${violations.join(', ')}. ` +
        `A nonfree component cannot be redistributed at all.`,
    );
  }

  const missing = REQUIRED_FLAGS.filter((f) => !configLine.includes(f));
  if (missing.length > 0) {
    throw new Error(
      `Refusing this ffmpeg build: missing ${missing.join(', ')}. ` +
        `This project pins the GPL build for libx264 (MP4/CRF) and needs ` +
        `libwebp for WebP. An LGPL build has neither x264 nor any CRF-capable ` +
        `H.264 encoder.`,
    );
  }

  const encoders = execFileSync(ffmpegExe, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  for (const enc of ['libwebp_anim', 'libwebp', 'libx264']) {
    if (!encoders.includes(enc)) throw new Error(`Refusing this ffmpeg build: no ${enc} encoder.`);
  }
  if (!/^\s*V\S*\s+gif\s/m.test(encoders)) {
    throw new Error('Refusing this ffmpeg build: no native gif encoder.');
  }
  if (!/^\s*V\S*\s+png\s/m.test(encoders)) {
    throw new Error('Refusing this ffmpeg build: no native png encoder.');
  }

  console.log('  verified: GPL build, libx264 + libwebp present, nothing nonfree');
```

Also update the file's header comment (lines 9-11), which currently says "Downloads an LGPL build":

```js
/**
 * Fetches the pinned GPL ffmpeg build into resources/bin/ (see
 * docs/superpowers/specs/2026-09-08-mp4-png-output-formats.md §2 for why GPL).
 *
 * The binaries are not committed: they are ~110 MB each, above GitHub's 100 MB
 * hard file limit. This runs at build time; the packaged app ships them via
 * electron-builder extraResources, so an end user never fetches anything.
 *
 * Everything here is checksum-verified, and the extracted ffmpeg is re-inspected
 * for its licence flags before it is accepted.
 */
```

- [ ] **Step 6: Fetch and verify**

```sh
rm -f resources/bin/ffmpeg.exe resources/bin/ffprobe.exe
npm run fetch:ffmpeg
```

Expected: `sha256 ok`, then `verified: GPL build, libx264 + libwebp present, nothing nonfree`. A checksum mismatch here means a hash was mistyped in Step 4 — the error prints expected and actual.

- [ ] **Step 7: Run the codec test to verify it passes**

Run: `npm run smoke:codecs`
Expected: all eight checks `ok`.

- [ ] **Step 8: Confirm nothing already working regressed**

Run: `npm run smoke:export`
Expected: both `webp` and `gif` cases pass, exactly as before. The GPL build is a superset; if WebP or GIF broke, the wrong asset was pinned.

- [ ] **Step 9: Rewrite the third-party notices for GPL**

Replace the `## FFmpeg` section of `THIRD-PARTY-NOTICES.md` with the following. Leave the file's opening lines and any other sections untouched.

```markdown
## FFmpeg

**Binaries redistributed:** `ffmpeg.exe`, `ffprobe.exe` (in `resources/bin/`)

| | |
|---|---|
| Version | `n9.0.1-11-ge47273f4d9-20260901` |
| License | **GNU GPL v3 or later** (built with `--enable-gpl --enable-version3`) |
| Build | BtbN/FFmpeg-Builds, release `autobuild-2026-09-01-13-13`, asset `ffmpeg-n9.0.1-11-ge47273f4d9-win64-gpl-9.0.zip` |
| Build scripts | https://github.com/BtbN/FFmpeg-Builds |
| Upstream source | https://github.com/FFmpeg/FFmpeg/tree/e47273f4d9 |

FFmpeg is LGPL v2.1+ by default. This build is configured with `--enable-gpl`
(required for **libx264**, which MP4 output depends on) and `--enable-version3`.
Together those make the resulting binaries **GPL v3**. The full licence text is
reproduced in `LICENSE.ffmpeg.txt` alongside this file.

Notable GPL components in this build: **libx264**, **libx265**, **libzimg**.

**Corresponding source.** GPL redistribution requires the corresponding source to
be available. It is at the upstream URL above, at the exact commit the build was
made from (`e47273f4d9`), and the scripts used to produce these binaries are in
the BtbN repository. The exact release and asset name are pinned in
`scripts/ffmpeg-build.json`, along with SHA-256 checksums of the archive and of
each extracted binary.

**Replacing the binaries.** These are separate executables invoked as child
processes, not libraries linked into Media Whiteboard. A user may replace
`resources/bin/ffmpeg.exe` and `resources/bin/ffprobe.exe` with their own builds;
the app invokes them by absolute path and does not verify their contents at
runtime.

### Why Media Whiteboard's own code stays MIT

The app never links against FFmpeg. It **spawns `ffmpeg.exe` as a separate
process** and communicates with it only through command-line arguments, exit codes
and pipes — see `src/main/encoder.ts` and `src/main/media.ts`, the only places a
child process is created.

Under the FSF's own guidance, programs that merely run at arm's length like this
are separate works rather than a single combined program, so the GPL does not
reach back into this codebase. This is the same arrangement many applications that
ship FFmpeg rely on. The FFmpeg binaries remain GPL and carry their obligations
with them; the code in `src/` remains MIT.

Two things would change that conclusion, so avoid both:

- linking FFmpeg's libraries directly (libavcodec and friends) instead of
  spawning the executable;
- shipping a build configured with `--enable-nonfree`, which cannot be
  redistributed at all. `scripts/fetch-ffmpeg.mjs` refuses those.

**When distributing a release,** keep `THIRD-PARTY-NOTICES.md`,
`LICENSE.ffmpeg.txt` and `LICENSE` inside the zip (electron-builder's `extraFiles`
already does this), and state in the release notes that the bundled FFmpeg is GPL
v3 and is not covered by this project's MIT licence, linking the upstream commit
above for corresponding source.
```

- [ ] **Step 10: Verify the notices still ship**

```sh
grep -n "LICENSE.ffmpeg.txt" electron-builder.yml
```

Expected: it appears under `extraFiles`. It already should; if it does not, add it there alongside `THIRD-PARTY-NOTICES.md`.

- [ ] **Step 11: Commit**

```bash
git add scripts/ffmpeg-build.json scripts/fetch-ffmpeg.mjs scripts/smoke-codecs.mjs package.json THIRD-PARTY-NOTICES.md LICENSE.ffmpeg.txt
git commit -m "$(cat <<'EOF'
build: pin the GPL ffmpeg build for libx264

MP4 output needs a CRF quality dropdown; CRF needs libx264; libx264 is GPL.
libopenh264 in the LGPL build is BSD but implements no CRF and cannot gain one.

Same BtbN release and upstream commit as before — only the asset changed. The
fetch script's licence check is inverted accordingly: GPL and libx264 are now
required, nonfree is still refused. Notices rewritten for GPL v3, including the
corresponding-source offer and the arm's-length rationale that keeps src/ MIT.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fbvQdiYXZqhCqEZSmT55U
EOF
)"
```

---

### Task 2: The format registry

Everything that currently hardcodes `webp|gif` starts reading one table. This task adds the two new format *identities* without any encoding behind them yet — selecting MP4 or PNG at the end of this task will still reach the WebP encoder branch. That is fine and expected; Tasks 3 and 4 fill it in.

**Files:**
- Create: `src/shared/formats.ts`
- Modify: `src/shared/ipc.ts:145` (the `OutputFormat` union)
- Modify: `src/shared/doc.ts:94` (the `Doc.format` field type)
- Modify: `src/main/index.ts:138-146` (save dialog filters)
- Modify: `src/renderer/state/store.ts:378` (project-file name derivation)
- Modify: `src/renderer/export/gradientProbe.ts:21` (use the shared union)
- Test: `scripts/smoke-formats.mjs` (create)

**Interfaces:**
- Consumes: nothing from Task 1 at the code level.
- Produces:
  - `type OutputFormat = 'webp' | 'gif' | 'mp4' | 'png'` from `src/shared/ipc.ts`
  - `interface FormatSpec { id: OutputFormat; label: string; extension: string; availability: 'always' | 'animated' | 'static'; supportsQuality: boolean; supportsAlpha: boolean; requirement: string | null }`
  - `const FORMATS: readonly FormatSpec[]`
  - `const FALLBACK_FORMAT: OutputFormat` (value `'webp'`)
  - `function formatSpec(id: OutputFormat): FormatSpec`
  - `function isFormatAvailable(id: OutputFormat, isStatic: boolean): boolean`
  - `const EXTENSION_PATTERN: RegExp` (value `/\.(webp|gif|mp4|png)$/i`)
  - `function withExtension(filePath: string, id: OutputFormat): string`

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-formats.mjs`:

```js
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
```

Register it in `package.json`:

```json
"smoke:formats": "node scripts/smoke-formats.mjs",
```

and insert `npm run smoke:formats && ` into the `smoke` chain, right after `smoke:codecs`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run smoke:formats`
Expected: FAIL — `format registry: ...` because `/../shared/formats.ts` does not resolve.

- [ ] **Step 3: Write the registry**

Create `src/shared/formats.ts`:

```ts
import type { OutputFormat } from './ipc';

/**
 * Everything that varies between output formats, in one table
 * (docs/superpowers/specs/2026-09-08-mp4-png-output-formats.md §6, §7).
 *
 * Main's save dialog, the renderer's dropdown, the project-file namer and the
 * encoder all read from here. Before this existed, `webp|gif` was spelled out in
 * five places and adding a format meant finding all five.
 */
export interface FormatSpec {
  id: OutputFormat;
  /** As shown in the dropdown. */
  label: string;
  /** Without the dot. */
  extension: string;
  /**
   * §6. 'animated' needs at least one animated layer; 'static' needs the
   * absence of one. An unavailable format is shown disabled, never hidden.
   */
  availability: 'always' | 'animated' | 'static';
  /** False for lossless formats, whose Quality control is disabled. */
  supportsQuality: boolean;
  /** False for MP4 — H.264 carries no alpha at all (§4). */
  supportsAlpha: boolean;
  /** Why this format is currently unavailable. Null when always available. */
  requirement: string | null;
}

export const FORMATS: readonly FormatSpec[] = [
  {
    id: 'webp',
    label: 'WebP',
    extension: 'webp',
    availability: 'always',
    supportsQuality: true,
    supportsAlpha: true,
    requirement: null,
  },
  {
    id: 'gif',
    label: 'GIF',
    extension: 'gif',
    availability: 'always',
    supportsQuality: true,
    supportsAlpha: true,
    requirement: null,
  },
  {
    id: 'mp4',
    label: 'MP4',
    extension: 'mp4',
    availability: 'animated',
    supportsQuality: true,
    supportsAlpha: false,
    requirement: 'MP4 needs at least one animated layer on the canvas.',
  },
  {
    id: 'png',
    label: 'PNG',
    extension: 'png',
    availability: 'static',
    supportsQuality: false,
    supportsAlpha: true,
    requirement: 'PNG is available only while nothing on the canvas animates.',
  },
];

/**
 * §6: what a stale selection falls back to. WebP is the only sane choice — it is
 * the default, and it is available in both document states.
 */
export const FALLBACK_FORMAT: OutputFormat = 'webp';

export function formatSpec(id: OutputFormat): FormatSpec {
  const spec = FORMATS.find((f) => f.id === id);
  if (!spec) throw new Error(`Unknown output format: ${id}`);
  return spec;
}

export function isFormatAvailable(id: OutputFormat, isStatic: boolean): boolean {
  const { availability } = formatSpec(id);
  if (availability === 'always') return true;
  return availability === 'static' ? isStatic : !isStatic;
}

/** Matches any output extension this app writes. */
export const EXTENSION_PATTERN = new RegExp(
  `\\.(${FORMATS.map((f) => f.extension).join('|')})$`,
  'i',
);

/**
 * Swaps a path's extension for the given format's, appending rather than
 * replacing when there is nothing to replace.
 */
export function withExtension(filePath: string, id: OutputFormat): string {
  const ext = formatSpec(id).extension;
  return EXTENSION_PATTERN.test(filePath)
    ? filePath.replace(EXTENSION_PATTERN, `.${ext}`)
    : `${filePath}.${ext}`;
}
```

- [ ] **Step 4: Widen the two type unions**

In `src/shared/ipc.ts`, replace line 145:

```ts
export type OutputFormat = 'webp' | 'gif' | 'mp4' | 'png';
```

In `src/shared/doc.ts`, replace line 94:

```ts
  format: OutputFormat;              // see shared/formats.ts
```

and add the import at the top of `src/shared/doc.ts` if it is not already importing from `./ipc`:

```ts
import type { OutputFormat } from './ipc';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run smoke:formats`
Expected: all twelve checks `ok`.

- [ ] **Step 6: Point the remaining hardcoded sites at the registry**

`src/main/index.ts` — replace the dialog filter block (lines 138-146):

```ts
  async (_e, defaultPath: string, format: OutputFormat): Promise<string | null> => {
    const spec = formatSpec(format);
    const result = await dialog.showSaveDialog({
      defaultPath,
      filters: [
        { name: `${spec.label} (.${spec.extension})`, extensions: [spec.extension] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
```

Keep whatever surrounds it (the `patchSettings({ lastOutputDir: ... })` call and the return) exactly as it is. Add the import:

```ts
import { formatSpec } from '../shared/formats';
```

`src/renderer/state/store.ts` — replace line 378:

```ts
      state.doc.outputPath.replace(EXTENSION_PATTERN, '') + `.${PROJECT_EXTENSION}`;
```

with the import:

```ts
import { EXTENSION_PATTERN } from '../../shared/formats';
```

`src/renderer/export/gradientProbe.ts` — replace the two literal unions on lines 21-22 with the shared types:

```ts
  format: OutputFormat;
  quality: Quality;
```

and extend its existing type import:

```ts
import type { EncodeRequest, ExportPhase, ExportResult, OutputFormat, Quality } from '../../shared/ipc';
```

- [ ] **Step 7: Typecheck and re-run the suite**

Run: `npm run typecheck`
Expected: clean across all three tsconfigs.

Run: `npm run smoke:formats && npm run smoke:export`
Expected: all pass. WebP and GIF are untouched by this task.

- [ ] **Step 8: Commit**

```bash
git add src/shared/formats.ts src/shared/ipc.ts src/shared/doc.ts src/main/index.ts src/renderer/state/store.ts src/renderer/export/gradientProbe.ts scripts/smoke-formats.mjs package.json
git commit -m "$(cat <<'EOF'
feat: add a format registry and widen OutputFormat for mp4 and png

One table now owns each format's label, extension, availability, and whether it
takes a quality setting or carries alpha. The save dialog, the project-file
namer and the export probe read from it instead of spelling out webp|gif.

No encoding behind mp4 or png yet — that is the next two commits.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fbvQdiYXZqhCqEZSmT55U
EOF
)"
```

---

### Task 3: MP4 encoding

**Files:**
- Modify: `src/main/encoder.ts` (`quality()`, new `mp4Args()`/`mp4Filters()`, `start()`)
- Modify: `scripts/smoke-export.mjs` (whole CASES/verify structure)

**Interfaces:**
- Consumes: `OutputFormat` and `formatSpec` from Task 2; a `libx264`-capable ffmpeg from Task 1.
- Produces: `EncodeRequest` with `format: 'mp4'` writes a playable H.264 MP4 with even dimensions. No new exported symbols — `Encoder`'s public surface (`start`, `writeFrame`, `finish`, `cancel`, `scratchBytes`, `cleanupScratch`) is unchanged.

- [ ] **Step 1: Write the failing test**

Rewrite the case construction and `verify()` in `scripts/smoke-export.mjs`.

Replace everything from `const which = process.argv[2] ?? 'both';` down to the end of the `CASES` definition — that span also contains the `outDir`, `ffprobe` and `num` declarations, which are re-stated below and must not be lost:

```js
const which = process.argv[2] ?? 'all';

const outDir = path.join(root, 'resources', '.download', 'smoke');
fs.mkdirSync(outDir, { recursive: true });

const ffprobe = path.join(root, 'resources', 'bin', 'ffprobe.exe');

// Overridable so the same harness can measure throughput at a realistic canvas
// size, and so the size estimate can be calibrated per quality.
const num = (name, fallback) => Number(process.env[name] ?? fallback);
const W = num('MW_W', 320);
const H = num('MW_H', 180);
const QUALITY = process.env.MW_QUALITY ?? 'high';

/**
 * ffprobe's codec name per format, and the dimensions to expect back.
 *
 * MP4 is the only format whose output may differ from the canvas: H.264 needs
 * even dimensions, and the spec pads rather than crops
 * (docs/superpowers/specs/2026-09-08-mp4-png-output-formats.md §3). The odd case
 * exists to prove the pad, because ffmpeg's default behaviour is to silently
 * crop instead.
 */
const FORMATS = {
  // ffprobe reports the animated WebP decoder as webp_anim, not webp.
  webp: { codec: 'webp_anim', frames: num('MW_FRAMES', 30) },
  gif: { codec: 'gif', frames: num('MW_FRAMES', 30) },
  mp4: { codec: 'h264', frames: num('MW_FRAMES', 30) },
  png: { codec: 'png', frames: 1 },
};

const even = (n) => n + (n % 2);

const formats = which === 'all' ? Object.keys(FORMATS) : which.split(',');

const CASES = [];
for (const format of formats) {
  const spec = FORMATS[format];
  if (!spec) throw new Error(`Unknown format "${format}". Try: ${Object.keys(FORMATS).join(', ')}`);
  CASES.push({
    format,
    codec: spec.codec,
    width: W,
    height: H,
    expectWidth: format === 'mp4' ? even(W) : W,
    expectHeight: format === 'mp4' ? even(H) : H,
    fps: num('MW_FPS', 25),
    frameCount: spec.frames,
    expectFrames: spec.frames,
    quality: QUALITY,
    outputPath: path.join(outDir, `smoke.${format}`),
  });
}

// §3: an odd canvas must gain a pixel, not lose one. Only MP4 constrains this.
if (formats.includes('mp4')) {
  CASES.push({
    format: 'mp4',
    codec: 'h264',
    width: 321,
    height: 181,
    expectWidth: 322,
    expectHeight: 182,
    fps: 25,
    frameCount: 10,
    expectFrames: 10,
    quality: QUALITY,
    outputPath: path.join(outDir, 'smoke-odd.mp4'),
    label: 'mp4 (odd canvas)',
  });
}
```

Change the loop header so the label is used:

```js
  process.stdout.write(`\n=== ${testCase.label ?? testCase.format} ===\n`);
```

And replace the `checks` array inside `verify()`:

```js
  const checks = [
    ['codec', stream.codec_name, testCase.codec],
    ['width', Number(stream.width), testCase.expectWidth],
    ['height', Number(stream.height), testCase.expectHeight],
    ['frames', frames, testCase.expectFrames],
  ];
```

Update the usage comment at the top of the file:

```js
 * Usage: node scripts/smoke-export.mjs [all|webp|gif|mp4|png|webp,mp4]
 *   MW_W / MW_H / MW_FPS / MW_FRAMES / MW_QUALITY override the case defaults.
```

Update `package.json` so the default run covers everything:

```json
"smoke:export": "node scripts/smoke-export.mjs all",
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/smoke-export.mjs mp4`
Expected: FAIL. Both MP4 cases produce a file whose `codec` is `webp_anim`, because `format: 'mp4'` currently falls through to the WebP branch of `Encoder.start()`.

- [ ] **Step 3: Write the MP4 encoder branch**

In `src/main/encoder.ts`, replace the `quality()` helper with a pair — WebP's `-q:v` scale and H.264's CRF/preset are unrelated knobs and must not share a function:

```ts
function webpQuality(request: EncodeRequest): string[] {
  // §12: webp q:v 50/75/90; gif maps quality to dither instead.
  const q = { low: '50', medium: '75', high: '90' }[request.quality];
  return ['-q:v', q];
}

/**
 * H.264 rate control (spec §7). CRF is constant-quality, so file size varies
 * with content rather than being targeted — which is the point.
 *
 * These match the sibling project Video Trim & Crop, deliberately: two apps by
 * the same author that both say "High" should mean the same thing by it.
 */
const H264_QUALITY = {
  high: { crf: '17', preset: 'slow' },
  medium: { crf: '20', preset: 'medium' },
  low: { crf: '23', preset: 'fast' },
} as const;
```

Update the existing WebP arg construction in `start()` to call `webpQuality(this.request)` instead of `quality(this.request)`.

Add the filter builder above the `Encoder` class:

```ts
/**
 * The MP4 filter chain (spec §3 and §4). Two problems, one pass:
 *
 * 1. H.264 with yuv420p needs even dimensions, and `canvasRect` can be odd.
 *    Left alone ffmpeg does not fail — it silently writes 400x300 for a 401x301
 *    input, losing a row and a column. `pad` adds up to one pixel instead, and
 *    computes the target size itself.
 *
 * 2. rgba -> yuv420p *discards* alpha rather than compositing it, so a
 *    transparent region keeps its underlying RGB at full strength and
 *    anti-aliased edges become hard colour halos. Compositing over black first
 *    is what makes transparency degrade the way a viewer expects.
 *
 * The overlay is only built when there is alpha to flatten; an opaque document
 * already has a background drawn by buildScene and would pay for the pass for
 * nothing.
 */
function mp4Filters(request: EncodeRequest): string[] {
  const pad = 'pad=ceil(iw/2)*2:ceil(ih/2)*2:color=black';

  if (!request.transparent) {
    return ['-vf', `${pad},format=yuv420p`];
  }

  const { width, height, fps } = request;
  return [
    '-filter_complex',
    `color=c=black:s=${width}x${height}:r=${fps}[bg];` +
      `[bg][0:v]overlay=shortest=1,${pad},format=yuv420p`,
  ];
}
```

Then, in `start()`, branch before the WebP path. The method should read:

```ts
  async start(): Promise<void> {
    await fsp.mkdir(this.cacheDir, { recursive: true });
    await fsp.mkdir(path.dirname(this.request.outputPath), { recursive: true });

    if (this.request.format === 'gif') {
      await this.assertDiskSpace();
      this.scratchStream = fs.createWriteStream(this.scratchPath);
      await once(this.scratchStream, 'open');
      return;
    }

    const { ffmpeg } = binaries();
    const args = [...inputArgs(this.request, 'pipe:0'), ...this.encoderArgs()];

    const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.proc = proc;
    this.pipe = proc.stdin;
    this.stderr.attach(proc.stderr);
    proc.stdin.on('error', () => {
      // ffmpeg exiting early closes the pipe; the exit code is the real error.
    });
  }

  /** Output-side arguments for the one-pass formats. GIF never reaches here. */
  private encoderArgs(): string[] {
    const request = this.request;

    if (request.format === 'mp4') {
      const { crf, preset } = H264_QUALITY[request.quality];
      return [
        ...mp4Filters(request),
        '-c:v', 'libx264',
        '-preset', preset,
        '-crf', crf,
        '-profile:v', 'high',
        // Puts the moov atom first so the file starts playing before it has
        // been fully read — the difference between a preview that works in a
        // chat client and one that does not.
        '-movflags', '+faststart',
        // §5: MP4 has no loop flag. Looping is the player's business.
        request.outputPath,
      ];
    }

    return [
      '-c:v', 'libwebp_anim',
      '-loop', '0', // §8: infinite
      ...webpPixelFormat(request),
      ...webpQuality(request),
      request.outputPath,
    ];
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/smoke-export.mjs mp4`
Expected: both cases pass. The odd case reports `width: 322` and `height: 182` as `ok` — proof the pad ran and nothing was cropped.

- [ ] **Step 5: Verify transparency flattens to black rather than leaking colour**

The gradient probe draws opaque, so this one is checked by hand:

```sh
node -e "
const fs=require('fs');const W=200,H=100,N=10;
const s=fs.createWriteStream('resources/.download/smoke/alpha.raw');
for(let f=0;f<N;f++){const b=Buffer.alloc(W*H*4);
for(let y=0;y<H;y++)for(let x=0;x<W;x++){const o=(y*W+x)*4;
b[o]=255;b[o+1]=0;b[o+2]=0;b[o+3]= x<W/2?255:0;}
s.write(b);} s.end();"

./resources/bin/ffmpeg.exe -y -v error -f rawvideo -pix_fmt rgba -s 200x100 -r 25 \
  -i resources/.download/smoke/alpha.raw -an \
  -filter_complex "color=c=black:s=200x100:r=25[bg];[bg][0:v]overlay=shortest=1,pad=ceil(iw/2)*2:ceil(ih/2)*2:color=black,format=yuv420p" \
  -c:v libx264 -preset fast -crf 23 -profile:v high -movflags +faststart \
  resources/.download/smoke/alpha.mp4

./resources/bin/ffmpeg.exe -v error -i resources/.download/smoke/alpha.mp4 \
  -vf "crop=4:4:150:50" -frames:v 1 -f rawvideo -pix_fmt rgb24 - \
  | node -e "const c=[];process.stdin.on('data',d=>c.push(d)).on('end',()=>{const b=Buffer.concat(c);console.log('transparent half:',b[0],b[1],b[2]);});"
```

Expected: `transparent half: 0 0 0`. Anything else — particularly `255 0 0` — means the overlay is not running and alpha is being dropped instead of composited.

- [ ] **Step 6: Confirm WebP and GIF did not regress**

Run: `node scripts/smoke-export.mjs webp,gif`
Expected: both pass. `encoderArgs()` refactored the WebP path; this proves it still produces the same thing.

- [ ] **Step 7: Commit**

```bash
git add src/main/encoder.ts scripts/smoke-export.mjs package.json
git commit -m "$(cat <<'EOF'
feat: encode MP4 via libx264 with CRF quality

One pass from the render loop's stdin, like WebP. Quality maps to CRF 17/20/23
with matching presets.

Two things the filter chain has to handle. H.264 needs even dimensions and the
canvas can be odd — left alone ffmpeg silently crops 401x301 to 400x300, so we
pad by up to a pixel instead. And rgba->yuv420p discards alpha rather than
compositing it, which turns anti-aliased edges into hard colour halos, so a
transparent document is composited over black first.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fbvQdiYXZqhCqEZSmT55U
EOF
)"
```

---

### Task 4: PNG encoding

**Files:**
- Modify: `src/main/encoder.ts` (`encoderArgs()`)

**Interfaces:**
- Consumes: `encoderArgs()` from Task 3.
- Produces: `EncodeRequest` with `format: 'png'` writes a single lossless RGBA PNG. No new exported symbols.

- [ ] **Step 1: Run the already-written test to verify it fails**

The PNG case was added to `scripts/smoke-export.mjs` in Task 3.

Run: `node scripts/smoke-export.mjs png`
Expected: FAIL on `codec` — a `.png` path currently reaches the WebP branch, so `libwebp_anim` writes a WebP file under a `.png` name.

- [ ] **Step 2: Write the PNG branch**

In `src/main/encoder.ts`, add a branch to `encoderArgs()` immediately after the MP4 branch and before the WebP fallthrough:

```ts
    if (request.format === 'png') {
      return [
        // Static output only (spec §6), so the renderer sends exactly one frame
        // and `frameCount` is already 1. Stating it anyway means a mismatch
        // ends the encode cleanly instead of writing a numbered sequence.
        '-frames:v', '1',
        // Lossless and alpha-carrying, so there is no quality knob and nothing
        // to flatten. The Quality control is disabled while PNG is selected.
        '-c:v', 'png',
        request.outputPath,
      ];
    }
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `node scripts/smoke-export.mjs png`
Expected: `codec: png`, `frames: 1`, and the dimensions unchanged — PNG has no even-dimension constraint, so nothing is padded.

- [ ] **Step 4: Verify alpha survives**

```sh
./resources/bin/ffprobe.exe -v error -select_streams v:0 \
  -show_entries stream=pix_fmt,width,height -of default=nw=1 \
  resources/.download/smoke/smoke.png
```

Expected: `pix_fmt=rgba`. A `pix_fmt` of `rgb24` means the alpha channel was dropped and a transparent document would export opaque.

- [ ] **Step 5: Run the whole export suite**

Run: `npm run smoke:export`
Expected: all five cases pass — `webp`, `gif`, `mp4`, `mp4 (odd canvas)`, `png`.

- [ ] **Step 6: Commit**

```bash
git add src/main/encoder.ts
git commit -m "$(cat <<'EOF'
feat: encode single-frame PNG for static documents

Lossless, keeps full alpha, no even-dimension constraint. A static document
exported as an animated WebP was only ever a worse PNG.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fbvQdiYXZqhCqEZSmT55U
EOF
)"
```

---

### Task 5: Dropdown availability, tooltip, fallback and quality greying

The UI half. After this task the two new formats are reachable by a user.

**Files:**
- Modify: `src/renderer/ui/BottomBar.tsx` (imports, `setFormat`, the Format and Quality controls)
- Modify: `src/renderer/App.tsx` (a new effect enforcing format validity)
- Modify: `src/renderer/index.css` (a `.field-hint` rule)

**Interfaces:**
- Consumes: `FORMATS`, `FALLBACK_FORMAT`, `formatSpec`, `isFormatAvailable`, `withExtension` from Task 2; `planLoop(doc).isStatic` from `src/renderer/scene/timing.ts`; `IconInfo` from `src/renderer/ui/icons.tsx`.
- Produces: no new exported symbols. `doc.format` is guaranteed to satisfy `isFormatAvailable(doc.format, planLoop(doc).isStatic)` at rest.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-output-ui.mjs`:

```js
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

await harness.stop();
console.log(c.failures === 0 ? '\nAll output-UI smoke tests passed.' : `\n${c.failures} failed.`);
process.exit(c.failures === 0 ? 0 : 1);
```

Register it in `package.json`:

```json
"smoke:output-ui": "node scripts/smoke-output-ui.mjs",
```

and add `npm run smoke:output-ui && ` to the `smoke` chain after `smoke:formats`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run smoke:output-ui`
Expected: FAIL on `mp4 falls back when animation goes` — the format stays `mp4`. Nothing corrects it yet.

- [ ] **Step 3: Enforce format validity in one place**

In `src/renderer/App.tsx`, add the imports:

```ts
import { FALLBACK_FORMAT, formatSpec, isFormatAvailable, withExtension } from '../shared/formats';
```

and add this effect alongside the other startup effects (after the `installShortcuts` effect is a good home):

```tsx
  /**
   * §6: a format the document can no longer produce falls back to WebP.
   *
   * Enforced here, from the document, rather than at each call site — a layer
   * can arrive or leave by a drop, a delete, an undo, or a project load, and
   * only one of those goes through the format dropdown.
   *
   * `mutate`, not `apply`: the app correcting itself is not an edit the user
   * should have to step back through.
   */
  const isStatic = useStore((s) => planLoop(s.doc).isStatic);
  const format = useStore((s) => s.doc.format);
  useEffect(() => {
    if (isFormatAvailable(format, isStatic)) return;

    const from = formatSpec(format).label;
    const to = formatSpec(FALLBACK_FORMAT).label;

    useStore.getState().mutate((draft) => {
      draft.format = FALLBACK_FORMAT;
      draft.outputPath = withExtension(draft.outputPath, FALLBACK_FORMAT);
    });

    toast('info', `${from} is not available for this document — switched to ${to}.`);

    // The new extension may collide with a file that is already there.
    void window.api
      .uniqueOutputPath(useStore.getState().doc.outputPath)
      .then((unique) => {
        useStore.getState().mutate((draft) => {
          draft.outputPath = unique;
        });
      });
  }, [format, isStatic, toast]);
```

Confirm `planLoop` is imported in `App.tsx` — it already is, for `generate()`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run smoke:output-ui`
Expected: all seven checks `ok`.

- [ ] **Step 5: Drive the dropdown from the registry**

In `src/renderer/ui/BottomBar.tsx`, extend the imports:

```ts
import { FORMATS, formatSpec, isFormatAvailable, withExtension } from '../../shared/formats';
import { IconInfo } from './icons';
```

Add a second one-shot warning flag beside the existing one near the top of the file:

```ts
/** §12 asks for this warning once, not once per format change. */
let warnedAboutGifAlpha = false;
/** Spec §4: the same courtesy for MP4, which has no alpha at all. */
let warnedAboutMp4Alpha = false;
```

Replace `setFormat` with:

```ts
  /** Keeps the extension consistent with the chosen format. */
  function setFormat(format: OutputFormat) {
    apply('Format', (draft) => {
      draft.format = format;
      draft.outputPath = withExtension(draft.outputPath, format);
    });

    // The new extension may collide with a file that is already there; §12's
    // rule is that the suggested path is always free.
    void window.api.uniqueOutputPath(useStore.getState().doc.outputPath).then((unique) => {
      useStore.getState().mutate((draft) => {
        draft.outputPath = unique;
      });
    });

    if (!doc.background.transparent) return;

    // §12: warn once that GIF's 1-bit alpha makes soft edges ragged, and once
    // that MP4 has no alpha at all. Only worth saying when there is actually
    // transparency at stake.
    if (format === 'gif' && !warnedAboutGifAlpha) {
      warnedAboutGifAlpha = true;
      useStore.getState().toast(
        'warn',
        'GIF alpha is 1-bit: soft or anti-aliased transparent edges will look ragged.',
      );
    }
    if (format === 'mp4' && !warnedAboutMp4Alpha) {
      warnedAboutMp4Alpha = true;
      useStore.getState().toast(
        'warn',
        'MP4 carries no transparency: the background will be flattened to black.',
      );
    }
  }
```

Add a derived list just below the existing `useMemo` block:

```ts
  // §6: unavailable formats are shown disabled, not hidden — a greyed option
  // with a reason is easier to understand than one that vanishes.
  const unavailable = useMemo(
    () => FORMATS.filter((f) => !isFormatAvailable(f.id, plan.isStatic)),
    [plan.isStatic],
  );
```

Replace the Format `<label>` block:

```tsx
        <label className="field">
          Format
          <select value={doc.format} onChange={(e) => setFormat(e.target.value as OutputFormat)}>
            {FORMATS.map((f) => (
              <option key={f.id} value={f.id} disabled={!isFormatAvailable(f.id, plan.isStatic)}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        {unavailable.length > 0 ? (
          <span
            className="field-hint"
            role="img"
            aria-label={`Some formats are unavailable: ${unavailable.map((f) => f.requirement).join(' ')}`}
            title={unavailable.map((f) => f.requirement).join('\n')}
          >
            <IconInfo />
          </span>
        ) : null}
```

Replace the Quality `<label>` block so it disables itself for lossless formats:

```tsx
        <label className={`field${formatSpec(doc.format).supportsQuality ? '' : ' disabled'}`}>
          Quality
          <select
            value={doc.quality}
            // Spec §7: PNG is lossless, so the control is disabled rather than
            // left to look as though it does something.
            disabled={!formatSpec(doc.format).supportsQuality}
            title={
              formatSpec(doc.format).supportsQuality
                ? undefined
                : `${formatSpec(doc.format).label} is lossless — there is nothing to trade.`
            }
            onChange={(e) => {
              const quality = e.target.value as Quality;
              apply('Quality', (draft) => {
                draft.quality = quality;
              });
            }}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
```

- [ ] **Step 6: Style the hint**

In `src/renderer/index.css`, add beside the existing `.field` rules (near line 122):

```css
.field-hint {
  display: inline-flex;
  align-items: center;
  color: var(--muted);
  cursor: help;
  flex: 0 0 auto;
}
.field-hint svg { width: 14px; height: 14px; }
.field.disabled { opacity: 0.5; }
.field.disabled select { cursor: not-allowed; }
```

- [ ] **Step 7: Typecheck and run the suite**

Run: `npm run typecheck`
Expected: clean.

Run: `npm run smoke:formats && npm run smoke:output-ui && npm run smoke:export`
Expected: all pass.

- [ ] **Step 8: Check it by hand**

Run: `npm run dev`

Confirm, in order:
1. Empty canvas — Format offers WebP, GIF, PNG; **MP4 is greyed**. The info icon beside the dropdown says MP4 needs an animated layer.
2. Select PNG — the Quality dropdown greys out.
3. Drop an animated GIF — the format switches back to **WebP** with a toast, the output path's extension becomes `.webp`, and MP4 becomes selectable while PNG greys out.
4. Select MP4 with **Transparent** ticked — the "no transparency" toast fires once, and not again on a second selection.
5. Generate — the file plays, and its dimensions match the canvas (or are one pixel larger on an odd canvas).

- [ ] **Step 9: Commit**

```bash
git add src/renderer/ui/BottomBar.tsx src/renderer/App.tsx src/renderer/index.css scripts/smoke-output-ui.mjs package.json
git commit -m "$(cat <<'EOF'
feat: offer MP4 and PNG in the format dropdown

MP4 needs an animated layer, PNG needs the absence of one. Unavailable formats
are greyed rather than hidden, with an info affordance beside the dropdown
saying what each one is waiting for.

A selection that goes stale falls back to WebP. Enforced from the document in
one effect rather than at each call site: a layer can arrive or leave by a drop,
a delete, an undo or a project load, and only one of those goes through the
dropdown. It is a mutate, not an apply — the app correcting itself is not an
edit the user should have to undo.

Quality greys out for PNG, which is lossless.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fbvQdiYXZqhCqEZSmT55U
EOF
)"
```

---

### Task 6: The MP4 size estimate

**Files:**
- Modify: `src/renderer/export/exportScene.ts:105-124` (`estimateBytes`)

**Interfaces:**
- Consumes: `doc.format` widened in Task 2; a working MP4 encoder from Task 3.
- Produces: no signature change. `estimateBytes(doc: Doc): number` continues to return a rough byte count.

PNG needs no work here: the bottom bar renders `Static — 1 frame` and no estimate at all for a static document, and PNG only exists for static documents.

- [ ] **Step 1: Measure the encoder**

The existing WebP constants came from measured output. Do the same rather than guessing. Run three encodes at a realistic size and read the bytes:

```sh
MW_W=640 MW_H=360 MW_FRAMES=120 MW_FPS=30 MW_QUALITY=high   node scripts/smoke-export.mjs mp4
MW_W=640 MW_H=360 MW_FRAMES=120 MW_FPS=30 MW_QUALITY=medium node scripts/smoke-export.mjs mp4
MW_W=640 MW_H=360 MW_FRAMES=120 MW_FPS=30 MW_QUALITY=low    node scripts/smoke-export.mjs mp4
```

Each run prints `wrote N KB`. For each, compute:

```
bytesPerPixelFrame = (N * 1024) / (640 * 360 * 120)
```

Keep the three figures to three significant digits. They are the constants for Step 2.

> The gradient probe is synthetic and compresses better than photographic
> content, so these will read low. That matches the existing WebP constants,
> which were measured the same way, and the UI labels the number as rough.

- [ ] **Step 2: Add the MP4 branch**

In `src/renderer/export/exportScene.ts`, replace `estimateBytes` with:

```ts
/**
 * H.264 bytes per pixel per frame at each CRF, measured from this encoder's own
 * output at 640x360x120 (spec §8). Unlike the WebP figures below, inter-frame
 * compression is already baked in — x264 is measured over a whole sequence, not
 * extrapolated from a first frame.
 */
const H264_BYTES_PER_PIXEL_FRAME = {
  low: <low figure from Step 1>,
  medium: <medium figure from Step 1>,
  high: <high figure from Step 1>,
};

/**
 * §12: an estimated output size shown before export starts. Animated WebP grows
 * fast, and a 651-frame loop is not obviously a large file until it is one.
 *
 * Encoding a real sample would be accurate but costs seconds; these figures come
 * from measured output of this encoder at each quality and are labelled as rough
 * in the UI.
 */
export function estimateBytes(doc: Doc): number {
  const plan = planLoop(doc);
  const pixels = doc.canvasRect.width * doc.canvasRect.height;
  const frames = plan.isStatic ? 1 : plan.frameCount;

  if (doc.format === 'mp4') {
    return Math.round(pixels * frames * H264_BYTES_PER_PIXEL_FRAME[doc.quality]);
  }

  // PNG is only offered for static documents, where the bottom bar shows
  // "Static — 1 frame" and no estimate at all. Nothing to compute.

  const perPixel =
    doc.format === 'gif'
      ? 0.45
      : { low: 0.035, medium: 0.06, high: 0.12 }[doc.quality];

  // Inter-frame compression means later frames cost far less than the first.
  return Math.round(pixels * perPixel * (1 + (frames - 1) * 0.55));
}
```

- [ ] **Step 3: Verify the estimate is in the right order of magnitude**

Run: `npm run dev`

Drop an animated source, select MP4, note the `~N MB` figure, press Generate, and compare against the toast's actual `Wrote N MB`.

Expected: within roughly 2× in either direction. The estimate is explicitly rough, but an order-of-magnitude miss means a constant was mistyped or the arithmetic lost the frame count.

- [ ] **Step 4: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/renderer/export/exportScene.ts
git commit -m "$(cat <<'EOF'
feat: estimate MP4 output size

Measured bytes per pixel per frame at each CRF, rather than extrapolated from a
first frame the way the WebP figures are — x264's constants already account for
inter-frame compression.

PNG needs nothing: a static document shows "Static — 1 frame" and no estimate,
and PNG only exists for static documents.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fbvQdiYXZqhCqEZSmT55U
EOF
)"
```

---

### Task 7: Documentation

`CLAUDE.md` is the authoritative spec and currently contradicts everything the previous six tasks built. Leaving it that way makes the next reader trust the wrong document.

**Files:**
- Modify: `CLAUDE.md` §12 (Per-format table and surrounding prose), §15 (Licensing bullet), §17 (Non-goals)
- Modify: `DECISIONS.md` (append two entries)
- Modify: `README.md` (the description, the user features list, and the developer licensing paragraph)

**Interfaces:**
- Consumes: everything. This task runs last.
- Produces: documentation only.

- [ ] **Step 1: Update `CLAUDE.md` §12**

Replace the **Per-format** table and the paragraph directly beneath it:

```markdown
### Per-format

| | WebP | GIF | MP4 | PNG |
|---|---|---|---|---|
| Encoder | `-c:v libwebp_anim -loop 0` | palettegen + paletteuse | `-c:v libx264` | `-c:v png -frames:v 1` |
| Passes | one | three, over a scratch file | one | one |
| Alpha | Full | 1-bit only | **None** — flattened to black | Full |
| Quality low / med / high | `-q:v 50 / 75 / 90` | dither: none / bayer / sierra2_4a | `-crf 23 / 20 / 17` with preset fast / medium / slow | *(lossless — control disabled)* |
| Dimensions | any | any | **even only — padded up by ≤1 px** | any |
| Available when | always | always | at least one animated layer | no animated layers |

**MP4 pads, never crops.** H.264 with `yuv420p` requires even dimensions, and
`canvasRect` can be odd. Left alone ffmpeg does not fail — it silently writes
400x300 for a 401x301 input. `pad=ceil(iw/2)*2:ceil(ih/2)*2:color=black` adds up
to one pixel to the right and bottom instead, and derives the size itself. MP4 is
the only format whose output may differ from `canvasRect`.

**MP4 flattens transparency to black.** `rgba` to `yuv420p` *discards* alpha
rather than compositing it, so a transparent region would keep its underlying RGB
at full strength and anti-aliased edges would become hard colour halos. When
`background.transparent` is set, composite over black first:
`color=c=black:s=WxH:r=fps[bg];[bg][0:v]overlay=shortest=1`. There is no matte
colour picker. Selecting MP4 with transparency on warns once, like GIF's 1-bit
warning.

**MP4 has no loop flag.** Looping is the player's business (`<video loop>`).
`-loop 0` is not passed and no UI mentions it.

**The format list depends on the document.** MP4 needs motion; PNG is for its
absence. Unavailable formats are shown disabled with a stated reason, never
hidden, and a selection that goes stale falls back to WebP — rewriting the
extension, re-uniquing the path and toasting. Enforce that from the document in
one place: a layer can arrive or leave by a drop, a delete, an undo or a project
load, and only one of those goes through the dropdown. It is not an undoable
edit.

Show an estimated output size before export starts. Animated WebP grows fast. A
static document shows `Static — 1 frame` and no estimate, so PNG is never
estimated.
```

- [ ] **Step 2: Update `CLAUDE.md` §15**

Replace the **Licensing** bullet and its three sub-bullets:

```markdown
- **Licensing: use a GPL ffmpeg build.** MP4 output needs a CRF quality control;
  CRF is a per-encoder rate-control mode; the only H.264 encoder that implements
  it is `libx264`, which is GPL. `libopenh264` (BSD, present in LGPL builds) has
  no CRF and no build flag that adds one. See
  `docs/superpowers/specs/2026-09-08-mp4-png-output-formats.md` §2 and
  `DECISIONS.md` D-041.
  - **This project's own source stays MIT.** The app never links FFmpeg. It
    spawns `ffmpeg.exe` as a child process and communicates only through argv,
    pipes and exit codes, which under the FSF's own guidance makes them separate
    works. Two things would break that, so never do either: linking libavcodec
    and friends directly, or shipping a `--enable-nonfree` build.
  - `scripts/fetch-ffmpeg.mjs` enforces this on every fetch: it **requires**
    `--enable-gpl`, `--enable-libx264` and `--enable-libwebp`, **refuses**
    `--enable-nonfree`, and checks that the `libwebp_anim`, `libwebp`, `libx264`,
    `gif` and `png` encoders are all present. Not every build has libwebp.
  - Pin the exact ffmpeg build (BtbN). Record its version, license, and source URL
    in `THIRD-PARTY-NOTICES.md` and ship that file inside the zip — GPL
    redistribution requires corresponding source to be available, and the release
    notes must state that the bundled FFmpeg is GPL v3 and not covered by this
    project's MIT licence.
```

- [ ] **Step 3: Update `CLAUDE.md` §17**

Delete this line from the non-goals list:

```
- MP4 or any other video-codec output (see §15 — this would change the license)
```

and replace it with:

```
- HEVC, AV1, VP9 or WebM output (MP4/H.264 and PNG are supported — see §12)
- A matte colour picker for MP4 (transparency flattens to black, always)
```

- [ ] **Step 4: Append to `DECISIONS.md`**

Add two entries at the end, following the file's existing `D-0xx` numbering — check the last number in use and continue from it. The numbers below assume the last existing entry is D-040:

```markdown
## D-041 — Ship a GPL ffmpeg build so MP4 can have a CRF quality control

**Decided:** 2026-09-08. Supersedes the LGPL-only rule in §15 as originally written.

MP4 output was a §17 non-goal because §15 forbids GPL components. Investigating
what MP4 would actually cost showed the constraint was really about CRF, not
about H.264:

- CRF is a per-encoder rate-control mode, not a container or codec feature.
- `libx264` implements it and is GPL.
- `libopenh264` — already present in the LGPL build, BSD-2-Clause — implements
  none. Its options are `-b:v` with `rc_mode {off, quality, bitrate, buffer,
  timestamp}`; "quality" mode is still bitrate-targeted. No flag adds CRF; the
  encoder does not contain that code.

So a bitrate-only MP4 was available for free, and a CRF one cost the licence
change. Took the licence change: the sibling project Video Trim & Crop already
ships a BtbN GPL build with libx264 at `-crf 17/20/23`, and the two apps saying
the same thing by "High" is worth something.

Media Whiteboard's own source stays MIT. The app spawns `ffmpeg.exe` rather than
linking it, which the FSF treats as separate works. `THIRD-PARTY-NOTICES.md`
carries the corresponding-source offer and the rationale.

Moved to the `win64-gpl` asset of the same BtbN release and the same upstream
commit, so only the licence surface changed. `scripts/fetch-ffmpeg.mjs` now
requires GPL and libx264 rather than refusing them, and still refuses nonfree.

**Rejected:** libopenh264 with bitrate targets. It keeps the LGPL story simple
but gives a worse knob and worse quality per byte, for a format that exists
precisely because people want to hand the file to someone else.

## D-042 — MP4 pads to even dimensions; PNG is the static output

**Decided:** 2026-09-08.

**Padding.** H.264 with `yuv420p` needs even dimensions and `canvasRect` does
not. The failure mode is worse than an error: ffmpeg exits 0 and silently writes
400x300 for a 401x301 input. Chose `pad=ceil(iw/2)*2:ceil(ih/2)*2:color=black`,
which adds at most one pixel to the right and bottom and lets ffmpeg derive the
size. Verified: 401x301 in, 402x302 out. Cropping was the alternative and was
rejected — losing content silently is the thing that made the default dangerous.

**Transparency.** `rgba` to `yuv420p` discards alpha rather than compositing it;
a transparent region emerged with its RGB intact at full strength, which would
have made anti-aliased edges into hard colour halos. Composite over black first.
No matte picker: one more control for a case where black is nearly always right.

**PNG.** A static document exported as a single-frame animated WebP is a worse
PNG — larger, lossy at anything but the top quality, and a surprising file to
receive. PNG is offered exactly when nothing animates, is lossless (so the
Quality control greys out), and needs no even-dimension handling.

**Availability.** Formats that do not apply are greyed with a reason rather than
hidden; a vanished option is harder to reason about than a disabled one. A stale
selection falls back to WebP through a single document-driven effect, because a
layer can arrive or leave four different ways and only one of them is the
dropdown. The correction is a `mutate`, not an `apply` — the app fixing itself
is not an edit to undo.
```

- [ ] **Step 5: Update `README.md`**

Three edits.

The opening description — replace `animated **WebP** or **GIF**` with:

```markdown
canvas and exporting an infinitely-looping animated **WebP**, **GIF** or **MP4** —
or a single **PNG** when nothing moves.
```

In the **What it does** list, add after the Transparency bullet:

```markdown
- **Four output formats.** WebP and GIF always; MP4 (H.264) once something on the
  canvas animates; PNG when nothing does. Formats that don't apply are greyed
  with the reason, and Quality greys out for PNG because it's lossless. MP4 has
  no transparency — the background flattens to black — and may come out one pixel
  larger on an odd-sized canvas, because H.264 needs even dimensions and padding
  beats cropping.
```

In the developer section, replace the paragraph beginning *"That fetch is not a
convenience wrapper around a URL"* with:

```markdown
That fetch is not a convenience wrapper around a URL. It verifies a SHA-256 for
the archive and for each binary, then re-inspects the extracted `ffmpeg` and
refuses it unless it is a **GPL** build carrying `libx264` and `libwebp`, and
refuses any build configured `--enable-nonfree`.

The GPL build is deliberate. MP4 output needs a CRF quality control, CRF is a
per-encoder feature, and `libx264` is the only H.264 encoder that has it —
`libopenh264` (BSD) has no CRF and no way to gain one. This project's own source
stays **MIT**: the app spawns `ffmpeg.exe` as a child process and never links
FFmpeg's libraries, which the FSF treats as separate works. The binaries stay GPL
and carry their obligations, so `THIRD-PARTY-NOTICES.md` and `LICENSE.ffmpeg.txt`
ship inside the zip and release notes must say the bundled FFmpeg is GPL v3.
See `DECISIONS.md` D-041. If you bump the pin in `scripts/ffmpeg-build.json`,
that check has to still pass.
```

- [ ] **Step 6: Verify the docs match the code**

```sh
grep -n "MP4 or any other video-codec output" CLAUDE.md
grep -rn "LGPL" README.md
```

Expected: no output from either. The first is the deleted non-goal; the second is the stale claim in the README's developer section. Any hit means an edit was missed.

Run: `npm run smoke`
Expected: the whole suite passes, `smoke:codecs` first.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md DECISIONS.md README.md
git commit -m "$(cat <<'EOF'
docs: record the GPL swap and the two new output formats

CLAUDE.md §12 gains MP4 and PNG with the padding and matte rules, §15 now
requires the GPL build it used to forbid, and §17 drops MP4 from the non-goals.
D-041 and D-042 record why. README updated to match.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_013fbvQdiYXZqhCqEZSmT55U
EOF
)"
```

---

## Verification checklist

After Task 7, the following should all hold:

- [ ] `npm run smoke` passes end to end, starting with `smoke:codecs`.
- [ ] `npm run typecheck` is clean.
- [ ] `npm run package` produces `release/MediaWhiteboard-1.0.0-win-x64.zip` containing `THIRD-PARTY-NOTICES.md`, `LICENSE`, and a `LICENSE.ffmpeg.txt` whose first lines read `GNU GENERAL PUBLIC LICENSE`.
- [ ] An MP4 exported from an odd-sized canvas is exactly one pixel larger per odd axis, with no content missing at the right or bottom edge.
- [ ] An MP4 exported from a transparent document has a black background, not colour fringing at the edges of objects.
- [ ] A PNG exported from a transparent static document opens with transparency intact.
- [ ] Deleting the last animated layer while MP4 is selected switches to WebP, fixes the extension, and does not add an undo step the user has to pass through.
