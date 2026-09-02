# Third-party notices

Media Whiteboard is MIT licensed. It redistributes the following third-party
software. This file ships inside the release zip.

---

## FFmpeg

**Binaries redistributed:** `ffmpeg.exe`, `ffprobe.exe` (in `resources/bin/`)

| | |
|---|---|
| Version | `n9.0.1-11-ge47273f4d9-20260901` |
| License | **LGPL v3 or later** (built with `--enable-version3`) |
| Build | BtbN/FFmpeg-Builds, release `autobuild-2026-09-01-13-13`, asset `ffmpeg-n9.0.1-11-ge47273f4d9-win64-lgpl-9.0.zip` |
| Build scripts | https://github.com/BtbN/FFmpeg-Builds |
| Upstream source | https://github.com/FFmpeg/FFmpeg/tree/e47273f4d9 |

FFmpeg is free software licensed under the GNU Lesser General Public License
version 3 or later. The full licence text is reproduced in `LICENSE.ffmpeg.txt`
alongside this file.

**Corresponding source.** LGPL redistribution requires the corresponding source
to be available. It is at the upstream URL above, at the exact commit the build
was made from (`e47273f4d9`), and the scripts used to produce these binaries are
in the BtbN repository. The exact release and asset name are pinned in
`scripts/ffmpeg-build.json`, along with SHA-256 checksums of the archive and of
each extracted binary.

**Relinking.** The LGPL requires that a user be able to replace the covered
library with a modified version. These binaries are separate executables invoked
as child processes, not libraries linked into Media Whiteboard. A user may
replace `resources/bin/ffmpeg.exe` and `resources/bin/ffprobe.exe` with their own
builds; the app invokes them by absolute path and does not verify their contents
at runtime.

**No GPL or non-free components.** This build was verified before it was pinned,
and `scripts/fetch-ffmpeg.mjs` re-verifies on every fetch, refusing any build
whose `configuration:` line contains `--enable-gpl` or `--enable-nonfree`. The
build explicitly disables `libx264`, `libx265`, `libxavs2` and `libxvid`.
Introducing any GPL component would relicense this project (CLAUDE.md §15).

**Encoders actually used by this app:**

- `libwebp` / `libwebp_anim` — WebP encoding. libwebp is BSD-3-Clause.
- `gif` — FFmpeg's native GIF encoder, plus the `palettegen` and `paletteuse`
  filters.

No video codec is used, and none may be added without revisiting the licence
(CLAUDE.md §15, §17).

---

## Electron

Electron 44.1.1 — MIT. Bundles Chromium (BSD-3-Clause and others) and Node.js
(MIT). Chromium's full licence set ships in the release as
`LICENSES.chromium.html`, and Electron's as `LICENSE.electron.txt`.

## Lucide icons

The tool, undo/redo, add-media and about glyphs in the top bar are Lucide icons
(`mouse-pointer-2`, `undo-2`, `redo-2`, `paintbrush`, `eraser`, `type`, `square`,
`circle`, `image-plus`, `info`), from **lucide-static v0.545.0**, **ISC licence**.

Source: https://github.com/lucide-icons/lucide

The path data is inlined into `src/renderer/ui/icons.tsx` rather than pulled from a
package or a CDN: CLAUDE.md §1 forbids runtime prerequisites, and the portable zip
must not depend on the network. No Lucide code ships — only the SVG path data.

```
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of
Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors
2022.

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

## Application icon

`build/icon.png` was supplied by the project owner and is not third-party
software. It is not covered by the notices above.

## Bundled npm packages

Compiled into the application bundle:

| Package | Version | Licence |
|---|---|---|
| react, react-dom | 19.2.8 | MIT |
| konva | 10.3.2 | MIT |
| react-konva | 19.2.5 | MIT |
| zustand | 5.0.15 | MIT |
| immer | 11.1.18 | MIT |

Build-time only (not redistributed): vite, esbuild, typescript,
electron-builder, and their dependencies.
