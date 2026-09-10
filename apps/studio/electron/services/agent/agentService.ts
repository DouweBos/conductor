import { app } from "electron";
import { mkdirSync } from "node:fs";
import path from "node:path";

import type {
  AgentPermissionRequest,
  AgentStartResult,
  AgentStatus,
} from "../../../app/lib/types";
import { broadcastToRenderers } from "../../broadcast";
import { appState } from "../../state";
import { getProjectInfo } from "../file/fileService";
import { getMcpAuthToken, getMcpPort } from "../mcp/server";
import { which } from "../util/exec";
import { ClaudeAgent } from "./claudeAgent";
import { buildAgentSystemPrompt } from "./systemPrompt";
import type { DeviceInfo } from "../../../app/lib/types";
import { listDevices } from "../conductor/conductorService";
import { endReservation, reserveDevice } from "../device/reservations";

interface AgentSession {
  agent: ClaudeAgent;
  deviceId: string | null;
  status: AgentStatus;
}

const sessions = new Map<string, ClaudeAgent>();
const meta = new Map<string, AgentSession>();
let agentSeq = 0;

export async function getAgentStatus(): Promise<{ available: boolean }> {
  const claude = await which("claude");
  return { available: claude !== null };
}

function setStatus(agentId: string, status: AgentStatus): void {
  const m = meta.get(agentId);
  if (m) m.status = status;
  broadcastToRenderers(`agent:status:${agentId}`, { status });
}

export async function startAgent(deviceId?: string, autoApprove?: boolean): Promise<AgentStartResult> {
  const claude = await which("claude");
  if (!claude) {
    throw new Error("Claude Code CLI (`claude`) not found on PATH. Install it to use the agent.");
  }
  const project = getProjectInfo();
  const cwd = project?.root ?? process.cwd();

  let device: DeviceInfo | null = null;
  if (deviceId) {
    try {
      device = (await listDevices()).find((d) => d.id === deviceId) ?? null;
    } catch {
      device = null;
    }
    // Claim the device for the life of this agent. Two agents driving one
    // device produce nonsense results, so refuse to start rather than race.
    await reserveDevice(deviceId, `the agent on ${device?.name ?? deviceId}`);
  }

  agentSeq += 1;
  const agentId = `agent-${Date.now()}-${agentSeq}`;
  const systemPrompt = await buildAgentSystemPrompt(device);

  const logDir = path.join(app.getPath("userData"), "agent-logs");
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    // best effort
  }

  const agent = new ClaudeAgent({
    agentId,
    cwd,
    systemPrompt,
    debugLogPath: path.join(logDir, `${agentId}.log`),
    autoApprove,
    mcpServers: studioMcpServer(),
  });

  agent.on("event", (line: string) => broadcastToRenderers(`agent:event:${agentId}`, line));
  agent.on("permission", (req: AgentPermissionRequest) => {
    setStatus(agentId, "awaiting-input");
    broadcastToRenderers(`agent:permission:${agentId}`, req);
  });
  agent.on("permission-cancel", (payload) =>
    broadcastToRenderers(`agent:permission-cancel:${agentId}`, payload),
  );
  agent.on("stderr", (text: string) => broadcastToRenderers(`agent:stderr:${agentId}`, text));
  agent.on("exit", (code: number) => {
    setStatus(agentId, code === 0 ? "stopped" : "error");
    broadcastToRenderers(`agent:exit:${agentId}`, { code });
    sessions.delete(agentId);
    // However the agent ended, the device goes back to the pool.
    if (deviceId) void endReservation(deviceId);
    if (appState.agentDevice?.id === deviceId) appState.agentDevice = null;
  });

  sessions.set(agentId, agent);
  meta.set(agentId, { agent, deviceId: deviceId ?? null, status: "starting" });
  // Reports stamp the device from here rather than trusting the model to retype it.
  appState.agentDevice = device;
  agent.start();
  setStatus(agentId, "running");
  return { agentId };
}

/** The Studio MCP server, injected into every agent we spawn. */
function studioMcpServer(): Record<string, unknown> {
  const port = getMcpPort();
  const token = getMcpAuthToken();
  if (!port || !token) return {};
  return {
    studio: {
      type: "http",
      url: `http://127.0.0.1:${port}/mcp`,
      headers: { Authorization: `Bearer ${token}` },
    },
  };
}

/**
 * Resolve when the agent finishes the turn it is on.
 *
 * The Claude Code stream emits one `{"type":"result"}` per turn, which is the
 * only reliable "it has stopped working" signal — token counts and tool calls
 * come and go mid-turn. A convergence loop needs it as its clock: hand the agent
 * a round of findings, wait for the turn to end, then measure.
 *
 * Rejects if the agent exits first, so a crashed agent fails the round instead
 * of hanging it forever.
 */
export interface AgentTurnResult {
  /** The agent's final text for the turn. */
  text: string;
  isError: boolean;
  durationMs?: number;
  costUsd?: number;
  turns?: number;
}

export function waitForAgentTurn(agentId: string): Promise<AgentTurnResult> {
  const agent = sessions.get(agentId);
  if (!agent) return Promise.reject(new Error("Agent is not running."));

  return new Promise((resolve, reject) => {
    const onEvent = (line: string): void => {
      // Cheap prefilter: parsing every streamed line would mean JSON.parse on
      // each token delta.
      if (!line.includes('"result"')) return;
      try {
        const parsed = JSON.parse(line) as {
          type?: string;
          result?: string;
          is_error?: boolean;
          duration_ms?: number;
          total_cost_usd?: number;
          num_turns?: number;
        };
        if (parsed.type === "result") {
          finish(() =>
            resolve({
              text: parsed.result ?? "",
              isError: parsed.is_error === true,
              durationMs: parsed.duration_ms,
              costUsd: parsed.total_cost_usd,
              turns: parsed.num_turns,
            }),
          );
        }
      } catch {
        // A partial or non-JSON line is not a turn boundary.
      }
    };
    const onExit = (code: number): void =>
      finish(() => reject(new Error(`the agent exited (code ${code}) before finishing its turn`)));

    const finish = (settle: () => void): void => {
      agent.off("event", onEvent);
      agent.off("exit", onExit);
      settle();
    };

    agent.on("event", onEvent);
    agent.on("exit", onExit);
  });
}

/** True when this agent session is still alive. */
export function isAgentRunning(agentId: string): boolean {
  return sessions.has(agentId);
}

export function sendAgentMessage(agentId: string, text: string): void {
  const agent = sessions.get(agentId);
  if (!agent) throw new Error("Agent is not running.");
  agent.send(text);
  setStatus(agentId, "running");
}

export function respondToAgentPermission(
  agentId: string,
  toolUseId: string,
  decision: "allow" | "deny",
  toolName?: string,
  allowAll?: boolean,
): void {
  const agent = sessions.get(agentId);
  if (!agent) return;
  if (allowAll && decision === "allow" && toolName) {
    agent.allowToolForSession(toolName);
  }
  agent.respondToPermission(toolUseId, decision);
  setStatus(agentId, "running");
}

export async function stopAgent(agentId: string): Promise<void> {
  const agent = sessions.get(agentId);
  if (!agent) return;
  await agent.kill();
  sessions.delete(agentId);
  setStatus(agentId, "stopped");
}

export function interruptAgent(agentId: string): void {
  sessions.get(agentId)?.interrupt();
}
