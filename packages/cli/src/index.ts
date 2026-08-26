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
import {
  nativePing,
  nativeInspect,
  nativeNav,
  nativeScreenshot,
  nativeImage,
  nativeSnapshot,
  nativeView,
  nativeSet,
  nativeProps,
  nativeConstraints,
  nativeHittest,
  nativeHighlight,
  nativeFind,
  nativeRaw,
  nativeConsole,
  nativeNetwork,
  nativeHeap,
  nativeAppearance,
  nativeEval,
  PING_HELP as nativePingHelp,
  INSPECT_HELP as nativeInspectHelp,
  NAV_HELP as nativeNavHelp,
  SCREENSHOT_HELP as nativeScreenshotHelp,
  IMAGE_HELP as nativeImageHelp,
  SNAPSHOT_HELP as nativeSnapshotHelp,
  VIEW_HELP as nativeViewHelp,
  SET_HELP as nativeSetHelp,
  PROPS_HELP as nativePropsHelp,
  CONSTRAINTS_HELP as nativeConstraintsHelp,
  HITTEST_HELP as nativeHittestHelp,
  HIGHLIGHT_HELP as nativeHighlightHelp,
  FIND_HELP as nativeFindHelp,
  RAW_HELP as nativeRawHelp,
  CONSOLE_HELP as nativeConsoleHelp,
  NETWORK_HELP as nativeNetworkHelp,
  HEAP_HELP as nativeHeapHelp,
  APPEARANCE_HELP as nativeAppearanceHelp,
  EVAL_HELP as nativeEvalHelp,
} from './commands/native.js';
import {
  nativeRnSet,
  nativeRnProps,
  RN_SET_HELP as nativeRnSetHelp,
  RN_PROPS_HELP as nativeRnPropsHelp,
} from './commands/native-rn.js';
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
import { inputServer, HELP as inputServerHelp } from './commands/input-server.js';
import { streamServer, HELP as streamServerHelp } from './commands/stream-server.js';
import { installWebCli, HELP_INSTALL_WEB } from './commands/install.js';
import { init, HELP as initHelp } from './commands/init.js';
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
import { profileFramesReset, profileFramesReport } from './commands/profile-frames.js';
import {
  profileJsRecord,
  profileJsStart,
  profileJsStop,
  profileJsHold,
} from './commands/profile-js.js';
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
import { listOptions, HELP as optionsHelp } from './commands/options.js';
import { webTargets, HELP as webTargetsHelp } from './commands/web-targets.js';
import { copyTextFrom, HELP as copyTextFromHelp } from './commands/copy-text-from.js';
import { assertTrue, HELP as assertTrueHelp } from './commands/assert-true.js';
import { setPermissions, HELP as setPermissionsHelp } from './commands/set-permissions.js';
import { addMedia, HELP as addMediaHelp } from './commands/add-media.js';
import {
  setAirplaneMode,
  toggleAirplaneMode,
  HELP as airplaneModeHelp,
} from './commands/airplane-mode.js';
import { travel, HELP as travelHelp } from './commands/travel.js';
import { recordVideo, HELP as recordVideoHelp } from './commands/record-video.js';
import { assertScreenshot, HELP as assertScreenshotHelp } from './commands/assert-screenshot.js';
import { getSession, updateSession } from './session.js';
import { pickDevice } from './device-picker.js';
import { parseCdpDeviceId } from './drivers/cdp-discovery.js';
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
  'native-ping': nativePingHelp,
  'native-inspect': nativeInspectHelp,
  'native-nav': nativeNavHelp,
  'native-screenshot': nativeScreenshotHelp,
  'native-image': nativeImageHelp,
  'native-snapshot': nativeSnapshotHelp,
  'native-view': nativeViewHelp,
  'native-set': nativeSetHelp,
  'native-props': nativePropsHelp,
  'native-rn-set': nativeRnSetHelp,
  'native-rn-props': nativeRnPropsHelp,
  'native-constraints': nativeConstraintsHelp,
  'native-hittest': nativeHittestHelp,
  'native-highlight': nativeHighlightHelp,
  'native-find': nativeFindHelp,
  'native-raw': nativeRawHelp,
  'native-console': nativeConsoleHelp,
  'native-network': nativeNetworkHelp,
  'native-heap': nativeHeapHelp,
  'native-appearance': nativeAppearanceHelp,
  'native-eval': nativeEvalHelp,
  'stop-app': stopAppHelp,
  'clear-state': clearStateHelp,
  'uninstall-app': uninstallAppHelp,
  'tap-on': tapHelp,
  'copy-text-from': copyTextFromHelp,
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
  'assert-true': assertTrueHelp,
  'assert-screenshot': assertScreenshotHelp,
  'open-link': openLinkHelp,
  'set-location': setLocationHelp,
  'set-permissions': setPermissionsHelp,
  'add-media': addMediaHelp,
  'set-airplane-mode': airplaneModeHelp,
  travel: travelHelp,
  'record-video': recordVideoHelp,
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
  init: initHelp,
  'daemon-start': daemonStartHelp,
  'daemon-stop': daemonStopHelp,
  'daemon-status': daemonStatusHelp,
  'input-server': inputServerHelp,
  'stream-server': streamServerHelp,
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
  'list-options': optionsHelp,
  'web-targets': webTargetsHelp,
};

