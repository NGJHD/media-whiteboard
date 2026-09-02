# CLAUDE.md — Media Whiteboard

Build a portable Windows 11 desktop application for compositing animated and static
media onto a canvas and exporting an infinitely-looping animated WebP (or GIF).

This file is the authoritative spec. Where it is silent, choose the simplest option
that does not contradict anything written here, and record the choice in
`DECISIONS.md`.

---

## 1. Hard constraints

- Windows 11, x64.
- **Portable**: user unzips a folder and double-clicks the exe. No installer, no
  admin rights, no runtime prerequisites, no registry writes, no writes outside the
  app folder (except an explicit fallback, see §7).
- Bundled binaries live inside the app folder and are invoked by absolute path.
- Never require the user to install ffmpeg, Node, Python, or a Visual C++ runtime.

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Shell | Electron |
| UI | React + TypeScript |
| Canvas | Konva + react-konva |
| State | Zustand + Immer |
| Build | Vite + electron-builder (`--dir` target, zipped) |
| Media | Bundled `ffmpeg.exe` + `ffprobe.exe` |

Rules:

- **Pin exact versions** in `package.json` (no `^`, no `~`) and list them at the top
  of `DECISIONS.md`. Konva and Electron both have API churn across majors.
- No native Node modules (`sharp`, `canvas`, `node-gyp` deps). They break portable
  packaging. All raster work happens in Chromium's canvas; all codec work happens in
  ffmpeg.
- `contextIsolation: true`, `nodeIntegration: false`. All main-process capability is
  exposed through a typed preload bridge.

---

## 3. Process architecture

**Main process** owns: window lifecycle, file dialogs, all ffmpeg spawning, the
disk frame cache, project file read/write, output file writing.

**Renderer** owns: all UI, all canvas rendering, all compositing.

**Export** runs in the same renderer, not a separate window. §12 blocks the UI during
export anyway, so a hidden `BrowserWindow` would only force the whole document to be
serialised across a process boundary and the scene rebuilt on the other side.

### The shared unit is the scene builder, not a pixel function

Konva owns its own rendering — you do not hand it a 2D context. So what preview and
export share is one level up:

```ts
// Pure. No UI chrome, no view transform, no side effects.
function buildScene(doc: Doc, frameIndex: number): Konva.Group
```

It returns a content group in **world coordinates** containing, in order: background,
every `SceneObject`, then the paint layer as a `Konva.Image`.

| | Preview | Export |
|---|---|---|
| Stage size | viewport | `canvasRect` size |
| Stage scale | `viewScale` | **1** (`Konva.pixelRatio = 1`) |
| Content offset | `viewOffset` | `-canvasRect.x, -canvasRect.y` |
| Overlay layer | transformer, snap guides, checkerboard, out-of-canvas grey | none |
| Draw call | `layer.batchDraw()` | `stage.draw()` (synchronous) |
| Container | the visible DOM node | a detached `<div>` |

Both paths call `buildScene`, so the same Konva version renders the same node tree.
Pixel equivalence is structural, not something to be maintained by discipline.

> **Non-negotiable:** `buildScene` is the only place scene content is constructed.
> Nothing that affects output pixels may live in the preview-only overlay layer, and
> nothing may be drawn directly to a canvas outside it. Two construction paths will
> diverge and the export will not match what the user saw.

### Export loop mechanics

- Ensure `await document.fonts.ready` before the first frame, or text metrics differ.
- Media nodes are updated per frame by swapping in the correct `ImageBitmap` from the
  cache (§7). Bitmaps must already be decoded — `stage.draw()` is synchronous and will
  silently render a blank node otherwise.
- Read pixels from the stage's layer canvas, transfer the `ArrayBuffer` to main via
  `postMessage` with a transfer list (zero-copy — do **not** send it through
  `ipcRenderer.invoke`, which structured-clones ~8 MB per frame).
- **Respect ffmpeg stdin backpressure.** If `stdin.write()` returns false, await
  `'drain'` before rendering the next frame. Without this, memory balloons on long
  exports.
