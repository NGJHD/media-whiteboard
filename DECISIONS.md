# DECISIONS.md

Choices made where `CLAUDE.md` was silent, and the reasoning behind them. The spec
stays authoritative; this file records what was filled in around it.

---

## Pinned versions (CLAUDE.md §2)

Exact versions, no `^`, no `~`.

| Package | Version | Note |
|---|---|---|
| `electron` | 44.1.1 | Node 24.19.0, Chromium 152.0.7977.65 |
| `electron-builder` | 26.15.3 | `dir` target only |
| `vite` | 8.2.2 | renderer only |
| `@vitejs/plugin-react` | 6.1.1 | |
| `esbuild` | 0.28.2 | main + preload bundles |
| `typescript` | 5.9.3 | see D-002 |
| `react` / `react-dom` | 19.2.8 | |
| `@types/react` / `@types/react-dom` | 19.2.18 / 19.2.5 | |
| `@types/node` | 24.13.3 | matches Electron 44's Node 24 |
| `konva` | 10.3.2 | |
| `react-konva` | 19.2.5 | peers `konva ^10`, `react ^19.2` |
| `zustand` | 5.0.15 | |
| `immer` | 11.1.18 | |

Build targets are pinned to the runtime rather than guessed: esbuild targets
`node24`, Vite targets `chrome152`. Both come from what Electron 44.1.1 actually
reports, so re-check them on any Electron bump.

---

## D-001 — No electron-vite or vite-plugin-electron

**Decision**: Vite builds the renderer only. `esbuild` bundles main and preload
directly, driven by `scripts/dev.mjs` and `scripts/build.mjs`.

**Why**: `electron-vite@5` peers `vite ^5 || ^6 || ^7` and would have forced Vite
down a major. The alternative plugins carry their own release churn on top of the
Electron and Konva churn §2 already warns about. The orchestration these packages
provide is about 60 lines here, and owning it means an Electron or Vite bump is a
version number rather than a wait for a third party.

---

## D-002 — TypeScript 5.9.3, not 7.x

**Decision**: pin the 5.x line.

**Why**: TypeScript 7 is the native (Go) port and still has feature gaps. This
project leans on the typed preload bridge as its main safety mechanism between
processes; that is the wrong place to absorb a compiler rewrite. Revisit once the
7.x line is the default recommendation.

---

## D-003 — Main and preload are bundled to CJS

**Decision**: both emit `.cjs`. `__dirname` is used, not `import.meta.url`.

**Why**: preload scripts load as CJS under `contextIsolation` without extra flags.
Keeping main on the same module system avoids two module resolutions in one process
tree for no gain — nothing in main needs ESM-only packages.

---

## D-004 — Runtime libraries live in `devDependencies`

**Decision**: `dependencies` is empty. React, Konva, Zustand and Immer are dev
dependencies.

**Why**: Vite bundles all of them into the renderer, so nothing needs to be resolved
from `node_modules` at runtime. With `dependencies` empty, electron-builder ships no
`node_modules` at all — confirmed in the packaged output, which contains only
`app.asar` plus `resources/bin`. This also enforces §2's "no native modules" rule
structurally: a native module cannot work from a bundle, so adding one fails loudly
at build time instead of on a user machine.

---

## D-005 — `userData` is redirected into the app folder

**Decision**: `app.setPath('userData')` and `sessionData` point at
`<appFolder>/data` before `app.whenReady()`. The frame cache is `<appFolder>/cache`.
If `<appFolder>` is not writable, both fall back to `<os.tmpdir()>/media-whiteboard/`
and `AppInfo.usingFallback` records it for the About dialog.

**Why**: §1 forbids writes outside the app folder, and the Electron default for
`userData` is `%APPDATA%\<productName>`. This was verified as a real leak — a first
packaged run created `%APPDATA%\Media Whiteboard` before the redirect was added, and
does not after. §7 already specifies a temp fallback for the cache when the app
folder is read-only (unzipped into Program Files, run from a share); the same rule is
applied to `userData`, since the failure mode is identical.

`sessionData` is set explicitly even though it currently defaults to `userData`, so a
future Electron change to that default cannot silently reintroduce the leak.

---

## D-006 — ffmpeg binaries are fetched, not committed

**Decision**: `resources/bin/` is gitignored except `.gitkeep`. A build script will
download a pinned LGPL build and verify its SHA-256. The packaged app still ships the
binaries via `extraResources` + `asarUnpack`.

**Why**: the two exes are roughly 90 MB each. GitHub hard-blocks files over 100 MB
and warns above 50, and even under the limit they would sit unmergeable in every
clone forever. Fetching is a build-time step only — the end user unzips a folder that
already contains them, exactly as §1 requires.

The `extraResources` path was verified in step 1 with a placeholder file: it lands at
`resources/bin/` in the packaged output as a real file on disk, outside the asar,
which is what §15 requires for `process.resourcesPath` resolution.

---

## D-007 — No application menu

**Decision**: `Menu.setApplicationMenu(null)`. In dev, `F12` toggles DevTools via a
`before-input-event` handler.

**Why**: §9 specifies the entire UI as an in-window top bar. The stock
File/Edit/View/Window menu is not part of that layout, and its accelerators (reload,
zoom) would fight the app shortcuts in §11.

---

## D-008 — Single instance lock

**Decision**: a second launch focuses the existing window and exits.

**Why**: not in the spec, but two instances would share one `<appFolder>/cache`
directory and race on the §7 startup LRU eviction. Cheaper to prevent than to make
the cache multi-process safe.

---

## D-009 — Content Security Policy on the renderer

**Decision**: `default-src 'self'`, no remote origins, `img-src` allows `data:` and
`blob:`.

**Why**: the renderer loads no remote content by design. `blob:` and `data:` are
needed for `ImageBitmap` sources and canvas exports (§7, §12). `style-src` allows
inline styles because the text tool in-place `<textarea>` (§10) is positioned and
styled from live measurements.

---

## Open items

Recorded here so they are not silently forgotten:

- **`canvasRect` origin**: starts centred on the world origin at
  `(-640, -360, 1280, 720)`, so the ±2048 clamp in §4 is symmetric. To be applied
  when the document model lands in a later step.
- **ffmpeg build selection**: BtbN `win64-lgpl` is the candidate. `libwebp` presence
  must be confirmed with `ffmpeg -hide_banner -encoders | findstr webp` before the
  version is pinned (§15). A local GPL ffmpeg 9.0 was checked as a sanity test and
  does have `libwebp_anim` (encoder) and `webp_anim` (demuxer + decoder), so animated
  WebP in and out is achievable on a current build — but that says nothing about what
  the LGPL build ships.
- **Zero-copy export frames**: §3 wants a transfer-list `postMessage`, but
  `contextBridge` structured-clones everything crossing the isolated-world boundary.
  A `MessageChannel` handshake is the intended route; to be prototyped and measured
  in step 2 against a plain clone, with the sandbox settings unchanged either way.
