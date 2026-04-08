#!/usr/bin/env node
import minimist from 'minimist';
import { setVerbose } from './verbose.js';
import {
  listDevices,
  discoverBootedDevices,
  HELP as listDevicesHelp,
} from './commands/list-devices.js';
import { launchApp, HELP as launchAppHelp } from './commands/launch-app.js';
import { stopApp, HELP as stopAppHelp } from './commands/stop-app.js';
import { clearState, HELP as clearStateHelp } from './commands/clear-state.js';
import { uninstallApp, HELP as uninstallAppHelp } from './commands/uninstall-app.js';
import { tap, HELP as tapHelp } from './commands/tap.js';
import { typeText, HELP as typeHelp } from './commands/type.js';
import { back, HELP as backHelp } from './commands/back.js';
import { scroll, HELP as scrollHelp } from './commands/scroll.js';
import { swipe, HELP as swipeHelp } from './commands/swipe.js';
import { assertVisible, HELP as assertVisibleHelp } from './commands/assert-visible.js';
import { screenshot, HELP as screenshotHelp } from './commands/screenshot.js';
import { inspect, HELP as inspectHelp } from './commands/inspect.js';
import { focused, HELP as focusedHelp } from './commands/focused.js';
import { runFlow, HELP as runFlowHelp } from './commands/run-flow.js';
import { runFlowInline, HELP as runFlowInlineHelp } from './commands/run-flow-inline.js';
import { pressKey, HELP as pressKeyHelp } from './commands/press-key.js';
import { sessionCmd, HELP as sessionHelp } from './commands/session.js';
import { cheatSheet, HELP as cheatSheetHelp } from './commands/cheat-sheet.js';
import {
  daemonStart,
  daemonStop,
  daemonStatusCmd,
  HELP_DAEMON_START as daemonStartHelp,
  HELP_DAEMON_STOP as daemonStopHelp,
  HELP_DAEMON_STATUS as daemonStatusHelp,
} from './commands/daemon.js';
import { installSkills, HELP as installHelp } from './commands/install.js';
import { devicePool, HELP as devicePoolHelp } from './commands/device-pool.js';
import { runParallel, HELP as runParallelHelp } from './commands/run-parallel.js';
import { foregroundApp, HELP as foregroundAppHelp } from './commands/foreground-app.js';
import { listApps, HELP as listAppsHelp } from './commands/list-apps.js';
import { copyApp, HELP as copyAppHelp } from './commands/copy-app.js';
import { eraseText, HELP as eraseTextHelp } from './commands/erase-text.js';
import { assertNotVisible, HELP as assertNotVisibleHelp } from './commands/assert-not-visible.js';
import { openLink, HELP as openLinkHelp } from './commands/open-link.js';
import { hideKeyboard, HELP as hideKeyboardHelp } from './commands/hide-keyboard.js';
import {
  scrollUntilVisible,
  HELP as scrollUntilVisibleHelp,
} from './commands/scroll-until-visible.js';
import { setLocation, HELP as setLocationHelp } from './commands/set-location.js';
import { setOrientation, HELP as setOrientationHelp } from './commands/set-orientation.js';
import { startDevice, HELP as startDeviceHelp } from './commands/start-device.js';
import { pickDevice } from './device-picker.js';
import { checkForUpdates } from './update-check.js';

const COMMAND_HELP: Record<string, string> = {
  'start-device': startDeviceHelp,
  'list-devices': listDevicesHelp,
  'foreground-app': foregroundAppHelp,
  'list-apps': listAppsHelp,
  'copy-app': copyAppHelp,
  'launch-app': launchAppHelp,
  'stop-app': stopAppHelp,
  'clear-state': clearStateHelp,
  'uninstall-app': uninstallAppHelp,
  tap: tapHelp,
  type: typeHelp,
  'erase-text': eraseTextHelp,
  back: backHelp,
  'press-key': pressKeyHelp,
  'hide-keyboard': hideKeyboardHelp,
  scroll: scrollHelp,
  swipe: swipeHelp,
  'scroll-until-visible': scrollUntilVisibleHelp,
  'assert-visible': assertVisibleHelp,
  'assert-not-visible': assertNotVisibleHelp,
  'open-link': openLinkHelp,
  'set-location': setLocationHelp,
  'set-orientation': setOrientationHelp,
  screenshot: screenshotHelp,
  inspect: inspectHelp,
  focused: focusedHelp,
  'run-flow': runFlowHelp,
  'run-flow-inline': runFlowInlineHelp,
  session: sessionHelp,
  'cheat-sheet': cheatSheetHelp,
  install: installHelp,
  'daemon-start': daemonStartHelp,
  'daemon-stop': daemonStopHelp,
  'daemon-status': daemonStatusHelp,
  'device-pool': devicePoolHelp,
  'run-parallel': runParallelHelp,
};

