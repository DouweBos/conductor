/// <reference types="vite/client" />

export interface ConductorStudioApi {
  invoke<T = unknown>(channel: string, args?: unknown): Promise<T>;
  send(channel: string, args?: unknown): void;
  on<T = unknown>(channel: string, callback: (payload: T) => void): () => void;
}

declare global {
  interface Window {
    conductorStudio: ConductorStudioApi;
  }
}
