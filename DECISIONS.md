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
download a pinned **GPL** build and verify its SHA-256. The packaged app still ships
the binaries via `extraResources` + `asarUnpack`. (The pin was LGPL originally; see
D-043 for why it moved to GPL.)

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

---

## D-030 — The preview draws animated layers from reduced-size proxies

**Decision**: the decode writes each animated frame twice — native into the entry
directory, and again scaled so its short side is `PREVIEW_PROXY_SHORT_SIDE`
(**240 px**) into `<entry>/proxy/`. The preview draws the proxies; export reads
the native frames and never sees a proxy. Stills, and sources whose short side is
under twice the target, get none.

**Why**: the preview of a large clip could not keep up. A 17 s 1080x2520 clip is
~11 GB of decoded bitmaps against a 512 MB budget, so only ~49 of its 1020
frames were resident — and because the loop walks them in order, LRU gave close
to a 0% hit rate. Each miss then cost ~15 ms to decode a full-size PNG, nowhere
near enough for 60 fps.

Measured on that clip, cold cache, before and after:

| | before | after |
|---|---|---|
| preview cache hit rate | ~0% | **100%** |
| resident frames | 49 of 1020 | 332, 317 MB |
| time to appear on canvas | 0.72 s | 0.43 s |
| full decode | 10.7 s | 11.0 s |

A proxy frame is ~126 KB on disk against ~1 MB for the native one, and cheap
enough to decode that a miss stops mattering when one happens.

**The size is a knob, and 240 is where it sits.** Measured on the same clip:

| short side | resident | hit rate | frame gap p50 / p95 / p99 |
|---|---|---|---|
| 320 | 457 frames, 437 MB | 100% | 16.8 / 21.6 / 27.9 ms |
| 240 | 438 frames, 235 MB | 100% | 16.7 / 18.8 / 20.3 ms |

Both hold 60 fps at the median, so the gain is entirely in the tail — the worst
frame goes from 28 ms to 21 ms — plus roughly half the memory. The cost is a
softer preview, which at §7's half-canvas drop size is still legible down to
small HUD text. `meta.json` records the size an entry was written at, so moving
the knob re-decodes rather than quietly serving the old one.

**One pass, two outputs.** ffmpeg decodes the source once and scales it twice,
which costs about 19% (8.5 s to 10.2 s on that clip, and 13% more disk) against
roughly doubling it by running a second command. `-progress` still counts source
frames, so the bar is unaffected.

**The scale targets the short side**, whichever it is: a portrait clip's short
side is its width and a landscape clip's is its height, so a fixed `-1:320`
would shrink one of them far past the target.

**Where the line is.** This is the only thing the preview is allowed to
substitute, and it substitutes *resolution only* — same node, same geometry,
same order, so §3's single construction path is intact. `previewProxySize` is in
`shared/doc.ts` and both processes derive from it, so neither has to be told
whether an entry has proxies; and the variant travels in the URL host rather
than in `MediaObject`, so it never reaches a saved project.

**Not for stills.** A still decodes once and is then drawn every frame for free.
There is no churn to spare, and softening it would be a pure loss. Nor for
sources whose short side is under twice the target: below that the second output
and the extra disk cost more than they save.

---

## D-031 — A drop is sized to half the canvas

**Decision**: `importMetaAsObject` fits the object inside half of `canvasRect` in
both dimensions rather than the whole of it. Still never scales up.

**Why**: photo-sized sources are far larger than any sensible canvas, so the old
rule scaled every one of them to fill the canvas exactly — each drop covered
everything already on it. Half leaves the composition visible and is still large
enough to work with; anything genuinely small keeps its native size.

---

## D-032 — The first decoded frame is a layer's fallback straight away

**Decision**: `load` registers a layer's first decoded frame as its
`lastDrawn` fallback, rather than waiting for something to `peek` it.

**Why**: a dropped clip showed an empty rectangle with handles for the whole
background decode — around ten seconds for a 17 s source.

Phase one puts exactly one frame on disk, at index 0. The preview does not ask
for index 0: it asks for whatever index the wall clock has reached, which for a
1020-frame loop is essentially arbitrary. That misses, so `peekOrLast` looks for
a fallback — and the fallback was only ever set by `peek`, which had never
succeeded for that layer. Nothing was drawn until the full decode published.