const OPTIONS_HELP = `Options:
  --device <id>     Target device ID (also keys the session and daemon)
  --device-name <n> Target a booted device by name (resolved to ID from booted devices)
  --json            Output as machine-readable JSON
  --verbose, -v     Log daemon calls, fallbacks, and raw output
  --help, -h        Show this help`;

const HELP = `Usage: conductor <command> [args] [options]

Commands:
${Object.values(COMMAND_HELP).join('\n')}

${OPTIONS_HELP}`;

async function main(): Promise<void> {
  checkForUpdates();

  const argv = minimist(process.argv.slice(2), {
    boolean: [
      'json',
      'help',
      'clear',
      'list',
      'verbose',
      'skills',
      'check',
      'all',
      'acquire',
      'release',
      'clear-state',
      'clear-keychain',
      'stop-app',
      'long-press',
      'double-tap',
      'optional',
      'benchmark',
      'dump',
    ],
    string: [
      'device',
      'output',
      'direction',
      'flows-dir',
      'yaml',
      'id',
      'text',
      'start',
      'end',
      'env',
      'below',
      'above',
      'left-of',
      'right-of',
      'lat',
      'lng',
      'platform',
      'os-version',
      'avd',
      'name',
      'device-name',
      'device-type',
      'from',
      'to',
    ],
    alias: { h: 'help', v: 'verbose' },
  });

  if (argv['verbose']) setVerbose(true);

  const [command, ...rest] = argv._;
  const opts = { json: argv['json'] as boolean };

  // Handle help and unknown commands before device resolution —
  // no point prompting for a device if we're just printing help or erroring out.
  if (!command || argv['help']) {
    if (command && argv['help'] && COMMAND_HELP[command]) {
      console.log(
        `Usage: conductor ${command} [options]\n\n${COMMAND_HELP[command]}\n\n${OPTIONS_HELP}`
      );
    } else {
      console.log(HELP);
    }
    process.exit(0);
  }

  // Commands that don't need a device session
  const NO_DEVICE_COMMANDS = new Set([
    'list-devices',
    'start-device',
    'cheat-sheet',
    'install',
    'copy-app',
    'device-pool',
    'run-parallel',
  ]);

  if (!NO_DEVICE_COMMANDS.has(command) && !COMMAND_HELP[command]) {
    console.error(`Unknown command: ${command}`);
    console.error('Run `conductor --help` for usage.');
    process.exit(1);
  }

  // The device ID is the natural key for both the session file and the daemon.
  // Use --device if given, otherwise detect the first booted device, otherwise 'default'.
  // Only resolve for commands that actually need a device.
  let sessionName = 'default';
  if (!NO_DEVICE_COMMANDS.has(command)) {
    const explicitDevice = argv['device'] as string | undefined;
    const deviceName = argv['device-name'] as string | undefined;

    if (explicitDevice && deviceName) {
      console.error('Error: --device and --device-name are mutually exclusive.');
      process.exit(1);
    }

    if (deviceName) {
      const devices = await discoverBootedDevices();
      const match = devices.find((d) => d.name === deviceName);
      if (!match) {
        console.error(
          `Error: No booted device found with name "${deviceName}". Run \`conductor list-devices\` to see booted devices.`
        );
        process.exit(1);
      }
      sessionName = match.id;
    } else {
      sessionName = explicitDevice ?? (await pickDevice()) ?? 'default';
    }
  }

  let exitCode = 0;

  switch (command) {
    case 'start-device':
      exitCode = await startDevice(argv['platform'] as string | undefined, opts, {
        osVersion: argv['os-version'] as string | undefined,
        avd: argv['avd'] as string | undefined,
        name: argv['name'] as string | undefined,
        deviceType: argv['device-type'] as string | undefined,
      });
      break;

    case 'list-devices':
      exitCode = await listDevices(opts);
      break;

    case 'foreground-app':
      exitCode = await foregroundApp(opts, sessionName);
      break;

    case 'list-apps':
      exitCode = await listApps(opts, sessionName);
      break;

    case 'copy-app': {
      const bundleId = rest[0] ?? '';
      const from = argv['from'] as string | undefined;
      const to = argv['to'] as string | undefined;
      exitCode = await copyApp(bundleId, from ?? '', to ?? '', opts);
      break;
    }

    case 'launch-app': {
      const appId = rest[0] ?? '';
      // --argument key=value (repeatable) → Record<string, string>
      const rawArgs = argv['argument'] ?? argv['arg'];
      const argPairs: string[] = Array.isArray(rawArgs) ? rawArgs : rawArgs ? [rawArgs] : [];
      const launchArgs = argPairs.length
        ? Object.fromEntries(argPairs.map((a: string) => a.split('=', 2) as [string, string]))
        : undefined;
      exitCode = await launchApp(appId, argv['device'] as string | undefined, opts, sessionName, {
        clearState: argv['clear-state'] as boolean,
        clearKeychain: argv['clear-keychain'] as boolean,
        stopApp: argv['stop-app'] !== false,
        launchArgs,
      });
      break;
    }

    case 'stop-app': {
      const appId = rest[0];
      exitCode = await stopApp(appId, opts, sessionName);
      break;
    }

    case 'clear-state': {
      const appId = rest[0];
      exitCode = await clearState(appId, opts, sessionName);
      break;
    }

    case 'uninstall-app': {
      const appId = rest[0] ?? '';
      exitCode = await uninstallApp(appId, opts, sessionName);
      break;
    }

    case 'tap': {
      const element = rest.join(' ');
      exitCode = await tap(element, opts, sessionName, {
        id: argv['id'] as string | undefined,
        text: argv['text'] as string | undefined,
        index: argv['index'] !== undefined ? Number(argv['index']) : undefined,
        longPress: argv['long-press'] as boolean,
        doubleTap: argv['double-tap'] as boolean,
        optional: argv['optional'] as boolean,
        focused: argv['focused'] !== undefined ? (argv['focused'] as boolean) : undefined,
        enabled: argv['enabled'] !== undefined ? (argv['enabled'] as boolean) : undefined,
        checked: argv['checked'] !== undefined ? (argv['checked'] as boolean) : undefined,
        selected: argv['selected'] !== undefined ? (argv['selected'] as boolean) : undefined,
        below: argv['below'] as string | undefined,
        above: argv['above'] as string | undefined,
        leftOf: argv['left-of'] as string | undefined,
        rightOf: argv['right-of'] as string | undefined,
      });
      break;
    }

    case 'type': {
      const text = rest.join(' ');
      exitCode = await typeText(text, opts, sessionName);
      break;
    }

    case 'erase-text': {
      const n =
        rest[0] !== undefined
          ? Number(rest[0])
          : argv['characters'] !== undefined
            ? Number(argv['characters'])
            : 50;
      exitCode = await eraseText(n, opts, sessionName);
      break;
    }

    case 'back':
      exitCode = await back(opts, sessionName);
      break;

    case 'hide-keyboard':
      exitCode = await hideKeyboard(opts, sessionName);
      break;

    case 'press-key': {
      const key = rest[0] ?? '';
      exitCode = await pressKey(key, opts, sessionName);
      break;
    }

    case 'scroll': {
      type ScrollDir = 'down' | 'up' | 'left' | 'right';
      const dir = ((argv['direction'] as string) || 'down').toLowerCase() as ScrollDir;
      exitCode = await scroll(dir, opts, sessionName);
      break;
    }

    case 'swipe': {
      const dir = (argv['direction'] as string) || '';
      exitCode = await swipe(dir, opts, sessionName, {
        start: argv['start'] as string | undefined,
        end: argv['end'] as string | undefined,
        duration: argv['duration'] !== undefined ? Number(argv['duration']) : undefined,
      });
      break;
    }

    case 'scroll-until-visible': {
      const element = rest.join(' ');
      const rawDir = ((argv['direction'] as string) || 'down').toLowerCase();
      exitCode = await scrollUntilVisible(element, opts, sessionName, {
        id: argv['id'] as string | undefined,
        text: argv['text'] as string | undefined,
        index: argv['index'] !== undefined ? Number(argv['index']) : undefined,
        direction: rawDir as 'down' | 'up' | 'left' | 'right',
        timeout: argv['timeout'] !== undefined ? Number(argv['timeout']) : undefined,
        focused: argv['focused'] !== undefined ? (argv['focused'] as boolean) : undefined,
        enabled: argv['enabled'] !== undefined ? (argv['enabled'] as boolean) : undefined,
        checked: argv['checked'] !== undefined ? (argv['checked'] as boolean) : undefined,
        selected: argv['selected'] !== undefined ? (argv['selected'] as boolean) : undefined,
      });
      break;
    }

    case 'assert-visible': {
      const element = rest.join(' ');
      exitCode = await assertVisible(element, opts, sessionName, {
        id: argv['id'] as string | undefined,
        text: argv['text'] as string | undefined,
        index: argv['index'] !== undefined ? Number(argv['index']) : undefined,
        timeout: argv['timeout'] !== undefined ? Number(argv['timeout']) : undefined,
        optional: argv['optional'] as boolean,
        focused: argv['focused'] !== undefined ? (argv['focused'] as boolean) : undefined,
        enabled: argv['enabled'] !== undefined ? (argv['enabled'] as boolean) : undefined,
        checked: argv['checked'] !== undefined ? (argv['checked'] as boolean) : undefined,
        selected: argv['selected'] !== undefined ? (argv['selected'] as boolean) : undefined,
        below: argv['below'] as string | undefined,
        above: argv['above'] as string | undefined,
        leftOf: argv['left-of'] as string | undefined,
        rightOf: argv['right-of'] as string | undefined,
      });
      break;
    }

    case 'assert-not-visible': {
      const element = rest.join(' ');
      exitCode = await assertNotVisible(element, opts, sessionName, {
        id: argv['id'] as string | undefined,
        text: argv['text'] as string | undefined,
        index: argv['index'] !== undefined ? Number(argv['index']) : undefined,
        timeout: argv['timeout'] !== undefined ? Number(argv['timeout']) : undefined,
        focused: argv['focused'] !== undefined ? (argv['focused'] as boolean) : undefined,
        enabled: argv['enabled'] !== undefined ? (argv['enabled'] as boolean) : undefined,
        checked: argv['checked'] !== undefined ? (argv['checked'] as boolean) : undefined,
        selected: argv['selected'] !== undefined ? (argv['selected'] as boolean) : undefined,
        below: argv['below'] as string | undefined,
        above: argv['above'] as string | undefined,
        leftOf: argv['left-of'] as string | undefined,
        rightOf: argv['right-of'] as string | undefined,
      });
      break;
    }

    case 'open-link': {
      const url = rest[0] ?? (argv['url'] as string | undefined) ?? '';
      exitCode = await openLink(url, opts, sessionName);
      break;
    }

    case 'set-location': {
      const lat = Number(argv['lat'] ?? argv['latitude']);
      const lng = Number(argv['lng'] ?? argv['longitude']);
      if (isNaN(lat) || isNaN(lng)) {
        console.error('set-location requires --lat <n> --lng <n>');
        exitCode = 1;
      } else {
        exitCode = await setLocation(lat, lng, opts, sessionName);
      }
      break;
    }

    case 'set-orientation': {
      const orientation = (
        rest[0] ??
        (argv['orientation'] as string | undefined) ??
        ''
      ).toLowerCase();
      exitCode = await setOrientation(orientation, opts, sessionName);
      break;
    }

    case 'screenshot': {
      const outPath = argv['output'] as string | undefined;
      exitCode = await screenshot(outPath, opts, sessionName);
      break;
    }

    case 'inspect':
      exitCode = await inspect(opts, sessionName, { dump: argv['dump'] as boolean });
      break;

    case 'focused':
      exitCode = await focused(opts, sessionName, {
        poll: argv['poll'] as boolean,
        interval: argv['interval'] !== undefined ? Number(argv['interval']) : undefined,
      });
      break;

    case 'run-flow': {
      const file = rest[0] ?? '';
      const rawEnv = argv['env'];
      const envPairs: string[] = Array.isArray(rawEnv) ? rawEnv : rawEnv ? [rawEnv] : [];
      const flowEnv = Object.fromEntries(
        envPairs.map((e: string) => e.split('=', 2) as [string, string])
      );
      exitCode = await runFlow(file, opts, sessionName, flowEnv, argv['benchmark'] as boolean);
      break;
    }

    case 'run-flow-inline': {
      const yaml = (argv['yaml'] as string) || rest.join(' ');
      exitCode = await runFlowInline(yaml, opts, sessionName, argv['benchmark'] as boolean);
      break;
    }

    case 'session':
      exitCode = await sessionCmd(
        argv['clear'] as boolean,
        argv['list'] as boolean,
        opts,
        sessionName
      );
      break;

    case 'cheat-sheet':
      exitCode = await cheatSheet();
      break;

    case 'install':
      exitCode = await installSkills(opts, argv['skills'] as boolean, argv['check'] as boolean);
      break;

    case 'daemon-start':
      exitCode = await daemonStart(opts, sessionName);
      break;

    case 'daemon-stop':
      exitCode = await daemonStop(opts, sessionName, argv['all'] as boolean);
      break;

    case 'daemon-status':
      exitCode = await daemonStatusCmd(opts, sessionName);
      break;

    case 'device-pool': {
      const acquire = argv['acquire'] as boolean;
      const release = argv['release'] as boolean;
      const releaseId = typeof argv['release'] === 'string' ? argv['release'] : rest[0];
      const action = acquire ? 'acquire' : release || releaseId ? 'release' : 'list';
      exitCode = await devicePool(action, releaseId, opts);
      break;
    }

    case 'run-parallel': {
      const flowsDir = (argv['flows-dir'] as string | undefined) ?? rest[0] ?? '';
      exitCode = await runParallel(flowsDir, opts);
      break;
    }

    default:
      // Should be unreachable — unknown commands are caught before device resolution.
      console.error(`Unknown command: ${command}`);
      console.error('Run `conductor --help` for usage.');
      exitCode = 1;
  }

  process.exit(exitCode);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${message}`);
  process.exit(1);
});
