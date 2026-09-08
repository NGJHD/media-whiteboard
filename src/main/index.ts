import { app, BrowserWindow, Menu, dialog, ipcMain, shell, type WebContents } from 'electron';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isOwnRepoUrl } from '../shared/about';
import { formatSpec } from '../shared/formats';
import {
  PROJECT_EXTENSION,
  type AppInfo,
  type CacheInfo,
  type FfmpegInfo,
  type ImportResult,
  type MediaProgress,
  type OutputFormat,
  type ProjectFile,
  type ProjectLoadResult,
  type Settings,
  type UpdateAvailable,
  type UpdateCheck,
  type UpdateInstallResult,
  type UpdateProgress,
} from '../shared/ipc';
import { registerExportHandler } from './export';
import { binaries } from './ffmpeg';
import { forgetFrameExtension, registerFrameScheme, serveFrames } from './frameProtocol';
import {
  ACCEPTED_EXTENSIONS,
  CACHE_LIMIT_BYTES,
  clearCache,
  evictCache,
  cancelDecode,
  importClipboardImage,
  importMedia,
  listCache,
  stopDecodes,
  sweepPartials,
} from './media';
import { applyPaths, resolvePaths } from './paths';
import { cancelUpdate, checkForUpdate, installUpdate, resolveAppVersion } from './updater';
import { getSettings, initSettings, patchSettings, uniquePath } from './settings';

const execFileAsync = promisify(execFile);

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = Boolean(DEV_SERVER_URL);

/** dist/main/ at runtime; dist/ is one level up. Bundled to CJS, so __dirname exists. */
const distDir = __dirname;

// Before anything else: Electron caches its paths at startup, and the defaults
// write to %APPDATA%, which §1 forbids.
const paths = resolvePaths(isDev, distDir);
applyPaths(paths);
initSettings(paths.userData);

// The app has its own top bar (§9). The stock File/Edit/View menu is not part of it.
Menu.setApplicationMenu(null);

// Privileged schemes must be declared before the app is ready.
registerFrameScheme();

function createWindow(): void {
  // MW_SMOKE_SIZE lets a smoke run open the window at the §9 minimum, which is
  // the size the single-row top bar has to survive.
  const size = (process.env.MW_SMOKE_SIZE ?? '').split('x').map(Number);
  const smokeWidth = size[0] ?? 0;
  const smokeHeight = size[1] ?? 0;

  const win = new BrowserWindow({
    width: smokeWidth > 0 ? smokeWidth : 1600,
    height: smokeHeight > 0 ? smokeHeight : 1000,
    // The single-row top bar (§9) is laid out for this width; below it the
    // options strip would scroll permanently.
    minWidth: 1280,
    minHeight: 720,
    // Packaged, the icon is compiled into the exe by electron-builder; in dev
    // there is no exe, so point the window at the source PNG.
    ...(isDev ? { icon: path.join(distDir, '..', '..', 'build', 'icon.png') } : {}),
    backgroundColor: '#1b1d21',
    show: false,
    webPreferences: {
      preload: path.join(distDir, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // External links open in the user's browser, never in an app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.key === 'F12' && input.type === 'keyDown') win.webContents.toggleDevTools();
    });
  }

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL);
    if (!process.env.MW_SMOKE) win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(path.join(distDir, '..', 'renderer', 'index.html'));
  }
}

ipcMain.handle('app:getInfo', (): AppInfo => ({
  appVersion: resolveAppVersion(paths.appFolder),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  appFolder: paths.appFolder,
  userData: paths.userData,
  cacheDir: paths.cacheDir,
  usingFallback: paths.usingFallback,
  fallbackReason: paths.fallbackReason,
  isDev,
}));

