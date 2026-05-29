#!/usr/bin/env node
import minimist from 'minimist';
import { setVerbose } from './verbose.js';
import { ensureAndroidEnv } from './android/sdk.js';
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
import { captureUI, HELP as captureUIHelp } from './commands/capture-ui.js';
import { inspect, HELP as inspectHelp } from './commands/inspect.js';
import { focused, HELP as focusedHelp } from './commands/focused.js';
import { runFlow, HELP as runFlowHelp } from './commands/run-flow.js';
import { runFlowInline, HELP as runFlowInlineHelp } from './commands/run-flow-inline.js';
import { pressKey, HELP as pressKeyHelp } from './commands/press-key.js';
import { sessionCmd, HELP as sessionHelp } from './commands/session.js';
import {
  daemonStart,
  daemonStop,
  daemonStatusCmd,
  HELP_DAEMON_START as daemonStartHelp,
  HELP_DAEMON_STOP as daemonStopHelp,
  HELP_DAEMON_STATUS as daemonStatusHelp,
} from './commands/daemon.js';
import { installWebCli, HELP_INSTALL_WEB } from './commands/install.js';
import { devicePool, HELP as devicePoolHelp } from './commands/device-pool.js';
import { runParallel, HELP as runParallelHelp } from './commands/run-parallel.js';
import { runSequence, HELP as runSequenceHelp } from './commands/run-sequence.js';
import { pinch, rotateGesture, gesture, HELP as gesturesHelp } from './commands/gestures.js';
import { workspaceCmd, HELP as workspaceHelp } from './commands/workspace.js';
import {
  debugStatus,
  debugEvaluate,
  debugComponentTree,
  debugInspectElement,
  debugLogRegistry,
  debugReload,
  HELP as debugHelp,
} from './commands/debug.js';
import { networkLogs, networkRequest, HELP as networkHelp } from './commands/network.js';
import { flowRecord, HELP as flowRecordHelp } from './commands/flow-record.js';
import {
  profileCpu,
  profileMemory,
  profileReactStart,
  profileReactStop,
  HELP as profileHelp,
} from './commands/profile.js';
import { crashesList, crashesShow, crashesTail, HELP as crashesHelp } from './commands/crashes.js';
import { getActiveRecording, appendStep, commandToYamlStep } from './drivers/flow-recorder.js';
import { foregroundApp, HELP as foregroundAppHelp } from './commands/foreground-app.js';
import { listApps, HELP as listAppsHelp } from './commands/list-apps.js';
import { copyApp, HELP as copyAppHelp } from './commands/copy-app.js';
import { downloadApp, HELP as downloadAppHelp } from './commands/download-app.js';
import { installApp, HELP as installAppHelp } from './commands/install-app.js';
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
import { setViewport, HELP as setViewportHelp } from './commands/set-viewport.js';
import { startDevice, HELP as startDeviceHelp } from './commands/start-device.js';
import { stopDevice, HELP as stopDeviceHelp } from './commands/stop-device.js';
import { deleteDevice, HELP as deleteDeviceHelp } from './commands/delete-device.js';
import { logs, HELP as logsHelp } from './commands/logs.js';
import { memory, HELP as memoryHelp } from './commands/memory.js';
import { metroStop, metroReload, HELP as metroHelp } from './commands/metro.js';
import {
  clipboardRead,
  clipboardWrite,
  paste,
  HELP as clipboardHelp,
} from './commands/clipboard.js';
import { pickDevice } from './device-picker.js';
import { checkForUpdates } from './update-check.js';
import { findPkgRoot } from './pkg-root.js';
import fs from 'fs';
import path from 'path';

