import { runDirect } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';

export async function back(opts: OutputOptions = {}, sessionName = 'default'): Promise<number> {
  const result = await runDirect(async (driver) => {
    if (driver instanceof IOSDriver) {
      // iOS has no universal "back" concept — this is a no-op (same as maestro IOSDriver.backPress)
    } else if (driver instanceof AndroidDriver) {
      await driver.back(); // adb shell input keyevent 4
    }
  }, sessionName);

  if (result.success) {
    printSuccess('back — done', opts);
    return 0;
  } else {
    printError(`back — failed\n${result.stderr}`, opts);
    return 1;
  }
}
