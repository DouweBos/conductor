import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import EventEmitter from "node:events";
import readline from "node:readline";

import type { AgentPermissionRequest } from "../../../app/lib/types";
import type { ControlRequest, ControlResponse, PermissionDecision } from "./protocol";

const CLAUDE_BIN = "claude";
/** Tools that are always safe to auto-approve. */
const AUTO_ALLOW_TOOLS = new Set(["Read", "Glob", "Grep", "TodoWrite", "NotebookRead"]);

export interface ClaudeAgentInit {
  agentId: string;
  cwd: string;
  systemPrompt: string;
  debugLogPath: string;
  /** Auto-approve every tool call (no interactive prompts). */
  autoApprove?: boolean;
  /** MCP servers to inject, keyed by name (passed via --mcp-config). */
  mcpServers?: Record<string, unknown>;
}

/**
 * One spawned Claude Code CLI subprocess. Ported from Argus's ClaudeCodeHandle +
 * ControlHandler, folded into a single self-contained class.
 *
 * Emits:
 *   "event"      → raw stream-json line (string)
 *   "permission" → AgentPermissionRequest
 *   "permission-cancel" → { requestId, toolUseId }
 *   "stderr"     → string
 *   "exit"       → number (exit code)
 */
export class ClaudeAgent extends EventEmitter {
  readonly agentId: string;
  private child: ChildProcess | null = null;
  private exited = false;
  private readonly autoApprove: boolean;
  private readonly init: ClaudeAgentInit;

  private initRequestId: string | null = null;
  private readonly outbound = new Map<string, () => void>();
  private readonly pending = new Map<string, { toolUseId: string; input: Record<string, unknown> }>();
  private readonly toolUseToRequest = new Map<string, string>();
  private readonly sessionAllow = new Set<string>();

  constructor(init: ClaudeAgentInit) {
    super();
    this.init = init;
    this.agentId = init.agentId;
    this.autoApprove = init.autoApprove ?? false;
  }

  start(): void {
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--debug-file",
      this.init.debugLogPath,
      "--permission-prompt-tool",
      "stdio",
    ];
    const mcpServers = this.init.mcpServers ?? {};
    if (Object.keys(mcpServers).length) {
      args.push("--mcp-config", JSON.stringify({ mcpServers }));
    }
    const child = spawn(CLAUDE_BIN, args, {
      cwd: this.init.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child = child;

    child.on("error", (err) => {
      this.emit("stderr", `Failed to start Claude Code: ${err.message}`);
      this.exited = true;
      this.emit("exit", 1);
    });
    child.stderr?.on("data", (c: Buffer) => {
      const t = c.toString().trim();
      if (t) this.emit("stderr", t);
    });
    child.on("close", (code) => {
      this.exited = true;
      for (const resolve of this.outbound.values()) resolve();
      this.outbound.clear();
      this.emit("exit", code ?? 0);
    });

    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on("line", (line) => this.onLine(line));
    }

    // Kick off the initialize handshake carrying the system prompt.
    this.initRequestId = randomUUID();
    this.writeLine(
      JSON.stringify({
        type: "control_request",
        request_id: this.initRequestId,
        request: { subtype: "initialize", appendSystemPrompt: this.init.systemPrompt || undefined },
      }),
    );
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    if (
      line.includes('"control_request"') ||
      line.includes('"control_cancel_request"') ||
      line.includes('"control_response"')
    ) {
      if (this.handleControlLine(line)) return;
    }
    this.emit("event", line);
  }

  private handleControlLine(line: string): boolean {
    let parsed: { type: string; request_id?: string };
    try {
      parsed = JSON.parse(line);
    } catch {
      return false;
    }

    if (parsed.type === "control_response") {
      const res = parsed as ControlResponse;
      const id = res.response.request_id;
      if (id === this.initRequestId) {
        this.initRequestId = null;
        return true;
      }
      const resolve = this.outbound.get(id);
      if (resolve) {
        this.outbound.delete(id);
        resolve();
        return true;
      }
      return true;
    }

    if (parsed.type === "control_request") {
      const req = parsed as ControlRequest;
      if (req.request.subtype === "can_use_tool") {
        this.handlePermission(req);
      } else {
        // Non-permission control requests: respond empty-success so the CLI
        // doesn't hang.
        this.writeLine(this.buildResponse(req.request_id, { behavior: "allow", updatedInput: {} }));
      }
      return true;
    }

    if (parsed.type === "control_cancel_request" && parsed.request_id) {
      const pending = this.pending.get(parsed.request_id);
      if (pending) {
        this.pending.delete(parsed.request_id);
        this.toolUseToRequest.delete(pending.toolUseId);
        this.emit("permission-cancel", {
          requestId: parsed.request_id,
          toolUseId: pending.toolUseId,
        });
      }
      return true;
    }

    return false;
  }

  private handlePermission(req: ControlRequest): void {
    const payload = req.request as unknown as {
      tool_name: string;
      input: Record<string, unknown>;
      tool_use_id: string;
      title?: string;
      description?: string;
    };
    const { tool_name, input, tool_use_id } = payload;

    // Studio's own MCP tools are read-only scene-graph queries — never prompt.
    const isStudioMcp = tool_name.startsWith("mcp__studio__");
    if (
      this.autoApprove ||
      isStudioMcp ||
      AUTO_ALLOW_TOOLS.has(tool_name) ||
      this.sessionAllow.has(tool_name)
    ) {
      this.writeLine(this.buildResponse(req.request_id, { behavior: "allow", updatedInput: input }));
      return;
    }

    this.pending.set(req.request_id, { toolUseId: tool_use_id, input });
    this.toolUseToRequest.set(tool_use_id, req.request_id);
    const request: AgentPermissionRequest = {
      requestId: req.request_id,
      toolUseId: tool_use_id,
      toolName: tool_name,
      toolInput: input,
      title: payload.title,
      description: payload.description,
    };
    this.emit("permission", request);
  }

  respondToPermission(toolUseId: string, decision: "allow" | "deny"): void {
    const requestId = this.toolUseToRequest.get(toolUseId);
    if (!requestId) return;
    const pending = this.pending.get(requestId);
    const input = pending?.input ?? {};
    this.pending.delete(requestId);
    this.toolUseToRequest.delete(toolUseId);

    const body: PermissionDecision =
      decision === "allow"
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "User denied" };
    this.writeLine(this.buildResponse(requestId, body));
  }

  allowToolForSession(toolName: string): void {
    this.sessionAllow.add(toolName);
  }

  send(text: string): void {
    const content = JSON.stringify([{ type: "text", text }]);
    this.writeLine(`{"type":"user","message":{"role":"user","content":${content}}}`);
  }

  interrupt(): void {
    const id = randomUUID();
    this.outbound.set(id, () => {});
    this.writeLine(JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "interrupt" } }));
  }

  async kill(): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (child.exitCode === null && child.pid) {
          try {
            process.kill(child.pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
        resolve();
      }, 2000);
      child.once("close", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private buildResponse(requestId: string, decision: PermissionDecision): string {
    const res: ControlResponse = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: decision as unknown as Record<string, unknown>,
      },
    };
    return JSON.stringify(res);
  }

  private writeLine(data: string): void {
    if (this.exited) return;
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) return;
    try {
      stdin.write(data + "\n");
    } catch {
      // pipe gone
    }
  }
}
