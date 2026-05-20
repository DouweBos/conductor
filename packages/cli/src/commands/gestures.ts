export const HELP = `  pinch [--scale N] [--center x,y] [--duration ms] [--angle deg]
                                       Two-finger pinch (scale<1 zoom out, scale>1 zoom in)
  rotate-gesture [--degrees N] [--center x,y] [--duration ms]
                                       Two-finger rotate gesture
  gesture <json|--file path>           Play a multi-touch path
                                       JSON: [{"steps":[{"x":,"y":,"dt":}]},...]
                                       dt is delay since previous step (seconds for iOS, see docs)`;

import fs from 'fs';
import { runDirect } from '../runner.js';
import { printError, printSuccess, OutputOptions } from '../output.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { WebDriver } from '../drivers/web.js';

export interface PinchOptions {
  scale?: number;
  center?: string;
  duration?: number;
  angle?: number;
}

export interface RotateOptions {
  degrees?: number;
  center?: string;
  duration?: number;
}

interface FingerStep {
  x: number;
  y: number;
  /** Delay since the previous step. */
  dt: number;
}

interface FingerPath {
  steps: FingerStep[];
}

function parseCenter(s: string | undefined): { x: number; y: number } | null {
  if (!s) return null;
  const m = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]) };
}

async function screenCenter(
  driver: IOSDriver | AndroidDriver | WebDriver
): Promise<{ width: number; height: number; cx: number; cy: number }> {
  if (driver instanceof IOSDriver) {
    const info = await driver.deviceInfo();
    return {
      width: info.widthPoints,
      height: info.heightPoints,
      cx: info.widthPoints / 2,
      cy: info.heightPoints / 2,
    };
  }
  const info = await driver.deviceInfo();
  return {
    width: info.widthPixels,
    height: info.heightPixels,
    cx: info.widthPixels / 2,
    cy: info.heightPixels / 2,
  };
}

/**
 * Build two synchronized finger paths for a pinch. The two fingers start at
 * `startDistance` apart, end at `endDistance`, along an axis rotated by
 * `angleDeg`. We emit a coarse path (~60fps) — the drivers interpolate inside.
 *
 * Distances are in pixels (iOS uses points, Android uses pixels — caller
 * passes the raw value; we don't normalize).
 */
function buildPinchPaths(
  cx: number,
  cy: number,
  startDist: number,
  endDist: number,
  angleDeg: number,
  durationMs: number
): FingerPath[] {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const steps = Math.max(2, Math.round(durationMs / 16));
  const dtStep = durationMs / steps / 1000;

  const finger1: FingerStep[] = [];
  const finger2: FingerStep[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const dist = startDist + (endDist - startDist) * t;
    const half = dist / 2;
    const dx = half * cos;
    const dy = half * sin;
    const dt = i === 0 ? 0 : dtStep;
    finger1.push({ x: cx - dx, y: cy - dy, dt });
    finger2.push({ x: cx + dx, y: cy + dy, dt });
  }
  return [{ steps: finger1 }, { steps: finger2 }];
}

function buildRotatePaths(
  cx: number,
  cy: number,
  radius: number,
  degrees: number,
  durationMs: number
): FingerPath[] {
  const steps = Math.max(2, Math.round(durationMs / 16));
  const dtStep = durationMs / steps / 1000;
  const finger1: FingerStep[] = [];
  const finger2: FingerStep[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const theta = (degrees * Math.PI * t) / 180;
    const dx = radius * Math.cos(theta);
    const dy = radius * Math.sin(theta);
    const dt = i === 0 ? 0 : dtStep;
    finger1.push({ x: cx - dx, y: cy - dy, dt });
    finger2.push({ x: cx + dx, y: cy + dy, dt });
  }
  return [{ steps: finger1 }, { steps: finger2 }];
}

async function playPaths(driver: IOSDriver | AndroidDriver, paths: FingerPath[]): Promise<void> {
  if (driver instanceof IOSDriver) {
    await driver.gesturePath(paths);
  } else {
    // Android proto uses dt_ms (ms), our internal model uses seconds.
    const androidPaths = paths.map((p) => ({
      steps: p.steps.map((s) => ({ x: s.x, y: s.y, dt_ms: Math.round(s.dt * 1000) })),
    }));
    await driver.gesturePath(androidPaths);
  }
}

