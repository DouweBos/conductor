/**
 * React Native prop live-editing over the Metro CDP (JS) channel.
 *
 * `RCTParagraphComponentView` and other Fabric host views have no working native
 * setter and the injected dylib can't reach RN's C++ Fabric layer — so text/style
 * edits must go through React itself. These commands drive React DevTools'
 * `overrideProps` (edit) and read a fiber's `memoizedProps` (raw JSX props),
 * reusing the same Metro CDP connection as `conductor debug`.
 *
 * Reads a component's reactTag from `native-inspect` (`rn.reactTag`).
 */
export const RN_SET_HELP = `  native-rn-set --react-tag <n> --path <dot.path> --value <json>   Live-edit an RN component's props via React (text, style.color, …; dev builds only)`;
export const RN_PROPS_HELP = `  native-rn-props --react-tag <n>      Raw JSX props (memoizedProps) of an RN fiber by reactTag`;

import { MetroCdpClient } from '../drivers/metro-cdp.js';
import { detectPlatform } from '../drivers/bootstrap.js';
import { makeOverridePropsScript, makeRnPropsScript } from '../drivers/metro-scripts.js';
import { printError, printData, OutputOptions } from '../output.js';

export interface RnOptions {
  port?: number;
  targetIndex?: number;
}

/** Session → device/platform for Metro target selection (mirrors debug.ts). */
function resolveSession(sessionName: string): {
  deviceId?: string;
  platformPromise: Promise<string | undefined>;
} {
  if (!sessionName || sessionName === 'default') {
    return { deviceId: undefined, platformPromise: Promise.resolve(undefined) };
  }
  return {
    deviceId: sessionName,
    platformPromise: detectPlatform(sessionName).catch(() => undefined),
  };
}

/** JSON-parse a --value, falling back to the raw string (so bare text works). */
function parseValue(raw: string): { json: string } {
  try {
    return { json: JSON.stringify(JSON.parse(raw)) };
  } catch {
    return { json: JSON.stringify(raw) };
  }
}

export async function nativeRnSet(
  args: { reactTag?: string; path?: string; value?: string },
  opts: OutputOptions,
  sessionName: string,
  rnOpts: RnOptions
): Promise<number> {
  const tag = Number(args.reactTag);
  if (!Number.isInteger(tag)) {
    printError('native-rn-set needs --react-tag <n> (from native-inspect rn.reactTag)', opts);
    return 1;
  }
  if (!args.path) {
    printError('native-rn-set needs --path <dot.path> (e.g. children, style.color)', opts);
    return 1;
  }
  if (args.value === undefined) {
    printError('native-rn-set needs --value <json> (JSON; a bare string is fine for text)', opts);
    return 1;
  }
  const path = args.path.split('.').filter((s) => s.length > 0);
  const { json } = parseValue(args.value);

  const port = rnOpts.port ?? 8081;
  const { deviceId, platformPromise } = resolveSession(sessionName);
  const client = new MetroCdpClient();
  try {
    const platform = await platformPromise;
    await client.connect({ port, deviceId, platform, targetIndex: rnOpts.targetIndex });
    const raw = await client.evaluate<string>(makeOverridePropsScript(tag, path, json), true);
    const res = JSON.parse(raw) as {
      status: string;
      applied?: boolean;
      message?: string;
      note?: string;
    };
    client.close();
    if (res.status !== 'ok') {
      printError(res.message ?? 'overrideProps failed', opts);
      return 1;
    }
    const out: Record<string, unknown> = { status: 'ok', applied: res.applied ?? true };
    if (res.note) out.note = res.note;
    printData(out, opts);
    return 0;
  } catch (err) {
    client.close();
    printError(`native-rn-set — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}

export async function nativeRnProps(
  args: { reactTag?: string },
  opts: OutputOptions,
  sessionName: string,
  rnOpts: RnOptions
): Promise<number> {
  const tag = Number(args.reactTag);
  if (!Number.isInteger(tag)) {
    printError('native-rn-props needs --react-tag <n> (from native-inspect rn.reactTag)', opts);
    return 1;
  }
  const port = rnOpts.port ?? 8081;
  const { deviceId, platformPromise } = resolveSession(sessionName);
  const client = new MetroCdpClient();
  try {
    const platform = await platformPromise;
    await client.connect({ port, deviceId, platform, targetIndex: rnOpts.targetIndex });
    const raw = await client.evaluate<string>(makeRnPropsScript(tag), true);
    const res = JSON.parse(raw) as { status: string; props?: unknown; message?: string };
    client.close();
    if (res.status !== 'ok') {
      printError(res.message ?? 'reading props failed', opts);
      return 1;
    }
    printData({ status: 'ok', props: res.props ?? {} }, opts);
    return 0;
  } catch (err) {
    client.close();
    printError(`native-rn-props — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}
