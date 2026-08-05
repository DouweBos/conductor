export const HELP = `  travel <lat,lng>...                  Move the device GPS through a series of coordinates
    --speed <m/s>                     Walk between points at this speed (adds realistic delays)`;

import { runDirect } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';
import { sleep } from '../utils.js';

const EARTH_RADIUS = 6371000; // meters

function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lng - a.lng) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(h));
}

export async function travel(
  coords: string[],
  opts: OutputOptions = {},
  sessionName = 'default',
  flags: { speed?: number } = {}
): Promise<number> {
  const points = coords.map((c) => {
    const [lat, lng] = c.split(',').map((s) => Number(s.trim()));
    return { lat, lng };
  });
  if (points.length === 0 || points.some((p) => Number.isNaN(p.lat) || Number.isNaN(p.lng))) {
    printError('travel requires one or more "lat,lng" coordinates', opts);
    return 1;
  }

  const speed = flags.speed;
  const result = await runDirect(async (driver) => {
    for (let i = 0; i < points.length; i++) {
      await driver.setLocation(points[i].lat, points[i].lng);
      if (i < points.length - 1 && speed && speed > 0) {
        const distM = haversine(points[i], points[i + 1]);
        await sleep(Math.min(Math.round((distM / speed) * 1000), 10000)); // cap 10s/step
      }
    }
  }, sessionName);

  if (result.success) {
    printSuccess(`travel — visited ${points.length} point(s)`, opts);
    return 0;
  } else {
    printError(`travel — failed\n${result.stderr}`, opts);
    return 1;
  }
}
