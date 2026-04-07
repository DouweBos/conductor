export const HELP = `  swipe
    --direction <up|down|left|right>  Swipe direction (required unless --start/--end are provided)
    --start <x,y>                     Start coordinate (0–1 normalised or absolute px)
    --end <x,y>                       End coordinate (0–1 normalised or absolute px)
    --duration <ms>                   Swipe duration in milliseconds (default: 500)`;

import { runDirect } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { Direction, swipeCoords } from '../utils.js';

function parseCoordPair(s: string): { x: number; y: number } {
  const [xs, ys] = s.split(',').map((p) => p.trim());
  return { x: parseFloat(xs), y: parseFloat(ys) };
}

export async function swipe(
  direction: string,
  opts: OutputOptions = {},
  sessionName = 'default',
  flags: {
    start?: string;
    end?: string;
    duration?: number;
  } = {}
): Promise<number> {
  if (!direction && !(flags.start && flags.end)) {
    printError(
      'swipe requires --direction <up|down|left|right> or --start <x,y> --end <x,y>',
      opts
    );
    return 1;
  }

  const result = await runDirect(async (driver) => {
    if (driver instanceof IOSDriver && driver.platform === 'tvos') {
      throw new Error(
        'swipe is not supported on tvOS — Apple TV uses focus-based navigation.\n' +
          'Use press-key to navigate (e.g. conductor press-key left).'
      );
    }

    let startX: number, startY: number, endX: number, endY: number;

    if (driver instanceof IOSDriver) {
      const { widthPoints: w, heightPoints: h } = await driver.deviceInfo();
      const durationSec = (flags.duration ?? 500) / 1000;

      if (flags.start && flags.end) {
        const s = parseCoordPair(flags.start);
        const e = parseCoordPair(flags.end);
        startX = s.x <= 1 ? s.x * w : s.x;
        startY = s.y <= 1 ? s.y * h : s.y;
        endX = e.x <= 1 ? e.x * w : e.x;
        endY = e.y <= 1 ? e.y * h : e.y;
      } else {
        const normalized = direction.toLowerCase() as Direction;
        const coords = swipeCoords(normalized);
        startX = coords.startX * w;
        startY = coords.startY * h;
        endX = coords.endX * w;
        endY = coords.endY * h;
      }
      await driver.swipe(startX, startY, endX, endY, durationSec);
    } else if (driver instanceof AndroidDriver) {
      const { widthPixels: w, heightPixels: h } = await driver.deviceInfo();
      const durationMs = flags.duration ?? 500;

      if (flags.start && flags.end) {
        const s = parseCoordPair(flags.start);
        const e = parseCoordPair(flags.end);
        startX = s.x <= 1 ? s.x * w : s.x;
        startY = s.y <= 1 ? s.y * h : s.y;
        endX = e.x <= 1 ? e.x * w : e.x;
        endY = e.y <= 1 ? e.y * h : e.y;
      } else {
        const normalized = direction.toLowerCase() as Direction;
        const coords = swipeCoords(normalized);
        startX = coords.startX * w;
        startY = coords.startY * h;
        endX = coords.endX * w;
        endY = coords.endY * h;
      }
      await driver.swipe(startX, startY, endX, endY, durationMs);
    }
  }, sessionName);

  const label =
    flags.start && flags.end ? `from ${flags.start} to ${flags.end}` : direction.toLowerCase();

  if (result.success) {
    printSuccess(`swipe ${label} — done`, opts);
    return 0;
  } else {
    printError(`swipe ${label} — failed\n${result.stderr}`, opts);
    return 1;
  }
}
