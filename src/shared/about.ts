/**
 * App identity, in one place (UPDATE_BUTTON.md §3 — the only file that changes
 * when this updater is lifted into another app).
 *
 * Imported by main, preload and renderer alike, so the About dialog does not
 * need an IPC round-trip to learn who wrote the app or where it lives.
 */

export const APP_NAME = 'Media Whiteboard';
export const AUTHOR = 'Darren Ng';

/** `owner/name`. The GitHub API and every link below are built from this. */
export const REPO = 'NGJHD/media-whiteboard';

/**
 * Must match electron-builder's `artifactName`
 * (`MediaWhiteboard-${version}-win-x64.zip`) — the updater picks the release
 * asset by this suffix.
 */
export const ASSET_SUFFIX = '-win-x64.zip';

export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases`;
export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

/**
 * The renderer may only send people to this app's own GitHub pages, and main
 * re-checks against this prefix before calling `shell.openExternal`. A
 * general-purpose "open any URL" bridge is a hole worth not opening.
 */
export function isOwnRepoUrl(url: string): boolean {
  return url === REPO_URL || url.startsWith(`${REPO_URL}/`);
}
