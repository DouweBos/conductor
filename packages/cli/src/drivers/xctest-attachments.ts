/**
 * Prune XCTest attachments (mostly screen recordings) that drivers leave behind
 * in each simulator's testmanagerd container. The driver session is always
 * killed rather than finished, so XCTest's own "delete on success" never runs.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { log } from '../verbose.js';

export const SIMULATOR_DEVICES_ROOT = path.join(
  os.homedir(),
  'Library',
  'Developer',
  'CoreSimulator',
  'Devices'
);

// Leaves room for an XCTest run outside conductor that is handing attachments to Xcode.
const MIN_AGE_MS = 10 * 60 * 1000;

export interface PruneOptions {
  devicesRoot?: string;
  minAgeMs?: number;
  now?: number;
  /** Inodes of the given files that some process holds open; null when unknown. */
  findOpenInodes?: (files: string[]) => Promise<Set<number> | null>;
}

export interface PruneResult {
  deleted: number;
  freedBytes: number;
  skippedOpen: number;
}

/** `<devicesRoot>/<udid>/data/Containers/Data/InternalDaemon/<id>/tmp/Attachments` dirs. */
export function findAttachmentDirs(devicesRoot: string): string[] {
  const dirs: string[] = [];
  for (const udid of readdir(devicesRoot)) {
    const daemons = path.join(devicesRoot, udid, 'data', 'Containers', 'Data', 'InternalDaemon');
    for (const id of readdir(daemons)) {
      const dir = path.join(daemons, id, 'tmp', 'Attachments');
      if (isDir(dir)) dirs.push(dir);
    }
  }
  return dirs;
}

export async function pruneXctestAttachments(opts: PruneOptions = {}): Promise<PruneResult> {
  const devicesRoot = opts.devicesRoot ?? SIMULATOR_DEVICES_ROOT;
  const minAgeMs = opts.minAgeMs ?? MIN_AGE_MS;
  const now = opts.now ?? Date.now();
  const findOpenInodes = opts.findOpenInodes ?? lsofOpenInodes;
  const result: PruneResult = { deleted: 0, freedBytes: 0, skippedOpen: 0 };

  const candidates: Array<{ file: string; size: number; ino: number }> = [];
  for (const dir of findAttachmentDirs(devicesRoot)) {
    for (const file of walkFiles(dir)) {
      try {
        const st = fs.statSync(file);
        if (now - st.mtimeMs >= minAgeMs) candidates.push({ file, size: st.size, ino: st.ino });
      } catch {
        /* vanished */
      }
    }
  }
  if (candidates.length === 0) return result;

  // A running driver's recording can sit untouched for hours on a static screen,
  // so age alone isn't enough; never delete without knowing what's open.
  // Match on inode: lsof's names can differ from ours (symlinked dirs, renamed files).
  const open = await findOpenInodes(candidates.map((c) => c.file));
  if (!open) return result;

  for (const { file, size, ino } of candidates) {
    if (open.has(ino)) {
      result.skippedOpen++;
      continue;
    }
    try {
      fs.unlinkSync(file);
      result.deleted++;
      result.freedBytes += size;
    } catch {
      /* already gone or not ours */
    }
  }
  return result;
}

/** Fire-and-forget wrapper for driver startup. */
export function pruneXctestAttachmentsInBackground(): void {
  pruneXctestAttachments()
    .then((r) => {
      if (r.deleted > 0) {
        const mb = Math.round(r.freedBytes / (1024 * 1024));
        log(`Removed ${r.deleted} stale XCTest attachment(s), freed ${mb} MB`);
      }
    })
    .catch((err: unknown) => log(`XCTest attachment cleanup failed: ${String(err)}`));
}

function lsofOpenInodes(files: string[]): Promise<Set<number> | null> {
  return new Promise((resolve) => {
    // lsof exits 1 when some of the given files aren't open, so ignore the code.
    const proc = spawn('lsof', ['-n', '-P', '-F', 'i', '--', ...files], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const open = new Set<number>();
      for (const line of out.split('\n')) {
        if (line.startsWith('i')) open.add(Number(line.slice(1)));
      }
      resolve(open);
    });
  });
}

function walkFiles(dir: string): string[] {
  const files: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...walkFiles(p));
    else if (e.isFile()) files.push(p);
  }
  return files;
}

function readdir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
