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

## D-016 — Interaction proxies rather than a Transformer on scene nodes

**Decision**: an interaction layer holds one invisible proxy rectangle per
object. The Konva `Transformer` attaches to those, never to the nodes
`buildScene` produced.

**Why**: §10 asks for a Konva Transformer, and §3 has `buildScene` rebuild the
content layer every frame. Those two are incompatible as written — a Transformer
needs a stable node to hold on to, and a rebuilt node is a different object each
frame. Proxies satisfy both: the Transformer is real, and content construction
stays in one place. They are chrome, so they affect no output pixels.

A multi-selection attaches the Transformer to a single group box rather than to
each member. That is what makes §10's group-resize rule expressible: one uniform
scale factor comes out, and it is applied to every member by §10's formula,
including the `strokeWidth` and `fontSize`/`boxWidth` scaling. Attaching to each
node would let Konva transform them independently and there would be no single
`s` to reason about.

---

## D-017 — Paint commits still mark the entry as touching paint

**Decision**: committing a brush or eraser stroke uses the ordinary `apply`, so
the history entry is flagged as touching paint.

**Why**: the live stroke has already been drawn into the §6 buffer, so the commit
itself needs no redraw, and an early version suppressed the flag to say so. That
was wrong: the flag is what makes *undo and redo* replay the buffer. Undoing a
stroke removed it from the document while leaving its pixels on screen. The
override that allowed this has been removed rather than left as a footgun.

Caught by exporting after an undo and reading the pixels back, not by checking
the stroke list — the document was correct the whole time.

---

## D-018 — `buildScene` can hide specific objects

**Decision**: `BuildOptions.hiddenIds`, used only by the preview, for the text
object whose in-place editor is currently drawn over it.

**Why**: §10's editor is a DOM textarea positioned over the canvas and styled to
match. Without hiding the Konva node underneath, the glyphs double up. Export
never passes this — §12 blocks the UI while it runs, so nothing can be mid-edit —
so preview and export still agree on every frame that gets encoded.

---

## Open items

Recorded here so they are not silently forgotten:

- ~~**`canvasRect` origin**~~ — applied: `createEmptyDoc` starts it centred on the
  world origin at `(-640, -360, 1280, 720)`, so §4's ±2048 clamp is symmetric.
- ~~**ffmpeg build selection**~~ — resolved in step 2. Pinned in
  `scripts/ffmpeg-build.json`; see D-006 and `THIRD-PARTY-NOTICES.md`.
- ~~**Zero-copy export frames**~~ — resolved in step 2, negatively. See D-010.

---

## D-019 — Import is two-phase, and the drop waits only for frame one

**Decision**: `media:import` resolves as soon as ffprobe has run and one frame is
on disk. The rest decodes in a background child process that reports `frame=N`
over `-progress pipe:1`, and the renderer shows one non-blocking bar per pending
item inside the canvas area.

**Why**: the drop was blocking on a full transcode. CLAUDE.md §7 never asked for
that — it asks for the object to be placed — and the wait scaled with the source,
so a 30 s clip froze the app for as long as it took to decode. Splitting it means
the cost the user pays at drop time is bounded by one frame regardless of length.

The first frame is written to `<cacheDir>/<key>.first.webp`, beside the entry
directory rather than inside it, so the atomic `.partial` → published rename is
untouched and `readMeta` can never mistake a half-finished entry for a complete
one. The frame protocol serves it for index 0 while the directory does not exist.

`meta.complete` and `readyFrames` are on the wire so the renderer can tell an
in-progress import from a cache hit without asking again.

---

## D-020 — Per-frame timings only for GIF and animated WebP

**Decision**: `probe` asks ffprobe for `-show_frames` only for `.gif` and
`.webp`. Video containers get a uniform frame duration from `avg_frame_rate`, and
their duration from the stream, the container format, or the `DURATION` tag.

**Why**: two things, one correctness and one cost.

The bug: §8.0's "a delay under 20 ms is a malformed GIF delay, treat it as 100 ms"
rule was being applied to every source. 59.94 fps video has a perfectly legitimate
16.68 ms frame, so every frame of it was rewritten to 100 ms — a 17 s clip
measured 102 s and §7 rejected it as too long. Matroska compounded it by carrying
no per-stream duration, so the only duration available was the one summed from
those rewritten frames.

