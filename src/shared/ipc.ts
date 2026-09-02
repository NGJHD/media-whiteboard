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

export interface FfmpegInfo {
  ok: boolean;
  version: string | null;
  error: string | null;
}

/* -------------------------------------------------------------------------- */
/* Media import (§7)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Bumped whenever the meaning of anything in MediaMeta changes, so cache entries
 * written by an older build are re-decoded instead of silently serving stale
 * metadata. The cache key covers the *source file*, not the decoder.
 */
export const MEDIA_META_VERSION = 2;

/** Written as meta.json beside the decoded frames. */
export interface MediaMeta {
  metaVersion: number;
  cacheKey: string;
  sourcePath: string;
  frameCount: number;
  /** Native timing. Length === frameCount. `[0]` for a static image. */
  frameDurationsMs: number[];
  nativeWidth: number;
  nativeHeight: number;
}

export type ImportResult =
  | { ok: true; meta: MediaMeta }
  | { ok: false; error: string };

export interface CacheInfo {
  dir: string;
  bytes: number;
  entries: number;
  limitBytes: number;
}

/**
 * Frames are served over a custom scheme rather than copied through IPC, so the
 * renderer can hand a URL straight to `createImageBitmap` without the bytes
 * crossing the process boundary as a message.
 */
export const FRAME_SCHEME = 'mwframe';

export function frameUrl(cacheKey: string, index: number): string {
  return `${FRAME_SCHEME}://frame/${cacheKey}/${index}`;
}

export type OutputFormat = 'webp' | 'gif';
export type Quality = 'low' | 'medium' | 'high';

export interface EncodeRequest {
  width: number;
  height: number;
  fps: number;
  /** Total frames the renderer will send. Static output (§12) is frameCount 1. */
  frameCount: number;
  format: OutputFormat;
  quality: Quality;
  outputPath: string;
}

/** Weighted across the three GIF passes; WebP only ever reports 'rendering'. */
export type ExportPhase = 'rendering' | 'palette' | 'encoding';

export interface ExportProgress {
  phase: ExportPhase;
  /** 0..1 across the whole export, not just the current phase. */
  progress: number;
}

export interface ExportResult {
  ok: boolean;
  outputPath: string;
  bytes: number;
  /** Wall-clock milliseconds, for the size/time estimate in §12. */
  elapsedMs: number;
  cancelled: boolean;
  error: string | null;
  /** Last ~10 lines of ffmpeg stderr when it failed (§14). */
  detail: string | null;
}

/* -------------------------------------------------------------------------- */
/* Frame channel                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Messages on the MessagePort that carries frames to main. §3 requires the pixel
 * buffer to move by transfer rather than through `ipcRenderer.invoke`, which
 * structured-clones several MB per frame.
 *
 * Every frame is acknowledged before the next is rendered. That is what carries
 * ffmpeg's stdin backpressure across the process boundary: main only acks once
 * the pipe has accepted the write, so a slow encoder throttles the render loop
 * instead of letting memory balloon (§3).
 */
export type FrameMessage =
  | { type: 'frame'; index: number; buffer: ArrayBuffer }
  | { type: 'finish' }
  | { type: 'cancel' };

export type FrameReply =
  | { type: 'ack'; index: number }
  | { type: 'progress'; phase: ExportPhase; progress: number }
  | { type: 'done'; result: ExportResult }
  | { type: 'error'; message: string; detail: string | null };

export interface Api {
  getAppInfo(): Promise<AppInfo>;
  getFfmpegInfo(): Promise<FfmpegInfo>;
  /**
   * Opens an export and resolves with its id. The frame `MessagePort` cannot be
   * returned directly — contextBridge clones rather than transfers — so it
   * arrives as a `window.postMessage` carrying `{ __mwExportPort: id }` with the
   * port in `event.ports[0]`. `openExportChannel` in the renderer pairs the two.
   */
  startExport(request: EncodeRequest): Promise<string>;
  /** Resolves the OS path of a dropped File (Electron removed File.path). */
  pathForFile(file: File): string;
  importMedia(sourcePath: string): Promise<ImportResult>;
  openMediaDialog(): Promise<string[]>;
  getCacheInfo(): Promise<CacheInfo>;
  clearCache(): Promise<CacheInfo>;
  chooseOutputPath(defaultPath: string, format: OutputFormat): Promise<string | null>;
  revealFile(filePath: string): Promise<void>;
}

declare global {
  interface Window {
    api: Api;
  }
}
