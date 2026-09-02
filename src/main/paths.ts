import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Portable-app path resolution. CLAUDE.md §1: no writes outside the app folder,
 * no registry, no admin rights. Electron's defaults violate that — userData lands
 * in %APPDATA% — so every writable location is re-pointed here, before app ready.
 *
 * §7's fallback rule is generalised: if the app folder is not writable (unzipped
 * into Program Files, run from a read-only share), fall back to the temp dir and
 * record that so the About dialog can say so.
 */

export interface AppPaths {
  /** The folder holding the exe. In dev, the project root. */
  appFolder: string;
  /** Chromium/Electron state: <appFolder>/data, or the fallback. */
  userData: string;
  /** Decoded frame cache: <appFolder>/cache, or the fallback. (§7) */
  cacheDir: string;
  /** True when appFolder was not writable and temp is being used instead. */
  usingFallback: boolean;
  /** Why the fallback kicked in — surfaced in About. Null when not applicable. */
  fallbackReason: string | null;
}

function isWritable(dir: string): true | string {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

let resolved: AppPaths | null = null;

export function resolvePaths(isDev: boolean, distDir: string): AppPaths {
  if (resolved) return resolved;

  const appFolder = isDev
    ? path.resolve(distDir, '..', '..')
    : path.dirname(app.getPath('exe'));

  const writable = isWritable(path.join(appFolder, 'data'));

  if (writable === true) {
    resolved = {
      appFolder,
      userData: path.join(appFolder, 'data'),
      cacheDir: path.join(appFolder, 'cache'),
      usingFallback: false,
      fallbackReason: null,
    };
  } else {
    const fallback = path.join(os.tmpdir(), 'media-whiteboard');
    resolved = {
      appFolder,
      userData: path.join(fallback, 'data'),
      cacheDir: path.join(fallback, 'cache'),
      usingFallback: true,
      fallbackReason: `${appFolder} is not writable (${writable})`,
    };
  }

  return resolved;
}

/** Must run before `app.whenReady()`; Electron caches these paths at startup. */
export function applyPaths(paths: AppPaths): void {
  app.setPath('userData', paths.userData);
  // sessionData defaults to userData, but set it explicitly so a future Electron
  // change to that default cannot silently reintroduce an %APPDATA% write.
  app.setPath('sessionData', paths.userData);
  fs.mkdirSync(paths.cacheDir, { recursive: true });
}
