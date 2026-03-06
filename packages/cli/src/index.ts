#!/usr/bin/env node
import minimist from 'minimist';
import { setVerbose } from './verbose.js';
import { listDevices } from './commands/list-devices.js';
import { launchApp } from './commands/launch-app.js';
import { stopApp } from './commands/stop-app.js';
import { tap } from './commands/tap.js';
import { typeText } from './commands/type.js';
import { back } from './commands/back.js';
import { scroll } from './commands/scroll.js';
import { swipe } from './commands/swipe.js';
import { assertVisible } from './commands/assert-visible.js';
import { screenshot } from './commands/screenshot.js';
import { inspect } from './commands/inspect.js';
import { runFlow } from './commands/run-flow.js';
import { runFlowInline } from './commands/run-flow-inline.js';
import { pressKey } from './commands/press-key.js';
import { sessionCmd } from './commands/session.js';
import { cheatSheet } from './commands/cheat-sheet.js';
import { daemonStart, daemonStop, daemonStatusCmd } from './commands/daemon.js';
import { installSkills } from './commands/install.js';
import { devicePool } from './commands/device-pool.js';
import { runParallel } from './commands/run-parallel.js';
import { foregroundApp } from './commands/foreground-app.js';
import { listApps } from './commands/list-apps.js';
import { eraseText } from './commands/erase-text.js';
import { assertNotVisible } from './commands/assert-not-visible.js';
import { openLink } from './commands/open-link.js';
import { hideKeyboard } from './commands/hide-keyboard.js';
import { scrollUntilVisible } from './commands/scroll-until-visible.js';
import { setLocation } from './commands/set-location.js';
import { setOrientation } from './commands/set-orientation.js';
import { startDevice } from './commands/start-device.js';
import { detectFirstDevice } from './runner.js';
import { checkForUpdates } from './update-check.js';

const HELP = `
Usage: conductor <command> [args] [options]

Commands:
  start-device --platform <ios|android>  Boot a simulator or emulator
    --os-version <n>                  iOS version (e.g. 18) or Android API level (e.g. 33)
    --avd <name>                      Android AVD name (default: first available)
  list-devices                        List connected devices/simulators
  foreground-app                      Print bundle ID / package of the foreground app
  list-apps                           List installed app IDs / package names
  launch-app <appId>                  Launch app (saves to session)
    --clear-state                     Clear app data/state before launching
    --clear-keychain                  Clear keychain before launching
    --no-stop-app                     Do not stop the app before launching (resume instead of restart)
    --argument key=value              Set launch argument (repeatable)
  stop-app [<appId>]                  Stop app
  tap <element>                       Tap element by text or id
    --id <id>                         Match by accessibility id instead of text
    --text <text>                     Match by text only (not id)
    --index <n>                       Pick the nth match (0-based)
    --long-press                      Hold instead of tap
    --double-tap                      Double-tap the element
    --optional                        Do not fail if element is not found
    --focused                         Match only focused elements
    --enabled / --no-enabled          Match by enabled state
    --checked / --no-checked          Match by checked state
    --selected / --no-selected        Match by selected state
    --below <text>                    Match element below the given reference
    --above <text>                    Match element above the given reference
    --left-of <text>                  Match element left of the given reference
    --right-of <text>                 Match element right of the given reference
    --verbose                         Log all candidates and chosen element
  type <text>                         Type text into focused field
  erase-text [n]                      Erase n characters (default: 50)
  back                                Press back button
  press-key <key>                     Press a key (Enter, Backspace, Home, ...)
  hide-keyboard                       Dismiss the on-screen keyboard
  scroll [--direction down|up|left|right]
  swipe --direction <UP|DOWN|LEFT|RIGHT>
    --start <x,y>                     Start coordinate (0–1 normalised or absolute px)
    --end <x,y>                       End coordinate (0–1 normalised or absolute px)
    --duration <ms>                   Swipe duration in milliseconds (default: 500)
  scroll-until-visible <element>      Scroll until element is visible
    --id <id>                         Match by accessibility id instead of text
    --text <text>                     Match by text only (not id)
    --direction <down|up|left|right>  Scroll direction (default: down)
    --timeout <ms>                    Max time in milliseconds (default: 30000)
  assert-visible <element>            Assert element is visible
    --id <id>                         Match by accessibility id instead of text
    --text <text>                     Match by text only (not id)
    --index <n>                       Pick the nth match (0-based)
    --timeout <ms>                    Max wait time in milliseconds
    --optional                        Do not fail if element is not found
    --focused                         Match only focused elements
    --enabled / --no-enabled          Match by enabled state
    --checked / --no-checked          Match by checked state
    --selected / --no-selected        Match by selected state
    --below <text>                    Match element below the given reference
    --above <text>                    Match element above the given reference
    --left-of <text>                  Match element left of the given reference
    --right-of <text>                 Match element right of the given reference
  assert-not-visible <element>        Assert element is absent from screen
    --id <id>                         Match by accessibility id instead of text
    --text <text>                     Match by text only (not id)
    --timeout <ms>                    Max check time in milliseconds (default: 1000)
  open-link <url>                     Open a URL / deep link
  set-location --lat <n> --lng <n>    Set GPS coordinates
  set-orientation <portrait|landscape> Set device orientation
  screenshot [--output <path>]        Take screenshot
  inspect                             Print UI hierarchy
  run-flow <file> [--device <id>]     Run a Maestro YAML flow file
    --env KEY=VALUE                   Inject env var (repeatable; overrides flow env block)
    --benchmark                       Print elapsed time for each command and total flow time
  run-flow-inline <yaml>              Run inline YAML commands
    --benchmark                       Print elapsed time for each command and total flow time
  session [--clear] [--list]          Show, clear, or list device sessions
  cheat-sheet                         Print command reference
  install                             Install/reinstall Claude Code plugin
  install --skills                    Copy skills into local .claude/skills/
  install --check                     Print current install status without modifying anything
  daemon-start                        Start background daemon (manages driver process)
  daemon-stop [--all]                 Stop background daemon (--all stops every session's daemon)
  daemon-status                       Show daemon status
  device-pool --list                  List all devices and pool status
  device-pool --acquire               Claim a free device (prints device ID)
  device-pool --release <id>          Release a device back to the pool
  run-parallel --flows-dir <path>     Run flows in parallel across all devices

Options:
  --device <id>     Target device ID (also keys the session and daemon)
  --json            Output as machine-readable JSON
  --verbose, -v     Log daemon calls, fallbacks, and raw output
  --help, -h        Show this help
`.trim();

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
    ],
    alias: { h: 'help', v: 'verbose' },
  });

  if (argv['verbose']) setVerbose(true);

  const [command, ...rest] = argv._;
  const opts = { json: argv['json'] as boolean };

  // The device ID is the natural key for both the session file and the daemon.
  // Use --device if given, otherwise detect the first booted device, otherwise 'default'.
  const explicitDevice = argv['device'] as string | undefined;
  const sessionName: string = explicitDevice ?? (await detectFirstDevice()) ?? 'default';

  if (!command || argv['help']) {
    console.log(HELP);
    process.exit(0);
  }

  let exitCode = 0;

  switch (command) {
    case 'start-device':
      exitCode = await startDevice(argv['platform'] as string | undefined, opts, {
        osVersion: argv['os-version'] as string | undefined,
        avd: argv['avd'] as string | undefined,
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
      exitCode = await inspect(opts, sessionName);
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