const OPTIONS_HELP = `Options:
  --device <id>     Target device ID (also keys the session and daemon)
  --device-name <n> Target a booted device by name (resolved to ID from booted devices)
  --platform <p>    Filter to devices of this platform (ios, android, tvos, web, vega, roku)
  --cdp-url <url>   Attach the web driver to an existing browser over CDP (e.g. an
                    Electron app started with --remote-debugging-port). Remembered per session.
  --cdp-target <id> Pick which CDP page target to control (see \`conductor web-targets\`)
  --json            Output as machine-readable JSON
  --options         List valid values for a command's enumerated parameters and exit
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
      'options',
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
      'global',
      'force',
      'yes',
      'update',
      'measure',
      'report',
      'timeline',
      'baselines',
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
      'save-baseline',
      'sequence',
      'settle',
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
      'cdp-url',
      'cdp-target',
      'duration',
      'react-tag',
      'path',
      'value',
      'repeat',
      'delay',
      'speed',
      'threshold',
      'reference',
    ],
    alias: { h: 'help', v: 'verbose', V: 'version', o: 'output', y: 'yes' },
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

  // `<command> --options` lists the valid values for that command's enumerated
  // parameters and exits — no device resolution needed. With no command it
  // lists every enumerated parameter. `--help` still wins if both are passed.
  if (argv['options'] && !argv['help'] && command !== 'list-options') {
    process.exit(listOptions(command, opts));
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
    'init',
    'copy-app',
    'device-pool',
    'run-parallel',
    'metro',
    'workspace',
    'list-options',
    'web-targets',
    // assert-true evaluates a pure JS expression in the flow sandbox — no device involved.
    'assert-true',
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

  // CDP attach settings (web only): --cdp-url/--cdp-target map to the env the daemon
  // reads. Passing them once persists them to the session so later commands for the
  // same --device don't need the flags; absent flags hydrate from the saved session.
  const isWebSession = sessionName === 'web' || sessionName.startsWith('web:');
  if (isWebSession && !NO_DEVICE_COMMANDS.has(command)) {
    const cdpUrlFlag = argv['cdp-url'] as string | undefined;
    const cdpTargetFlag = argv['cdp-target'] as string | undefined;
    // A discovered `web:cdp:<port>:<target>` device id is self-describing —
    // derive the CDP url/target from it so it's drivable with no --cdp-* flags.
    const fromDeviceId = parseCdpDeviceId(sessionName);
    if (cdpUrlFlag || cdpTargetFlag) {
      if (cdpUrlFlag) process.env.CONDUCTOR_CDP_URL = cdpUrlFlag;
      if (cdpTargetFlag) process.env.CONDUCTOR_CDP_TARGET_ID = cdpTargetFlag;
      await updateSession(
        {
          cdpUrl: process.env.CONDUCTOR_CDP_URL,
          cdpTargetId: process.env.CONDUCTOR_CDP_TARGET_ID,
        },
        sessionName
      );
    } else if (fromDeviceId) {
      if (!process.env.CONDUCTOR_CDP_URL) process.env.CONDUCTOR_CDP_URL = fromDeviceId.cdpUrl;
      if (!process.env.CONDUCTOR_CDP_TARGET_ID) {
        process.env.CONDUCTOR_CDP_TARGET_ID = fromDeviceId.targetId;
      }
    } else {
      const saved = await getSession(sessionName);
      if (saved.cdpUrl && !process.env.CONDUCTOR_CDP_URL) {
        process.env.CONDUCTOR_CDP_URL = saved.cdpUrl;
      }
      if (saved.cdpTargetId && !process.env.CONDUCTOR_CDP_TARGET_ID) {
        process.env.CONDUCTOR_CDP_TARGET_ID = saved.cdpTargetId;
      }
    }
  }

  let exitCode = 0;

  switch (command) {
    case 'web-targets':
      exitCode = await webTargets(argv['cdp-url'] as string | undefined, opts);
      break;

    case 'start-device':
      exitCode = await startDevice(argv['platform'] as string | undefined, opts, {
        osVersion: argv['os-version'] as string | undefined,
        avd: argv['avd'] as string | undefined,
        name: argv['name'] as string | undefined,
        deviceType: argv['device-type'] as string | undefined,
        systemImage: argv['system-image'] as string | undefined,
        browser: argv['browser'] as string | undefined,
        memory: argv['memory'] !== undefined ? Number(argv['memory']) : undefined,
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
        inject: argv['inject'] as boolean,
      });
      break;
    }

    case 'native-ping': {
      exitCode = await nativePing(opts, sessionName);
      break;
    }

    case 'native-inspect': {
      exitCode = await nativeInspect(opts, sessionName);
      break;
    }

    case 'native-nav': {
      exitCode = await nativeNav(opts, sessionName);
      break;
    }

    case 'native-screenshot': {
      exitCode = await nativeScreenshot(argv['output'] as string | undefined, opts, sessionName);
      break;
    }

    case 'native-image': {
      exitCode = await nativeImage(
        rest[0],
        argv['output'] as string | undefined,
        opts,
        sessionName
      );
      break;
    }

    case 'native-snapshot': {
      exitCode = await nativeSnapshot(
        rest[0],
        argv['with-subviews'] as boolean,
        argv['output'] as string | undefined,
        opts,
        sessionName
      );
      break;
    }

    case 'native-view': {
      exitCode = await nativeView(rest[0], opts, sessionName);
      break;
    }

    case 'native-set': {
      exitCode = await nativeSet(rest, opts, sessionName);
      break;
    }

    case 'native-props': {
      exitCode = await nativeProps(rest[0], opts, sessionName);
      break;
    }

    case 'native-rn-set': {
      const rnOpts = {
        port: argv['port'] !== undefined ? Number(argv['port']) : undefined,
        targetIndex: argv['target'] !== undefined ? Number(argv['target']) : undefined,
      };
      exitCode = await nativeRnSet(
        {
          reactTag: argv['react-tag'] as string | undefined,
          path: argv['path'] as string | undefined,
          value: argv['value'] as string | undefined,
        },
        opts,
        sessionName,
        rnOpts
      );
      break;
    }

    case 'native-rn-props': {
      const rnOpts = {
        port: argv['port'] !== undefined ? Number(argv['port']) : undefined,
        targetIndex: argv['target'] !== undefined ? Number(argv['target']) : undefined,
      };
      exitCode = await nativeRnProps(
        { reactTag: argv['react-tag'] as string | undefined },
        opts,
        sessionName,
        rnOpts
      );
      break;
    }

    case 'native-constraints': {
      exitCode = await nativeConstraints(rest[0], opts, sessionName);
      break;
    }

    case 'native-hittest': {
      exitCode = await nativeHittest(rest[0], opts, sessionName);
      break;
    }

    case 'native-highlight': {
      exitCode = await nativeHighlight(rest[0], opts, sessionName);
      break;
    }

    case 'native-find': {
      exitCode = await nativeFind(
        {
          className: argv['class'] as string | undefined,
          text: argv['text'] as string | undefined,
        },
        opts,
        sessionName
      );
      break;
    }

    case 'native-raw': {
      exitCode = await nativeRaw(rest[0], argv['output'] as string | undefined, opts, sessionName);
      break;
    }

    case 'native-console': {
      exitCode = await nativeConsole(
        argv['since'] !== undefined ? Number(argv['since']) : undefined,
        opts,
        sessionName
      );
      break;
    }

    case 'native-network': {
      exitCode = await nativeNetwork(
        argv['since'] !== undefined ? Number(argv['since']) : undefined,
        opts,
        sessionName
      );
      break;
    }

    case 'native-heap': {
      exitCode = await nativeHeap(
        {
          className: argv['class'] as string | undefined,
          pattern: argv['pattern'] as string | undefined,
          read: argv['read'] as string | undefined,
          key: argv['key'] as string | undefined,
        },
        opts,
        sessionName
      );
      break;
    }

    case 'native-appearance': {
      exitCode = await nativeAppearance(
        {
          style: rest[0],
          direction: argv['direction'] as string | undefined,
          contentSize: argv['content-size'] as string | undefined,
          animSpeed: argv['anim-speed'] as string | undefined,
        },
        opts,
        sessionName
      );
      break;
    }

    case 'native-eval': {
      exitCode = await nativeEval(
        rest.join(' '),
        argv['mode'] === 'full' ? 'full' : 'expr',
        opts,
        sessionName
      );
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
        at: argv['at'] as string | undefined,
        repeat: argv['repeat'] !== undefined ? Number(argv['repeat']) : undefined,
        delay: argv['delay'] !== undefined ? Number(argv['delay']) : undefined,
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
      const durationArg = argv['duration'] as string | undefined;
      exitCode = await pressKey(key, opts, sessionName, {
        longPress: argv['long-press'] as boolean,
        duration: durationArg !== undefined ? Number(durationArg) : undefined,
        measure: argv['measure'] as boolean,
        repeat: argv['repeat'] !== undefined ? Number(argv['repeat']) : undefined,
        timeoutMs: argv['timeout'] !== undefined ? Number(argv['timeout']) : undefined,
        pollIntervalMs:
          argv['poll-interval'] !== undefined ? Number(argv['poll-interval']) : undefined,
        settleMs: argv['settle'] !== undefined ? Number(argv['settle']) : undefined,
        sequence:
          typeof argv['sequence'] === 'string'
            ? (argv['sequence'] as string).split(',')
            : undefined,
        appId: argv['app'] as string | undefined,
      });
      break;
    }

    case 'list-options': {
      exitCode = listOptions(rest[0], opts);
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

    case 'assert-true': {
      const expr = rest.join(' ');
      const env: Record<string, string> = {};
      const envArgs = ([] as string[]).concat((argv['env'] as string | string[]) ?? []);
      for (const e of envArgs) {
        const idx = e.indexOf('=');
        if (idx > 0) env[e.slice(0, idx)] = e.slice(idx + 1);
      }
      exitCode = await assertTrue(expr, opts, env);
      break;
    }

    case 'assert-screenshot': {
      const reference = rest[0] ?? (argv['reference'] as string | undefined) ?? '';
      exitCode = await assertScreenshot(reference, opts, sessionName, {
        threshold: argv['threshold'] !== undefined ? Number(argv['threshold']) : undefined,
        update: argv['update'] as boolean,
      });
      break;
    }

    case 'copy-text-from': {
      const element = rest.join(' ');
      exitCode = await copyTextFrom(element, opts, sessionName, {
        id: argv['id'] as string | undefined,
        text: argv['text'] as string | undefined,
        index: argv['index'] !== undefined ? Number(argv['index']) : undefined,
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

    case 'set-permissions': {
      exitCode = await setPermissions(rest.map(String), opts, sessionName);
      break;
    }

    case 'add-media': {
      exitCode = await addMedia(rest.map(String), opts, sessionName);
      break;
    }

    case 'set-airplane-mode': {
      const value = rest[0] ?? '';
      exitCode = await setAirplaneMode(value, opts, sessionName);
      break;
    }

    case 'toggle-airplane-mode': {
      exitCode = await toggleAirplaneMode(opts, sessionName);
      break;
    }

    case 'travel': {
      exitCode = await travel(rest.map(String), opts, sessionName, {
        speed: argv['speed'] !== undefined ? Number(argv['speed']) : undefined,
      });
      break;
    }

    case 'record-video': {
      exitCode = await recordVideo(rest[0] ?? '', opts, sessionName, {
        out: argv['out'] as string | undefined,
      });
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
      const element = rest.join(' ');
      exitCode = await screenshot(outPath, opts, sessionName, fullPage, element, {
        id: argv['id'] as string | undefined,
        text: argv['text'] as string | undefined,
        index: argv['index'] !== undefined ? Number(argv['index']) : undefined,
        margin: argv['margin'] !== undefined ? Number(argv['margin']) : undefined,
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
      exitCode = await runFlow(
        file,
        opts,
        sessionName,
        flowEnv,
        argv['benchmark'] as boolean,
        argv['repeat'] !== undefined ? Number(argv['repeat']) : 1
      );
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

    case 'init':
      exitCode = await init(opts, rest[0], {
        global: argv['global'] as boolean,
        force: argv['force'] as boolean,
        yes: argv['yes'] as boolean,
      });
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

    case 'input-server':
      exitCode = await inputServer(opts, sessionName);
      break;

    case 'stream-server':
      exitCode = await streamServer(opts, sessionName);
      break;

    case 'device-pool': {
      const acquire = argv['acquire'] as boolean;
      const release = argv['release'] as boolean;
      const releaseId = typeof argv['release'] === 'string' ? argv['release'] : rest[0];
      const action = acquire ? 'acquire' : release || releaseId ? 'release' : 'list';
      const owner = argv['owner'] ? Number(argv['owner']) : undefined;
      exitCode = await devicePool(
        action,
        releaseId,
        opts,
        argv['device'] as string | undefined,
        owner
      );
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
      const top = argv['top'] !== undefined ? Number(argv['top']) : undefined;
      if (sub === 'cpu') {
        const durationSec = argv['duration'] !== undefined ? Number(argv['duration']) : 10;
        exitCode = await profileCpu(opts, sessionName, {
          durationSec,
          out: argv['out'] as string | undefined,
          appId: rest[1],
          report: argv['report'] as boolean,
          top,
        });
      } else if (sub === 'memory') {
        const trackSec = argv['track'] !== undefined ? Number(argv['track']) : 10;
        const intervalMs = argv['interval'] !== undefined ? Number(argv['interval']) : 1000;
        exitCode = await profileMemory(opts, sessionName, {
          trackSec,
          intervalMs,
          appId: rest[1],
        });
      } else if (sub === 'frames') {
        const sub2 = (rest[1] ?? '').toLowerCase();
        if (sub2 === 'reset') {
          exitCode = await profileFramesReset(opts, sessionName, rest[2]);
        } else if (sub2 === 'report') {
          exitCode = await profileFramesReport(opts, sessionName, {
            appId: rest[2],
            trackSec: argv['track'] !== undefined ? Number(argv['track']) : undefined,
            intervalMs: argv['interval'] !== undefined ? Number(argv['interval']) : undefined,
            top,
            saveBaseline: argv['save-baseline'] as string | undefined,
            diff: argv['diff'] as string | undefined,
            listBaselines: argv['baselines'] as boolean,
          });
        } else {
          console.error('Usage: conductor profile frames <reset|report> [<appId>]');
          exitCode = 1;
        }
      } else if (sub === 'js') {
        const sub2 = (rest[1] ?? '').toLowerCase();
        const jsOpts = {
          port,
          targetIndex,
          out: argv['out'] as string | undefined,
          top,
          durationSec: argv['duration'] !== undefined ? Number(argv['duration']) : undefined,
        };
        if (sub2 === 'record') {
          exitCode = await profileJsRecord(opts, sessionName, jsOpts);
        } else if (sub2 === 'start') {
          exitCode = await profileJsStart(opts, sessionName, jsOpts);
        } else if (sub2 === 'stop') {
          exitCode = await profileJsStop(opts, sessionName, jsOpts);
        } else if (sub2 === '_hold') {
          exitCode = await profileJsHold(sessionName, jsOpts);
        } else {
          console.error('Usage: conductor profile js <record|start|stop>');
          exitCode = 1;
        }
      } else if (sub === 'react') {
        const sub2 = (rest[1] ?? '').toLowerCase();
        const reactOpts = {
          port,
          targetIndex,
          maxCommits: argv['max-commits'] !== undefined ? Number(argv['max-commits']) : undefined,
          maxComponents:
            argv['max-components'] !== undefined ? Number(argv['max-components']) : undefined,
          timeline: argv['timeline'] as boolean,
        };
        if (sub2 === 'start') {
          exitCode = await profileReactStart(opts, sessionName, reactOpts);
        } else if (sub2 === 'stop') {
          exitCode = await profileReactStop(opts, sessionName, reactOpts, top ?? 20);
        } else {
          console.error('Usage: conductor profile react <start|stop>');
          exitCode = 1;
        }
      } else {
        console.error('Usage: conductor profile <cpu|memory|frames|js|react> [args]');
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
