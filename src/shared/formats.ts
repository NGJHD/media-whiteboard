import type { OutputFormat } from './ipc';

/**
 * Everything that varies between output formats, in one table
 * (docs/superpowers/specs/2026-09-08-mp4-png-output-formats.md §6, §7).
 *
 * Main's save dialog, the renderer's dropdown, the project-file namer and the
 * encoder all read from here. Before this existed, `webp|gif` was spelled out in
 * five places and adding a format meant finding all five.
 */
export interface FormatSpec {
  id: OutputFormat;
  /** As shown in the dropdown. */
  label: string;
  /** Without the dot. */
  extension: string;
  /**
   * §6. 'animated' needs at least one animated layer; 'static' needs the
   * absence of one. An unavailable format is shown disabled, never hidden.
   */
  availability: 'always' | 'animated' | 'static';
  /** False for lossless formats, whose Quality control is disabled. */
  supportsQuality: boolean;
  /** False for MP4 — H.264 carries no alpha at all (§4). */
  supportsAlpha: boolean;
  /** Why this format is currently unavailable. Null when always available. */
  requirement: string | null;
  /**
   * The same thing in two or three words, appended to the option's own label
   * while it is unavailable.
   *
   * A native `<select>` renders its option list outside the page, so how far a
   * browser dims `option:disabled` is not something this app controls — and
   * Chromium's default is barely a shade. Putting the reason in the text makes
   * the distinction survive regardless, and puts it where the eye already is
   * instead of behind a hover.
   */
  unavailableNote: string | null;
}

/**
 * Keyed by id so a fifth format with no entry here is a compile error, not a
 * runtime `throw` in `formatSpec()`. `OutputFormat` (src/shared/ipc.ts) and this
 * table would otherwise be free to drift — the union grows, the table doesn't,
 * and nothing notices until the missing lookup throws at runtime.
 */
const FORMAT_BY_ID: Record<OutputFormat, FormatSpec> = {
  webp: {
    id: 'webp',
    label: 'WebP',
    extension: 'webp',
    availability: 'always',
    supportsQuality: true,
    supportsAlpha: true,
    requirement: null,
    unavailableNote: null,
  },
  gif: {
    id: 'gif',
    label: 'GIF',
    extension: 'gif',
    availability: 'always',
    supportsQuality: true,
    supportsAlpha: true,
    requirement: null,
    unavailableNote: null,
  },
  mp4: {
    id: 'mp4',
    label: 'MP4',
    extension: 'mp4',
    availability: 'animated',
    supportsQuality: true,
    supportsAlpha: false,
    requirement: 'MP4 needs at least one animated layer on the canvas.',
    unavailableNote: 'needs animation',
  },
  png: {
    id: 'png',
    label: 'PNG',
    extension: 'png',
    availability: 'static',
    supportsQuality: false,
    supportsAlpha: true,
    requirement: 'PNG is available only while nothing on the canvas animates.',
    unavailableNote: 'static only',
  },
};

// Array order is the dropdown's render order and is asserted by
// scripts/smoke-formats.mjs — keep it webp, gif, mp4, png.
export const FORMATS: readonly FormatSpec[] = Object.values(FORMAT_BY_ID);

/**
 * §6: what a stale selection falls back to. WebP is the only sane choice — it is
 * the default, and it is available in both document states.
 */
export const FALLBACK_FORMAT: OutputFormat = 'webp';

export function formatSpec(id: OutputFormat): FormatSpec {
  return FORMAT_BY_ID[id];
}

export function isFormatAvailable(id: OutputFormat, isStatic: boolean): boolean {
  const { availability } = formatSpec(id);
  if (availability === 'always') return true;
  return availability === 'static' ? isStatic : !isStatic;
}

/** Matches any output extension this app writes. */
export const EXTENSION_PATTERN = new RegExp(
  `\\.(${FORMATS.map((f) => f.extension).join('|')})$`,
  'i',
);

/**
 * Swaps a path's extension for the given format's, appending rather than
 * replacing when there is nothing to replace.
 */
export function withExtension(filePath: string, id: OutputFormat): string {
  const ext = formatSpec(id).extension;
  return EXTENSION_PATTERN.test(filePath)
    ? filePath.replace(EXTENSION_PATTERN, `.${ext}`)
    : `${filePath}.${ext}`;
}
