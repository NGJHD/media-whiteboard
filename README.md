# Media Whiteboard

A portable Windows desktop app for compositing animated and static media onto a
canvas and exporting an infinitely-looping animated **WebP**, **GIF** or **MP4** —
or a single **PNG** when nothing moves.

Drop in clips, GIFs and images, arrange them, annotate on top, and generate a
single seamless loop — no timeline, no install, no dependencies.

---

## For users

### Getting started

1. Download `MediaWhiteboard-<version>-win-x64.zip` from the
   [Releases page](https://github.com/NGJHD/media-whiteboard/releases).
2. Unzip it anywhere you can write to — your Desktop, a USB stick, a project folder.
3. Double-click **`MediaWhiteboard.exe`**.

That's it. No installer, no admin rights, nothing written to the registry or to
`%APPDATA%`. The app keeps its frame cache and settings in `cache/` and `data/`
beside the exe, so deleting the folder removes every trace of it. (If the folder
isn't writable — say you unzipped into `Program Files` — it falls back to your
temp directory and says so in **About**.)

Requires Windows 11 x64.

### Making a loop

1. **Drag media onto the canvas** — `.gif`, `.webp`, `.png`, `.jpg`, `.bmp`,
   `.mp4`, `.mov`, `.webm`, `.mkv`, `.avi`. Sources up to 30 seconds.
   Each drop lands centred on your cursor, scaled to fit and ready to move.
2. **Arrange it.** Drag, rotate, resize from the corners; objects snap to each
   other and to the canvas edges. Right-click for z-order.
3. **Annotate** with the brush, eraser, text and shape tools.
4. **Set the canvas** size, or hit **Trim to fit** to snap it to your content.
5. **Pick an output path, format and quality**, then press **Generate**.

The canvas animates live the whole time, so what you see is what gets exported.

### What it does

- **Seamless looping.** Every layer's own frame rate is preserved and the loop
  length is the least common multiple of them, so nothing gets cut mid-cycle.
- **Automatic frame rate.** `Auto` picks the lowest rate that still shows the
  fastest layer at full speed, rather than inflating the file. Override it any
  time from the dropdown.
- **Transparency.** Turn the background off for a transparent WebP. (GIF alpha is
  1-bit, so soft edges go ragged — the app warns you.)
- **Four output formats.** WebP and GIF always; MP4 (H.264) once something on the
  canvas animates; PNG when nothing does. A format that doesn't apply is greyed
  and says why in the list itself — `MP4 — needs animation` — rather than making
  you hover. Quality greys out for PNG, because it's lossless. MP4 has
  no transparency — the background flattens to black — and may come out one pixel
  larger on an odd-sized canvas, because H.264 needs even dimensions and padding
  beats cropping.
- **Annotation tools.** Brush and eraser paint onto a raster layer above
  everything; rectangles, ellipses and multi-line text are editable objects with
  fonts, outlines and shadows. Double-click text to re-edit it in place.
- **Undo everything.** Transforms, paint strokes, canvas resizes, background
  changes — 100 levels deep.
- **Projects.** `Ctrl+S` / `Ctrl+O` save and reload the whole document as
  `.mwproj`.
- **Nothing blocks.** Imports decode in the background with their own progress
  bars; you can keep working while they finish.

### Shortcuts

| Key | Action |
|---|---|
| `V` `B` `E` `T` `R` `O` | Select · Brush · Eraser · Text · Rectangle · Ellipse |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / Redo |
| `Ctrl+A` | Select all |
| `Ctrl+C` / `Ctrl+V` | Copy / paste (an image on the clipboard pastes as a new layer) |
| `Ctrl+S` / `Ctrl+O` | Save / open project |
| `Delete` | Delete selection |
| Arrows / `Shift`+Arrows | Nudge 1 px / 10 px |
| `Shift` while resizing | Free the aspect ratio (shapes only) · snap rotation to 15° |
| `Ctrl` while dragging | Suspend snapping |
| `Alt`+click | Cycle through overlapping objects |
| `Esc` | Deselect, or cancel a text edit |

There is no zoom or pan: the canvas is always fitted to the window.

### Updating

Open **About** (the info button, top right) and press **Check for updates**. It
pulls the latest release and replaces the install folder in place. Nothing checks
on launch and nothing nags. That dialog also shows your cache size with a **Clear
cache** button, and the licence notices.

---

## For developers

### Setup

```sh
git clone https://github.com/NGJHD/media-whiteboard.git
cd media-whiteboard
npm install
npm run fetch:ffmpeg   # required once — see below
npm run dev
```

Node 20+ and Windows x64. `npm run dev` starts Vite, builds main and preload with
esbuild, and launches Electron with hot reload on both sides.

### The one thing that will trip you up

**`resources/bin/` is empty in a fresh clone.** `ffmpeg.exe` and `ffprobe.exe` are
~90 MB each and are not committed; `npm run fetch:ffmpeg` downloads the pinned
build. Without it, import and export both fail immediately.

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
See `DECISIONS.md` D-043. If you bump the pin in `scripts/ffmpeg-build.json`,
that check has to still pass.

### Scripts

| | |
|---|---|
| `npm run dev` | Dev server + Electron, hot reload |
| `npm run build` | Compile main, preload and renderer into `dist/` |
| `npm run typecheck` | `tsc --noEmit` across all three tsconfigs |
| `npm run smoke` | Headless end-to-end checks (codecs, formats, output-ui, updater, export, import, scene, select, timing, tools, transform, preview) |
| `npm run package` | `prepackage` fetches ffmpeg and builds, then electron-builder writes `release/` |

`npm run package` produces both a portable folder and the zip that the in-app
updater consumes.

### Things worth knowing before you edit

- **`CLAUDE.md` is the authoritative spec**, section by section. Most code
  comments cite it (`§7`, `§12`). If behaviour and spec disagree, one of them is
  wrong. `DECISIONS.md` records every choice the spec left open, numbered
  `D-0xx`.
- **`buildScene(doc, frameIndex)` is the only place scene content is
  constructed.** Preview and export differ only in stage geometry — size, scale,
  offset — so pixel equivalence is structural rather than maintained by
  discipline. Anything that affects output pixels must go through it; preview-only
  chrome (transformer, guides, placeholders) lives on a separate overlay layer.
- **One world coordinate space.** `canvasRect` is a rectangle *in* that space, not
  an origin, which is why nothing shifts when the canvas resizes. The view
  transform is always the fit of `canvasRect` into the viewport — there is no zoom
  or pan state to manage.
- **Process split.** Main owns ffmpeg, the disk cache, dialogs and file I/O; the
  renderer owns all UI, canvas and compositing. Everything crosses a typed preload
  bridge (`contextIsolation: true`, `nodeIntegration: false`). Export frames move
  by `MessagePort` transfer, not `ipcRenderer.invoke` — an 8 MB structured clone
  per frame is not viable.
- **No native Node modules, ever.** They break portable packaging. Raster work
  happens in Chromium's canvas, codec work in ffmpeg.
- **Exact version pins in `package.json`.** No `^`, no `~`. Konva and Electron
  both churn across majors.
- **Paint is raster, not objects.** Strokes are replayed as commands for undo;
  pixels are never snapshotted. The buffer is a fixed 4096 × 4096 independent of
  `canvasRect`, so resizing never resamples it.
- **Previews draw reduced-resolution proxy frames; export never does.** That is
  the only substitution the preview is allowed to make, and it is resolution only.

### Releases

The in-app updater is only as good as the release it finds. A release must have a
tag of `v<version>` matching `package.json` exactly, exactly one `.zip` asset
named to match `artifactName` in `electron-builder.yml`, and be published rather
than a draft. The app compares the downloaded build's own version against the tag
before applying it, so a mislabelled release fails the update rather than silently
downgrading.

### Licence

MIT — see [`LICENSE`](LICENSE). Bundled ffmpeg is **GPL v3**; the app's own
source is unaffected because it spawns `ffmpeg.exe` as a child process rather
than linking it. See [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) and
[`LICENSE.ffmpeg.txt`](LICENSE.ffmpeg.txt), both of which ship inside the zip.
