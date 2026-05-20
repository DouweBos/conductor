export const HELP_DAEMON_START = `  daemon-start [--ios-driver xctest|dylib]  Start background daemon (manages driver process).
                                          --ios-driver dylib is experimental, iOS simulators only;
                                          apps must be relaunched after start to load the dylib.`;
export const HELP_DAEMON_STOP = `  daemon-stop [--all]                 Stop background daemon (--all stops every session's daemon)`;
export const HELP_DAEMON_STATUS = `  daemon-status                       Show daemon status`;

import { startDaemon, stopDaemon, daemonStatus, listDaemonSessions } from '../daemon/client.js';
import { printSuccess, printError, printData, OutputOptions } from '../output.js';

export async function daemonStart(
  opts: OutputOptions = {},
  sessionName = 'default',
  startOpts: { iosDriverImpl?: 'xctest' | 'dylib' } = {}
): Promise<number> {
  try {
    const ready = await startDaemon(sessionName, startOpts);
    if (ready) {
      const suffix =
        startOpts.iosDriverImpl === 'dylib' ? ' (--ios-driver dylib, experimental)' : '';
      printSuccess(
        `daemon [${sessionName}] started — driver process is running${suffix}`,
        opts
      );
      return 0;
    } else {
      printError(`daemon [${sessionName}] failed to start within timeout`, opts);
      return 1;
    }
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err), opts);
    return 1;
  }
}

export async function daemonStop(
  opts: OutputOptions = {},
  sessionName = 'default',
  all = false
): Promise<number> {
  if (all) {
    const sessions = listDaemonSessions();
    if (sessions.length === 0) {
      printSuccess('no daemons running', opts);
      return 0;
    }
    let exitCode = 0;
    for (const name of sessions) {
      const stopped = await stopDaemon(name);
      if (stopped) {
        printSuccess(`daemon [${name}] stopped`, opts);
      } else {
        printError(`daemon [${name}] was not running`, opts);
        exitCode = 1;
      }
    }
    return exitCode;
  }

  const stopped = await stopDaemon(sessionName);
  if (stopped) {
    printSuccess(`daemon [${sessionName}] stopped`, opts);
    return 0;
  } else {
    printError(`daemon [${sessionName}] was not running`, opts);
    return 1;
  }
}

export async function daemonStatusCmd(
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  const status = await daemonStatus(sessionName);
  if (opts.json) {
    printData({ ...status, sessionName }, opts);
  } else if (status.running) {
    console.log(`daemon [${sessionName}]: running (pid ${status.pid ?? 'unknown'})`);
    if (status.iosDriverImpl === 'dylib') {
      console.log(`  ios-driver: dylib (experimental; port ${status.iosDylibPort ?? 'unknown'})`);
      console.log(
        `  note: apps launched before the daemon started have no dylib loaded — ` +
          `their interaction routes fall back to xctest. Restart the app to enable the fast path.`
      );
    } else if (status.iosDriverImpl === 'xctest') {
      console.log(`  ios-driver: xctest`);
    }
    if (status.iosSimDriverPort) {
      // Host-side sim-driver is unconditional on iOS sessions — surface its
      // port so a human can curl /status against it for triage.
      console.log(`  ios-sim-driver: running (port ${status.iosSimDriverPort})`);
    }
    if (status.driverStartError) {
      console.log(`  warning: ${status.driverStartError}`);
    }
  } else {
    console.log(`daemon [${sessionName}]: not running`);
  }
  return 0;
}
