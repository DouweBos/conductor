import { getDriver } from '../runner.js';
import { printError, OutputOptions } from '../output.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { inspectIOSToText, inspectAndroidToText } from '../drivers/element-resolver.js';

export async function inspect(opts: OutputOptions = {}, sessionName = 'default'): Promise<number> {
  try {
    const driver = await getDriver(sessionName);
    let text: string;

    if (driver instanceof IOSDriver) {
      const hierarchy = await driver.viewHierarchy(false);
      text = inspectIOSToText(hierarchy.axElement);
    } else if (driver instanceof AndroidDriver) {
      const xml = await driver.viewHierarchy();
      text = inspectAndroidToText(xml);
    } else {
      throw new Error('Unknown driver type');
    }

    if (opts.json) {
      console.log(JSON.stringify({ status: 'ok', hierarchy: text }));
    } else {
      console.log(text);
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printError(`inspect — failed\n${msg}`, opts);
    return 1;
  }
}