- **Yield to the event loop between frames** (`await new Promise(r => setTimeout(r, 0))`).
  Otherwise the progress bar never repaints and Cancel is unresponsive.

---

## 4. Coordinate model

Everything lives in a single **world coordinate space** in pixels.

- `canvasRect: { x, y, width, height }` is a rectangle *in world space*. It is the
  region that gets exported.
- Objects and paint have world coordinates and never move when `canvasRect` changes.
- Changing the width/height textboxes resizes `canvasRect` (anchored at its top-left).
- **Trim to fit** sets `canvasRect` to the exact union bounding box of all visible
  content (media, shapes, text, and the painted dirty rect). No padding is added. It
  may expand as well as shrink. It is one undoable action and writes the new
  dimensions back into the width/height textboxes.

This is why nothing shifts on resize: the objects don't move, the window moves.

**View transform**: `viewScale` and `viewOffset` map world → screen. On load and on
"Fit to window", `viewScale` auto-fits `canvasRect` into the viewport.

**Limits**: `canvasRect` width and height are each capped at **2560 px**. Reject
values above that with an inline message; do not silently clamp.

**World bounds**: the usable world is the paint buffer's extent (§6), i.e.
`-2048..2048` on both axes. `canvasRect` and every object's bounding box are **hard
clamped** to it:

- Dragging or resizing an object stops at the boundary rather than crossing it.
- A width/height entry or a `canvasRect` move that would push an edge outside is
  rejected with the same inline message as the 2560 cap.
- **Trim to fit** cannot produce an out-of-bounds rect, because it is the union of
  content that is itself already in bounds.

Without this, paint would silently stop existing past the buffer edge.

---

## 5. Data model

```ts
type LayerId = string;

interface Doc {
  canvasRect: Rect;                 // world space
  background: { transparent: boolean; color: string };  // color used when !transparent
  outputFps: number | 'auto';       // 10 | 12 | 15 | 24 | 25 | 30 | 50 | 60 | 'auto'
                                    // default 'auto' (see §8)
  quality: 'low' | 'medium' | 'high';
  format: 'webp' | 'gif';
  outputPath: string;
  objects: SceneObject[];           // array order == z-order, index 0 = back
  paint: PaintLayer;                // always rendered above media, below nothing else
}

type SceneObject = MediaObject | ShapeObject | TextObject;

interface BaseObject {
  id: LayerId;
  x: number; y: number;             // world, center of the object
  width: number; height: number;    // world, pre-rotation
  rotation: number;                 // degrees
  opacity: number;                  // 0..1
  locked?: boolean;
}

interface MediaObject extends BaseObject {
  kind: 'media';
  sourcePath: string;
  cacheKey: string;                 // see §7
  frameCount: number;               // 1 for static
  frameDurationsMs: number[];       // native timing; length == frameCount
  nativeWidth: number; nativeHeight: number;
}

interface ShapeObject extends BaseObject {
  kind: 'shape';
  shape: 'rect' | 'ellipse';
  stroke: string; strokeWidth: number;
  fill: string | null;              // null == no fill
}

interface TextObject extends BaseObject {
  kind: 'text';
  text: string;                     // may contain newlines
  fontFamily: string; fontSize: number; fontStyle: string;
  color: string;
  outline: { color: string; width: number } | null;
  shadow: { color: string; blur: number; offsetX: number; offsetY: number } | null;
  boxWidth: number;                 // text reflows within this; height auto-computed
}
```

**Z-order** is the `objects` array order. Exposed only via the right-click menu:
Bring to Front / Bring Forward / Send Backward / Send to Back. There is no layer panel.

---

## 6. Paint layer

Brush and eraser strokes are **raster, not objects**. They are not selectable and
cannot be individually moved or deleted.

- One offscreen canvas, **fixed at 4096 × 4096 world pixels**, independent of
  `canvasRect`. World origin maps to its center. Objects and `canvasRect` may not be
  placed outside this buffer.
