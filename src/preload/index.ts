import { contextBridge, ipcRenderer } from 'electron';
import type { Api } from '../shared/ipc';

// contextIsolation is on, so the renderer sees only what is listed here.
const api: Api = {
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
};

contextBridge.exposeInMainWorld('api', api);
