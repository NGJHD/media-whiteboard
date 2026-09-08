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
}

export const FORMATS: readonly FormatSpec[] = [
  {
    id: 'webp',
    label: 'WebP',
    extension: 'webp',
    availability: 'always',
    supportsQuality: true,
    supportsAlpha: true,
    requirement: null,
  },
  {
    id: 'gif',
    label: 'GIF',
    extension: 'gif',
    availability: 'always',
    supportsQuality: true,
    supportsAlpha: true,
    requirement: null,
  },
  {
    id: 'mp4',
    label: 'MP4',
    extension: 'mp4',
    availability: 'animated',
    supportsQuality: true,
    supportsAlpha: false,
    requirement: 'MP4 needs at least one animated layer on the canvas.',
  },
  {
    id: 'png',
    label: 'PNG',
    extension: 'png',
    availability: 'static',
    supportsQuality: false,
    supportsAlpha: true,
    requirement: 'PNG is available only while nothing on the canvas animates.',
  },
];

/**
 * §6: what a stale selection falls back to. WebP is the only sane choice — it is
 * the default, and it is available in both document states.
 */
export const FALLBACK_FORMAT: OutputFormat = 'webp';

export function formatSpec(id: OutputFormat): FormatSpec {
  const spec = FORMATS.find((f) => f.id === id);
  if (!spec) throw new Error(`Unknown output format: ${id}`);
  return spec;
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