ipcMain.handle('app:getFfmpegInfo', async (): Promise<FfmpegInfo> => {
  try {
    const { ffmpeg } = binaries();
    const { stdout } = await execFileAsync(ffmpeg, ['-hide_banner', '-version']);
    const version = stdout.split('\n')[0]?.trim() ?? null;
    return { ok: true, version, error: null };
  } catch (err) {
    return { ok: false, version: null, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle(
  'dialog:chooseOutputPath',
  async (_e, defaultPath: string, format: OutputFormat): Promise<string | null> => {
    const spec = formatSpec(format);
    const result = await dialog.showSaveDialog({
      defaultPath,
      filters: [
        { name: `${spec.label} (.${spec.extension})`, extensions: [spec.extension] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePath) return null;
    // Feedback item 22: the next launch starts in the folder used last.
    patchSettings({ lastOutputDir: path.dirname(result.filePath) });
    return result.filePath;
  },
);

ipcMain.handle('shell:revealFile', (_e, filePath: string) => {
  shell.showItemInFolder(filePath);
});

/** §12: prompt before overwriting an existing file. */
ipcMain.handle('dialog:confirmOverwrite', async (_e, filePath: string): Promise<boolean> => {
  try {
    await fsp.access(filePath);
  } catch {
    return true; // nothing there to overwrite
  }

  const [win] = BrowserWindow.getAllWindows();
  const options = {
    type: 'question' as const,
    buttons: ['Replace', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Replace file?',
    message: `${path.basename(filePath)} already exists.`,
    detail: 'Generating will overwrite it.',
  };
  const result = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  return result.response === 0;
});

registerExportHandler(() => paths.cacheDir);

/**
 * §7: resolves as soon as the first frame exists. The rest of the decode reports
 * itself over `media:progress`, addressed to whichever window asked for it.
 */
ipcMain.handle('media:import', (event, sourcePath: string): Promise<ImportResult> =>
  importMedia({
    cacheDir: paths.cacheDir,
    sourcePath,
    onProgress: (progress) => sendProgress(event.sender, progress),
  }),
);

function sendProgress(sender: WebContents, progress: MediaProgress): void {
  if (sender.isDestroyed()) return;
  sender.send('media:progress', progress);
}

ipcMain.handle('media:openDialog', async (): Promise<string[]> => {
  const lastDir = getSettings().lastMediaDir;
  const result = await dialog.showOpenDialog({
    // Feedback item 23: reopen where the user last picked media from.
    ...(lastDir ? { defaultPath: lastDir } : {}),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Media', extensions: ACCEPTED_EXTENSIONS.map((e) => e.slice(1)) }],
  });
  if (result.canceled || result.filePaths.length === 0) return [];
  patchSettings({ lastMediaDir: path.dirname(result.filePaths[0]!) });
  return result.filePaths;
});

ipcMain.on('media:cancelImport', (_e, cacheKey: string) => {
  if (!/^[a-f0-9]{16}$/.test(cacheKey)) return;
  void cancelDecode(paths.cacheDir, cacheKey).then(() => forgetFrameExtension(cacheKey));
});

ipcMain.handle('settings:get', (): Settings => getSettings());
ipcMain.handle('settings:set', (_e, patch: Partial<Settings>): Settings => patchSettings(patch));
ipcMain.handle('fs:uniqueOutputPath', (_e, candidate: string): string => uniquePath(candidate));

async function cacheInfo(): Promise<CacheInfo> {
  const entries = await listCache(paths.cacheDir);
  return {
    dir: paths.cacheDir,
    bytes: entries.reduce((sum, e) => sum + e.bytes, 0),
    entries: entries.length,
    limitBytes: CACHE_LIMIT_BYTES,
  };
}

ipcMain.handle(
  'media:importClipboardImage',
  (event, bytes: number[], mimeType: string): Promise<ImportResult> =>
    importClipboardImage(paths.cacheDir, Buffer.from(bytes), mimeType, (progress) =>
      sendProgress(event.sender, progress),
    ),
);

/* -- Project files (§13) --------------------------------------------------- */

ipcMain.handle(
  'project:save',
  async (_e, data: ProjectFile, suggestedPath: string): Promise<string | null> => {
    const result = await dialog.showSaveDialog({
      defaultPath: suggestedPath,
      filters: [{ name: 'Media Whiteboard project', extensions: [PROJECT_EXTENSION] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fsp.writeFile(result.filePath, JSON.stringify(data, null, 2), 'utf8');
    return result.filePath;
  },
);

ipcMain.handle('project:open', async (): Promise<ProjectLoadResult> => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Media Whiteboard project', extensions: [PROJECT_EXTENSION] }],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, cancelled: true, error: null };
  }
  const file = result.filePaths[0]!;
  try {
    const data = JSON.parse(await fsp.readFile(file, 'utf8')) as ProjectFile;
    return { ok: true, path: file, data };
  } catch (err) {
    return { ok: false, cancelled: false, error: `Could not read ${file}: ${String(err)}` };
  }
});

/** §13: a layer whose source file has vanished is dropped, not prompted for. */
ipcMain.handle('project:checkSources', async (_e, sourcePaths: string[]): Promise<string[]> => {
  const missing: string[] = [];
  for (const source of sourcePaths) {
    try {
      await fsp.access(source);
    } catch {
      missing.push(source);
    }
  }
  return missing;
});

/* -- Self-update (UPDATE_BUTTON.md) ---------------------------------------- */

ipcMain.handle('update:check', (): Promise<UpdateCheck> => checkForUpdate(paths.appFolder));

ipcMain.handle(
  'update:install',
  (event, target: UpdateAvailable): Promise<UpdateInstallResult> =>
    installUpdate(target, (progress: UpdateProgress) => {
      if (!event.sender.isDestroyed()) event.sender.send('update:progress', progress);
    }),
);

ipcMain.on('update:cancel', () => cancelUpdate());

/**
 * The renderer may only send people to this app's own GitHub pages, and the URL
 * is re-checked here rather than trusted. A general-purpose "open any URL"
 * bridge is a hole worth not opening.
 */
ipcMain.handle('update:openLink', async (_e, url: string): Promise<void> => {
  if (isOwnRepoUrl(url)) await shell.openExternal(url);
});

ipcMain.handle('cache:info', cacheInfo);
ipcMain.handle('cache:clear', async (): Promise<CacheInfo> => {
  await clearCache(paths.cacheDir);
  return cacheInfo();
});

/**
 * Evaluates MW_SMOKE as an expression in the renderer and reports what it
 * resolves to, so any renderer-side flow can be tested without simulating
 * clicks. Dev builds only — the `__mw*` hooks it calls do not exist in a
 * packaged renderer.
 *
 * The result goes to a file rather than stdout: an Electron GUI process on
 * Windows does not reliably attach to a parent console, so a piped console.log
 * is silently lost and every failure looks like a hang.
 */
async function runSmoke(): Promise<void> {
  const spec = process.env.MW_SMOKE ?? '';
  const resultPath = process.env.MW_SMOKE_OUT;
  const rendererLog: string[] = [];

  const report = (value: unknown) => {
    const json = JSON.stringify(
      typeof value === 'object' && value !== null ? { ...value, log: rendererLog.slice(-40) } : value,
    );
    if (resultPath) {
      try {
        writeFileSync(resultPath, json, 'utf8');
      } catch {
        // fall through to the log below
      }
    }
    console.log(`SMOKE_RESULT ${json}`);
    app.exit(0);
  };

  const [win] = BrowserWindow.getAllWindows();
  if (!win) return report({ ok: false, error: 'no window' });

  // Renderer console output is the only view into where an export stalls.
  win.webContents.on('console-message', (event) => {
    rendererLog.push(`[${event.level}] ${event.message}`);
    if (rendererLog.length > 100) rendererLog.shift();
  });

  win.webContents.on('did-fail-load', (_e, code, description, url) =>
    report({ ok: false, error: `did-fail-load ${code} ${description} ${url}` }),
  );
  win.webContents.on('render-process-gone', (_e, details) =>
    report({ ok: false, error: `renderer gone: ${details.reason}` }),
  );
  // Never hang: a smoke run that produces nothing is worse than one that fails.
  const guard = setTimeout(() => report({ ok: false, error: 'smoke timed out in main' }), 90_000);

  if (win.webContents.isLoading()) {
    await new Promise<void>((resolve) => win.webContents.once('did-finish-load', () => resolve()));
  }

  // MW_SMOKE_SHOT captures the window once the expression has settled. Layout
  // is the one thing an assertion cannot check for you, and a screenshot from
  // the real window is cheaper than describing what it should look like.
  const shotPath = process.env.MW_SMOKE_SHOT;
  const capture = async () => {
    if (!shotPath) return;
    try {
      const image = await win.webContents.capturePage();
      writeFileSync(shotPath, image.toPNG());
    } catch {
      // A capture failure must not fail the run it was only observing.
    }
  };

  try {
    const result = await win.webContents.executeJavaScript(
      `Promise.resolve().then(() => (${spec})).then(
         r => JSON.stringify(r ?? { ok: true }),
         e => JSON.stringify({ ok: false, error: String((e && e.message) || e), detail: (e && e.detail) || null }),
       )`,
    );
    clearTimeout(guard);
    await capture();
    report(JSON.parse(result));
  } catch (err) {
    clearTimeout(guard);
    await capture();
    report({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

// Single instance: a second launch focuses the existing window instead of
// opening a rival one that would fight over the same cache folder.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(async () => {
    serveFrames(() => paths.cacheDir);
    // §7: tidy up after any decode that was killed, then LRU-evict, both before
    // anything can add to the cache.
    await sweepPartials(paths.cacheDir).catch(() => {});
    await evictCache(paths.cacheDir).catch(() => 0);
    createWindow();
    if (process.env.MW_SMOKE) void runSmoke();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // A background decode outliving the window would keep writing into the cache
  // of an app that is gone.
  app.on('before-quit', stopDecodes);
  app.on('window-all-closed', () => app.quit());
}
