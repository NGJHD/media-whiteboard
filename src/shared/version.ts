/**
 * Version arithmetic and release-asset selection (UPDATE_BUTTON.md §3, §5).
 *
 * Deliberately pure: no Electron, no fs, no fetch. That is what lets
 * `scripts/smoke-update.mjs` exercise every branch without launching the app —
 * and these are exactly the comparisons that are wrong when done as strings
 * (`"1.10.0" > "1.9.0"` is false).
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

/** Accepts `1.2.3` and `v1.2.3`, with anything after the patch ignored. */
export function parseVersion(raw: string | null | undefined): Version | null {
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(raw ?? '');
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/**
 * True only when `candidate` parses, `current` parses, and the first is
 * strictly greater. An unparseable tag answers *not newer*: never offer an
 * update that cannot be reasoned about (§5).
 */
export function isNewer(candidate: string | null | undefined, current: string | null | undefined): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  return compareVersions(a, b) > 0;
}

/** Same three numbers, whatever the `v` prefix or trailing junk. Used by the
 *  post-unpack verification, where a disagreement is a hard stop (§4.5). */
export function sameVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  return compareVersions(x, y) === 0;
}

export interface ReleaseAsset {
  name: string;
  /** GitHub's `browser_download_url`. */
  url: string;
  size: number;
}

/**
 * Picks the zip to download. A release built by this project has exactly one
 * asset and its name ends in `assetSuffix`, so that is preferred; a lone `.zip`
 * under some other name is accepted as a fallback, and anything ambiguous
 * (several zips, none matching) answers null rather than guessing.
 */
export function pickReleaseAsset(
  assets: readonly ReleaseAsset[] | null | undefined,
  assetSuffix: string,
): ReleaseAsset | null {
  const usable = (assets ?? []).filter((a) => a && typeof a.url === 'string' && a.size > 0);

  const suffixed = usable.filter((a) => a.name.toLowerCase().endsWith(assetSuffix.toLowerCase()));
  if (suffixed.length === 1) return suffixed[0]!;
  if (suffixed.length > 1) return null;

  const zips = usable.filter((a) => a.name.toLowerCase().endsWith('.zip'));
  return zips.length === 1 ? zips[0]! : null;
}
