/**
 * Unified test entry point.
 *
 * Always runs:  unit tests (parser, executors, mock drivers) — no device needed
 * When a booted iOS simulator is detected, also runs: YAML flow E2E tests
 *
 * Run: pnpm test
 *
 * Options:
 *   SUITE=<pattern>    Env var: run only suites whose name contains <pattern> (case-insensitive)
 *   [udid]             First positional arg is treated as the device UDID
 *
 * Examples:
 *   SUITE=parser pnpm test
 *   SUITE=executor pnpm test
 *   SUITE=e2e pnpm test -- <udid>
 */
import path from 'path';
import { runAll, TestSuite } from './runner.js';
import { parser } from './parser.test.js';
import { iosExec } from './executor-ios.test.js';
import { androidExec } from './executor-android.test.js';
import { fileBased } from './file-based.test.js';
import { scriptSuite } from './run-script.test.js';
import { elementResolver } from './element-resolver.test.js';
import { a11ySuite } from './a11y.test.js';
import { envFlag } from './env-flag.test.js';
import { daemonIdle } from './daemon-idle.test.js';
import { devicePoolSuite } from './device-pool.test.js';
import { androidSdk } from './android-sdk.test.js';
import { getDriver } from '../src/runner.js';
import { IOSDriver } from '../src/drivers/ios.js';
import { parseFlowFile, executeFlow } from '../src/drivers/flow-runner.js';

// __dirname = dist-tests/tests/  →  ../../tests/flows = source tree
const FLOWS = path.join(__dirname, '../../tests/flows');

function parseArgs(): { deviceUdid: string | undefined; suiteFilter: string | undefined } {
  const args = process.argv.slice(2);
  let deviceUdid: string | undefined;
  const suiteFilter: string | undefined = process.env.SUITE;

  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('-')) {
      deviceUdid = args[i];
    }
  }

  return { deviceUdid, suiteFilter };
}

async function detectDevice(deviceUdid: string | undefined): Promise<string | undefined> {
  if (deviceUdid) return deviceUdid;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execSync } = require('child_process') as typeof import('child_process');
    const out = execSync('xcrun simctl list devices booted --json', { encoding: 'utf-8' });
    const parsed = JSON.parse(out) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    for (const sims of Object.values(parsed.devices)) {
      for (const s of sims) {
        if (s.state === 'Booted') return s.udid;
      }
    }
  } catch { /* no xcrun */ }
  return undefined;
}

async function main(): Promise<void> {
  const { deviceUdid, suiteFilter } = parseArgs();
  const device = await detectDevice(deviceUdid);
  let suites = [parser, iosExec, androidExec, fileBased, scriptSuite, elementResolver, a11ySuite, envFlag, daemonIdle, devicePoolSuite, androidSdk];

  if (device) {
    console.log(`\nDevice: ${device}`);

    const e2e = new TestSuite('YAML Flow E2E');

    e2e.test('settings-about.yaml: launch → General → About → iOS Version → Home', async () => {
      const driver = await getDriver(device);
      if (!(driver instanceof IOSDriver)) throw new Error('Expected iOS driver');
      const flow = await parseFlowFile(path.join(FLOWS, 'settings-about.yaml'));
      await executeFlow(flow, driver, { cwd: FLOWS });
    });

    suites.push(e2e);
  } else {
    console.log('\n(No booted iOS simulator — skipping E2E tests)');
  }

  if (suiteFilter) {
    const pattern = suiteFilter.toLowerCase();
    suites = suites.filter(s => s.name.toLowerCase().includes(pattern));
    if (suites.length === 0) {
      console.error(`\nNo suites matched filter: "${suiteFilter}"`);
      process.exit(1);
    }
    console.log(`\nRunning ${suites.length} suite(s) matching "${suiteFilter}": ${suites.map(s => s.name).join(', ')}`);
  }

  await runAll(suites);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
