import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AppInfo, FfmpegInfo, OutputFormat } from '../shared/ipc';
import { registerExportHandler } from './export';
import { binaries } from './ffmpeg';
import { applyPaths, resolvePaths } from './paths';

const execFileAsync = promisify(execFile);

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = Boolean(DEV_SERVER_URL);

/** dist/main/ at runtime; dist/ is one level up. Bundled to CJS, so __dirname exists. */
const distDir = __dirname;

// Before anything else: Electron caches its paths at startup, and the defaults
// write to %APPDATA%, which §1 forbids.
const paths = resolvePaths(isDev, distDir);
applyPaths(paths);

// The app has its own top bar (§9). The stock File/Edit/View menu is not part of it.
Menu.setApplicationMenu(null);

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 600,
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
  appVersion: app.getVersion(),
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
    const result = await dialog.showSaveDialog({
      defaultPath,
      filters: [
        format === 'webp'
          ? { name: 'Animated WebP', extensions: ['webp'] }
          : { name: 'Animated GIF', extensions: ['gif'] },
      ],
    });
    return result.canceled || !result.filePath ? null : result.filePath;
  },
);

ipcMain.handle('shell:revealFile', (_e, filePath: string) => {
  shell.showItemInFolder(filePath);
});

registerExportHandler(() => paths.cacheDir);

/**
 * Drives one real export through the renderer and reports the result, so the
 * export pipe can be tested without simulating UI clicks. Dev builds only —
 * `__mwProbe` does not exist in a packaged renderer.
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

  try {
    const result = await win.webContents.executeJavaScript(
      `window.__mwProbe(${spec}).then(r => JSON.stringify(r), e => JSON.stringify({ ok:false, error:String((e && e.message) || e), detail:(e && e.detail) || null }))`,
    );
    clearTimeout(guard);
    report(JSON.parse(result));
  } catch (err) {
    clearTimeout(guard);
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

  void app.whenReady().then(() => {
    createWindow();
    if (process.env.MW_SMOKE) void runSmoke();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
