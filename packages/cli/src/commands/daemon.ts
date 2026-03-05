import { startDaemon, stopDaemon, daemonStatus, listDaemonSessions } from '../daemon/client.js';
import { printSuccess, printError, printData, OutputOptions } from '../output.js';

export async function daemonStart(
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  const ready = await startDaemon(sessionName);
  if (ready) {
    printSuccess(`daemon [${sessionName}] started — driver process is running`, opts);
    return 0;
  } else {
    printError(`daemon [${sessionName}] failed to start within timeout`, opts);
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
  } else {
    console.log(`daemon [${sessionName}]: not running`);
  }
  return 0;
}
