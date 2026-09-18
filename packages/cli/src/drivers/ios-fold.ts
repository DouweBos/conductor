/**
 * Fold (hinge) control for foldable simulators, e.g. the iPhone Duo.
 *
 * Apple exposes no setter: `simctl` has nothing, and `devicectl` only *reads*
 * the angle. The fold is driven by an AVP event that travels Device Hub ->
 * CoreDevice remote HID -> the guest's dtuhidd -> locationd, whose CoreMotion
 * relay synthesises the hinge HID event SpringBoard folds on. Conductor's own
 * Indigo channel cannot carry it (backboardd rejects hinge events), so we
 * inject `drivers/ios-fold/conductor-fold.dylib` into the simulator's locationd
 * and feed that relay directly — see packages/ios-fold for the full rationale.
 *
 * Injection lasts until locationd restarts, so every call re-checks the pid the
 * dylib recorded and re-injects when it no longer matches.
 */
import fs from 'fs';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { getFoldDylibPath } from './bootstrap.js';

const exec = promisify(execFile);

/** Named poses, mirroring Device Hub's three hinge buttons. */
export const FOLD_POSES: Record<string, number> = {
  closed: 0,
  book: 130,
  open: 180,
};

export interface FoldState {
  angle: number;
  /** Nearest named pose, or 'partial' for angles that aren't close to one. */
  pose: string;
}

/** A simulator process's /tmp is the host's /tmp, so scope paths by device. */
const controlPath = (udid: string) => `/tmp/conductor-fold-${udid}`;
const orientationPath = (udid: string) => `/tmp/conductor-orientation-${udid}`;

/**
 * The relay's own orientation vocabulary, which is not devicectl's spelling.
 * Foldables ignore `devicectl device orientation set`, so they need this path.
 */
export const RELAY_ORIENTATIONS: Record<string, string> = {
  portrait: 'portrait',
  portraitUpsideDown: 'pud',
  landscapeLeft: 'landscape-left',
  landscapeRight: 'landscape-right',
  faceUp: 'faceup',
  faceDown: 'facedown',
};

/**
 * Resolve a CLI value — a pose name or an angle in degrees — to an angle.
 * Returns null for anything else, including an empty value: `Number('')` is 0,
 * which would otherwise turn a bare `set-fold` into "fold the device shut".
 */
export function resolveFoldAngle(value: string): number | null {
  const key = value.trim().toLowerCase();
  if (!key) return null;
  if (key in FOLD_POSES) return FOLD_POSES[key];
  const angle = Number(key);
  if (!Number.isFinite(angle) || angle < 0 || angle > 180) return null;
  return angle;
}

/**
 * Name the pose when the angle is close to one, else call it partial. Which
 * panel is lit is deliberately not derived from the angle: the system swaps
 * displays on its own transition logic, so a hinge parked mid-way can still be
 * driving the cover display.
 */
export function poseForAngle(angle: number): string {
  for (const [name, value] of Object.entries(FOLD_POSES)) {
    if (Math.abs(value - angle) <= 10) return name;
  }
  return 'partial';
}

async function locationdPid(udid: string): Promise<string | null> {
  try {
    const { stdout } = await exec('xcrun', [
      'simctl',
      'spawn',
      udid,
      'launchctl',
      'print',
      'system/com.apple.locationd',
    ]);
    return stdout.match(/^\s*pid = (\d+)/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

function recordedPid(udid: string): string | null {
  try {
    return fs.readFileSync(`${controlPath(udid)}.pid`, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Ensure the fold controller is live inside locationd. DYLD_INSERT_LIBRARIES is
 * set on the simulator's launchd only for the moment it takes to restart
 * locationd — anything else launched in that window loads the dylib too, which
 * is harmless (it no-ops outside locationd).
 */
export async function ensureFoldControllerInjected(udid: string): Promise<void> {
  const pid = await locationdPid(udid);
  if (pid && pid === recordedPid(udid)) return;

  // Restarting locationd resets CoreMotion's relay to a 0° hinge, which folds
  // the device. Remember where the hinge was so it can be put back.
  const previousAngle = await readHingeAngleViaDevicectl(udid).catch(() => null);

  const dylib = await getFoldDylibPath();
  if (!dylib) {
    throw new Error(
      'fold control requires drivers/ios-fold/conductor-fold.dylib — build it with packages/ios-fold/tools/build-fold.sh'
    );
  }

  const spawn = (args: string[]) => exec('xcrun', ['simctl', 'spawn', udid, ...args]);
  await spawn(['launchctl', 'setenv', 'DYLD_INSERT_LIBRARIES', dylib]);
  try {
    await spawn(['launchctl', 'kickstart', '-k', 'system/com.apple.locationd']);
  } finally {
    await spawn(['launchctl', 'unsetenv', 'DYLD_INSERT_LIBRARIES']).catch(() => {});
  }

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const current = await locationdPid(udid);
    if (current && current === recordedPid(udid)) {
      if (previousAngle !== null) {
        fs.writeFileSync(controlPath(udid), String(previousAngle));
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('fold controller did not come up inside locationd (is this a foldable device?)');
}

/** Apply a hinge angle in degrees (0 = closed, 180 = open flat). */
export async function setFoldAngle(udid: string, angle: number): Promise<void> {
  if (!Number.isFinite(angle) || angle < 0 || angle > 180) {
    throw new Error(`fold angle must be between 0 and 180 (got ${angle})`);
  }
  await ensureFoldControllerInjected(udid);
  fs.writeFileSync(controlPath(udid), String(angle));
}

/**
 * Rotate through the injected relay, the way Device Hub's orientation picker
 * does. Only needed where devicectl's setter is ignored.
 */
export async function setOrientationViaRelay(udid: string, orientation: string): Promise<void> {
  const token = RELAY_ORIENTATIONS[orientation];
  if (!token) throw new Error(`no relay mapping for orientation '${orientation}'`);
  await ensureFoldControllerInjected(udid);
  fs.writeFileSync(orientationPath(udid), token);
}

/**
 * Read the current fold state. devicectl is the authority: the hinge can be
 * moved from Device Hub as well as by us, so anything we cached locally would
 * only cover the folds this process happened to see.
 */
export async function getFoldState(udid: string): Promise<FoldState> {
  const angle = await readHingeAngleViaDevicectl(udid);
  return { angle, pose: poseForAngle(angle) };
}

/**
 * `devicectl device motion hinge-angle` is a monitor: it prints the current
 * angle immediately but then streams until its session expires, so take the
 * first sample and stop it rather than waiting around.
 */
async function readHingeAngleViaDevicectl(udid: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const proc = spawn('xcrun', [
      'devicectl',
      'device',
      'motion',
      'hinge-angle',
      '--device',
      udid,
      '--session-timeout',
      '10',
    ]);
    let out = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.kill('SIGTERM');
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error('timed out reading hinge angle'))),
      15000
    );
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const match = out.match(/Angle:\s*([0-9.]+)/);
      if (match) finish(() => resolve(Number(match[1])));
    });
    proc.on('error', (err) => finish(() => reject(err)));
    proc.on('close', () =>
      finish(() => reject(new Error('could not read hinge angle — is this a foldable device?')))
    );
  });
}
