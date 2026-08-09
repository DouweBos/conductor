import { type ChildProcess, spawn } from "node:child_process";

import type { RunLogLine } from "../../../app/lib/types";
import { broadcastToRenderers } from "../../broadcast";
import { resolveConductor } from "../maestro/maestroService";

// One log tail per device, streamed to `device_logs:{deviceId}`.
const tails = new Map<string, ChildProcess>();
let seq = 0;

export async function startLogs(deviceId: string): Promise<void> {
  if (tails.has(deviceId)) return;
  const resolved = await resolveConductor();
  if (!resolved) throw new Error("Conductor CLI not found — cannot stream logs.");

  const child = spawn(
    resolved.bin,
    [...resolved.prefixArgs, "logs", "--device", deviceId],
    { env: process.env },
  );
  tails.set(deviceId, child);

  const emit = (chunk: Buffer, tone: RunLogLine["tone"]) => {
    for (const raw of chunk.toString().split(/\r?\n/)) {
      if (!raw.length) continue;
      seq += 1;
      broadcastToRenderers(`device_logs:${deviceId}`, {
        id: `log-${seq}`,
        text: raw,
        tone: /error|exception|fatal/i.test(raw) ? "error" : tone,
      } satisfies RunLogLine);
    }
  };
  child.stdout?.on("data", (c: Buffer) => emit(c, "default"));
  child.stderr?.on("data", (c: Buffer) => emit(c, "muted"));
  child.on("close", () => tails.delete(deviceId));
  child.on("error", (err) => {
    broadcastToRenderers(`device_logs:${deviceId}`, {
      id: `log-err-${Date.now()}`,
      text: `logs failed: ${err.message}`,
      tone: "error",
    } satisfies RunLogLine);
    tails.delete(deviceId);
  });
}

export function stopLogs(deviceId: string): void {
  const child = tails.get(deviceId);
  if (child) {
    child.kill("SIGTERM");
    tails.delete(deviceId);
  }
}

export function stopAllLogs(): void {
  for (const id of [...tails.keys()]) stopLogs(id);
}
