export const HELP = `  set-viewport [<width> <height>]      Resize the web browser viewport, or on macOS the target app's window (points)
    --preset <mobile|tablet|desktop>  Use a device preset instead of explicit width/height
    --width <n> / --height <n>         Viewport size in CSS pixels
    --scale <n>                       Device scale factor (default: 2 for mobile/tablet, else 1)
    --mobile / --no-mobile            Emulate a mobile device (touch + mobile UA hints)
    --user-agent <str>                Override the user agent string
    --color-scheme <dark|light>       Emulate prefers-color-scheme
                                       (--scale, --mobile, --user-agent and --color-scheme are web-only)`;

import { runDirect } from '../runner.js';
import { WebDriver } from '../drivers/web.js';
import { MacDriver } from '../drivers/macos.js';
import { printSuccess, printError, OutputOptions } from '../output.js';

interface Preset {
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
}

export const PRESETS: Record<string, Preset> = {
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

/** Flags that only mean something to a browser; macOS resizes a real window. */
export function macViewportFlagError(flags: SetViewportOptions): string | null {
  const webOnly = [
    flags.scale !== undefined && '--scale',
    flags.mobile !== undefined && '--mobile',
    flags.userAgent !== undefined && '--user-agent',
    flags.colorScheme !== undefined && '--color-scheme',
  ].filter(Boolean);
  return webOnly.length
    ? `${webOnly.join(', ')} ${webOnly.length === 1 ? 'is' : 'are'} web-only — on macOS set-viewport only resizes the window`
    : null;
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
    if (driver instanceof MacDriver) {
      const error = macViewportFlagError(flags);
      if (error) throw new Error(error);
      await driver.setWindow({ width: width!, height: height! });
      return;
    }
    if (!(driver instanceof WebDriver)) {
      throw new Error('set-viewport is only supported on web devices and macOS');
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
