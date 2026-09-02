import fs from 'node:fs';
import path from 'node:path';
import type { Settings } from '../shared/ipc';

/**
 * Small persisted preferences (CLAUDE.md §1, §12).
 *
 * Lives in the portable userData folder, so it travels with the unzipped app and
 * writes nothing outside it. Deliberately not part of the Doc (§5): these are
 * per-installation conveniences, not document content, and must never end up in
 * a .mwproj or in the undo stack.
 *
 * Every read is defensive. A settings file that is missing, truncated or hand
 * edited into nonsense must degrade to the defaults, never stop the app booting.
 */

const DEFAULTS: Settings = {
  lastOutputDir: null,
  lastMediaDir: null,
};

let file = '';
let cache: Settings = { ...DEFAULTS };

export function initSettings(userData: string): void {
  file = path.join(userData, 'settings.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Settings>;
    cache = {
      lastOutputDir: typeof parsed.lastOutputDir === 'string' ? parsed.lastOutputDir : null,
      lastMediaDir: typeof parsed.lastMediaDir === 'string' ? parsed.lastMediaDir : null,
    };
  } catch {
    cache = { ...DEFAULTS };
  }
}

export function getSettings(): Settings {
  return { ...cache };
}

export function patchSettings(patch: Partial<Settings>): Settings {
  cache = { ...cache, ...patch };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    // A read-only app folder already fell back to temp in paths.ts; if even that
    // fails, the in-memory value still serves this session.
  }
  return getSettings();
}

/**
 * §12 (feedback item 19): the suggested output file must be one that does not
 * exist yet, so Generate never silently overwrites and never needs the overwrite
 * prompt for the default path. `out.webp` becomes `out2.webp`, then `out3.webp`.
 *
 * A name that already ends in digits continues its own run rather than losing
 * them: `clip2024.webp` goes to `clip2025.webp`, not back to `clip.webp`.
 * Numbering an unsuffixed name starts at 2, because the bare name *is* the
 * first one — `out1.webp` beside `out.webp` reads as a different file.
 */
export function uniquePath(candidate: string): string {
  const dir = path.dirname(candidate);
  const ext = path.extname(candidate);
  const stem = path.basename(candidate, ext) || 'output';

  const exists = (name: string) => {
    const full = path.join(dir, `${name}${ext}`);
    try {
      fs.accessSync(full);
      return true;
    } catch {
      return false;
    }
  };

  if (!exists(stem)) return path.join(dir, `${stem}${ext}`);

  const match = /^(.*?)(\d+)$/.exec(stem);
  const prefix = match ? match[1]! : stem;
  let n = match ? Number(match[2]) + 1 : 2;

  for (let guard = 0; guard < 10_000; guard += 1, n += 1) {
    if (!exists(`${prefix}${n}`)) return path.join(dir, `${prefix}${n}${ext}`);
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}