Registering it in `load` fixes the whole class: any layer with a decoded frame
has something to draw, whatever index is asked for. It costs one map write per
layer.

---

## D-033 — Placeholders are overlay chrome

**Decision**: the "Loading <file>…" box and the "Drop a media file to get
started" line are drawn in `drawOverlay`, not in `buildScene`.

**Why**: §3's rule is that nothing affecting output pixels may live on the
overlay, and the corollary is that everything which must *not* affect them
belongs there. Both of these would otherwise be composited into an export — a
grey rectangle labelled with a filename, burned into someone's WebP.

It also means neither needs a flag threaded through `buildScene`: the overlay
already has the document and the view transform, and asks the bitmap cache
whether a layer has anything to draw.

The loading box appears only when the layer has **no** frame at all. Once phase
one's frame is standing in (D-032) the layer is showing real content, and the
§7 progress bar covers the rest — laying "Loading" over a visible frame would be
worse than saying nothing.

---

## D-034 — `baseName` is defined once

**Decision**: one `baseName` in `shared/doc.ts`.

**Why**: it existed twice, and both copies had lost the backslash out of their
character class in editing — so on the only platform this app targets, neither
split anything. The import progress bar had been labelling every job with a full
absolute path. Two copies of a three-line function is how that happens twice.

---

## D-035 — The proxy size is recorded in cache metadata

**Decision**: `meta.json` stores `proxyShortSide`, and an entry whose value
disagrees with `PREVIEW_PROXY_SHORT_SIDE` is treated as a cache miss.

**Why**: it is a tuning knob, and the first thing anyone does with a knob is turn
it. Without this, changing the constant left every already-decoded source
serving proxies at the old size — so the change appears to do nothing, or worse,
appears to do something on new files only. A knob that quietly keeps serving the
previous value is worse than no knob.

Recomputing the expected size from the same shared rule and comparing is enough;
there is no need to measure the files.

---

## D-036 — Packaging emits the zip itself

**Decision**: `electron-builder.yml` declares both `dir` and `zip` targets, and
`npm run package` no longer passes `--dir`.

**Why**: §15 asks for "a zip of the output folder" as the deliverable, but the
`--dir` flag on the command line overrides the configured targets, so nothing
ever produced one — the zip had to be made by hand, which is exactly the sort of
step that gets forgotten or done differently each time.

`zip` here is an archive of the `dir` output, not an installer, so §15's actual
constraint — no NSIS, no MSI, no auto-updater — is untouched. `artifactName`
drops the space out of the product name so the asset survives being a URL.

---

## D-037 — Corner handles only, and resizing snaps

**Decision**: the Transformer offers four corner anchors and nothing else, for
every kind of object and for group selections. Resizing snaps the dragged corner
to the same targets a move snaps to, implemented in `boundBoxFunc`.

**Why the corners**: an edge handle can only change one dimension, so its whole
purpose is to distort. For media that is distortion against the source's own
aspect ratio, which is almost never intended and easy to do by accident when the
handle sits right next to the one you wanted. Corners with `keepRatio` hold the
ratio by default; `Shift` remains the deliberate route to a stretch (§10).

Text keeps corners too. Its resize only ever uses the horizontal component
(§10), so a corner drag does exactly what the old middle-left/right handles did,
with two fewer things on screen.

**Why `boundBoxFunc`**: the handles have to end up on the snapped rectangle, not
trailing the pointer — the same requirement that made a snapped *drag* write its
position back to the node. `boundBoxFunc` is Konva's supported hook for adjusting
the box mid-gesture, so the box, the handles and the model all come out of one
number. This is not the mistake D-021 describes: that was resetting the node's
scale behind the Transformer's back, whereas this is the seam it provides.

**One axis, not two.** A resize pins the corner opposite the handle, so the thing
to align is the dragged corner rather than a whole box. Under aspect lock only
one axis can be honoured — the other follows from the ratio — so `snapPoint`
reports each axis separately with its distance, and the nearer one wins.

Restricted to rotation 0. The guides are axis-aligned; a rotated box has no edge
that meaningfully lines up with them.

---

## D-038 — Media size is typed against the source ratio

