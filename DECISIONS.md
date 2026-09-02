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

## D-010 — Frames are structured-cloned, not transferred

**Decision**: the export frame channel posts `{ type, index, buffer }` over a
MessagePort **without** a transfer list.

**Why**: §3 asks for `postMessage` with a transfer list, and that is not possible
in Electron. Its MessagePort transfer list accepts only MessagePorts; putting an
`ArrayBuffer` in it makes the entire message deserialize to `null` on the main
side. Verified twice: wrapped in an object, and as a bare `ArrayBuffer` — both
arrive as `null`, so main throws reading `.type` (or silently never acks).

What §3 was actually protecting against — `ipcRenderer.invoke` serialising several
MB per frame through the IPC router — is still avoided. The port is a direct
channel to main, and a cross-process copy is unavoidable regardless, since the
pixels must physically reach another process. The only cost of not transferring
is that the renderer's buffer is not detached.

Measured on this machine at 1280×720:

| Format | Frames | Total | Per frame |
|---|---|---|---|
| WebP | 120 | 8.1 s | 67 ms |
| GIF | 120 | 15.4 s | 128 ms (includes both palette passes over a 442 MB scratch file) |

That is 442 MB of raw pixels moved per run. The transport is not the bottleneck;
libwebp encoding and the mandated per-frame event-loop yield dominate. Revisit
only if a future Electron supports ArrayBuffer transfer.

---

## D-011 — Backpressure is a per-frame ack

**Decision**: main acknowledges each frame, and the render loop awaits the ack
before rendering the next.

**Why**: §3 requires honouring ffmpeg's stdin backpressure, but `stdin.write()`
returns its `false` in the main process while the render loop lives in the
renderer. The ack carries that signal across the boundary: main only acks after
the pipe has accepted the write, awaiting `'drain'` first when it has not. A slow
encoder therefore throttles rendering instead of letting frames queue in memory.

An error reply also rejects every in-flight frame promise. Without that, an
encoder that dies mid-export leaves the render loop awaiting an ack that will
never arrive, and the export hangs instead of reporting the failure — which is
exactly how the first ffmpeg-path bug presented.

---

## D-012 — Export has a scriptable smoke test

**Decision**: `npm run smoke:export [webp|gif|both]` runs a real export through the
real transport and verifies the output with ffprobe. Results come back through a
file, not stdout.

**Why**: the export pipe is the highest-risk part of this project (§16 step 2) and
clicking a button is not a repeatable check. The test asserts codec, dimensions
and frame count, because ffmpeg exiting 0 does not prove the file animates — and
separately the loop flag was verified by reading the GIF `NETSCAPE2.0` extension
and the WebP `ANIM` chunk, both `loop_count = 0`.

The result goes to a file because an Electron GUI process on Windows does not
reliably attach to a parent console: a piped `console.log` from main is silently
lost, and every failure looks identical to a hang. That cost real debugging time
before the file channel was added.

`MW_W`/`MW_H`/`MW_FRAMES`/`MW_FPS` override the defaults, so the same harness
measures throughput at a realistic canvas size.

---

## D-013 — Cache frames are served over a custom scheme

**Decision**: a privileged `mwframe://` scheme serves decoded frames from the
cache directory. The renderer fetches `mwframe://frame/<cacheKey>/<index>` and
hands the blob to `createImageBitmap`.

**Why**: the alternative is reading each frame in main and posting the bytes,
which copies every frame through IPC purely to hand it to the decoder. This way
Chromium loads the file and the renderer decodes it directly.

Two things this needed that were not obvious:

- **`corsEnabled: true`, plus an `Access-Control-Allow-Origin` header on the
  response.** The page origin is `http://localhost` in dev and `file://` when
  packaged, so every frame request is cross-origin. Without this Chromium
  refuses them all and nothing ever draws — and it fails *silently* as far as the
  document is concerned, since a missing bitmap simply renders nothing.
- **Path validation in the handler.** The renderer is not trusted to stay inside
  the cache directory, so a key that is not exactly 16 hex characters, or a
  non-integer index, is rejected. Otherwise a key of `../..` reads anything on
  disk.

---

## D-014 — The preview requests frames; `buildScene` only peeks

**Decision**: `buildScene` reads the bitmap cache synchronously and draws nothing
for a frame that is not decoded. The preview loop is what notices the gap,
requests the decode, and keeps redrawing while any frame is outstanding. It also
decodes ~12 output frames ahead. Export instead prefetches every frame it needs
*before* drawing.

**Why**: §3 requires `buildScene` to be usable from the synchronous export path,
where `stage.draw()` cannot await anything. So it cannot load. Something has to,
and the two callers have genuinely different needs: the preview should show what
it has and improve, while export must never emit a frame with a missing layer.

This was caught by looking at the running app, not by the tests: a static image
appeared correctly while an animated layer stayed invisible, because only its
first frame had been decoded and the preview was cycling through nineteen it had
never asked for.

---

## D-015 — Cache metadata is versioned

**Decision**: `meta.json` carries `metaVersion`, and an entry whose version does
not match is treated as a cache miss and re-decoded.

**Why**: §7's cache key covers the *source file* (path, mtime, size), not the
decoder. When the frame-duration calculation changed, every existing entry kept
serving metadata computed the old way, and the fix appeared not to work. The key
cannot cover the decoder without churning the cache on every unrelated change, so
the version field is the narrower fix.

---

## Open items

Recorded here so they are not silently forgotten:

- **`canvasRect` origin**: starts centred on the world origin at
  `(-640, -360, 1280, 720)`, so the ±2048 clamp in §4 is symmetric. To be applied
  when the document model lands in a later step.
- ~~**ffmpeg build selection**~~ — resolved in step 2. Pinned in
  `scripts/ffmpeg-build.json`; see D-006 and `THIRD-PARTY-NOTICES.md`.
- ~~**Zero-copy export frames**~~ — resolved in step 2, negatively. See D-010.
