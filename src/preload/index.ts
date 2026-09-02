import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Api, EncodeRequest, OutputFormat, ProjectFile } from '../shared/ipc';

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
} satisfies Omit<Api, 'startExport'> & { startExport: typeof startExport };

contextBridge.exposeInMainWorld('api', api);