**Decision**: selecting a single media layer shows its source dimensions and
editable width/height, locked to the **source** aspect ratio — not to the
layer's current one.

**Why the source**: if a layer has somehow been stretched, typing a width should
put it back on the ratio rather than preserve the distortion. Locking to the
current ratio would make the field a way to keep a mistake.

Per-object, so a multi-selection of media shows nothing: two layers at different
sizes have no shared answer, and applying one to both is a resize nobody asked
for. This is why `hasOptions` special-cases media on selection count.

---

## D-039 — Shift frees the aspect ratio for shapes only

**Decision**: `shiftBehavior` is set per selection — `'inverted'` for a shape,
`'none'` for media, text and groups. The Transformer's default is `'none'`.

**Why**: a media layer has a source aspect ratio, and stretching against it is
always a mistake rather than a choice. Corner-only handles (D-037) stopped it
happening by accident; this closes the deliberate route too, so there is now no
gesture that distorts media. A shape has no source to be wrong about, so it keeps
§10's escape hatch.

This also makes the group case true. §10 has always said Shift does not enable
free distortion for a group — a non-uniform scale on a rotated object needs a
shear the model cannot represent — but `shiftBehavior` was set once on the shared
Transformer as `'inverted'`, so holding Shift distorted a group anyway. The
comment saying otherwise sat directly above `keepRatio(true)`.

**Rotation is untouched.** Konva applies `rotationSnaps` in a different branch of
`_handleMouseMove` than `shiftBehavior`, so Shift still snaps rotation to 15° for
every kind, media included. Both behaviours are pinned by
`scripts/smoke-transform.mjs`: with Shift the rotation lands on a multiple of 15,
without it on 17.

---

## D-040 — The About dialog carries a self-update button

**Decision**: the info overlay opens with `Made by` and `Repo` rows — the
author and a link to `github.com/NGJHD/media-whiteboard`, sitting in the same
two-column grid as Version and the folder paths rather than in a byline of their
own — and holds a **Check for updates** button
that pulls a newer release off GitHub and replaces the install in place. Built to
`UPDATE_BUTTON.md`, which is the reference for every trap listed below.

`CLAUDE.md` §15 rules out an auto-updater and `electron-builder`'s update
machinery — that wants an NSIS target, a `latest.yml` and code signing, none of
which a plain portable zip has. This is the other shape: ~450 lines, no
dependency, and **nothing automatic**. Nothing checks on launch and nothing nags;
the user presses a button. It does not violate §15's "no auto-updater" because
there is no updater running unless someone asks for one.

**Where the pieces live**

| File | Contents |
|---|---|
| `src/shared/about.ts` | app name, author, `owner/repo`, asset suffix. The only file that changes if this is lifted into another app. |
| `src/shared/version.ts` | `parseVersion` / `compareVersions` / `isNewer` / `sameVersion` / `pickReleaseAsset`. Pure — no Electron, no fs, no fetch. |
| `src/main/updater.ts` | everything with a side effect: fetch, download, unpack, verify, the `.cmd`. |
| `src/renderer/ui/AboutDialog.tsx` | the section's state machine and its one button. |
| `scripts/smoke-update.mjs` | 28 assertions over `version.ts`, wired into `npm run smoke`. |

**What the release has to look like** — the updater is only as good as it: tag
`v<version>` matching `package.json` exactly, exactly one `.zip` asset, and a
published release (`/releases/latest` skips drafts and pre-releases). The
existing `RELEASE_GUIDE.md` loop already produces that.

**No `update:about` channel.** `UPDATE_BUTTON.md` §3 lists five IPC channels;
this has four (`update:check`, `update:install`, `update:cancel`,
`update:openLink`) plus the `update:progress` event. `about.ts` is a shared
module, so the renderer imports the name and the repo URL directly rather than
asking main for constants it already has compiled in.

**`app.getVersion()` is wrong in dev.** There is no `package.json` beside the
loaded main script in a dev run, so Electron answers with *its own* version
(44.1.1) — which compares as newer than every release and makes the check
permanently report "latest". `resolveAppVersion` reads the project's
`package.json` when `!app.isPackaged`, which also fixes the Version row in About,
where 44.1.1 had always been showing.