- Rendered **above all media, shapes, and text**.
- Brush strokes draw normally. Eraser strokes draw with
  `globalCompositeOperation = 'destination-out'` **on this buffer only**. The eraser
  never affects media, shapes, text, or background.
- Maintain a running **dirty rect** (union of every stroke's bounding box, inflated by
  stroke width). Trim-to-fit uses it. Do not scan the buffer for content.

**Undo**: store every stroke as a command
`{ tool, points[], color, size, timestamp }`. Undo clears the buffer and replays the
remaining commands. Do not snapshot pixels.

Because the buffer is fixed-size and independent of `canvasRect`, resizing the canvas
or trimming to fit never resamples or crops paint.

---

## 7. Media import and frame cache

### On drop

1. `ffprobe` the file for duration, dimensions, and frame count.
2. **Reject** any source longer than **30 seconds** with a toast. Reject unsupported
   or corrupt files with a toast. Both cases: ignore the file, do not add a layer.
3. Decode to a frame sequence (see below).
4. Place the object **centered at the cursor**, at native size. If native size exceeds
   `canvasRect` in either dimension, scale down proportionally to fit. Never scale up.
5. The canvas is **never** auto-resized to match dropped media.

Accepted inputs: `.gif`, `.webp` (static and animated), `.png`, `.jpg/.jpeg`, `.bmp`,
`.mp4`, `.mov`, `.webm`, `.mkv`, `.avi`.

### Decoding

Decode at the source's **native frame rate**, never at `outputFps`. Changing the fps
dropdown must not invalidate the cache — resampling happens at render time (§8).

```
ffmpeg -i <source> -vsync 0 <cacheDir>/<cacheKey>/%06d.webp -lossless 1
```

Write a sibling `meta.json` with `frameCount`, `frameDurationsMs[]`,
`nativeWidth`, `nativeHeight`.

Static images: one frame, `frameCount = 1`.

### Cache

- **Location**: `<appFolder>/cache/`. If not writable, fall back to
  `<os.tmpdir()>/media-whiteboard-cache/` and note it in the app's About dialog.
- **Key**: SHA-256 of `sourcePath + mtimeMs + fileSize`, truncated to 16 hex chars.
- **Format**: lossless WebP frames.
- **Persistence**: survives across sessions. Never cleared on exit.
- **Eviction**: on startup, LRU-evict whole cache entries until total size ≤ **5 GB**.
- **UI**: a "Clear cache" button showing current size (in a Settings or About dialog).

### In-memory

LRU cache of decoded `ImageBitmap`, **budgeted in bytes** (not frame count), capped
around 512 MB. Evict least-recently-drawn.

---

## 8. Timing and loop model

### 8.0 Resolving output fps

The fps dropdown lists `Auto`, 10, 12, 15, 24, 25, 30, 50, 60. **`Auto` is the
default.** Auto resolves to the highest effective source frame rate on the canvas —
there is no point exporting at 30 fps when the fastest layer is 15 fps; it only
inflates the file.

```
For each animated layer L:
  L.effectiveFps = 1000 / min(L.frameDurationsMs)   // after normalisation, below
autoFps = ceilToAllowedValue(max(L.effectiveFps))   // round UP to a dropdown value
        = clamp(autoFps, 10, 60)
```

Rules:

- **Round up, never down.** Sources are commonly 29.97, 23.976 or 59.94; these resolve
  to 30, 24 and 60. Rounding down would drop frames.
- **Normalise degenerate GIF delays first**: any `frameDurationMs < 20` is treated as
  100 ms, matching browser behaviour for malformed GIFs. Without this, a single junk
  frame reports several hundred fps.
- **Cap at 60**, even if a 120 fps source is dropped in.
- **No animated layers** → Auto displays as `Auto (—)` and fps is irrelevant; output is
  static (§12).
- **Recompute** whenever a layer is added or removed.
- **A manual selection is sticky.** Once the user picks an explicit value, adding a
  faster layer does not change it. Only re-selecting `Auto` re-enables detection.
