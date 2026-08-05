export const HELP = `  record-video start [--out <path>]    Start a screen VIDEO recording (distinct from \`flow record\`)
  record-video stop                    Stop recording and write the video file
                                       iOS: HEVC .mov via simctl · Android: .mp4 via screenrecord`;

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { runDirect } from '../runner.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { resolveAndroidTool, androidSpawnEnv } from '../android/sdk.js';
import { printSuccess, printError, printData, OutputOptions } from '../output.js';

const RECORDINGS_DIR = path.join(os.homedir(), '.conductor', 'recordings');
const ANDROID_REMOTE = '/sdcard/conductor_recording.mp4';

interface RecordingState {
  pid: number;
  platform: 'ios' | 'android';
  outPath: string;
  serial?: string; // android only
}

function stateFile(sessionName: string): string {
  return path.join(RECORDINGS_DIR, `${sessionName}.json`);
}

export async function recordVideo(
  sub: string,
  opts: OutputOptions,
  sessionName: string,
  flags: { out?: string } = {}
): Promise<number> {
  if (sub === 'start') return start(opts, sessionName, flags);
  if (sub === 'stop') return stop(opts, sessionName);
  printError('record-video expects "start" or "stop"', opts);
  return 1;
}

async function start(
  opts: OutputOptions,
  sessionName: string,
  flags: { out?: string }
): Promise<number> {
  const existing = stateFile(sessionName);
  if (fs.existsSync(existing)) {
    printError(
      `record-video start — a recording is already active for this session (run \`record-video stop\`)`,
      opts
    );
    return 1;
  }

  let state: RecordingState | null = null;
  const result = await runDirect(async (driver) => {
    if (driver instanceof IOSDriver) {
      const outPath = path.resolve(process.cwd(), flags.out ?? 'conductor-recording.mov');
      const proc = spawn(
        'xcrun',
        ['simctl', 'io', driver.deviceId ?? 'booted', 'recordVideo', '--codec', 'hevc', outPath],
        { detached: true, stdio: 'ignore' }
      );
      proc.unref();
      state = { pid: proc.pid!, platform: 'ios', outPath };
    } else if (driver instanceof AndroidDriver) {
      const outPath = path.resolve(process.cwd(), flags.out ?? 'conductor-recording.mp4');
      const proc = spawn(
        resolveAndroidTool('adb'),
        ['-s', driver.serial, 'shell', 'screenrecord', ANDROID_REMOTE],
        { detached: true, stdio: 'ignore', env: androidSpawnEnv() }
      );
      proc.unref();
      state = { pid: proc.pid!, platform: 'android', outPath, serial: driver.serial };
    } else {
      throw new Error('record-video is only supported on iOS and Android');
    }
  }, sessionName);

  if (!result.success || !state) {
    printError(`record-video start — failed\n${result.stderr}`, opts);
    return 1;
  }

  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  fs.writeFileSync(stateFile(sessionName), JSON.stringify(state));
  const outPath = (state as RecordingState).outPath;
  if (opts.json) printData({ recording: true, outPath }, opts);
  else printSuccess(`record-video start — recording to ${outPath}`, opts);
  return 0;
}

async function stop(opts: OutputOptions, sessionName: string): Promise<number> {
  const file = stateFile(sessionName);
  if (!fs.existsSync(file)) {
    printError('record-video stop — no active recording for this session', opts);
    return 1;
  }
  const state = JSON.parse(fs.readFileSync(file, 'utf-8')) as RecordingState;

  try {
    if (state.platform === 'ios') {
      // SIGINT lets simctl flush and finalize the .mov it is writing directly to outPath.
      try {
        process.kill(state.pid, 'SIGINT');
      } catch {
        /* already gone */
      }
      await sleep(800);
    } else {
      const adb = resolveAndroidTool('adb');
      const env = androidSpawnEnv();
      // screenrecord runs on-device; interrupt it so it finalizes the mp4, then pull it.
      await run(adb, ['-s', state.serial!, 'shell', 'pkill', '-SIGINT', 'screenrecord'], env);
      await sleep(2000); // allow the file to flush on device
      try {
        process.kill(state.pid, 'SIGINT');
      } catch {
        /* local adb shell may have exited */
      }
      await run(adb, ['-s', state.serial!, 'pull', ANDROID_REMOTE, state.outPath], env);
      await run(adb, ['-s', state.serial!, 'shell', 'rm', '-f', ANDROID_REMOTE], env);
    }
  } finally {
    fs.rmSync(file, { force: true });
  }

  if (!fs.existsSync(state.outPath)) {
    printError(`record-video stop — recording stopped but no file at ${state.outPath}`, opts);
    return 1;
  }
  if (opts.json) printData({ recording: false, outPath: state.outPath }, opts);
  else printSuccess(`record-video stop — saved ${state.outPath}`, opts);
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'ignore', env });
    p.on('close', () => resolve());
    p.on('error', () => resolve());
  });
}
