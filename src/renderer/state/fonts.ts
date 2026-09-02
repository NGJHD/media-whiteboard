/**
 * System font enumeration (CLAUDE.md §10).
 *
 * `queryLocalFonts()` where available, else a `document.fonts` probe list.
 */

/** Fonts that ship with Windows 11 and are worth probing for. */
const PROBE_LIST = [
  'Segoe UI', 'Segoe UI Variable Text', 'Arial', 'Arial Black', 'Calibri', 'Cambria',
  'Candara', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New',
  'Ebrima', 'Franklin Gothic Medium', 'Gabriola', 'Gadugi', 'Georgia', 'Impact',
  'Ink Free', 'Javanese Text', 'Leelawadee UI', 'Lucida Console', 'Lucida Sans Unicode',
  'Malgun Gothic', 'Marlett', 'Microsoft Himalaya', 'Microsoft JhengHei',
  'Microsoft New Tai Lue', 'Microsoft PhagsPa', 'Microsoft Sans Serif',
  'Microsoft Tai Le', 'Microsoft YaHei', 'MingLiU-ExtB', 'Mongolian Baiti',
  'MS Gothic', 'MV Boli', 'Myanmar Text', 'Nirmala UI', 'Palatino Linotype',
  'Segoe Print', 'Segoe Script', 'Segoe UI Emoji', 'Segoe UI Historic',
  'Segoe UI Symbol', 'SimSun', 'Sitka', 'Sylfaen', 'Symbol', 'Tahoma',
  'Times New Roman', 'Trebuchet MS', 'Verdana', 'Webdings', 'Wingdings',
  'Yu Gothic',
];

const FALLBACK = 'Segoe UI';

interface LocalFontData {
  family: string;
}

declare global {
  interface Window {
    queryLocalFonts?: () => Promise<LocalFontData[]>;
  }
}

export async function enumerateFonts(): Promise<string[]> {
  if (typeof window.queryLocalFonts === 'function') {
    try {
      const fonts = await window.queryLocalFonts();
      const families = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
      if (families.length > 0) return families;
    } catch {
      // Permission denied or unsupported; fall through to the probe list.
    }
  }

  return PROBE_LIST.filter(isAvailable).sort((a, b) => a.localeCompare(b));
}

/**
 * `document.fonts.check` needs a size and returns true for anything the browser
 * can substitute, so compare rendered widths against a known-absent family
 * instead: a font that is really present measures differently from the fallback.
 */
let measureCtx: CanvasRenderingContext2D | null = null;

function widthOf(family: string): number {
  if (!measureCtx) {
    const canvas = document.createElement('canvas');
    measureCtx = canvas.getContext('2d');
  }
  if (!measureCtx) return 0;
  measureCtx.font = `72px "${family}", "__mw_absent__"`;
  return measureCtx.measureText('mmmmmwwwwwiiiiil').width;
}

function isAvailable(family: string): boolean {
  const baseline = widthOf('__mw_absent__');
  return widthOf(family) !== baseline;
}

/**
 * §10: on project load, if a referenced font is missing, warn and fall back to
 * the default font.
 */
export function resolveFont(family: string, available: string[]): string {
  return available.includes(family) ? family : FALLBACK;
}

export { FALLBACK as DEFAULT_FONT };
