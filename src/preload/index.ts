import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  Api,
  EncodeRequest,
  MediaProgress,
  OutputFormat,
  ProjectFile,
  Settings,
} from '../shared/ipc';

/**
 * contextIsolation is on, so the renderer sees only what is listed here.
 *
 * The export frame channel needs a MessagePort in the main world, and
 * contextBridge cannot carry one — it structured-clones everything it passes,
 * which is exactly what §3 is trying to avoid for pixel buffers. `window.postMessage`
 * can transfer a port across the world boundary, so the port is handed over that
 * way and correlated with the id `startExport` resolves to.
 */

export const EXPORT_PORT_MESSAGE = '__mwExportPort';

async function startExport(request: EncodeRequest): Promise<string> {
  const id = crypto.randomUUID();
  const { port1, port2 } = new MessageChannel();

  // port2 goes to main; port1 goes to the renderer's main world.
  ipcRenderer.postMessage('export:start', { id, request }, [port2]);
  window.postMessage({ [EXPORT_PORT_MESSAGE]: id }, '*', [port1]);

  return id;
}

const api = {
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
  getFfmpegInfo: () => ipcRenderer.invoke('app:getFfmpegInfo'),
  startExport,
  // Electron removed File.path; this is the supported replacement.
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  importMedia: (sourcePath: string) => ipcRenderer.invoke('media:import', sourcePath),
  // A push channel rather than a poll: main knows exactly when ffmpeg has
  // written another frame, and the renderer has nothing useful to ask for in
  // between. The unsubscribe keeps the listener off `ipcRenderer` forever.
  onMediaProgress: (handler: (progress: MediaProgress) => void) => {
    const listener = (_event: unknown, progress: MediaProgress) => handler(progress);
    ipcRenderer.on('media:progress', listener);
    return () => {
      ipcRenderer.removeListener('media:progress', listener);
    };
  },
  cancelImport: (cacheKey: string) => ipcRenderer.send('media:cancelImport', cacheKey),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:set', patch),
  uniqueOutputPath: (candidate: string) => ipcRenderer.invoke('fs:uniqueOutputPath', candidate),
  importClipboardImage: (bytes: number[], mimeType: string) =>
    ipcRenderer.invoke('media:importClipboardImage', bytes, mimeType),
  saveProject: (data: ProjectFile, suggestedPath: string) =>
    ipcRenderer.invoke('project:save', data, suggestedPath),
  openProject: () => ipcRenderer.invoke('project:open'),
  checkSources: (sourcePaths: string[]) => ipcRenderer.invoke('project:checkSources', sourcePaths),
  openMediaDialog: () => ipcRenderer.invoke('media:openDialog'),
  getCacheInfo: () => ipcRenderer.invoke('cache:info'),
  clearCache: () => ipcRenderer.invoke('cache:clear'),
  chooseOutputPath: (defaultPath: string, format: OutputFormat) =>
    ipcRenderer.invoke('dialog:chooseOutputPath', defaultPath, format),
  revealFile: (filePath: string) => ipcRenderer.invoke('shell:revealFile', filePath),
  confirmOverwrite: (filePath: string) => ipcRenderer.invoke('dialog:confirmOverwrite', filePath),
} satisfies Omit<Api, 'startExport'> & { startExport: typeof startExport };

contextBridge.exposeInMainWorld('api', api);
