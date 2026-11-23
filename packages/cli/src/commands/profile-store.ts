/**
 * On-disk layout of a profiling session. One directory per recording holds
 * everything the analysis commands read, so a profile can be re-analysed (or
 * diffed) long after the app is gone:
 *
 *   meta.json         what was recorded, on which target, when
 *   react.json        React commits (from the injected commit hook)
 *   cpu.cpuprofile    Hermes samples (+ cpu.seg<N>.cpuprofile after a reconnect)
 *   cpu.json          sampler bookkeeping: segments, gaps, clock anchors
 *   symbols.json      source-map lookups for JS functions
 *   native.trace / native.perf.data, native.json
 *
 * `~/.conductor/profiles/<session>/active.json` points at the recording in
 * progress, `latest.json` at the last finished one.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PinnedTarget } from './profile-js.js';

export interface ProfileMeta {
  version: 1;
  session: string;
  platform?: string;
  appId?: string;
  dir: string;
  startedAt: string;
  stoppedAt?: string;
  target?: PinnedTarget;
  react?: { state: 'recording' | 'done' | 'lost'; cpu: boolean; error?: string };
  native?: {
    state: 'recording' | 'done' | 'failed';
    tool: 'xctrace' | 'simpleperf';
    trace: string;
    pid?: number;
    error?: string;
  };
  /** Set when the recording wrapped a `run-flow`. */
  flow?: { file: string; runs: number; ok: boolean };
}

export function profilesRoot(session: string): string {
  return path.join(os.homedir(), '.conductor', 'profiles', session.replace(/[^\w.-]/g, '_'));
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

export async function readMeta(dir: string): Promise<ProfileMeta | null> {
  return readJson<ProfileMeta>(path.join(dir, 'meta.json'));
}

export async function writeMeta(meta: ProfileMeta): Promise<void> {
  await writeJson(path.join(meta.dir, 'meta.json'), meta);
}

/** The recording in progress for this session, if any. */
export async function activeProfile(session: string): Promise<ProfileMeta | null> {
  const ptr = await readJson<{ dir: string }>(path.join(profilesRoot(session), 'active.json'));
  return ptr ? readMeta(ptr.dir) : null;
}

/** Reuse the active recording's directory, or create a new one. */
export async function openProfile(
  session: string,
  init: { platform?: string; appId?: string; out?: string }
): Promise<ProfileMeta> {
  const active = await activeProfile(session);
  if (active) return active;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.resolve(init.out ?? path.join(profilesRoot(session), stamp));
  await fs.mkdir(dir, { recursive: true });
  const meta: ProfileMeta = {
    version: 1,
    session,
    platform: init.platform,
    appId: init.appId,
    dir,
    startedAt: new Date().toISOString(),
  };
  await writeMeta(meta);
  await writeJson(path.join(profilesRoot(session), 'active.json'), { dir });
  return meta;
}

/** Close the recording once no profiler in it is still running. */
export async function settleProfile(meta: ProfileMeta): Promise<void> {
  const running = meta.react?.state === 'recording' || meta.native?.state === 'recording';
  if (running) {
    await writeMeta(meta);
    return;
  }
  meta.stoppedAt = new Date().toISOString();
  await writeMeta(meta);
  const root = profilesRoot(meta.session);
  await fs.rm(path.join(root, 'active.json'), { force: true });
  await writeJson(path.join(root, 'latest.json'), { dir: meta.dir });
}

/**
 * Directory to analyse: an explicit path, else this session's latest finished
 * recording, else the one still in progress.
 */
export async function resolveProfileDir(session: string, explicit?: string): Promise<string> {
  if (explicit) {
    const dir = path.resolve(explicit);
    if (!(await readMeta(dir))) throw new Error(`${dir} is not a conductor profile directory`);
    return dir;
  }
  const latest = await readJson<{ dir: string }>(path.join(profilesRoot(session), 'latest.json'));
  if (latest && (await readMeta(latest.dir))) return latest.dir;
  throw new Error(
    'no finished profile for this device — record one with `conductor profile react start` / ' +
      '`stop` (or pass a profile directory)'
  );
}

export { readJson };