- The dropdown displays the resolved value, e.g. `Auto (24)`.

Everything below uses the resolved `outputFps`.

### 8.1 Loop length

All timing math is in **whole output frames**. Never in seconds.

```
outputFrame = 1 / outputFps

For each animated layer L:
  L.cycleFrames = round(L.nativeDurationSec * outputFps)     // min 1

If no animated layers exist:
  → static output (see §12)

outputFrameCount = LCM(all L.cycleFrames)

capFrames = 30 * outputFps
if outputFrameCount > capFrames:
    outputFrameCount = max(L.cycleFrames)
    warn the user in the UI: some layers will be cut mid-cycle at the loop point
```

**Why frames**: an LCM requires integers, and the output file can only contain a whole
number of frames. Quantizing each layer to whole output frames *first* guarantees
every layer lands on a frame boundary. Doing the LCM in seconds produces a fractional
frame count that, once rounded, makes *no* layer land cleanly.

Worked example at 30 fps: a 0.7 s GIF → 21 frames; a 25-frame 24 fps clip (1.041666… s)
→ 31 frames. LCM(21, 31) = 651 frames = 21.7 s, both seamless.

**Sampling** (nearest-frame, no blending, no interpolation):

```
localFrame = outputFrameIndex % L.cycleFrames
localTimeMs = (localFrame / outputFps) * 1000
sourceIndex = index of the frame whose [start, end) span contains localTimeMs
```

Loop count in the output file is **infinite** (`-loop 0`).

**Re-evaluate `outputFrameCount` and the cap warning on every fps change.** Because the
LCM is taken over *rounded* frame counts, changing fps does not scale the result
proportionally — two layers may resolve to 651 frames at 30 fps but 176 at 15 fps. A
change in fps can move the document across the 30 s cap in either direction.

**Known limitation, do not attempt to fix**: layers with mismatched source rates (e.g.
24 fps and 25 fps together) will judder, because nearest-frame sampling duplicates a
frame roughly once per second. This is inherent to the sampling rule and is accepted.

---

## 9. UI layout

```
┌──────────────────────────────────────────────────────────────┐
│ TOP BAR                                                      │
│  W [1280] H [720]  [Trim to fit]  ☐ Transparent  [■ color]   │
│  ─────────────────────────────────────────────────────────   │
│  Tools: Select | Brush | Eraser | Text | Rect | Ellipse       │
│  Options row: active tool's options, or selection properties  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                    CANVAS VIEWPORT                           │
│           (checkerboard when transparent)                    │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ BOTTOM BAR                                                   │
│  Output: [C:\...\out.webp] [Browse]                          │
│  Format [WebP ▾]  FPS [Auto (24) ▾]  Quality [High ▾]  [Generate] │
└──────────────────────────────────────────────────────────────┘
```

Defaults: canvas **1280 × 720**, background solid white, fps **Auto**, quality
**High**, format **WebP**.

### The options row

One row, three states, in this precedence:

1. **A drawing tool is active** (Brush, Eraser, Text, Rect, Ellipse) → that tool's
   creation options, which become the defaults for the next object drawn.
2. **Select is active with a selection** → the **properties of the selected
   object(s)**, live-editable. Editing a control mutates the selection immediately;
   each edit is one undo entry. This is the primary way to change an object after
   creation — the context menu's Properties… (§11) opens the same controls in a
   dialog and exists for discoverability, not as the only route.
3. **Select is active with nothing selected** → the row is empty.

Per-kind properties, matching the fields in §5:

| Selection | Controls |
|---|---|
| Media | opacity |
| Shape | stroke color, stroke width, fill color, No fill, opacity |
| Text | font family, size, bold, italic, color, outline, shadow, opacity |
| Mixed kinds | opacity only |

With a multi-selection of one kind, show the shared controls. A control whose value
differs across the selection renders blank/indeterminate; setting it applies that
value to every member as a single undo entry.

