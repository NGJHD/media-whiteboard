/**
 * The typed surface between renderer and main. Both sides import from here, so a
 * change to a channel's shape is a compile error on the side that did not follow.
 */

export interface AppInfo {
  appVersion: string;
  electron: string;
  chrome: string;
  node: string;
  /** Directory the app is running from. Everything the app writes lives under here. */
  appFolder: string;
  /** Electron/Chromium state. Redirected out of %APPDATA% to honour §1. */
  userData: string;
  /** Decoded frame cache (§7). */
  cacheDir: string;
  /** True when appFolder was not writable and the temp dir is in use instead. */
  usingFallback: boolean;
  /** Why the fallback kicked in. Null when not applicable. */
  fallbackReason: string | null;
  /** True when running against the Vite dev server. */
  isDev: boolean;
}

export interface Api {
  getAppInfo(): Promise<AppInfo>;
}

declare global {
  interface Window {
    api: Api;
  }
}
