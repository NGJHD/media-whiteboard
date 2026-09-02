import { app, BrowserWindow, Menu, ipcMain, shell } from 'electron';
import path from 'node:path';
import type { AppInfo } from '../shared/ipc';
import { applyPaths, resolvePaths } from './paths';

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
    win.webContents.openDevTools({ mode: 'detach' });
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
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
