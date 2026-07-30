/**
 * Compiles user Swift into a fresh dylib exporting `conductor_eval`, then drops
 * it into the target app's container so the injected library can dlopen it.
 *
 * `expr` mode wraps an expression; `full` mode takes the whole function body.
 * Each build is a uniquely-named dylib to avoid dlopen caching.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const run = promisify(execFile);

export interface CompileResult {
  ok: boolean;
  /** Path the injected library should dlopen (inside the app container). */
  dylibPath?: string;
  error?: string;
  info?: string;
}

const EXPR_TEMPLATE = (code: string) => `import Foundation
import UIKit
import SwiftUI

@_cdecl("conductor_eval")
public func conductor_eval() -> UnsafePointer<CChar> {
    let __result: Any = {
${code}
    }()
    return UnsafePointer(strdup(String(describing: __result))!)
}
`;

const FULL_TEMPLATE = (code: string) => `import Foundation
import UIKit
import SwiftUI

@_cdecl("conductor_eval")
public func conductor_eval() -> UnsafePointer<CChar> {
${code}
}
`;

async function detectTarget(
  platform: 'ios' | 'tvos'
): Promise<{ sdkName: string; sdkPath: string; target: string }> {
  const sdkName = platform === 'tvos' ? 'appletvsimulator' : 'iphonesimulator';
  const sdkPlatform = platform === 'tvos' ? 'tvos' : 'ios';
  const [{ stdout: sdkPath }, { stdout: sdkVer }] = await Promise.all([
    run('xcrun', ['--sdk', sdkName, '--show-sdk-path']),
    run('xcrun', ['--sdk', sdkName, '--show-sdk-version']),
  ]);
  const major = sdkVer.trim().split('.')[0];
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x86_64';
  return {
    sdkName,
    sdkPath: sdkPath.trim(),
    target: `${arch}-apple-${sdkPlatform}${major}.0-simulator`,
  };
}

/**
 * Compile `code` and place the dylib inside the app container's tmp so the
 * sandboxed app can dlopen it. Returns the container-relative host path (which,
 * on the simulator, is the same path the app opens).
 */
export async function compileEval(
  code: string,
  mode: 'expr' | 'full',
  platform: 'ios' | 'tvos',
  deviceId: string,
  bundleId: string
): Promise<CompileResult> {
  const start = Date.now();
  const { sdkName, sdkPath, target } = await detectTarget(platform);

  const source = (mode === 'full' ? FULL_TEMPLATE : EXPR_TEMPLATE)(code);
  const hash = crypto.createHash('md5').update(source).digest('hex').slice(0, 10);
  const workDir = path.join(os.tmpdir(), 'conductor-eval');
  await fs.mkdir(workDir, { recursive: true });
  const swiftFile = path.join(workDir, `eval_${hash}.swift`);
  const dylibName = `eval_${hash}_${Date.now()}.dylib`;
  const dylibPath = path.join(workDir, dylibName);
  await fs.writeFile(swiftFile, source, 'utf-8');

  try {
    await run('xcrun', [
      '-sdk',
      sdkName,
      'swiftc',
      '-target',
      target,
      '-sdk',
      sdkPath,
      '-emit-library',
      '-Onone',
      '-enable-testing',
      '-o',
      dylibPath,
      // Unresolved symbols (app/system) resolve at dlopen time in the host process.
      '-Xlinker',
      '-undefined',
      '-Xlinker',
      'dynamic_lookup',
      swiftFile,
    ]);
  } catch (err) {
    return {
      ok: false,
      error: `compile failed:\n${(err as { stderr?: string }).stderr ?? String(err)}`,
    };
  }

  // Ad-hoc sign (sim rejects unsigned dylibs for dlopen on newer runtimes).
  await run('codesign', ['--force', '--sign', '-', dylibPath]).catch(() => {});

  // Copy into the app's data container tmp so the sandboxed app can read it.
  try {
    const { stdout } = await run('xcrun', [
      'simctl',
      'get_app_container',
      deviceId,
      bundleId,
      'data',
    ]);
    const container = stdout.trim();
    // System apps (and any without a data container) print "(null)"; use the raw
    // path there — simulator apps are host processes and can dlopen it directly.
    if (!container.startsWith('/')) throw new Error('no data container');
    const containerTmp = path.join(container, 'tmp');
    await fs.mkdir(containerTmp, { recursive: true });
    const dest = path.join(containerTmp, dylibName);
    await fs.copyFile(dylibPath, dest);
    return { ok: true, dylibPath: dest, info: `compiled in ${Date.now() - start}ms` };
  } catch {
    // Fall back to the raw temp path — simulator apps can usually open it directly.
    return {
      ok: true,
      dylibPath,
      info: `compiled in ${Date.now() - start}ms (container copy skipped)`,
    };
  }
}
