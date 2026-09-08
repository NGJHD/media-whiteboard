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
export const MEDIA_META_VERSION = 6;

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
  /**
   * Extension of the cached frame files, including the dot. Animated sources
   * decode to `.png`; a static source keeps its own container, because the
   * renderer can decode it as it stands and re-encoding it is the slowest step
   * in the import (§7).
   */
  frameExt: string;
  /**
   * Short side the preview proxies were written at, or null when this entry has
   * none (§7). Stored rather than recomputed so that changing
   * `PREVIEW_PROXY_SHORT_SIDE` invalidates entries built at the old size — a
   * tuning knob that quietly kept serving the previous value would be worse
   * than no knob.
   */
  proxyShortSide: number | null;
  /**
   * False while the background decode is still running (§7). The object is
   * already placeable — only frame 0 exists on disk — and a `MediaProgress`
   * event with `done: true` carries the completed meta.
   */
  complete: boolean;
  /** Frames written so far. Equals frameCount once `complete`. */
  readyFrames: number;
}

/**
 * Emitted while a dropped source decodes in the background, one per pending
 * item. Nothing about the import blocks on it: the object is already on the
 * canvas by the time the first of these arrives.
 */
export interface MediaProgress {
  cacheKey: string;
  readyFrames: number;
  totalFrames: number;
  done: boolean;
  /** The final metadata, once the decode succeeded. Null otherwise. */
  meta: MediaMeta | null;
  /** Set when the background decode failed; surfaced as a §14 toast. */
  error: string | null;
}

export type ImportResult =
  | { ok: true; meta: MediaMeta }
  | { ok: false; error: string };

/** §13: the project file. `schemaVersion` is present from day one. */
export interface ProjectFile {
  schemaVersion: number;
  doc: unknown;
}

export const PROJECT_SCHEMA_VERSION = 1;
export const PROJECT_EXTENSION = 'mwproj';

export type ProjectLoadResult =
  | { ok: true; path: string; data: ProjectFile }
  | { ok: false; cancelled: boolean; error: string | null };

/**
 * Per-installation conveniences that are deliberately not part of the Doc (§5):
 * they belong to this copy of the app, not to a document, so they never reach a
 * .mwproj or the undo stack.
 */
export interface Settings {
  /** §12: the last directory an output was written to. */
  lastOutputDir: string | null;
  /** §7: the last directory Add media browsed. */
  lastMediaDir: string | null;
}

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

/**
 * `proxy` asks for the reduced-resolution preview frame (§7) rather than the
 * native one. The host segment carries it so the size never has to travel in
 * the URL, in `MediaObject`, or into a saved project.
 */
export function frameUrl(cacheKey: string, index: number, proxy = false): string {
  return `${FRAME_SCHEME}://${proxy ? 'proxy' : 'frame'}/${cacheKey}/${index}`;
}

export type OutputFormat = 'webp' | 'gif' | 'mp4' | 'png';
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
  /**
   * §5's `background.transparent`. The encoder pins its pixel format and its
   * palette flags from this rather than leaving them to ffmpeg's negotiation —
   * see the notes in encoder.ts.
   */
  transparent: boolean;
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

/* -------------------------------------------------------------------------- */
/* Self-update (UPDATE_BUTTON.md)                                             */
/* -------------------------------------------------------------------------- */

/** The one shape the renderer may hand back to `installUpdate`. */
export interface UpdateAvailable {
  status: 'available';
  currentVersion: string;
  latestVersion: string;
  assetName: string;
  assetUrl: string;
  assetBytes: number;
  releaseUrl: string;
}

export type UpdateCheck =
  | { status: 'latest'; currentVersion: string; latestVersion: string }
  | UpdateAvailable
  | { status: 'error'; message: string };

/**
 * `applying` is terminal: the .cmd script has been launched and the app is
 * about to quit, so there is nothing left for the dialog to do but say so.
 */
export type UpdatePhase = 'downloading' | 'unpacking' | 'verifying' | 'applying';

export interface UpdateProgress {
  phase: UpdatePhase;
  /** Bytes written so far. Zero outside `downloading`. */
  receivedBytes: number;
  /** Content-Length, or 0 when the server did not send one. */
  totalBytes: number;
}

export interface UpdateInstallResult {
  ok: boolean;
  cancelled: boolean;
  error: string | null;
}

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
  /** Background decode progress (§7). Returns an unsubscribe function. */
  onMediaProgress(handler: (progress: MediaProgress) => void): () => void;
  /**
   * §7: abandons an entry's background decode, for when the layer it was
   * feeding is gone. Fire and forget — there is nothing to wait for.
   */
  cancelImport(cacheKey: string): void;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  /**
   * §12: the first name in this file's series that does not exist yet, so the
   * default output never silently overwrites and Generate can be pressed twice.
   */
  uniqueOutputPath(candidate: string): Promise<string>;
  /** §11: Ctrl+V with an image on the clipboard. Bytes are written to a temp
   *  file first, so the normal §7 import path handles it unchanged. */
  importClipboardImage(bytes: number[], mimeType: string): Promise<ImportResult>;
  saveProject(data: ProjectFile, suggestedPath: string): Promise<string | null>;
  openProject(): Promise<ProjectLoadResult>;
  /** Returns the subset of paths that no longer exist (§13). */
  checkSources(sourcePaths: string[]): Promise<string[]>;
  openMediaDialog(): Promise<string[]>;
  getCacheInfo(): Promise<CacheInfo>;
  clearCache(): Promise<CacheInfo>;
  chooseOutputPath(defaultPath: string, format: OutputFormat): Promise<string | null>;
  revealFile(filePath: string): Promise<void>;
  /** §14-style: never throws. A failure comes back as `{ status: 'error' }`. */
  checkForUpdate(): Promise<UpdateCheck>;
  /**
   * Downloads, verifies and applies the release `checkForUpdate` offered. On
   * success it does not resolve in any useful sense — the app quits so the
   * .cmd script can replace the folder it is running from.
   */
  installUpdate(target: UpdateAvailable): Promise<UpdateInstallResult>;
  /** Aborts an in-flight download. No-op once unpacking has started. */
  cancelUpdate(): void;
  /** Download progress. Returns an unsubscribe function. */
  onUpdateProgress(handler: (progress: UpdateProgress) => void): () => void;
  /** Opens a link in the user's browser. Main rejects anything outside this
   *  app's own GitHub pages. */
  openRepoLink(url: string): Promise<void>;
  /** §12: returns false when the user declines to overwrite. */
  confirmOverwrite(filePath: string): Promise<boolean>;
}

declare global {
  interface Window {
    api: Api;
  }
}
