import type { AgentPermissionRequest, AgentStatus } from "../lib/types";
import { parseStreamEvent } from "../lib/streamParse";
import {
  addItems,
  getAgentSeq,
  setAgentError,
  setAgentStatus,
  setPermission,
} from "../stores/agentStore";
import { useIpcEvent } from "./useIpcEvent";

/** Wire an agent's backend push channels into the agent store. */
export function useAgentEvents(agentId: string | null): void {
  useIpcEvent<string>(agentId ? `agent:event:${agentId}` : null, (line) => {
    addItems(parseStreamEvent(line, getAgentSeq()));
  });
  useIpcEvent<{ status: AgentStatus }>(agentId ? `agent:status:${agentId}` : null, (p) => {
    setAgentStatus(p.status);
  });
  useIpcEvent<AgentPermissionRequest>(agentId ? `agent:permission:${agentId}` : null, (req) => {
    setPermission(req);
  });
  useIpcEvent<{ requestId: string }>(agentId ? `agent:permission-cancel:${agentId}` : null, () => {
    setPermission(null);
  });
  useIpcEvent<string>(agentId ? `agent:stderr:${agentId}` : null, (text) => {
    if (/error|not found|failed/i.test(text)) setAgentError(text);
  });
}