**The five traps, and what was done about them** (all four packaged-only ones
were confirmed by the §8 test below):

- **`spawn` refuses a `.cmd`** since the CVE-2024-27980 fix. Launched as
  `spawn(ComSpec, ['/c', script])` — `cmd.exe` is a real exe and the script stays
  its own argv entry. Never `shell: true` with an interpolated path.
- **Waiting with `tasklist | find` hangs.** The script waits on the exe's *file
  lock* instead: `2>nul (>>"%EXE%" call )` opens it for append and runs a no-op,
  writing zero bytes and failing only while the file is held. No pipe, so nothing
  to sit on.
- **Unzip with `%SystemRoot%\System32\tar.exe`** (bsdtar, Windows 10 1803+),
  falling back to `Expand-Archive`. The absolute path matters: a `tar` on PATH may
  be Git for Windows' GNU tar, which cannot read zip.
- **`robocopy /E /R:3 /W:2`**, not xcopy. Exit codes 0–7 are success, so the test
  is `if errorlevel 8`. **No `/MIR`** — mirroring would delete the user's own
  `data/` and `cache/` folders beside the exe (D-005).
- **Verify before trusting.** `readAsarVersion` reads `version` straight out of
  `resources/app.asar` (the header is JSON; no library). "Cannot read it" is
  unknown and carries on; "read it and it disagrees" is a hard stop, because that
  is a silent downgrade loop.

**Other details that are load-bearing**: writability is checked *before* the
download, not after 233 MB; the download is cancellable and Cancel disappears
once unpacking starts, because there is nothing left to abort; bytes are shown,
not just a percentage; staging folders and the orphaned `.cmd` carry the
`mw-update-` prefix and anything over a day old is swept on every check; `rd /s
/q` is only ever written for a folder whose name carries that prefix; and
`openExternal` is reachable only through `update:openLink`, which re-checks the
URL against this repo's own prefix in main.

**Tested for real** (`UPDATE_BUTTON.md` §8, the only test that means anything): a
packaged build claiming 0.0.1 was copied to a scratch folder and driven through
About → Check → Update against the live `v0.1.2` release. The progress bar moved
in bytes, the app closed and came back on its own, the exe went from `0.0.1.0` to
`0.1.2.0`, `update.log` read `update applied` **2.3 seconds** after `applying` —
robocopy skipped the ~180 MB of unchanged ffmpeg binaries — and `%TEMP%` was left
holding only the `.cmd`, as expected. The dev-run refusal, the already-latest
reply and the asset picker were exercised separately.

---

## D-041 — A new text object is `pendingText`, not a document object

**Decision**: `placeText` no longer pushes into `doc.objects`. The object lives
in `store.pendingText` while the editor is open, and lands in the document as a
single `Add text` entry only when the editor commits with content. Cancelling
writes nothing at all.

**Why**: placing wrote one undo entry and committing wrote a second, so one text
insertion cost two undo steps — a line drawn before a text needed three presses
to come back. Worse, a text that was placed and clicked away from *also* left a
pair of entries (the add, then a remove labelled `Add text`), so Ctrl+Z appeared
to do nothing: it was faithfully un-removing an empty, invisible, unselectable
object.

The framing that fixes both is that **an in-progress text is not yet an edit**.
Nothing that is not in the document can be half-undone.

Nothing else needs to see the object while it is being edited. §10 already
requires the Konva node, the selection outline and the transform handles to be
hidden — the editor is the only box on screen. So the document is not missing
anything during the edit; it simply does not have an object yet.

**Superseded in part by D-045**: this originally added "and any control that
could touch the object first has to take focus off the textarea, which commits".
The options row now shows the pending text's own properties and edits it in
place, without committing. The conclusion stands — a pending object is still not
a document object — but that argument for it does not.

`setEditingText` drops the pending slot whenever the id stops matching, so an
uncommitted object cannot outlive its editor by any route — commit, `Esc`, or the
global `Escape` shortcut in `keyboard.ts` that closes the editor without going
through `commit` at all.

**Emptying an existing text** is still one entry, now labelled `Delete text`
rather than `Add text`, which is what it does.

## D-042 — The click places the text box's left edge