const COMMAND_HELP: Record<string, string> = {
  'start-device': startDeviceHelp,
  'stop-device': stopDeviceHelp,
  'delete-device': deleteDeviceHelp,
  'list-devices': listDevicesHelp,
  'foreground-app': foregroundAppHelp,
  'list-apps': listAppsHelp,
  'copy-app': copyAppHelp,
  'download-app': downloadAppHelp,
  'install-app': installAppHelp,
  'launch-app': launchAppHelp,
  'stop-app': stopAppHelp,
  'clear-state': clearStateHelp,
  'uninstall-app': uninstallAppHelp,
  'tap-on': tapHelp,
  'input-text': typeHelp,
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
  'set-viewport': setViewportHelp,
  'take-screenshot': screenshotHelp,
  'capture-ui': captureUIHelp,
  inspect: inspectHelp,
  focused: focusedHelp,
  'run-flow': runFlowHelp,
  'run-flow-inline': runFlowInlineHelp,
  session: sessionHelp,
  'install-web': HELP_INSTALL_WEB,
  'daemon-start': daemonStartHelp,
  'daemon-stop': daemonStopHelp,
  'daemon-status': daemonStatusHelp,
  'device-pool': devicePoolHelp,
  'run-parallel': runParallelHelp,
  'run-sequence': runSequenceHelp,
  gestures: gesturesHelp,
  workspace: workspaceHelp,
  debug: debugHelp,
  network: networkHelp,
  'flow record': flowRecordHelp,
  profile: profileHelp,
  crashes: crashesHelp,
  logs: logsHelp,
  memory: memoryHelp,
  metro: metroHelp,
  clipboard: clipboardHelp,
  paste: '  paste                                Trigger OS-level paste (or type clipboard on iOS)',
};

const OPTIONS_HELP = `Options:
  --device <id>     Target device ID (also keys the session and daemon)
  --device-name <n> Target a booted device by name (resolved to ID from booted devices)
  --platform <p>    Filter to devices of this platform (ios, android, tvos, web)
  --json            Output as machine-readable JSON
  --verbose, -v     Log daemon calls, fallbacks, and raw output
  --version, -V     Print version number
  --help, -h        Show this help`;

const HELP = `Usage: conductor <command> [args] [options]

Commands:
${Object.values(COMMAND_HELP).join('\n')}

${OPTIONS_HELP}`;

