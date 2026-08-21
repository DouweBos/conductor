import { writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  CaptureElement,
  CaptureUiResult,
  Highlight,
  TestExpectation,
  TestRunLog,
  TestSession,
  TestStepStatus,
} from "../../../app/lib/types";
import { broadcastToRenderers } from "../../broadcast";
import { appState } from "../../state";
import { captureUi } from "../conductor/conductorService";

/**
 * The test the agent is running right now. Two things depend on it: the live
 * checklist beside the device, and the evidence — Studio captures the screen
 * itself when an expectation resolves, rather than trusting the agent to
 * remember a screenshot at the one moment that mattered.
 */
let session: TestSession | null = null;

export function getTestSession(): TestSession | null {
  return session;
}

function publish(): void {
  broadcastToRenderers("test_session:updated", session);
}

export function startSession(init: Omit<TestSession, "expectations" | "startedAt">): TestSession {
  const device = appState.agentDevice;
  session = {
    ...init,
    device: device ? `${device.name} — ${device.id}` : undefined,
    expectations: [],
    startedAt: Date.now(),
  };
  publish();
  return session;
}

export interface RecordInput {
  text: string;
  status: TestStepStatus;
  evidence?: string;
  /** Element the check was about — outlined in the captured screenshot. */
  element?: string;
  /** Skip the capture for a check that isn't about the screen. */
  capture?: boolean;
}

export async function recordExpectation(input: RecordInput): Promise<TestExpectation> {
  const expectation: TestExpectation = {
    text: input.text,
    status: input.status,
    evidence: input.evidence,
    at: Date.now(),
  };

  if (session && input.capture !== false) {
    const shot = await captureEvidence(
      session.dir,
      session.expectations.length + 1,
      input.text,
      input.element,
    ).catch(() => null);
    if (shot) {
      expectation.screenshot = shot.screenshot;
      expectation.highlight = shot.highlight;
    }
  }

  if (session) {
    session.expectations.push(expectation);
    publish();
  }
  return expectation;
}

/** Note the report the session produced, then let the panel fade out. */
export function finishSession(reportId: string, verdict: TestSession["verdict"]): void {
  if (!session) return;
  session = { ...session, reportId, verdict };
  publish();
}

export function clearTestSession(): void {
  session = null;
  publish();
}

/**
 * Fold what Studio observed into the run-log the agent hands over. The agent's
 * wording wins; the screenshot and timing come from the recording, because the
 * agent can't know either reliably.
 */
export function mergeSession(log: TestRunLog): TestRunLog {
  if (!session) return log;
  const recorded = [...session.expectations];
  const claimed = log.expectations ?? [];

  const merged: TestExpectation[] = claimed.map((e) => {
    const i = recorded.findIndex((r) => same(r.text, e.text));
    if (i < 0) return e;
    const [hit] = recorded.splice(i, 1);
    return { ...e, screenshot: e.screenshot ?? hit.screenshot, highlight: e.highlight ?? hit.highlight, at: hit.at };
  });
  // Anything Studio saw resolve that the run-log forgot still counts — dropping
  // it would let a failed check disappear from the report.
  merged.push(...recorded);

  return {
    ...log,
    description: log.description ?? session.description,
    plan: log.plan ?? session.plan,
    expectations: merged,
  };
}

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

async function captureEvidence(
  dir: string,
  index: number,
  label: string,
  element?: string,
): Promise<{ screenshot?: string; highlight?: Highlight } | null> {
  const device = appState.agentDevice;
  if (!device) return null;
  const capture = await captureUi(device.id);
  const base64 = capture.screenshot?.split(",")[1];
  if (!base64) return null;

  const file = path.join(dir, `${String(index).padStart(2, "0")}-${slug(label)}.png`);
  await writeFile(file, Buffer.from(base64, "base64"));
  return { screenshot: file, highlight: element ? findHighlight(capture, element) : undefined };
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "check"
  );
}

/**
 * The smallest element matching what the check was about. Smallest, because a
 * label match usually also hits the container it sits in, and outlining the
 * whole screen tells the reader nothing.
 */
function findHighlight(capture: CaptureUiResult, query: string): Highlight | undefined {
  if (!capture.width || !capture.height) return undefined;
  const needle = query.trim().toLowerCase();
  let best: CaptureElement | null = null;

  const visit = (el: CaptureElement) => {
    const hay = [el.identifier, el.text].filter(Boolean).map((s) => s!.toLowerCase());
    const hit = hay.some((h) => h === needle || h.includes(needle));
    if (hit && el.bounds && el.bounds.width > 0 && el.bounds.height > 0) {
      if (!best || area(el) < area(best)) best = el;
    }
    for (const child of el.children ?? []) visit(child);
  };
  visit(capture.root);

  const bounds = (best as CaptureElement | null)?.bounds;
  if (!bounds) return undefined;
  return {
    x: bounds.x / capture.width,
    y: bounds.y / capture.height,
    width: bounds.width / capture.width,
    height: bounds.height / capture.height,
  };
}

function area(el: CaptureElement): number {
  return el.bounds ? el.bounds.width * el.bounds.height : Number.MAX_SAFE_INTEGER;
}
