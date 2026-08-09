import { create } from "zustand";

import { readFlow, writeFlow } from "../lib/ipc";

export interface FlowBuffer {
  path: string;
  content: string;
  dirty: boolean;
  loading: boolean;
}

interface FlowState {
  buffers: Record<string, FlowBuffer>;
  openOrder: string[];
}

const store = create<FlowState>(() => ({ buffers: {}, openOrder: [] }));

export const useOpenTabs = () => store((s) => s.openOrder);
export const useBuffer = (path: string | undefined) =>
  store((s) => (path ? s.buffers[path] : undefined));
export const useFlowBuffers = () => store((s) => s.buffers);

/** Imperative read for non-React code (e.g. the gesture recorder). */
export function getBuffer(path: string): FlowBuffer | undefined {
  return store.getState().buffers[path];
}

export function languageFor(path: string): "yaml" | "javascript" {
  return /\.(js|ts)$/.test(path) ? "javascript" : "yaml";
}

export async function openFile(path: string): Promise<void> {
  const state = store.getState();
  if (state.buffers[path]) {
    if (!state.openOrder.includes(path)) {
      store.setState((s) => ({ openOrder: [...s.openOrder, path] }));
    }
    return;
  }
  store.setState((s) => ({
    buffers: { ...s.buffers, [path]: { path, content: "", dirty: false, loading: true } },
    openOrder: s.openOrder.includes(path) ? s.openOrder : [...s.openOrder, path],
  }));
  try {
    const content = await readFlow(path);
    store.setState((s) => ({
      buffers: { ...s.buffers, [path]: { path, content, dirty: false, loading: false } },
    }));
  } catch {
    store.setState((s) => ({
      buffers: { ...s.buffers, [path]: { path, content: "", dirty: false, loading: false } },
    }));
  }
}

export function setBufferContent(path: string, content: string): void {
  store.setState((s) => {
    const buf = s.buffers[path];
    if (!buf) return s;
    return {
      buffers: { ...s.buffers, [path]: { ...buf, content, dirty: content !== buf.content ? true : buf.dirty } },
    };
  });
}

/** Append a snippet as a new step at the end of the buffer. */
export function appendToBuffer(path: string, snippet: string): void {
  const buf = store.getState().buffers[path];
  if (!buf) return;
  const sep = buf.content.endsWith("\n") || buf.content === "" ? "" : "\n";
  setBufferContent(path, `${buf.content}${sep}${snippet}\n`);
}

export async function saveFile(path: string): Promise<void> {
  const buf = store.getState().buffers[path];
  if (!buf) return;
  await writeFlow(path, buf.content);
  store.setState((s) => ({
    buffers: { ...s.buffers, [path]: { ...s.buffers[path], dirty: false } },
  }));
}

export function closeFile(path: string): void {
  store.setState((s) => {
    const { [path]: _removed, ...rest } = s.buffers;
    return { buffers: rest, openOrder: s.openOrder.filter((p) => p !== path) };
  });
}