**Decision**: `placeText` sets `x = click.x + boxWidth / 2`, so the box's left
edge lands on the pointer rather than its centre.

**Why**: `BaseObject.x` is a centre (§5), and writing the click straight into it
put the caret half a box — 160 px — to the left of where the user clicked. Every
other program places a caret where the pointer is and runs the text to the right
of it. The vertical is unchanged: `y` is still the click, so the first line sits
centred on it.

## D-043 — Ship a GPL ffmpeg build so MP4 can have a CRF quality control

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

**On the duplicated encoder assertions.** `scripts/fetch-ffmpeg.mjs` and
`scripts/smoke-codecs.mjs` each independently check the installed binary for
GPL/libx264/libwebp and the absence of nonfree flags, rather than the smoke
test importing the fetch script's helper. This duplication is deliberate: the
smoke test's entire value is that it asserts facts about the *installed*
binary independently of the logic that fetched it. If it called into
`fetch-ffmpeg.mjs`'s own assertion helper, a bug in that helper would pass
both the fetch and the smoke test, and the corresponding-source guarantee this
decision rests on could silently go stale. The accepted risk is that the two
checks drift apart over time; that risk is bounded because divergence surfaces
as a `smoke:codecs` failure, which is exactly the signal this exists to catch,
not a silent gap.

## D-044 — MP4 pads to even dimensions; PNG is the static output

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

## D-045 — The options row follows the text being edited; underline and alignment

**Decided:** 2026-09-16.

**The row.** §9's three states are read from the tool and the selection, and
placing a text switches to Select with nothing selected (§10, D-041) — so the
options row emptied at the exact moment the user started typing, and the font,
size and colour of the text being written were the one thing on screen that
could not be changed. A text open in the in-place editor now takes precedence
over all three states and shows its own properties.

**Which is why D-041's last argument no longer holds.** It reasoned that nothing
needs to see a pending object because "any control that could touch the object
first has to take focus off the textarea, which commits". That was a statement
about the blur handler, not about the object model, and it is what the bug was
made of. Two changes retire it:

- **Blur is not "click away".** Focus moving into the options row keeps the
  editor open; it is the user restyling this text, not finishing it.
- **The press that finishes a text is caught directly**, as a `pointerdown`
  anywhere outside both the editor and the options row, in the capture phase.
  Once focus has gone to a colour swatch the textarea will not blur again, so
  blur alone would have left the editor open forever. Capture phase and
  `pointerdown` so it runs before the canvas turns the same press into a
  selection; `done` guards the pair from committing twice.
- The toggle buttons (B, I, U, the three alignments) `preventDefault` on
  mousedown and so never take focus at all, which is why pressing one does not
  interrupt typing.

**Where an edit lands.** A pending text is not in the document (D-041), so
restyling it cannot be an undo entry — the whole insertion stays one `Add text`.
An existing text being re-edited is an ordinary document object and gets one
entry per control, like any other selection. The patch sink reads `pendingText`
back out of the store rather than patching the copy its render closed over: two
presses land inside one render often enough — underline, then centre — and the
second carried the object as it was before the first, silently undoing it.

**Underline and alignment.** `TextObject` gains `underline: boolean` and
`align: 'left' | 'center' | 'right'`. Underline is kept out of `fontStyle`
because both draw sites already separate them — Konva takes weight and slant as
`fontStyle` and underline as `textDecoration`, and a DOM textarea does the same
— so folding them together would only mean splitting them again twice. Alignment
positions each wrapped line inside `boxWidth`; the box itself does not move, so
none of §10's reflow geometry changes.

Text objects written before this have neither field. They are filled in on
project load, next to the missing-font fallback, rather than defaulted at each
draw site, so everything downstream can rely on the type. No `schemaVersion`
bump: an old file still loads, and a new one read by an old build would ignore
two unknown keys.

**One `TextControls`.** The Text tool's defaults, a text selection and the text
being edited differ only in where a change lands, so they share one component
and hand it a patch sink. Three copies of eight controls would have drifted the
moment one of them grew a ninth.

**The row is wider now**, and at the 1280 px minimum the last controls sit past
the right edge. That is the one thing §9 allows to scroll, and it already did
before these four buttons: everything to its left is fixed-width and still does
not move.