The cost: `-show_frames` decodes the entire file. It was the largest single
component of the drop latency, spent to learn something `avg_frame_rate` already
says. §8.1 samples by nearest frame at whole output frames, so per-packet jitter
in a VFR source cannot change which frame is picked — a uniform assumption is not
just cheaper, it is unobservable.

---

## D-021 — The transform gesture keeps its scale on the node

**Decision**: `transform` handlers derive the model from `gestureStart × node
scale` and reset the node's scale once, on `transformend`. They do not reset it or
re-place the node between events.

**Why**: Konva's `Transformer` computes each step from the node's live attributes.
Resetting the scale to 1 and re-placing the node mid-gesture moves the ground
under it, so the next pointer event is measured against geometry that has already
absorbed the change. The visible result was an object that lurched between sizes
and drifted, so a resize read as a move. `scripts/smoke-transform.mjs` drives the
real Transformer with a sequence of synthetic pointer events, which is the only
way to see it — a single event cannot tell the two implementations apart.

A snapped **drag** is the mirror image: there the node has to be written back,
because snapping moves the object away from the pointer and the handles would
otherwise stay behind under the cursor.

---

## D-022 — The preview loop redraws once more after the last missing frame

**Decision**: the rAF loop tracks whether its previous draw was made with frames
still undecoded, and treats that as a reason to draw again.

**Why**: the loop skips a redraw when neither the frame index, the document, nor
an outstanding decode has moved. A bitmap lands *after* the pass that noticed it
was missing, so on the next tick nothing has changed and the loop returns —
leaving the frame that would have shown it undrawn. A dropped image was invisible
until something else happened to bump the revision, which is why it appeared the
moment it was nudged.

`peekOrLast` is the other half: a media node with no bitmap draws nothing at all,
so holding the last frame it drew is strictly better than a hole. Export prefetches
every frame before its synchronous `stage.draw()`, so neither path is reachable
there and output pixels are unchanged.

---

## D-023 — The view is always the fit, enforced in the render loop

**Decision**: no zoom, no pan, no "Fit to window". The rAF loop compares
`canvasRect` and the viewport size against the last values it fitted and refits
when they differ.

**Why**: CLAUDE.md §4 now says the canvas is always fitted. Calling `fitToWindow`
from each site that could invalidate it — width/height entry, trim, undo, redo,
project load, window resize, drop — is a list that is wrong the moment someone
adds a route to it. Deriving it in the one place that already runs every frame
makes "always" structural rather than a convention.

---

## D-024 — Settings live outside the document

**Decision**: `lastOutputDir` and `lastMediaDir` are stored in
`<userData>/settings.json`, read through their own IPC channel, and applied with
`mutate` rather than `apply`.

**Why**: they belong to this installation, not to a document. Putting them in the
`Doc` would carry them into `.mwproj` files (§13) and into the undo stack, where
"undo" would mean reverting a folder the app merely remembered. `mutate` exists
for exactly this class of change — a fact the app discovered rather than an edit
the user made — and is documented as never moving or removing an object, because
the undo stack's Immer patches address objects by array index.

---

## D-025 — Cache frames are PNG, and static sources are not encoded at all

**Decision**: animated sources decode to `%06d.png` at zlib level 1. A static
source whose container Chromium already decodes (png, jpg, jpeg, bmp, webp, gif)
is **copied** into the cache entry unchanged. `meta.frameExt` records which.

**Why**: measured, on this machine.

| Source | lossless WebP | PNG (level 1) | copy |
|---|---|---|---|
| 40 frames @ 1080x2520 | 38.0 s | 0.9 s | — |
| trim.mkv, 1020 frames | ~16 min (extrapolated) | 8.4 s | — |
| 3456x5184 JPEG, one frame | 11.0 s | 1.1 s | ~0 s |

Through the real app, cold cache: a 17 s 1080x2520 clip now appears on the canvas
in 0.7 s and finishes decoding in 10.7 s; an 18 MP JPEG lands in 0.44 s, where it
used to take nine seconds to show anything at all.

libwebp's lossless mode is the slowest encoder in the build, and the cache had no
reason to use it: both formats are lossless, so nothing about output fidelity
changes. The trade is cache size — roughly 1 GB for that 17 s clip against ~250 MB
— which the §7 LRU cap already governs, and which is a cache being a cache.

Level 1 rather than 0: level 0 stores raw, quadrupling the entry for no speed
gain. Level 3 is fractionally smaller and fractionally slower; level 1 is the
knee.

