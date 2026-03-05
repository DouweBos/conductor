import { runDirect } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { Direction, swipeCoords } from '../utils.js';

export async function scroll(
  direction: Direction = 'down',
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  const valid: Direction[] = ['down', 'up', 'left', 'right'];
  if (!valid.includes(direction)) {
    printError(`scroll --direction must be one of: ${valid.join(', ')}`, opts);
    return 1;
  }

  const result = await runDirect(async (driver) => {
    const coords = swipeCoords(direction);
    if (driver instanceof IOSDriver) {
      const info = await driver.deviceInfo();
      const { widthPoints: w, heightPoints: h } = info;
      await driver.swipe(
        coords.startX * w,
        coords.startY * h,
        coords.endX * w,
        coords.endY * h,
        0.5
      );
    } else if (driver instanceof AndroidDriver) {
      const info = await driver.deviceInfo();
      const { widthPixels: w, heightPixels: h } = info;
      await driver.swipe(
        coords.startX * w,
        coords.startY * h,
        coords.endX * w,
        coords.endY * h,
        500
      );
    }
  }, sessionName);

  if (result.success) {
    printSuccess(`scroll ${direction} — done`, opts);
    return 0;
  } else {
    printError(`scroll ${direction} — failed\n${result.stderr}`, opts);
    return 1;
  }
}
