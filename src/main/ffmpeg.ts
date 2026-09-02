import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Bundled binary resolution (CLAUDE.md §15). Never rely on PATH: the user is not
 * required to have ffmpeg installed, and a system ffmpeg could be any build with
 * any license and any missing encoder.
 */

let cached: { ffmpeg: string; ffprobe: string } | null = null;

function resolveBinDir(): string {
  // Packaged: extraResources puts them at <resources>/bin, unpacked from the asar.
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin');

  // Dev: they sit in the repo where fetch-ffmpeg.mjs wrote them. Derive that from
  // this bundle's own location (dist/main -> repo root) rather than
  // app.getAppPath(), which points at the entry script's directory when Electron
  // is launched with an explicit file path, as scripts/dev.mjs does.
  return path.resolve(__dirname, '..', '..', 'resources', 'bin');
}

export function binaries(): { ffmpeg: string; ffprobe: string } {
  if (cached) return cached;

  const dir = resolveBinDir();
  const ffmpeg = path.join(dir, 'ffmpeg.exe');
  const ffprobe = path.join(dir, 'ffprobe.exe');

  const missing = [ffmpeg, ffprobe].filter((p) => !fs.existsSync(p));
  if (missing.length > 0) {
    throw new Error(
      `Bundled ffmpeg is missing:\n${missing.join('\n')}\n` +
        `Run "npm run fetch:ffmpeg" in development, or repackage the app.`,
    );
  }

  cached = { ffmpeg, ffprobe };
  return cached;
}