**The copy matters more than the encoder for stills.** For a single frame the
only thing an encode buys is a different container, and `createImageBitmap` was
always going to do the real decoding. The renderer now checks that the first
frame decodes before the object is placed, so bytes this app has not itself
produced cannot become a layer that silently draws nothing.

---

## D-026 — The frame protocol resolves the extension, the URL does not carry it

**Decision**: `frameUrl` stays `mwframe://frame/<key>/<index>`. The handler reads
the entry directory once per key to learn the extension and remembers it,
forgetting it when a fetch misses or the entry is cancelled.

**Why**: the extension is a property of the cache entry, not of the document.
Putting it in the URL would mean putting it on `MediaObject`, which means putting
it in every saved `.mwproj` (§13) — persisting an implementation detail of a
cache that is explicitly disposable. One `readdir` per key, amortised over every
frame of that layer, is cheaper than that.

Only successful resolutions are cached: an entry that is still decoding has no
directory yet and has to be looked at again once it does.

---

## D-027 — Deleting a layer cancels its decode

**Decision**: `media:cancelImport` kills that key's ffmpeg and removes its
`.partial` directory and phase-one frame. The renderer derives when to call it by
subscribing to the store and cancelling any import whose `cacheKey` no longer
appears in the document.

**Why**: a background decode can be tens of seconds of CPU and a gigabyte of
disk. Spending that on a layer the user has already deleted is pure waste, and
the partial output would otherwise sit in the cache until eviction.

Derived rather than hooked into `deleteSelection`, for the same reason the fit is
(D-023): delete, undo, project load and the failed-decode cleanup are all ways an
object disappears, and that list grows.

A cancellation is not a failure. `CancelledError` is thrown past the reporting
path so no §14 toast fires — the user asked for it, and the progress bar it
belonged to is already gone.

---

## D-028 — The preview loop draws synchronously

**Decision**: the shared rAF loop calls `layer.draw()`, not `layer.batchDraw()`.
And `evictTo` never closes the bitmap a layer is currently standing on.

**Why**: a reported freeze — after dropping in a 17 s 1080x2520 clip, resizing
the canvas or moving objects would kill the canvas. Media stopped animating,
dragging appeared to do nothing, and the rest of the app carried on as normal.

The cause was one uncaught exception:

```
InvalidStateError: Failed to execute 'drawImage' … The image source is detached
  at Image._sceneFunc (konva) → Layer._drawChildren
```

That clip is ~11 GB of decoded bitmaps against a 512 MB budget, so only ~49 of
its 1020 frames are resident and the preview misses on nearly every frame,
falling back to `peekOrLast`. Eviction closed the very frame that fallback was
handing out.

The freeze rather than a stutter is `batchDraw`'s doing. It sets
`_waitingForDraw` and schedules the real draw for later; if that draw throws, the
flag is never cleared and the layer never schedules another. One bad frame kills
the canvas permanently.

So both halves are fixed, and a third guard added:

- `evictTo` skips the entry a layer's `lastDrawn` points at, so the fallback can
  never dangle.
- The loop draws synchronously, closing the window between building nodes and
  Konva reading their bitmaps. It is the animation frame already; deferring to
  another one bought nothing but latency.
- `peek`/`peekOrLast` treat a zero-sized bitmap as absent. A closed
  `ImageBitmap` reports 0x0, and the cost of being wrong here is not a wrong
  pixel, it is a dead canvas.

`scripts/smoke-preview.mjs` reproduces it: 480 frames at 2560x1440 (~34 resident
of 480), stressed with canvas resizes and object moves, fingerprinting what the
content layer actually painted. Before the fix, 4 of 6 seconds painted nothing.
Frame size is the trigger, not length — a 1920x1080 clip fits ~64 frames, the
prefetch keeps up, and it never reproduces.

---

## D-029 — A right-click on empty canvas deselects

**Decision**: the `contextmenu` handler clears the selection when nothing is
under the cursor, and `onObject` is `Boolean(hit)` alone.

**Why**: it used to be `Boolean(hit) || selection.length > 0`, which meant that
with anything selected, right-clicking bare canvas produced the *object* menu —
Delete and the z-order moves, aimed at something nowhere near the pointer. Left
click deselects on empty space via the mousedown handler, but a right-click
returns from that handler early, so the contextmenu handler has to do it itself.
