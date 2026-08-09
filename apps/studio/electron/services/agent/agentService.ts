import { which } from "../util/exec";

/**
 * The agentic writer is scaffolded this pass. The full runner mirrors Argus:
 * spawn `claude --print --output-format stream-json --input-format stream-json
 * --verbose`, parse the stream, and give the agent conductor's skills + the POM
 * catalog + the scene graph as its "hands". For now we only report whether the
 * Claude Code CLI is installed so the UI can guide setup.
 */
export async function getAgentStatus(): Promise<{ available: boolean }> {
  const claude = await which("claude");
  return { available: claude !== null };
}
