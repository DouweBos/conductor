export const HELP = `  set-viewport [<width> <height>]      Resize the web browser viewport (web only)
    --preset <mobile|tablet|desktop>  Use a device preset instead of explicit width/height
    --width <n> / --height <n>         Viewport size in CSS pixels
    --scale <n>                       Device scale factor (default: 2 for mobile/tablet, else 1)
    --mobile / --no-mobile            Emulate a mobile device (touch + mobile UA hints)
    --user-agent <str>                Override the user agent string
    --color-scheme <dark|light>       Emulate prefers-color-scheme`;

import { runDirect } from '../runner.js';
import { WebDriver } from '../drivers/web.js';
import { printSuccess, printError, OutputOptions } from '../output.js';

interface Preset {
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
}

const PRESETS: Record<string, Preset> = {
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2, isMobile: true },
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false },
};

export interface SetViewportOptions {
  preset?: string;
  width?: number;
  height?: number;
  scale?: number;
  mobile?: boolean;
  userAgent?: string;
  colorScheme?: string;
}

export async function setViewport(
  flags: SetViewportOptions,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  let width = flags.width;
  let height = flags.height;
  let isMobile = flags.mobile;
  let scale = flags.scale;

  if (flags.preset !== undefined) {
    const preset = PRESETS[flags.preset.toLowerCase()];
    if (!preset) {
      printError(`--preset must be one of: ${Object.keys(PRESETS).join(', ')}`, opts);
      return 1;
    }
    width ??= preset.width;
    height ??= preset.height;
    scale ??= preset.deviceScaleFactor;
    isMobile ??= preset.isMobile;
  }

  if (width === undefined || height === undefined) {
    printError('set-viewport requires --preset or both width and height', opts);
    return 1;
  }

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    printError('set-viewport width and height must be positive numbers', opts);
    return 1;
  }

  if (
    flags.colorScheme !== undefined &&
    flags.colorScheme !== 'dark' &&
    flags.colorScheme !== 'light'
  ) {
    printError('--color-scheme must be "dark" or "light"', opts);
    return 1;
  }

  const result = await runDirect(async (driver) => {
    if (!(driver instanceof WebDriver)) {
      throw new Error('set-viewport is only supported on web devices');
    }
    await driver.setViewport({
      width: width!,
      height: height!,
      ...(scale !== undefined ? { deviceScaleFactor: scale } : {}),
      ...(isMobile !== undefined ? { isMobile } : {}),
      ...(flags.userAgent !== undefined ? { userAgent: flags.userAgent } : {}),
      ...(flags.colorScheme !== undefined
        ? { colorScheme: flags.colorScheme as 'dark' | 'light' }
        : {}),
    });
  }, sessionName);

  if (result.success) {
    printSuccess(`set-viewport ${width}x${height} — done`, opts);
    return 0;
  } else {
    printError(`set-viewport ${width}x${height} — failed\n${result.stderr}`, opts);
    return 1;
  }
}