Transparent background renders as a checkerboard in the viewport. Outside `canvasRect`
the viewport is a flat neutral grey so the canvas boundary is unambiguous.

---

## 10. Tools

### Select (default)

- Click to select. Click empty space to deselect. `Esc` deselects.
- **Multi-select**: rubber-band drag on empty space; `Shift`+click to add/remove;
  `Ctrl+A` selects all.
- Konva `Transformer` handles for move / resize / rotate.
- **Resize is aspect-locked by default**; hold `Shift` to distort freely.
- **Rotation snaps to 15°** while `Shift` is held.
- **Multi-select supports move, delete, z-order, and resize — but not rotation.**
  Show a bounding box with corner resize handles only (no rotation handle, no edge
  handles) when more than one object is selected.

#### Group resize

Uniform scale only. Dragging a corner produces a single scale factor `s`, applied
about the anchor corner (the one diagonally opposite the handle being dragged).

For every object in the selection:

```
offset      = obj.position - anchor
position    = anchor + offset * s
width      *= s
height     *= s
rotation    = unchanged
```

Additionally:
- `ShapeObject.strokeWidth *= s` — otherwise outlines look wrong after scaling.
- `TextObject.fontSize *= s` **and** `boxWidth *= s`. Glyphs scale; text does **not**
  reflow. This deliberately differs from single-object text resize (§10, Text), which
  reflows and never changes glyph size. Scaling both together keeps the wrap points
  identical, so the group looks the same, just larger — reflowing here would visibly
  rearrange text the user only meant to scale.
- **`Shift` does not enable free distortion for group resize.** A non-uniform scale
  applied to a rotated object requires a shear, which the object model cannot
  represent. Uniform only, always.
- One undo entry for the whole group operation, not one per object.
- Snapping (§11) applies to the group bounding box, not to individual members.
- **Alt+click** cycles through overlapping objects under the cursor. This is the only
  way to reach a fully-covered object.

### Brush / Eraser

Options: color (brush only), size. Draws to the paint layer (§6). Round cap, round
join. Interpolate between pointer events so fast strokes don't gap.

### Text

- Click to place, then edit **in place** via a positioned DOM `<textarea>` overlaid on
  the canvas and styled to match. Commit on blur or `Ctrl+Enter`; cancel on `Esc`.
- Multi-line.
- Options: system font family, size, style (bold/italic), color, optional outline,
  optional shadow.
- **Resize reflows**: dragging a horizontal handle changes `boxWidth` and the text
  re-wraps; height is always auto-computed from the wrapped result. Vertical and corner
  handles only apply their horizontal component. Glyph size is changed only via the
  font-size control, never by dragging.
- Enumerate system fonts via `queryLocalFonts()` where available, else a `document.fonts`
  probe list. On project load, if a referenced font is missing, warn and fall back to
  the default font.

### Rect / Ellipse

- Drag to draw. **Hold `Alt` to constrain** to a square / perfect circle.
- Options: stroke color, stroke width, fill color, and a "No fill" toggle.
- Shapes are `SceneObject`s — selectable, movable, deletable, editable after creation.

---

## 11. Interaction details

### Snapping

- Threshold **8 screen pixels** (convert to world by dividing by `viewScale`, so
  snapping feels identical at every zoom level).
- Snap targets: other objects' left / center-x / right and top / center-y / bottom,
  **plus** `canvasRect`'s edges and center.
- Show a thin guide line for each active snap while dragging or resizing.
- Hold `Ctrl` to temporarily disable snapping.

### Keyboard

| Key | Action |
|---|---|
| `Delete` / `Backspace` | Delete selection |
| Arrows | Nudge 1 px |
| `Shift`+Arrows | Nudge 10 px |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / Redo |
| `Ctrl+C` / `Ctrl+V` | Copy / paste objects (offset by 10, 10) |
| `Ctrl+V` with image on clipboard | Paste as new media object |
| `Ctrl+D` | Duplicate |
| `Ctrl+A` | Select all |
| `Ctrl+S` / `Ctrl+O` | Save / open project |
| `Esc` | Deselect, or cancel in-progress text edit |
| `Space`+drag | Pan |
| `Ctrl`+wheel | Zoom at cursor |
| `Ctrl+0` | Fit to window |

