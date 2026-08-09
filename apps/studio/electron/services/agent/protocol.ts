// Subset of the Claude Code CLI bidirectional control protocol used by Studio.
// Reference: Argus electron/services/llm/runners/claudeCode/protocol.ts.

export interface CanUseToolPayload {
  subtype: "can_use_tool";
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id: string;
  title?: string;
  description?: string;
}

export interface ControlRequest {
  type: "control_request";
  request_id: string;
  request: { subtype: string } & Record<string, unknown>;
}

export interface ControlResponse {
  type: "control_response";
  response:
    | { subtype: "success"; request_id: string; response?: Record<string, unknown> }
    | { subtype: "error"; request_id: string; error: string };
}

export type PermissionDecision =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };
