/**
 * run-parallel: Run Maestro YAML flows in parallel across all booted simulators.
 *
 * Usage:
 *   conductor run-parallel --flows-dir ./tests
 *   conductor run-parallel --flows-dir ./tests --devices auto
 *
 * - Auto-detects all booted simulators (and connected Android devices)
 * - Distributes flow files round-robin across devices
 * - Spawns one child process per shard
 * - Collects and prints aggregated pass/fail results
 */
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { printError, OutputOptions } from '../output.js';

interface ShardResult {
  deviceId: string;
  flowFile: string;
  success: boolean;
  output: string;
}

export async function runParallel(flowsDir: string, opts: OutputOptions = {}): Promise<number> {
  if (!flowsDir) {
    printError('run-parallel requires --flows-dir <path>', opts);
    return 1;
  }

  const resolvedDir = path.resolve(flowsDir);
  if (!fs.existsSync(resolvedDir)) {
    printError(`flows-dir not found: ${resolvedDir}`, opts);
    return 1;
  }

  // Discover flow files
  const flowFiles = fs
    .readdirSync(resolvedDir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => path.join(resolvedDir, f));

  if (flowFiles.length === 0) {
    printError(`No YAML flow files found in: ${resolvedDir}`, opts);
    return 1;
  }

  // Discover devices
  const devices = await discoverAllDevices();
  if (devices.length === 0) {
    printError('No devices found. Connect a device or start a simulator.', opts);
    return 1;
  }

  console.log(`Found ${devices.length} device(s), ${flowFiles.length} flow(s). Distributing...`);

  // Assign flows to devices (round-robin)
  const assignments: Array<{ deviceId: string; flowFile: string }> = flowFiles.map((f, i) => ({
    deviceId: devices[i % devices.length],
    flowFile: f,
  }));

  // Run all shards in parallel
  const promises = assignments.map(({ deviceId, flowFile }) => runShard(deviceId, flowFile));

  const results = await Promise.all(promises);

  // Print results
  const passed = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  if (opts.json) {
    console.log(
      JSON.stringify({
        status: failed.length === 0 ? 'ok' : 'error',
        total: results.length,
        passed: passed.length,
        failed: failed.length,
        results: results.map((r) => ({
          deviceId: r.deviceId,
          flowFile: path.basename(r.flowFile),
          success: r.success,
        })),
      })
    );
  } else {
    console.log('\n─── Results ───────────────────────────────────────');
    for (const r of results) {
      const status = r.success ? '✓ PASS' : '✗ FAIL';
      console.log(`${status}  ${path.basename(r.flowFile)}  [${r.deviceId.slice(0, 8)}...]`);
      if (!r.success && r.output.trim()) {
        console.log(`       ${r.output.trim().split('\n').join('\n       ')}`);
      }
    }
    console.log(`\nTotal: ${results.length}  Passed: ${passed.length}  Failed: ${failed.length}`);
  }

  return failed.length === 0 ? 0 : 1;
}

async function runShard(deviceId: string, flowFile: string): Promise<ShardResult> {
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath, // node
      [process.argv[1], 'run-flow', flowFile, '--device', deviceId],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let output = '';
    proc.stdout?.on('data', (c: Buffer) => {
      output += c.toString();
    });
    proc.stderr?.on('data', (c: Buffer) => {
      output += c.toString();
    });

    proc.on('close', (code) => {
      resolve({ deviceId, flowFile, success: code === 0, output });
    });
    proc.on('error', (err) => {
      resolve({ deviceId, flowFile, success: false, output: err.message });
    });
  });
}

async function discoverAllDevices(): Promise<string[]> {
  const devices: string[] = [];

  try {
    const out = await spawnCapture('adb', ['devices']);
    for (const line of out.split('\n').slice(1)) {
      const id = line.trim().split(/\s+/)[0];
      if (id && !line.includes('offline') && id !== '') devices.push(id);
    }
  } catch {
    /* ok */
  }

  try {
    const out = await spawnCapture('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']);
    const parsed = JSON.parse(out) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    for (const sims of Object.values(parsed.devices)) {
      for (const sim of sims) {
        if (sim.state === 'Booted') devices.push(sim.udid);
      }
    }
  } catch {
    /* ok */
  }

  return devices;
}

function spawnCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} failed`))));
    proc.on('error', reject);
  });
}
