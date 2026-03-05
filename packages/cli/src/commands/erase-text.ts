import { runDirect } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';

export async function eraseText(
  characters: number,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  const result = await runDirect(async (driver) => {
    if (driver instanceof AndroidDriver) {
      await driver.eraseAllText(characters);
    } else if (driver instanceof IOSDriver) {
      for (let i = 0; i < characters; i++) await driver.pressKey('delete');
    }
  }, sessionName);

  if (result.success) {
    printSuccess(`erase-text ${characters} — done`, opts);
    return 0;
  } else {
    printError(`erase-text ${characters} — failed\n${result.stderr}`, opts);
    return 1;
  }
}