async function main(): Promise<void> {
  ensureAndroidEnv();
  checkForUpdates();

  const argv = minimist(process.argv.slice(2), {
    boolean: [
      'json',
      'help',
      'version',
      'clear',
      'list',
      'verbose',
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
      'tappable',
      'objects',
      'heap',
      'leaks',
      'snapshots',
      'growth-only',
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
      'system-image',
      'browser',
      'from',
      'to',
      'source',
      'level',
      'save',
      'diff',
      'vs',
      'top',
      'filter',
      'port',
      'target',
      'at',
      'file',
      'scale',
      'center',
      'degrees',
      'angle',
      'limit',
      'method',
      'body',
      'header',
      'url',
      'out',
      'track',
      'interval',
      'app',
      'since',
      'preset',
      'width',
      'height',
      'user-agent',
      'color-scheme',
    ],
    alias: { h: 'help', v: 'verbose', V: 'version' },
  });

  if (argv['verbose']) setVerbose(true);

  const [command, ...rest] = argv._;
  const opts = { json: argv['json'] as boolean };

  if (argv['version']) {
    const pkgRoot = findPkgRoot(__dirname);
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf-8'));
    console.log(pkg.version);
    process.exit(0);
  }

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
    'stop-device',
    'delete-device',
    'install-web',
    'copy-app',
    'device-pool',
    'run-parallel',
    'metro',
    'workspace',
    // `logs --list` and `logs --source metro` only query Metro on localhost — no device needed
    // `logs` always needs a device session — Metro discovery is device-scoped.
    // `daemon-stop --all` stops every daemon — no device needed
    ...(command === 'daemon-stop' && argv['all'] ? ['daemon-stop'] : []),
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
      sessionName =
        explicitDevice ?? (await pickDevice(argv['platform'] as string | undefined)) ?? 'default';
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
        systemImage: argv['system-image'] as string | undefined,
        browser: argv['browser'] as string | undefined,
      });
      break;

    case 'list-devices':
      exitCode = await listDevices(opts);
      break;

    case 'stop-device':
      exitCode = await stopDevice(rest[0], opts, {
        platform: argv['platform'] as string | undefined,
        all: argv['all'] as boolean,
      });
      break;

    case 'delete-device':
      exitCode = await deleteDevice(rest[0], opts, {
        platform: argv['platform'] as string | undefined,
        all: argv['all'] as boolean,
      });
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

    case 'download-app': {
      const appId = rest[0] ?? '';
      exitCode = await downloadApp(appId, argv['output'] as string | undefined, opts, sessionName);
      break;
    }

    case 'install-app': {
      const appPath = rest[0] ?? '';
      exitCode = await installApp(appPath, opts, sessionName);
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

    case 'tap-on': {
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

    case 'input-text': {
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

    case 'set-viewport': {
      exitCode = await setViewport(
        {
          preset: argv['preset'] as string | undefined,
          width:
            argv['width'] !== undefined
              ? Number(argv['width'])
              : rest[0] !== undefined
                ? Number(rest[0])
                : undefined,
          height:
            argv['height'] !== undefined
              ? Number(argv['height'])
              : rest[1] !== undefined
                ? Number(rest[1])
                : undefined,
          scale: argv['scale'] !== undefined ? Number(argv['scale']) : undefined,
          mobile: argv['mobile'] as boolean | undefined,
          userAgent: argv['user-agent'] as string | undefined,
          colorScheme: argv['color-scheme'] as string | undefined,
        },
        opts,
        sessionName
      );
      break;
    }

    case 'take-screenshot': {
      const outPath = argv['output'] as string | undefined;
      const fullPage = Boolean(argv['full-page']);
      exitCode = await screenshot(outPath, opts, sessionName, fullPage);
      break;
    }

    case 'capture-ui': {
      const outPath = argv['output'] as string | undefined;
      exitCode = await captureUI(outPath, opts, sessionName);
      break;
    }

    case 'inspect':
      exitCode = await inspect(opts, sessionName, {
        dump: argv['dump'] as boolean,
        at: argv['at'] as string | undefined,
        tappableOnly: argv['tappable'] as boolean,
      });
      break;

    case 'focused':
      exitCode = await focused(opts, sessionName, {
        poll: argv['poll'] as boolean,
        interval: argv['interval'] !== undefined ? Number(argv['interval']) : undefined,
      });
      break;

    case 'logs':
      exitCode = await logs(opts, sessionName, {
        source: argv['source'] as string | undefined,
        level: argv['level'] as string | undefined,
        list: argv['list'] as boolean,
        recent: argv['recent'] !== undefined ? Number(argv['recent']) : undefined,
        duration: argv['duration'] !== undefined ? Number(argv['duration']) : undefined,
      });
      break;

    case 'memory': {
      const appId = rest[0];
      const all = argv['all'] as boolean;
      exitCode = await memory(appId, opts, sessionName, {
        objects: (argv['objects'] as boolean) || (argv['heap'] as boolean) || all,
        leaks: (argv['leaks'] as boolean) || all,
        top: argv['top'] !== undefined ? Number(argv['top']) : undefined,
        save: argv['save'] as string | undefined,
        diff: argv['diff'] as string | undefined,
        diffOther: argv['vs'] as string | undefined,
        listSnapshots: argv['snapshots'] as boolean,
        // minimist treats --no-gc as gc=false; default-on lives in memory.ts.
        gc: argv['gc'] as boolean | undefined,
        filter: argv['filter'] as string | undefined,
        growthOnly: argv['growth-only'] as boolean,
      });
      break;
    }

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

    case 'install-web':
      exitCode = await installWebCli(opts, argv['check'] as boolean, rest[0]);
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

    case 'run-sequence': {
      const file = (argv['file'] as string | undefined) ?? rest[0];
      exitCode = await runSequence(file, opts, sessionName);
      break;
    }

    case 'run-parallel': {
      const flowsDir = (argv['flows-dir'] as string | undefined) ?? rest[0] ?? '';
      exitCode = await runParallel(flowsDir, opts);
      break;
    }

    case 'crashes': {
      const sub = (rest[0] ?? 'list').toLowerCase();
      if (sub === 'list') {
        exitCode = await crashesList(opts, sessionName, {
          app: argv['app'] as string | undefined,
          since: argv['since'] as string | undefined,
        });
      } else if (sub === 'show') {
        exitCode = await crashesShow(rest[1] ?? '', opts);
      } else if (sub === 'tail') {
        exitCode = await crashesTail(opts, sessionName);
      } else {
        console.error('Usage: conductor crashes <list|show|tail>');
        exitCode = 1;
      }
      break;
    }

    case 'profile': {
      const sub = (rest[0] ?? '').toLowerCase();
      const port = argv['port'] !== undefined ? Number(argv['port']) : undefined;
      const targetIndex = argv['target'] !== undefined ? Number(argv['target']) : undefined;
      if (sub === 'cpu') {
        const durationSec = argv['duration'] !== undefined ? Number(argv['duration']) : 10;
        exitCode = await profileCpu(opts, sessionName, {
          durationSec,
          out: argv['out'] as string | undefined,
          appId: rest[1],
        });
      } else if (sub === 'memory') {
        const trackSec = argv['track'] !== undefined ? Number(argv['track']) : 10;
        const intervalMs = argv['interval'] !== undefined ? Number(argv['interval']) : 1000;
        exitCode = await profileMemory(opts, sessionName, {
          trackSec,
          intervalMs,
          appId: rest[1],
        });
      } else if (sub === 'react') {
        const sub2 = (rest[1] ?? '').toLowerCase();
        const top = argv['top'] !== undefined ? Number(argv['top']) : 20;
        if (sub2 === 'start') {
          exitCode = await profileReactStart(opts, sessionName, { port, targetIndex });
        } else if (sub2 === 'stop') {
          exitCode = await profileReactStop(opts, sessionName, { port, targetIndex }, top);
        } else {
          console.error('Usage: conductor profile react <start|stop>');
          exitCode = 1;
        }
      } else {
        console.error('Usage: conductor profile <cpu|memory|react> [args]');
        exitCode = 1;
      }
      break;
    }

    case 'flow': {
      const sub1 = (rest[0] ?? '').toLowerCase();
      if (sub1 !== 'record') {
        console.error('Usage: conductor flow record <start|finish|echo|status>');
        exitCode = 1;
        break;
      }
      const sub2 = (rest[1] ?? '').toLowerCase();
      exitCode = await flowRecord(
        sub2,
        rest.slice(2).map(String),
        opts,
        sessionName,
        argv as unknown as Record<string, unknown>
      );
      break;
    }

    case 'network': {
      const sub = (rest[0] ?? '').toLowerCase();
      const port = argv['port'] !== undefined ? Number(argv['port']) : undefined;
      const targetIndex = argv['target'] !== undefined ? Number(argv['target']) : undefined;
      if (sub === 'logs') {
        const limit = argv['limit'] !== undefined ? Number(argv['limit']) : undefined;
        exitCode = await networkLogs(opts, sessionName, { port, targetIndex, limit });
      } else if (sub === 'request') {
        const url = rest[1] ?? (argv['url'] as string | undefined) ?? '';
        const rawHeaders = argv['header'];
        const headers = Array.isArray(rawHeaders)
          ? (rawHeaders as string[])
          : rawHeaders
            ? [rawHeaders as string]
            : [];
        exitCode = await networkRequest(url, opts, sessionName, {
          port,
          targetIndex,
          method: argv['method'] as string | undefined,
          body: argv['body'] as string | undefined,
          headers,
        });
      } else {
        console.error('Usage: conductor network <logs|request> [args]');
        exitCode = 1;
      }
      break;
    }

    case 'debug': {
      const sub = (rest[0] ?? '').toLowerCase();
      const debugOpts = {
        port: argv['port'] !== undefined ? Number(argv['port']) : undefined,
        targetIndex: argv['target'] !== undefined ? Number(argv['target']) : undefined,
      };
      if (sub === 'status') {
        exitCode = await debugStatus(opts, sessionName, debugOpts);
      } else if (sub === 'evaluate' || sub === 'eval') {
        const expr = rest.slice(1).join(' ');
        exitCode = await debugEvaluate(expr, opts, sessionName, debugOpts);
      } else if (sub === 'component-tree') {
        exitCode = await debugComponentTree(opts, sessionName, debugOpts);
      } else if (sub === 'inspect-element') {
        const at = rest[1] ?? (argv['at'] as string | undefined) ?? '';
        exitCode = await debugInspectElement(at, opts, sessionName, debugOpts);
      } else if (sub === 'log-registry') {
        exitCode = await debugLogRegistry(opts, sessionName);
      } else if (sub === 'reload') {
        exitCode = await debugReload(opts, sessionName, debugOpts);
      } else {
        console.error(
          'Usage: conductor debug <status|evaluate|component-tree|inspect-element|log-registry|reload>'
        );
        exitCode = 1;
      }
      break;
    }

    case 'workspace': {
      const sub = (rest[0] ?? 'info').toLowerCase();
      exitCode = await workspaceCmd(sub, opts);
      break;
    }

    case 'pinch':
      exitCode = await pinch(opts, sessionName, {
        scale: argv['scale'] !== undefined ? Number(argv['scale']) : undefined,
        center: argv['center'] as string | undefined,
        duration: argv['duration'] !== undefined ? Number(argv['duration']) : undefined,
        angle: argv['angle'] !== undefined ? Number(argv['angle']) : undefined,
      });
      break;

    case 'rotate-gesture':
      exitCode = await rotateGesture(opts, sessionName, {
        degrees: argv['degrees'] !== undefined ? Number(argv['degrees']) : undefined,
        center: argv['center'] as string | undefined,
        duration: argv['duration'] !== undefined ? Number(argv['duration']) : undefined,
      });
      break;

    case 'gesture': {
      const file = argv['file'] as string | undefined;
      const rawJson = !file ? rest.join(' ') : undefined;
      exitCode = await gesture(rawJson, file, opts, sessionName);
      break;
    }

    case 'clipboard': {
      const sub = (rest[0] ?? '').toLowerCase();
      if (sub === 'read') {
        exitCode = await clipboardRead(opts, sessionName);
      } else if (sub === 'write') {
        const text = rest.slice(1).join(' ');
        exitCode = await clipboardWrite(text, opts, sessionName);
      } else {
        console.error('Usage: conductor clipboard <read|write> [text]');
        exitCode = 1;
      }
      break;
    }

    case 'paste':
      exitCode = await paste(opts, sessionName);
      break;

    case 'metro': {
      const sub = (rest[0] ?? '').toLowerCase();
      const port = argv['port'] !== undefined ? Number(argv['port']) : undefined;
      const targetIndex = argv['target'] !== undefined ? Number(argv['target']) : undefined;
      const metroSession = (argv['device'] as string | undefined) ?? 'default';
      if (sub === 'stop') {
        exitCode = await metroStop(opts, { port });
      } else if (sub === 'reload') {
        exitCode = await metroReload(opts, metroSession, { port, targetIndex });
      } else {
        console.error('Usage: conductor metro <stop|reload> [--port N] [--target N]');
        exitCode = 1;
      }
      break;
    }

    default:
      // Should be unreachable — unknown commands are caught before device resolution.
      console.error(`Unknown command: ${command}`);
      console.error('Run `conductor --help` for usage.');
      exitCode = 1;
  }

  // Flow recording — append a YAML step for action commands that succeeded.
  if (exitCode === 0 && !NO_DEVICE_COMMANDS.has(command) && command !== 'flow') {
    try {
      const active = await getActiveRecording(sessionName);
      if (active) {
        const step = commandToYamlStep(command, rest.map(String), argv as Record<string, unknown>);
        if (step) appendStep(active, step);
      }
    } catch {
      // Recording is best-effort — never fail the command for a bookkeeping issue.
    }
  }

  process.exit(exitCode);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${message}`);
  process.exit(1);
});
