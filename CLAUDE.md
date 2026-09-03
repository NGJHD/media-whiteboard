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

**View transform**: `viewScale` and `viewOffset` map world → screen, and they are
**always** the fit of `canvasRect` into the viewport. There is no zoom and no pan:
no wheel zoom, no space-drag, no "Fit to window" command, because there is no
other state to return from. Anything that changes `canvasRect` or the viewport
size — a width/height entry, Trim to fit, an undo, a project load, resizing the
window — refits. Enforce that in one place rather than at each call site.

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
3. Decode **one frame**, and place the object with it.
4. Place the object **centered at the cursor**, sized to fit within **half** of
   `canvasRect` in both dimensions. Scale down proportionally to reach that;
   never scale up, so anything already smaller is left at native size.
   Fitting the whole canvas meant every photo-sized drop covered everything
   already on it.
5. Switch back to the Select tool, so the new object can be moved immediately.
6. Decode the rest **in the background** (see below).
7. The canvas is **never** auto-resized to match dropped media.

**The first frame a layer decodes becomes its fallback immediately**, before
anything has drawn it. During phase one the only frame on disk is index 0, while
the preview asks for whatever index the wall clock has reached — so without this
a dropped clip draws nothing at all until the background decode publishes.

**A drop must never block the UI.** Nothing waits for the full decode: the object
is on the canvas, selected and manipulable, as soon as one frame exists. While the
rest decodes, show a **non-blocking progress bar per pending item** inside the
canvas area, and let a media node fall back to the last frame it drew rather than
disappearing. Generate is disabled until every decode has finished — that is the
only thing that waits.

**A decode exists to feed a layer.** When that layer goes — deleted, undone away,
replaced by a project load — kill the decode and delete its partial output.
Derive that from the document rather than hooking each removal path; there is
more than one way to remove an object. A cancellation is not an error and gets no
toast.

**Verify the first frame decodes before placing the object.** A copied static
source is bytes this app has never looked at. Better one toast and no layer than
an object that silently draws nothing.

**Probe cost is part of the drop.** Reading per-frame timestamps means decoding the
whole file, so only ask for them where they carry information: GIF and animated
WebP have meaningful per-frame delays, video containers do not. For video, take the
duration from the stream, the container format, or the `DURATION` tag — Matroska
has no stream duration and a missing one must not be read as zero — and the timing
from `avg_frame_rate`, uniform across frames.

Accepted inputs: `.gif`, `.webp` (static and animated), `.png`, `.jpg/.jpeg`, `.bmp`,
`.mp4`, `.mov`, `.webm`, `.mkv`, `.avi`.

### Decoding

Decode at the source's **native frame rate**, never at `outputFps`. Changing the fps
dropdown must not invalidate the cache — resampling happens at render time (§8).

```
ffmpeg -i <source> -an -fps_mode passthrough -c:v png -compression_level 1        <cacheDir>/<cacheKey>/%06d.png
```

Write a sibling `meta.json` with `frameCount`, `frameDurationsMs[]`,
`nativeWidth`, `nativeHeight`, `frameExt`.

**A static source is copied, not encoded.** One frame is one frame; if the
renderer can decode the file as it stands — png, jpg, bmp, webp, gif — copy it
into the entry and let `createImageBitmap` do the work. Encoding it first buys a
different container for the slowest step in the whole import.

**Animated layers are previewed from reduced-resolution proxy frames.** A second
output on the same decode pass writes each frame again, scaled so its **short
side** is `PREVIEW_PROXY_SHORT_SIDE` (currently **240 px**), into
`<entry>/proxy/`. The preview draws those; **export reads the native frames and
never sees a proxy**. This is the only substitution the preview is allowed to
make, and it is resolution only — same node, same geometry, same order, so §3's
single construction path is intact.

Why it is needed: a 17 s 1080x2520 clip is ~11 GB of decoded bitmaps against a
512 MB budget, so nearly every preview frame missed, and decoding a native frame
is nowhere near fast enough for 60 fps. With proxies the same clip holds a 100%
hit rate in 235 MB. The second output costs about **19%** of the decode (8.5 s to
10.2 s on that clip) and about **13%** more disk.

