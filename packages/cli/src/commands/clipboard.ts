export const HELP = `  clipboard read                       Print the iOS simulator clipboard
  clipboard write <text>               Set the iOS simulator clipboard
  paste                                Paste the clipboard into the focused field (iOS only)`;

import { runDirect } from '../runner.js';
import { printSuccess, printError, printData, OutputOptions } from '../output.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { WebDriver } from '../drivers/web.js';

const ANDROID_MSG =
  'clipboard is iOS-only. On Android, use `conductor input-text` to type instead.';

export async function clipboardRead(
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  const result = await runDirect(async (driver) => {
    if (driver instanceof IOSDriver) return await driver.clipboardRead();
    if (driver instanceof AndroidDriver) throw new Error(ANDROID_MSG);
    if (driver instanceof WebDriver) throw new Error('clipboard read is not supported on Web');
    return '';
  }, sessionName);

  if (result.success) {
    if (opts.json) printData({ text: result.stdout }, opts);
    else process.stdout.write(result.stdout);
    return 0;
  } else {
    printError(`clipboard read — failed\n${result.stderr}`, opts);
    return 1;
  }
}

export async function clipboardWrite(
  text: string,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  const result = await runDirect(async (driver) => {
    if (driver instanceof IOSDriver) {
      await driver.clipboardWrite(text);
    } else if (driver instanceof AndroidDriver) {
      throw new Error(ANDROID_MSG);
    } else if (driver instanceof WebDriver) {
      throw new Error('clipboard write is not supported on Web');
    }
  }, sessionName);

  if (result.success) {
    printSuccess('clipboard write — done', opts);
    return 0;
  } else {
    printError(`clipboard write — failed\n${result.stderr}`, opts);
    return 1;
  }
}

export async function paste(opts: OutputOptions = {}, sessionName = 'default'): Promise<number> {
  const result = await runDirect(async (driver) => {
    if (driver instanceof IOSDriver) {
      // iOS has no universal OS-level paste — read the clipboard and type it into
      // the focused field. For app-specific Cmd+V handling, callers should issue
      // press-key paste explicitly via the keyboard route.
      const text = await driver.clipboardRead();
      if (text) await driver.inputText(text);
    } else if (driver instanceof AndroidDriver) {
      throw new Error('paste is iOS-only. On Android, use `conductor input-text` instead.');
    } else if (driver instanceof WebDriver) {
      throw new Error('paste is not supported on Web');
    }
  }, sessionName);

  if (result.success) {
    printSuccess('paste — done', opts);
    return 0;
  } else {
    printError(`paste — failed\n${result.stderr}`, opts);
    return 1;
  }
}
