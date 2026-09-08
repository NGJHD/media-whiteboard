# Spec: MP4 and PNG output formats

**Status:** accepted 2026-09-08
**Amends:** `CLAUDE.md` §12 (Export), §15 (Packaging), §17 (Non-goals)

This spec deliberately contradicts three statements in `CLAUDE.md` as it stands
today. Those sections are rewritten as part of the work; until they are, `CLAUDE.md`
and this document disagree and **this document wins**.

---

## 1. Motivation

The app exports animated WebP and GIF. Two gaps:

- **MP4** is the format people actually paste into Slack, Discord, editors and
  phones. WebP animation support is still patchy outside browsers.
- **PNG** is the correct output for a document with nothing animated. A
  single-frame "animated WebP" is a worse PNG in every respect.

## 2. The licence decision (the reason this was not already built)

`CLAUDE.md` §15 forbids GPL ffmpeg components, and `scripts/fetch-ffmpeg.mjs`
actively refuses any build configured with `--enable-gpl`. That rule exists to keep
the project MIT.

The constraint was really about **CRF**, not about H.264:

- CRF is a per-encoder rate-control mode, not a container or codec feature.
- `libx264` implements CRF and is **GPL**.
- `libopenh264` (already present in the current LGPL build) is BSD-2-Clause but
  implements **no CRF** — only `-b:v` with `rc_mode`. There is no build flag that
  adds CRF to it; the encoder does not contain that code.

So a quality dropdown backed by CRF requires libx264, which requires a GPL build.

**Decision: take the GPL build.** This mirrors the sibling project *Video Trim &
Crop*, which ships a BtbN GPL build with libx264 and maps quality to
`-crf 17/20/23` with matching presets, while keeping its own source MIT.

The reasoning it records, which applies unchanged here: the app never links
FFmpeg's libraries. It spawns `ffmpeg.exe` as a separate process and communicates
only through argv, pipes and exit codes. Under the FSF's own guidance those are
separate works, so the GPL does not reach back into `src/`. The **binaries** stay
GPL and carry their obligations with them — ship the notices, ship the GPL text,
and point at corresponding source.

Media Whiteboard's own source stays **MIT**.

### Consequences

- `scripts/fetch-ffmpeg.mjs` inverts its licence check: it must now **require**
  `--enable-gpl` and `--enable-libx264`, and continue to forbid `--enable-nonfree`.
- `THIRD-PARTY-NOTICES.md` is rewritten for GPL v3, including the corresponding-source
  offer and the arm's-length rationale.
- The full GPL v3 text ships beside the existing LGPL text.
- The pinned build moves from the `win64-lgpl` asset to the `win64-gpl` asset of
  **the same BtbN autobuild release and the same upstream commit**, so nothing but
  the licence surface changes.

### Out of scope

The H.264 patent position (Via LA / MPEG LA licensing for AVC encoders) is
independent of the copyright licence and is unchanged by this decision. It is not
addressed here.

## 3. Even-dimension handling

H.264 with `yuv420p` requires even width and height. `canvasRect` can be any size
up to 2560, so odd dimensions are reachable by typing them or by Trim to fit.

**Verified behaviour, current bundled ffmpeg, rawvideo rgba in:** feeding 401×301
to an H.264 encoder does *not* fail. ffmpeg exits 0 and **silently writes 400×300**,
losing a row and a column with no warning.

**Decision: pad, never crop.** Up to one pixel is added to the right and bottom
edges:

```
pad=ceil(iw/2)*2:ceil(ih/2)*2:color=black
```

ffmpeg derives the target size itself; the app passes no numbers. Verified:
401×301 → 402×302, no content lost. The padding is black, matching the matte in
§4, so the added strip is invisible.

MP4 is therefore the only format whose output dimensions may differ from
`canvasRect`, by at most one pixel per axis.

PNG has no even-dimension constraint. Verified: 401×301 in, 401×301 out.

## 4. Transparency

MP4/H.264 carries no alpha.

**Verified behaviour:** converting rgba to `yuv420p` **discards** the alpha channel
rather than compositing against anything. A fully transparent region emerged with
its underlying RGB intact at full strength, which would turn anti-aliased edges
into hard colour halos.

**Decision: when `background.transparent` is set and the format is MP4, composite
onto black** before conversion:

```
color=c=black:s=<W>x<H>:r=<fps>[bg];[bg][0:v]overlay=shortest=1,<pad>,format=yuv420p
```

Verified to yield `rgb(0, 0, 0)` in the formerly transparent region. There is no
matte-colour picker; black is the only option.

Selecting MP4 while transparency is on raises a one-time toast, in the same shape
as the existing GIF 1-bit-alpha warning.

PNG carries full alpha and needs none of this.

## 5. Looping

MP4 has no loop flag; looping is a player concern (`<video loop>`). `-loop 0` is
simply not passed. This is accepted and needs no UI.

## 6. Availability

The Format dropdown depends on whether the document has an animated layer
(`planLoop(doc).isStatic`):

| Format | Available when |
|---|---|
| WebP | always |
| GIF | always |
| MP4 | at least one animated layer |
| PNG | no animated layers |

Unavailable formats are **shown and disabled**, not hidden — a greyed option with a
stated reason is easier to understand than one that vanishes. An info affordance
beside the dropdown carries the reason each currently-unavailable format is
unavailable.

**Stale selection falls back to WebP.** Deleting the last animated layer while MP4
is selected, or adding an animated layer while PNG is selected, rewrites
`doc.format` to `webp`, fixes the output extension, re-uniques the path, and
toasts. This is a `mutate`, not an `apply` — the app correcting itself is not an
edit the user should have to undo. It must be enforced in one place, reacting to
the document, because there is more than one way to add or remove a layer
(drop, delete, undo, project load).

## 7. Encoder settings

### MP4

One pass, straight from the render loop's stdin, exactly like WebP.

```
ffmpeg -y -f rawvideo -pix_fmt rgba -s <W>x<H> -r <fps> -i pipe:0 -an \
  <filters> \
  -c:v libx264 -preset <preset> -crf <crf> -profile:v high -movflags +faststart \
  <out.mp4>
```

Quality mapping, matching *Video Trim & Crop* so the two apps agree:

| Quality | CRF | Preset |
|---|---|---|
| High | 17 | slow |
| Medium | 20 | medium |
| Low | 23 | fast |

### PNG

```
ffmpeg -y -f rawvideo -pix_fmt rgba -s <W>x<H> -r <fps> -i pipe:0 -an \
  -frames:v 1 -c:v png <out.png>
```

Lossless, so the Quality dropdown is **disabled** while PNG is selected rather than
silently ignored. PNG is only offered for static documents, where the renderer
already sends exactly one frame.

## 8. Size estimate

The bottom bar's byte estimate is only rendered for animated documents — a static
document shows `Static — 1 frame` and no estimate at all. PNG is therefore never
estimated and needs no code.

MP4 needs its own bytes-per-pixel-per-frame figures, measured from this encoder at
each quality, in the same spirit as the existing WebP constants.

## 9. Non-goals for this work

- No matte-colour picker for MP4. Black, always.
- No HEVC, AV1, VP9 or WebM output.
- No audio, in any form. Sources are still stripped.
- No change to the loop model, sampling, or `buildScene`. Export output pixels are
  unchanged; only the encoding of them changes.
