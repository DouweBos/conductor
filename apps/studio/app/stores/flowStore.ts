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
  /** A line to jump to once its file is open, from a global-search hit. */
  reveal: { path: string; line: number } | null;
}

const store = create<FlowState>(() => ({ buffers: {}, openOrder: [], reveal: null }));

export const useOpenTabs = () => store((s) => s.openOrder);
export const useBuffer = (path: string | undefined) =>
  store((s) => (path ? s.buffers[path] : undefined));
export const useFlowBuffers = () => store((s) => s.buffers);
export const useReveal = () => store((s) => s.reveal);

/** Ask the editor to jump to a line; the pane clears it once it has. */
export function requestReveal(path: string, line: number): void {
  store.setState({ reveal: { path, line } });
}

export function clearReveal(): void {
  store.setState({ reveal: null });
}

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

/**
 * Close a tab and report which one should take over — the tab to its left, or
 * the right one when it was first. Undefined means nothing is left to show.
 * The caller routes, since the open file lives in the URL, not here.
 */
export function closeFile(path: string): string | undefined {
  const { openOrder } = store.getState();
  const index = openOrder.indexOf(path);
  store.setState((s) => {
    const { [path]: _removed, ...rest } = s.buffers;
    return { buffers: rest, openOrder: s.openOrder.filter((p) => p !== path) };
  });
  if (index < 0) return undefined;
  return openOrder[index - 1] ?? openOrder[index + 1];
}
