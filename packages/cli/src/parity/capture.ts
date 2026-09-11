/**
 * One screen capture, normalised across platforms.
 *
 * `capture-ui` and the parity harness both need "screenshot + hierarchy + a11y
 * snapshot for whatever driver this session has". That per-driver branching used
 * to live inside `capture-ui`; it lives here so both callers share it.
 */
import type { AnyDriver } from '../runner.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { WebDriver } from '../drivers/web.js';
import { VegaDriver } from '../drivers/vega.js';
import { RokuDriver } from '../drivers/roku.js';
import {
  buildIOSA11y,
  buildAndroidA11y,
  buildWebA11y,
  A11ySnapshotEntry,
} from '../drivers/a11y.js';

/**
 * Where a capture came from. `design` is not a driver: it marks a reference
 * authored from a spec or a design export rather than captured from a running
 * app, so the diff relaxes roles against it the way it does across stacks.
 */
export type CapturePlatform = 'ios' | 'android' | 'web' | 'tvos' | 'vega' | 'roku' | 'design';

export interface ScreenCapture {
  platform: CapturePlatform;
  /** Logical screen size. iOS reports points; every other platform reports pixels. */
  width: number;
  height: number;
  hierarchy: unknown;
  a11ySnapshot: A11ySnapshotEntry[];
  screenshot: Buffer;
}

/** Capture the current screen through whichever driver backs this session. */
export async function captureScreen(driver: AnyDriver): Promise<ScreenCapture> {
  if (driver instanceof IOSDriver) {
    const [info, vh, shot] = await Promise.all([
      driver.deviceInfo(),
      driver.viewHierarchy(false),
      driver.screenshot(),
    ]);
    const built = buildIOSA11y(vh.axElement);
    return {
      platform: driver.platform, // 'ios' | 'tvos'
      width: info.widthPoints,
      height: info.heightPoints,
      hierarchy: { axElement: built.hierarchy, depth: vh.depth },
      a11ySnapshot: built.a11ySnapshot,
      screenshot: shot,
    };
  }

  if (driver instanceof WebDriver) {
    const [info, vh, shot] = await Promise.all([
      driver.deviceInfo(),
      driver.viewHierarchy(),
      driver.screenshot(),
    ]);
    const built = buildWebA11y(vh);
    return {
      platform: 'web',
      width: info.widthPixels,
      height: info.heightPixels,
      hierarchy: { ...vh, elements: built.hierarchy },
      a11ySnapshot: built.a11ySnapshot,
      screenshot: shot,
    };
  }

  if (
    driver instanceof AndroidDriver ||
    driver instanceof VegaDriver ||
    driver instanceof RokuDriver
  ) {
    // Vega and Roku emit uiautomator-style XML, so they reuse the Android a11y builder.
    const platform: CapturePlatform =
      driver instanceof VegaDriver ? 'vega' : driver instanceof RokuDriver ? 'roku' : 'android';
    const [info, xml, shot] = await Promise.all([
      driver.deviceInfo(),
      driver.viewHierarchy(),
      driver.screenshot(),
    ]);
    const built = buildAndroidA11y(xml);
    return {
      platform,
      width: info.widthPixels,
      height: info.heightPixels,
      hierarchy: { xml, elements: built.hierarchy },
      a11ySnapshot: built.a11ySnapshot,
      screenshot: shot,
    };
  }

  throw new Error('Unknown driver type');
}