`PREVIEW_PROXY_SHORT_SIDE` is a tuning knob. Lower is snappier and softer; the
measured trade at 240 against 320 is in `shared/doc.ts`. Changing it must
invalidate entries built at the old size, so `meta.json` records what they were
written at.

Stills do not get proxies. A still decodes once and is then drawn every frame for
free, so there is no churn to spare and softening it would be a pure loss. Nor do
sources whose short side is less than twice the target: below that the second
decode output and the extra disk cost more than they save.

**Cache frames must be cheap to write, not small.** This is the single biggest
cost in an import, and the encoder choice dominates it. Measured on the reference
machine at 1080x2520: lossless WebP took 38 s per 40 frames, PNG 0.9 s. A 17 s
clip went from roughly sixteen minutes to eight seconds; a 3456x5184 JPEG from
eleven seconds to none at all. Both are lossless, so output fidelity is
identical — the trade is cache size, which the LRU cap already governs.

### Cache

- **Location**: `<appFolder>/cache/`. If not writable, fall back to
  `<os.tmpdir()>/media-whiteboard-cache/` and note it in the app's About dialog.
- **Key**: SHA-256 of `sourcePath + mtimeMs + fileSize`, truncated to 16 hex chars.
- **Format**: lossless. PNG for anything decoded; a copied static source keeps its
  own container. `meta.frameExt` records which.
- **Persistence**: survives across sessions. Never cleared on exit.
- **Eviction**: on startup, LRU-evict whole cache entries until total size ≤ **5 GB**.
- **UI**: a "Clear cache" button showing current size (in a Settings or About dialog).
  That dialog is also where the author, the repo link and the update button live (§15).

### In-memory

LRU cache of decoded `ImageBitmap`, **budgeted in bytes** (not frame count), capped
around 512 MB. Evict least-recently-drawn.

**Eviction may not close a frame the preview is still standing on.** A long or
large source cannot fit — a 17 s 1080x2520 clip is ~11 GB of decoded bitmaps
against a 512 MB budget — so the preview misses constantly and falls back to the
last frame each layer drew. Closing that frame turns the next draw into a
detached-source error. Keep one frame per layer pinned, and treat a zero-sized
bitmap as absent rather than drawing it.

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
  **This applies to GIF and animated WebP only.** 16.68 ms is what 59.94 fps video
  looks like, not a malformed delay; rewriting those to 100 ms makes a 17 s clip
  measure 102 s and be rejected by §7's duration limit.
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

The app is exactly **three sections**: the top bar, the canvas area, the bottom
bar. Each bar is a **single row that never wraps**.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ TOP BAR (one row)                                                          │
│ W[1280] H[720] [Trim to fit] ☐Transparent [■] [+media] │ ▶ ↶ ↷ 🖌 ⌫ T □ ○ │ …options… [i] │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│                    CANVAS AREA (checkerboard when transparent)             │
│                    always fitted to the window (§4)                        │
│                    decode progress bars overlay the bottom                 │
│                                                                            │
├────────────────────────────────────────────────────────────────────────────┤
│ BOTTOM BAR (one row)                                                       │
│ Output [C:\...\out.webp] [Browse] │ Format[WebP▾] FPS[Auto(24)▾] Quality[High▾] est. [Generate] │
└────────────────────────────────────────────────────────────────────────────┘
```

- Tools are **square icon buttons**, not text. Undo and Redo sit between Select and
  Brush — they are used constantly and belong in the same reach as the tools.
- Vertical dividers separate the three groups in the top bar (canvas settings |
  tools | options) and the two in the bottom bar (output | generation).
- **Minimum window size 1280 × 720.** Everything except the options section is
  fixed-width and always reachable at that size; the options section is the only
  thing allowed to scroll horizontally, so the controls to its left never move.
- The output path is a normal **editable** field. Browse is a convenience.

Defaults: canvas **1280 × 720**, background solid **black**, fps **Auto**, quality
**High**, format **WebP**. Brush, shape stroke and text colour all default to red.

### The options row

One row, three states, in this precedence:

1. **A drawing tool is active** (Brush, Eraser, Text, Rect, Ellipse) → that tool's
   creation options, which become the defaults for the next object drawn.
2. **Select is active with a selection** → the **properties of the selected
   object(s)**, live-editable. Editing a control mutates the selection immediately;
   each edit is one undo entry. This is the only way to change an object after
   creation.
3. **Select is active with nothing selected** → the section is empty.

The Eraser's options carry a **Clear all drawing** button beside its size. Wiping
the layer is a different action from erasing, not a very large eraser, and it goes
through the document so undo replays correctly (§6).

Per-kind properties, matching the fields in §5:

| Selection | Controls |
|---|---|
| Media | source size (read-only), width, height |
| Shape | stroke color, stroke width, fill color, No fill |
| Text | font family, size, bold, italic, color, outline, shadow |
| Mixed kinds | *(none — the section is empty)* |

Media's width and height are **locked to the source aspect ratio**: typing one
sets the other to whatever keeps the layer undistorted. That is the point of
being able to type them, and it matches the corner-only handles — there is
deliberately no way to distort media by accident. They are per-object, so a
multi-selection of media shows nothing.

`opacity` stays in the model (§5) and is honoured by `buildScene`, but **it has no
UI**. There is no opacity control anywhere.

With a multi-selection of one kind, show the shared controls. A control whose value
differs across the selection renders blank/indeterminate; setting it applies that
value to every member as a single undo entry.

Transparent background renders as a checkerboard in the viewport. Outside `canvasRect`
the viewport is a flat neutral grey so the canvas boundary is unambiguous.

### Placeholders

Both are preview chrome and live on the overlay layer, so neither can reach the
output (§3).

- **A media layer with no decoded frame** draws a dark grey rectangle over its
  bounds with `Loading <file name>…` centred in it. A layer with nothing to draw
  is otherwise indistinguishable from an empty selection rectangle, and the
  first frame of a cold drop, a project load or an evicted layer is not always
  instant.
- **An empty document** — no objects and no paint — centres
  `Drop a media file to get started` in `canvasRect`.

---

## 10. Tools

### Select (default)

- Click to select. Click empty space to deselect. `Esc` deselects.
- **Multi-select**: rubber-band drag on empty space; `Shift`+click to add/remove;
  `Ctrl+A` selects all.
- Konva `Transformer` handles for move / resize / rotate.
- **Corner handles only — never edge handles.** An edge handle can only change
  one dimension, so its entire purpose is to distort, and for media that is
  against the source's own aspect ratio. Four corners plus the rotation handle.
- **Resize is aspect-locked.** `Shift` frees it **for shapes only**. A media
  layer has a source aspect ratio that stretching is always wrong against, so no
  gesture distorts one — not an edge handle, not `Shift`. A group cannot be
  distorted either, for the reason in "Group resize" below.
- `Shift` is about the **resize** only. It still snaps rotation to 15° for
  everything, including media; that is a separate mechanism.
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
- **Double-click an existing text object to edit it.**
- While the editor is open it is the **only** box on screen: hide the Konva text
  node, the selection outline and the transform handles. Two rectangles of
  different sizes stacked on each other read as a bug, not as an editor.
- Multi-line. The box **grows downward** to fit; it must never scroll. Height is
  auto-computed from the wrapped result anyway, so the editor measures its own
  content and matches. On commit the **top edge** stays put — the model stores a
  centre, so writing a taller height without moving it would jump the finished
  text upward the moment the editor closed.
- Options: system font family, size, style (bold/italic), color, optional outline,
  optional shadow.
- **Resize reflows**: dragging a corner changes `boxWidth` and the text re-wraps;
  height is always auto-computed from the wrapped result, so only the horizontal
  component of the drag is used. Glyph size is changed only via the font-size
  control, never by dragging.
- Enumerate system fonts via `queryLocalFonts()` where available, else a `document.fonts`
  probe list. On project load, if a referenced font is missing, warn and fall back to
  the default font.

### Rect / Ellipse

- Drag to draw. **Hold `Shift` to constrain** to a square / perfect circle.
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
- **Resizing snaps too**, not just moving. A resize pins the corner opposite the
  handle and moves the dragged one, so it is that corner which gets aligned.
  Under aspect lock only one axis can be honoured — the other follows from the
  ratio — so the nearer one wins. Only at rotation 0: the guides are
  axis-aligned and a rotated box has no edge that lines up with them.
  Do this through the Transformer's `boundBoxFunc`, which is the seam Konva
  provides for adjusting the box mid-gesture; anything else leaves the handles
  on the unsnapped rectangle.
- **The transform handles snap with the object.** The snapped position and the
  pointer differ by up to the threshold; the box, the handles and the object must
  all end up on the same rectangle, or the handles visibly lag the thing they
  belong to.
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
| `Ctrl+A` | Select all |
| `Ctrl+S` / `Ctrl+O` | Save / open project |
| `Esc` | Deselect, or cancel in-progress text edit |

There are no view shortcuts. §4 leaves nothing to zoom, pan or re-fit.

### Context menu (right-click an object)

Delete · — · Bring Forward · Send Backward · Bring to Front · Send to Back

The one-step moves come first: they are the ones reached for repeatedly.

Right-click on empty canvas: Paste · Select All. **It deselects first** — a
right-click never reaches the mousedown handler that would otherwise have cleared
the selection, so without this the menu belongs to an object nowhere near the
cursor.

Nothing else belongs here. Z-order has no other home (§5), and everything that does
— object properties — lives in the options row where it is visible without a click.

The menu **flips to the other side of the cursor** rather than being clipped when it
is opened near an edge of the canvas area.

### Undo/redo

Covers **everything**: object transforms, creation, deletion, z-order, paint strokes,
canvas resize, trim-to-fit, background change. Implement as an inverse-command stack.
Depth 100.

### Live preview

The canvas **animates continuously** while editing, driven by one shared
`requestAnimationFrame` loop that advances a global `outputFrameIndex` and draws
once. Never one timer per layer.

**The loop draws synchronously.** It already *is* the animation frame, so
`batchDraw` would only defer the real draw to a later callback — and that gap is
long enough for an in-flight decode to land and evict a bitmap that a node built
this frame is still pointing at. Drawing in the same synchronous block keeps
peek-and-draw atomic.

This matters more than it sounds: a `drawImage` on a closed `ImageBitmap` throws
from inside Konva's layer draw, which leaves that layer's `_waitingForDraw`
latched. The canvas then never paints again — media stops animating and dragging
an object appears to do nothing, while the rest of the app carries on.

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
- Remember the **last used output directory** and the **last directory Add media
  browsed**, across sessions, in a settings file inside the app folder (§1). Neither
  belongs in the `Doc` (§5) or in a project file (§13).
- **The suggested output name is always one that does not exist.** `output.webp`
  becomes `output2.webp`, then `output3.webp`; a name already ending in digits
  continues its own run. Apply it when seeding the path at startup, when the format
  changes the extension, and again after a successful Generate — so Generate can be
  pressed twice without a dialog in between. Still prompt before overwriting a path
  the user typed or chose themselves.

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

- `electron-builder` with the `dir` and `zip` targets only. No NSIS, no MSI, no
  auto-updater — `zip` is an archive of the `dir` output, not an installer.
- **The About dialog updates the app in place, on demand.** It shows the author
  and a link to the GitHub repo, and carries a **Check for updates** button that
  reads `/releases/latest`, downloads the release zip and replaces the install
  folder. That is not the auto-updater ruled out above: nothing checks on launch
  and nothing nags, and it needs no NSIS target, no `latest.yml` and no code
  signing. See `DECISIONS.md` D-040.
  - The updater is only as good as the release, so a release must have a tag of
    `v<version>` matching `package.json` exactly, exactly one `.zip` asset named
    to match `artifactName`, and be published rather than a draft.
  - The app verifies the download's own version against the tag before applying
    it. A disagreement is a hard stop, so a mislabelled release is a failed
    update rather than a silent downgrade.
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
- The app icon lives at `build/icon.png` (square, at least 256 px). electron-builder
  compiles it into the exe; in dev the window points at the same file.
- Any third-party asset that ships — icons included — is listed in
  `THIRD-PARTY-NOTICES.md` with its licence.
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

- Manual zoom or pan of the canvas (§4: it is always fitted)
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
