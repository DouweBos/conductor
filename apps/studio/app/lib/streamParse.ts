import type { ConversationItem } from "./types";

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface StreamEvent {
  type: string;
  subtype?: string;
  message?: { role?: string; content?: ContentBlock[] };
  result?: string;
  is_error?: boolean;
}

/**
 * Convert one Claude Code stream-json event into renderable conversation items.
 * `seq` makes ids stable/unique across events without a module counter.
 */
export function parseStreamEvent(raw: string, seq: number): ConversationItem[] {
  let event: StreamEvent;
  try {
    event = JSON.parse(raw) as StreamEvent;
  } catch {
    return [];
  }

  if (event.type === "assistant" && event.message?.content) {
    return event.message.content.flatMap((block, i) => blockToItems(block, `${seq}-${i}`));
  }

  if (event.type === "user" && event.message?.content) {
    return event.message.content.flatMap((block, i) => {
      if (block.type === "tool_result") {
        return [
          {
            kind: "tool_result" as const,
            id: `${seq}-${i}`,
            text: toolResultText(block.content),
            isError: block.is_error === true,
          },
        ];
      }
      return [];
    });
  }

  if (event.type === "result") {
    const text = event.result ?? "";
    if (!text) return [];
    return [{ kind: "result", id: `${seq}-r`, text, isError: event.is_error === true }];
  }

  return [];
}

function blockToItems(block: ContentBlock, id: string): ConversationItem[] {
  if (block.type === "text" && block.text) {
    return [{ kind: "text", id, role: "assistant", text: block.text }];
  }
  if (block.type === "tool_use" && block.name) {
    return [{ kind: "tool_use", id: block.id ?? id, name: block.name, input: block.input ?? {} }];
  }
  return [];
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
