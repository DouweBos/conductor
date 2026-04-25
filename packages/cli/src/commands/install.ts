export const HELP_INSTALL_WEB = `  install-web [--check] [browser]     Install Playwright browser (chromium, firefox, webkit) (status only with --check)`;

import { printSuccess, printError, printData } from '../output.js';
import { ensurePlaywrightBrowser, isPlaywrightBrowserInstalled } from '../drivers/bootstrap.js';

export async function installWebCli(
  opts: { json: boolean },
  check: boolean,
  browserArg: string | undefined
): Promise<number> {
  try {
    if (check) {
      return checkWebInstallStatus(opts);
    }
    return installWebBrowser(browserArg, opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printError(`Install failed: ${message}`, opts);
    return 1;
  }
}

function checkWebInstallStatus(opts: { json: boolean }): number {
  const webBrowsers = {
    chromium: isPlaywrightBrowserInstalled('chromium'),
    firefox: isPlaywrightBrowserInstalled('firefox'),
    webkit: isPlaywrightBrowserInstalled('webkit'),
  };

  if (opts.json) {
    printData({ webBrowsers }, opts);
  } else {
    const installedBrowsers = Object.entries(webBrowsers)
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (installedBrowsers.length > 0) {
      console.log(`Web browsers: ${installedBrowsers.join(', ')}`);
    } else {
      console.log('Web browsers: none installed');
      console.log(
        'Run `conductor install-web` to install a Playwright browser (default: chromium).'
      );
    }
  }

  return 0;
}

async function installWebBrowser(
  browserArg: string | undefined,
  opts: { json: boolean }
): Promise<number> {
  const validBrowsers = ['chromium', 'firefox', 'webkit'] as const;
  type BrowserName = (typeof validBrowsers)[number];

  let browserName: BrowserName = 'chromium';
  if (browserArg !== undefined && browserArg !== '') {
    if (!validBrowsers.includes(browserArg as BrowserName)) {
      printError(`Unknown browser "${browserArg}". Supported: ${validBrowsers.join(', ')}`, opts);
      return 1;
    }
    browserName = browserArg as BrowserName;
  }

  try {
    await ensurePlaywrightBrowser(browserName, (msg) => {
      if (!opts.json) console.log(msg);
    });
    printSuccess(`Playwright ${browserName} browser installed`, opts);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printError(msg, opts);
    return 1;
  }
}