### Context menu (right-click an object)

Delete · Duplicate · — · Bring to Front · Bring Forward · Send Backward · Send to Back
· — · Opacity slider · Properties…

Right-click on empty canvas: Paste · Select All · Fit to window.

### Undo/redo

Covers **everything**: object transforms, creation, deletion, z-order, paint strokes,
canvas resize, trim-to-fit, background change. Implement as an inverse-command stack.
Depth 100.

### Live preview

The canvas **animates continuously** while editing, driven by one shared
`requestAnimationFrame` loop that advances a global `outputFrameIndex` and calls
`layer.batchDraw()` once. Never one timer per layer.

If the preview drops below ~15 fps, degrade by skipping preview frames — never by
changing what gets exported.

---

## 12. Export

1. Disable UI, show a modal with a determinate progress bar and a **Cancel** button.
2. Await `document.fonts.ready`. Create the export stage: detached container, size =
   `canvasRect`, scale 1, `Konva.pixelRatio = 1`, content offset `-canvasRect.x/y`.
3. Compute `outputFrameCount` (§8). If zero animated layers → **static output**: a
   single-frame WebP or GIF; skip the loop entirely and ignore fps.
4. For each frame `i` in `[0, outputFrameCount)`:
   - `buildScene(doc, i)` (§3), mount into the export stage, `stage.draw()`.
     Drawing order and clipping to `canvasRect` are properties of `buildScene` and the
     stage geometry — do not reimplement them here.
   - Read RGBA from the layer canvas, transfer to main, write to ffmpeg stdin.
   - Await `'drain'` if stdin is backed up; then yield to the event loop.
5. Wait for ffmpeg to exit, then reveal the file.

Base command:

```
ffmpeg -y -f rawvideo -pix_fmt rgba -s <W>x<H> -r <fps> -i pipe:0 <encoder flags> <out>
```

### Per-format

| | WebP | GIF |
|---|---|---|
| Encoder | `-c:v libwebp -loop 0` | palettegen + paletteuse |
| Alpha | Full | 1-bit only |
| Quality low / med / high | `-q:v 50 / 75 / 90` | dither: none / bayer / sierra2_4a |
| Dimensions | any | any |

Neither encoder constrains dimensions, so `canvasRect` is exported as-is. There is no
video codec in this project (see §15) — do not add one without revisiting the license.

**WebP is one pass**: the base command above, straight from the render loop's stdin.

**GIF is two passes over a scratch file**, because `palettegen` must see every frame
before `paletteuse` can write the first one, and the render loop can only produce the
stream once:

```
# pass 0 — the render loop writes raw frames to scratch
<cacheDir>/export-<pid>.rawvideo

# pass 1 — palette
ffmpeg -y -f rawvideo -pix_fmt rgba -s <W>x<H> -r <fps> -i <scratch>        -vf palettegen=reserve_transparent=1 <cacheDir>/export-<pid>.png

# pass 2 — encode
ffmpeg -y -f rawvideo -pix_fmt rgba -s <W>x<H> -r <fps> -i <scratch>        -i <cacheDir>/export-<pid>.png        -lavfi paletteuse=dither=<none|bayer|sierra2_4a> -loop 0 <out>
```

- The scratch file is large (W × H × 4 × frameCount — hundreds of MB to a few GB).
  Check free disk space against that figure before starting and refuse with a toast if
  it will not fit (§14, disk full).
- Delete the scratch file and the palette PNG on success, on failure, **and on cancel**.
- The progress bar covers all three passes, weighted: rendering is the slow part, so
  give pass 0 the bulk of the range and the two ffmpeg passes the remainder.
