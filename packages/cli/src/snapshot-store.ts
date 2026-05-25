/**
 * Snapshot-scoped ephemeral element refs.
 *
 * `capture-ui` assigns each accessible element a short ref (`@e1`, `@e2`, …) and
 * persists its resolved screen coordinates here, keyed by session. `tap-on @e3`
 * then taps the cached point directly — no fuzzy text/id matching.
 *
 * Refs are deliberately ephemeral: a stale snapshot warns (it does not hard-fail),
 * and the agent is expected to re-run `capture-ui` and act on fresh refs.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { A11ySnapshotEntry, A11yFrame } from './drivers/a11y.js';

const SNAPSHOTS_DIR = path.join(os.homedir(), '.conductor', 'snapshots');

/** A snapshot older than this is considered stale. */
export const SNAPSHOT_STALE_MS = 60_000;

export interface SnapshotRefEntry {
  ref: string;
  centerX: number;
  centerY: number;
  frame: A11yFrame;
  /** Accessibility label — used to render a friendly message and for replay portability. */
  label: string;
  /** Tree-path id of the source node within the capture's hierarchy. */
  nodeId: string;
}

export interface StoredSnapshot {
  version: 1;
  /** ISO timestamp of the capture. */
  capturedAt: string;
  deviceId: string;
  platform: string;
  refs: Record<string, SnapshotRefEntry>;
}

export function snapshotFilePath(sessionName = 'default'): string {
  return path.join(SNAPSHOTS_DIR, `${sessionName}.json`);
}

/** True when `s` looks like an ephemeral element ref (`@e3`). */
export function isRefQuery(s: string): boolean {
  return /^@e\d+$/i.test(s.trim());
}

/** Build a `StoredSnapshot` from a freshly built a11y snapshot. */
export function buildStoredSnapshot(
  entries: A11ySnapshotEntry[],
  device: { deviceId: string; platform: string }
): StoredSnapshot {
  const refs: Record<string, SnapshotRefEntry> = {};
  for (const e of entries) {
    refs[e.ref] = {
      ref: e.ref,
      centerX: e.frame.x + e.frame.w / 2,
      centerY: e.frame.y + e.frame.h / 2,
      frame: e.frame,
      label: e.label,
      nodeId: e.nodeId,
    };
  }
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    deviceId: device.deviceId,
    platform: device.platform,
    refs,
  };
}

export async function saveSnapshot(sessionName: string, snapshot: StoredSnapshot): Promise<void> {
  await fs.mkdir(SNAPSHOTS_DIR, { recursive: true });
  await fs.writeFile(snapshotFilePath(sessionName), JSON.stringify(snapshot, null, 2));
}

export async function loadSnapshot(sessionName: string): Promise<StoredSnapshot | null> {
  try {
    const data = await fs.readFile(snapshotFilePath(sessionName), 'utf-8');
    return JSON.parse(data) as StoredSnapshot;
  } catch {
    return null;
  }
}

export interface RefResolution {
  entry: SnapshotRefEntry;
  /** Non-null when the snapshot may no longer match what's on screen. Advisory. */
  staleReason: string | null;
}

/**
 * Resolve an `@eN` ref against the session's last `capture-ui` snapshot.
 * Throws when there is no snapshot or the ref is unknown. `staleReason` is
 * advisory — callers warn but still act, since refs are explicitly ephemeral.
 */
export function resolveRef(
  snapshot: StoredSnapshot | null,
  ref: string,
  ctx?: { deviceId?: string }
): RefResolution {
  if (!snapshot) {
    throw new Error(
      `no snapshot for this session — run \`conductor capture-ui\` before using ${ref}`
    );
  }
  const norm = ref.trim().toLowerCase();
  const key = Object.keys(snapshot.refs).find((k) => k.toLowerCase() === norm);
  if (!key) {
    const avail = Object.keys(snapshot.refs);
    const shown = avail.slice(0, 8).join(', ');
    throw new Error(
      `${ref} is not in the last snapshot ` +
        `(${avail.length} ref${avail.length === 1 ? '' : 's'}: ${shown}${avail.length > 8 ? ', …' : ''})`
    );
  }

  let staleReason: string | null = null;
  const ageMs = Date.now() - new Date(snapshot.capturedAt).getTime();
  if (ageMs > SNAPSHOT_STALE_MS) {
    staleReason = `snapshot is ${Math.round(ageMs / 1000)}s old`;
  } else if (ctx?.deviceId && snapshot.deviceId && ctx.deviceId !== snapshot.deviceId) {
    staleReason = `snapshot was captured on a different device (${snapshot.deviceId})`;
  }

  return { entry: snapshot.refs[key], staleReason };
}