export async function pinch(
  opts: OutputOptions,
  sessionName: string,
  pinchOpts: PinchOptions
): Promise<number> {
  const scale = pinchOpts.scale ?? 0.5;
  const duration = pinchOpts.duration ?? 400;
  const angle = pinchOpts.angle ?? 0;
  const result = await runDirect(async (driver) => {
    if (driver instanceof WebDriver) throw new Error('pinch is not supported on Web');
    const { width, height, cx: defCx, cy: defCy } = await screenCenter(driver);
    const center = parseCenter(pinchOpts.center) ?? { x: defCx, y: defCy };
    // Start span is half the shorter screen dimension; end is scaled.
    const baseSpan = Math.min(width, height) * 0.5;
    const startDist = scale < 1 ? baseSpan : baseSpan * scale;
    const endDist = scale < 1 ? baseSpan * scale : baseSpan;
    const paths = buildPinchPaths(center.x, center.y, startDist, endDist, angle, duration);
    await playPaths(driver as IOSDriver | AndroidDriver, paths);
  }, sessionName);

  if (result.success) {
    printSuccess('pinch — done', opts);
    return 0;
  }
  printError(`pinch — failed\n${result.stderr}`, opts);
  return 1;
}

export async function rotateGesture(
  opts: OutputOptions,
  sessionName: string,
  rotateOpts: RotateOptions
): Promise<number> {
  const degrees = rotateOpts.degrees ?? 90;
  const duration = rotateOpts.duration ?? 500;
  const result = await runDirect(async (driver) => {
    if (driver instanceof WebDriver) throw new Error('rotate-gesture is not supported on Web');
    const { width, height, cx: defCx, cy: defCy } = await screenCenter(driver);
    const center = parseCenter(rotateOpts.center) ?? { x: defCx, y: defCy };
    const radius = Math.min(width, height) * 0.25;
    const paths = buildRotatePaths(center.x, center.y, radius, degrees, duration);
    await playPaths(driver as IOSDriver | AndroidDriver, paths);
  }, sessionName);

  if (result.success) {
    printSuccess('rotate-gesture — done', opts);
    return 0;
  }
  printError(`rotate-gesture — failed\n${result.stderr}`, opts);
  return 1;
}

interface InputTouchPoint {
  x: number;
  y: number;
  /** Either dt (seconds) or t (cumulative ms). dt wins if both present. */
  dt?: number;
  t?: number;
}

interface InputTrack {
  /** Optional id — ignored by the driver but preserved in errors. */
  id?: number;
  points?: InputTouchPoint[];
  steps?: InputTouchPoint[];
}

function inputToPaths(tracks: InputTrack[]): FingerPath[] {
  return tracks.map((t) => {
    const pts = t.steps ?? t.points ?? [];
    let prevT = 0;
    return {
      steps: pts.map((p) => {
        let dt = p.dt;
        if (dt === undefined && p.t !== undefined) {
          dt = (p.t - prevT) / 1000;
          prevT = p.t;
        }
        return { x: p.x, y: p.y, dt: dt ?? 0 };
      }),
    };
  });
}

function readGestureInput(raw: string | undefined, filePath?: string): InputTrack[] {
  let json: string;
  if (filePath) json = fs.readFileSync(filePath, 'utf-8');
  else if (raw) json = raw;
  else throw new Error('gesture requires a JSON argument or --file <path>');
  const parsed = JSON.parse(json) as InputTrack[];
  if (!Array.isArray(parsed)) throw new Error('gesture input must be a JSON array of tracks');
  return parsed;
}

export async function gesture(
  rawJson: string | undefined,
  filePath: string | undefined,
  opts: OutputOptions,
  sessionName: string
): Promise<number> {
  let tracks: InputTrack[];
  try {
    tracks = readGestureInput(rawJson, filePath);
  } catch (err) {
    printError(`gesture — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
  const paths = inputToPaths(tracks);

  const result = await runDirect(async (driver) => {
    if (driver instanceof WebDriver) throw new Error('gesture is not supported on Web');
    await playPaths(driver as IOSDriver | AndroidDriver, paths);
  }, sessionName);

  if (result.success) {
    printSuccess(`gesture — played ${tracks.length} track(s)`, opts);
    return 0;
  }
  printError(`gesture — failed\n${result.stderr}`, opts);
  return 1;
}
