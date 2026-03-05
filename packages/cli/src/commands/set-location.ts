import { runDirect } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';

export async function setLocation(
  latitude: number,
  longitude: number,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  const result = await runDirect(async (driver) => {
    await driver.setLocation(latitude, longitude);
  }, sessionName);

  if (result.success) {
    printSuccess(`set-location ${latitude},${longitude} — done`, opts);
    return 0;
  } else {
    printError(`set-location ${latitude},${longitude} — failed\n${result.stderr}`, opts);
    return 1;
  }
}
