// Subscribe to a backend → renderer push channel. Returns an unlisten function.
export function listen<T = unknown>(channel: string, handler: (payload: T) => void): () => void {
  return window.conductorStudio.on<T>(channel, handler);
}
