export const HELP = `  inspect [--dump]                     Print UI hierarchy (--dump for raw driver output)`;

import { getDriver } from '../runner.js';
import { printError, OutputOptions } from '../output.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { WebDriver } from '../drivers/web.js';
import {
  inspectIOSToText,
  inspectAndroidToText,
  inspectWebToText,
} from '../drivers/element-resolver.js';
import { buildIOSA11y, buildAndroidA11y, buildWebA11y } from '../drivers/a11y.js';

export interface InspectOptions {
  dump?: boolean;
}

export async function inspect(
  opts: OutputOptions = {},
  sessionName = 'default',
  inspectOpts: InspectOptions = {}
): Promise<number> {
  try {
    const driver = await getDriver(sessionName);

    if (inspectOpts.dump) {
      let raw: string;
      if (driver instanceof IOSDriver) {
        const hierarchy = await driver.viewHierarchy(false);
        // Augment each node with a11y fields (traits, accessibilityOrder,
        // isAccessibilityElement, announcement). All existing fields are preserved.
        const built = buildIOSA11y(hierarchy.axElement);
        raw = JSON.stringify({ axElement: built.hierarchy, depth: hierarchy.depth }, null, 2);
      } else if (driver instanceof WebDriver) {
        const vh = await driver.viewHierarchy();
        const built = buildWebA11y(vh);
        raw = JSON.stringify({ ...vh, elements: built.hierarchy }, null, 2);
      } else if (driver instanceof AndroidDriver) {
        const xml = await driver.viewHierarchy();
        const built = buildAndroidA11y(xml);
        raw = JSON.stringify(built.hierarchy, null, 2);
      } else {
        throw new Error('Unknown driver type');
      }

      if (opts.json) {
        console.log(JSON.stringify({ status: 'ok', dump: raw }));
      } else {
        console.log(raw);
      }
      return 0;
    }

    let text: string;

    if (driver instanceof IOSDriver) {
      const hierarchy = await driver.viewHierarchy(false);
      text = inspectIOSToText(hierarchy.axElement);
    } else if (driver instanceof WebDriver) {
      const hierarchy = await driver.viewHierarchy();
      text = inspectWebToText(hierarchy);
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