- Do **not** substitute the single-pass `split[a][b];[a]palettegen[p];[b][p]paletteuse`
  filtergraph. It moves the same buffer into ffmpeg's RAM instead of onto disk, where
  it can't be bounds-checked and will OOM on a long loop.

- **GIF**: warn once that soft/anti-aliased transparent edges will look ragged, since
  GIF alpha is 1-bit.
- **Cancel**: kill the ffmpeg process and **delete the partial output file**.
- Remember and reuse the **last used output directory**. Prompt before overwriting an
  existing file.

Show an estimated output size before export starts. Animated WebP grows fast.

---

## 13. Project file

`.mwproj`, JSON, saved via Ctrl+S. Contains the full `Doc` (§5), the paint layer's
stroke command list, and absolute source paths.

**On load, if a source file is missing**: drop that layer, and show a single summary
warning listing every dropped file. Do not prompt for relocation. Do not block the load.

Include a `schemaVersion` integer from day one.

---

## 14. Error handling

Every one of these is a toast plus a no-op — never a crash, never a silent failure:

- Unsupported / corrupt file dropped
- Source longer than 30 s
- Canvas dimension above 2560
- ffmpeg exits non-zero (surface the last ~10 lines of stderr in an expandable detail)
- Cache directory not writable (fall back, notify once)
- Disk full during export
- Missing font on project load

---

## 15. Packaging

- `electron-builder` with the `dir` target only. No NSIS, no MSI, no auto-updater.
- Ship `ffmpeg.exe` and `ffprobe.exe` in `resources/bin/`, marked as
  `extraResources` and **unpacked** (they must exist as real files on disk).
- Resolve their paths via `process.resourcesPath` in production and a local path in
  dev. Never rely on `PATH`.
- **Licensing: use an LGPL ffmpeg build.** The only encoders this project needs are
  `libwebp` (BSD) and the native GIF encoder, both LGPL-compatible. No GPL-only
  component (`libx264`, `libx265`, `libxvid`) may be introduced — adding one would
  force the whole project to GPL. The project itself is therefore free to use a
  permissive license; **MIT** unless decided otherwise.
  - **Verify `libwebp` is actually present in the chosen LGPL build.** LGPL builds ship
    a reduced set of external libraries and not all include it. Check with
    `ffmpeg -hide_banner -encoders | findstr webp` before committing to a build.
  - Pin the exact ffmpeg build (BtbN or gyan.dev). Record its version, license, and
    source URL in `THIRD-PARTY-NOTICES.md` and ship that file inside the zip — LGPL
    redistribution still requires corresponding source to be available.
- Final deliverable: a zip of the output folder containing `MediaWhiteboard.exe`.

---

## 16. Build order

Build in this sequence. Do not start a step before the previous one runs end to end.

1. **Electron + Vite + React shell**, portable packaging proven. Ship a window that
   says hello and can be zipped, unzipped elsewhere, and launched.
2. **ffmpeg bundling + the export pipe.** Render a hardcoded animated gradient and
   encode a real looping WebP. *This is the highest-risk piece — prove it early.*
3. **Media import + decode + disk cache**, one static image on the canvas.
4. **Select tool**: transform handles, snapping, multi-select, context menu, z-order,
   delete.
5. **Timing model + live animated preview** with multiple looping layers.
6. **Full export** wired to the real scene, all three formats.
7. **Canvas settings**: resize, background, trim to fit.
8. **Undo/redo** across everything built so far.
9. **Annotation tools**: shapes, text, brush, eraser.
10. **Project save/load**, cache management UI, polish.

---

## 17. Non-goals

Do not build these unless explicitly asked later:

- Timeline / filmstrip / seek bar / scrubbing
- Per-layer trim in/out points or start offsets
- Audio in any form (strip it from every source)
- Blend modes
- Alignment/distribute buttons (drag-snapping covers it)
- A layer panel
- Cropping within a media object
- Multi-select rotation (group *resize* is supported — see §10)
- MP4 or any other video-codec output (see §15 — this would change the license)
- macOS or Linux support
