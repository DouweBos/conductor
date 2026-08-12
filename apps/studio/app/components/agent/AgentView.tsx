import {
  Button,
  ChatMessage,
  EmptyState,
  Icon,
  StatusPill,
  ToolCallCard,
  type StatusTone,
} from "@conductor/studio-ui";
import { useEffect, useRef, useState } from "react";

import { useAgentEvents } from "../../hooks/useAgentEvents";
import {
  agentStatus as fetchAgentStatus,
  respondAgentPermission,
  sendAgentMessage,
  startAgent,
  stopAgent,
} from "../../lib/ipc";
import type { AgentStatus, ConversationItem } from "../../lib/types";
import {
  setPermission,
  startSession,
  useAgentId,
  useAgentItems,
  useAgentPermission,
  useAgentStatus,
  usePendingPrompt,
  setPendingPrompt,
} from "../../stores/agentStore";
import { getSelectedDevice, refreshDevices } from "../../stores/deviceStore";
import { DevicePanel } from "../flows/DevicePanel";
import { TestRunPanel } from "./TestRunPanel";
import styles from "./AgentView.module.css";

const STATUS_TONE: Record<AgentStatus, StatusTone> = {
  idle: "neutral",
  starting: "running",
  running: "running",
  "awaiting-input": "warning",
  stopped: "neutral",
  error: "error",
};

export function AgentView() {
  const agentId = useAgentId();
  const status = useAgentStatus();
  const items = useAgentItems();
  const permission = useAgentPermission();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const pending = usePendingPrompt();
  const [startError, setStartError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useAgentEvents(agentId);

  useEffect(() => {
    fetchAgentStatus().then((s) => setAvailable(s.available)).catch(() => setAvailable(false));
    void refreshDevices();
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [items, permission]);

  // A failed run handed over from the workbench: load it, don't send it — the
  // engineer gets to read and edit before the agent starts touching the app.
  useEffect(() => {
    if (!pending) return;
    setDraft(pending);
    setPendingPrompt(null);
  }, [pending]);

  const begin = async (prompt: string) => {
    const device = getSelectedDevice();
    setStartError(null);
    try {
      const { agentId: id } = await startAgent(device?.id, false);
      startSession(id);
      if (prompt.trim()) {
        // Give the CLI a tick to finish its initialize handshake.
        setTimeout(() => void sendAgentMessage(id, prompt.trim()), 400);
      }
      setDraft("");
    } catch (err) {
      setStartError(String(err));
    }
  };

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    if (!agentId) {
      void begin(text);
      return;
    }
    void sendAgentMessage(agentId, text);
    setDraft("");
  };

  const respond = (decision: "allow" | "deny", allowAll = false) => {
    if (!agentId || !permission) return;
    void respondAgentPermission(
      agentId,
      permission.toolUseId,
      decision,
      permission.toolName,
      allowAll,
    );
    setPermission(null);
  };

  const running = agentId !== null && status !== "stopped" && status !== "error";

  return (
    <div className={styles.layout}>
      <div className={styles.view}>
        <header className={styles.header}>
          <div className={styles.headTitle}>
            <Icon name="agent" size={18} />
            <span>Agentic test writing</span>
          </div>
          {agentId ? <StatusPill tone={STATUS_TONE[status]} pulse={status === "running"}>{status}</StatusPill> : null}
          <div className={styles.spacer} />
          {available === false ? <StatusPill tone="warning">Claude Code not on PATH</StatusPill> : null}
          {running ? (
            <Button size="sm" variant="secondary" icon="stop" onClick={() => agentId && void stopAgent(agentId)}>
              Stop
            </Button>
          ) : null}
        </header>

        {/* The plan, ticking over — above the transcript, because it's the result. */}
        <TestRunPanel />

        <div className={styles.conversation}>
          {!agentId && items.length === 0 ? (
            <EmptyState
              icon="agent"
              title="Describe the test you want"
              description="The agent drives the app through conductor, reuses your Maestro subflow POMs, and writes flows. Connect a device first for it to interact."
            />
          ) : (
            items.map((item) => <ConversationRow key={item.id} item={item} />)
          )}
          {startError ? <div className={styles.error}>{startError}</div> : null}
          <div ref={endRef} />
        </div>

        {permission ? (
          <div className={styles.permission}>
            <div className={styles.permText}>
              <strong>{permission.toolName}</strong> wants to run
              {summaryOf(permission.toolInput)
                ? `: ${summaryOf(permission.toolInput)}`
                : ""}
            </div>
            <div className={styles.permActions}>
              <Button size="sm" variant="ghost" onClick={() => respond("deny")}>
                Deny
              </Button>
              <Button size="sm" variant="secondary" onClick={() => respond("allow", true)}>
                Allow all {permission.toolName}
              </Button>
              <Button size="sm" variant="primary" onClick={() => respond("allow")}>
                Allow
              </Button>
            </div>
          </div>
        ) : null}

        <div className={styles.composer}>
          <textarea
            className={styles.input}
            placeholder={agentId ? "Message the agent…" : "Describe a test to write, then press Enter to start…"}
            value={draft}
            rows={2}
            disabled={available === false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <Button variant="primary" icon={agentId ? "flow" : "agent"} onClick={send} disabled={available === false}>
            {agentId ? "Send" : "Start"}
          </Button>
        </div>
      </div>
      {/* Watch the agent drive the device while it works. */}
      <div className={styles.device}>
        <DevicePanel showRecord={false} showInspector={false} />
      </div>
    </div>
  );
}

function ConversationRow({ item }: { item: ConversationItem }) {
  switch (item.kind) {
    case "text":
      return <ChatMessage role={item.role}>{item.text}</ChatMessage>;
    case "tool_use":
      return (
        <ToolCallCard
          name={item.name}
          summary={summaryOf(item.input)}
          detail={JSON.stringify(item.input, null, 2)}
        />
      );
    case "tool_result":
      return (
        <ToolCallCard
          name="result"
          state={item.isError ? "error" : "done"}
          summary={item.text.split("\n")[0]?.slice(0, 80)}
          detail={item.text}
        />
      );
    case "result":
      return <ChatMessage role="assistant">{item.text}</ChatMessage>;
    default:
      return null;
  }
}

function summaryOf(input: Record<string, unknown>): string {
  if (typeof input.command === "string") return input.command;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.path === "string") return input.path;
  const first = Object.values(input).find((v) => typeof v === "string");
  return typeof first === "string" ? first : "";
}
