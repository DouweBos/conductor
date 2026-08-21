import { create } from "zustand";

import type { AgentPermissionRequest, AgentStatus, ConversationItem } from "../lib/types";

interface AgentState {
  agentId: string | null;
  status: AgentStatus;
  items: ConversationItem[];
  permission: AgentPermissionRequest | null;
  error: string | null;
  eventSeq: number;
  /** A prompt handed over from elsewhere, e.g. a failed run to fix. */
  pendingPrompt: string | null;
}

const store = create<AgentState>(() => ({
  agentId: null,
  status: "idle",
  pendingPrompt: null,
  items: [],
  permission: null,
  error: null,
  eventSeq: 0,
}));

export const usePendingPrompt = () => store((s) => s.pendingPrompt);

/** A prompt composed elsewhere (e.g. "fix this failed run") for the agent view. */
export function setPendingPrompt(prompt: string | null): void {
  store.setState({ pendingPrompt: prompt });
}

export const useAgentId = () => store((s) => s.agentId);
export const useAgentStatus = () => store((s) => s.status);
export const useAgentItems = () => store((s) => s.items);
export const useAgentPermission = () => store((s) => s.permission);
export const useAgentError = () => store((s) => s.error);

export function getAgentSeq(): number {
  const seq = store.getState().eventSeq;
  store.setState({ eventSeq: seq + 1 });
  return seq;
}

export function startSession(agentId: string): void {
  store.setState({ agentId, status: "running", items: [], permission: null, error: null });
}

export function setAgentStatus(status: AgentStatus): void {
  store.setState({ status });
}

export function addItems(items: ConversationItem[]): void {
  if (items.length === 0) return;
  store.setState((s) => ({ items: [...s.items, ...items] }));
}

export function setPermission(permission: AgentPermissionRequest | null): void {
  store.setState({ permission });
}

export function setAgentError(error: string): void {
  store.setState({ error });
}

export function endSession(): void {
  store.setState({ agentId: null, status: "stopped", permission: null });
}
