import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

// The entire renderer↔main surface is these three generic primitives. Typed
// wrappers live in app/lib/ipc.ts — the renderer never calls this directly.
const api = {
  invoke<T = unknown>(channel: string, args?: unknown): Promise<T> {
    return ipcRenderer.invoke(channel, args);
  },
  send(channel: string, args?: unknown): void {
    ipcRenderer.send(channel, args);
  },
  on<T = unknown>(channel: string, callback: (payload: T) => void): () => void {
    const listener = (_event: IpcRendererEvent, payload: T) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld("conductorStudio", api);

export type ConductorStudioApi = typeof api;
