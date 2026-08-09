import { commandFor } from "../components/flows/Inspector";
import { getCurrentRoute } from "./router";
import { captureUi } from "./ipc";
import type { CaptureElement, CaptureUiResult } from "./types";
import { getBuffer, setBufferContent } from "../stores/flowStore";

// Record mode: translate live device gestures into Maestro steps appended to the
// currently-open flow. Taps resolve the tapped element via capture-ui so the
// generated step uses a stable text/id selector instead of raw coordinates.

function appendStep(step: string): void {
  const path = getCurrentRoute().flowPath;
  if (!path) return;
  const buf = getBuffer(path);
  if (!buf) return;
  const sep = buf.content.endsWith("\n") || buf.content === "" ? "" : "\n";
  setBufferContent(path, `${buf.content}${sep}${step}\n`);
}

function area(el: CaptureElement): number {
  return el.bounds ? el.bounds.width * el.bounds.height : Number.POSITIVE_INFINITY;
}

/** Smallest element whose bounds contain the point, anywhere in the tree. */
function findElementAtPoint(cap: CaptureUiResult, px: number, py: number): CaptureElement | null {
  let best: CaptureElement | null = null;
  const visit = (el: CaptureElement) => {
    const b = el.bounds;
    if (b && px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height) {
      if (el.text && (!best || area(el) < area(best))) best = el;
    }
    for (const child of el.children ?? []) visit(child);
  };
  visit(cap.root);
  return best;
}

export async function recordTap(deviceId: string, xN: number, yN: number): Promise<void> {
  const pct = `${Math.round(xN * 100)}%, ${Math.round(yN * 100)}%`;
  let step = `- tapOn:\n    point: "${pct}"`;
  try {
    const cap = await captureUi(deviceId);
    const el = findElementAtPoint(cap, xN * cap.width, yN * cap.height);
    if (el) step = commandFor(el, "tapOn");
  } catch {
    // fall back to the point-based step
  }
  appendStep(step);
}

export function recordSwipe(x1: number, y1: number, x2: number, y2: number): void {
  const start = `${Math.round(x1 * 100)}%, ${Math.round(y1 * 100)}%`;
  const end = `${Math.round(x2 * 100)}%, ${Math.round(y2 * 100)}%`;
  appendStep(`- swipe:\n    start: "${start}"\n    end: "${end}"`);
}
