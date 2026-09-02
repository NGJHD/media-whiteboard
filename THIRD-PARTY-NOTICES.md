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
