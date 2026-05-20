export const HELP = `  debug status [--port N]              Show RN debugger connection info
  debug evaluate <expr> [--port N]     Run JS in the app runtime (Hermes/Fusebox)
  debug component-tree [--port N]      Print the React component tree (on-screen)
  debug inspect-element <x,y>          Print the React component at a screen point
  debug log-registry [--source metro]  Summarize recent Metro/Hermes console logs`;

import crypto from 'crypto';
import { printError, printData, OutputOptions } from '../output.js';
import { MetroCdpClient, cdpCall } from '../drivers/metro-cdp.js';
import { detectPlatform } from '../drivers/bootstrap.js';
import { fetchTargets } from '../drivers/log-sources/metro.js';
import { makeComponentTreeScript, makeInspectElementScript } from '../drivers/metro-scripts.js';
import { logs as logsCmd } from './logs.js';

function newRequestId(): string {
  return crypto.randomBytes(6).toString('hex');
}

export interface DebugOptions {
  port?: number;
  targetIndex?: number;
}

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

export async function debugStatus(
  opts: OutputOptions,
  sessionName: string,
  debugOpts: DebugOptions
): Promise<number> {
  const port = debugOpts.port ?? 8081;
  try {
    const targets = await fetchTargets(port, 'localhost');
    const { deviceId, platformPromise } = resolveSession(sessionName);
    const platform = await platformPromise;

    const client = new MetroCdpClient();
    await client.connect({ port, deviceId, platform, targetIndex: debugOpts.targetIndex });
    await client.enableDomain('Runtime');
    await client.enableDomain('Debugger');

    // Give a beat for Debugger.scriptParsed events to flow in before reporting count.
    await new Promise((r) => setTimeout(r, 300));

    const info = {
      port,
      host: 'localhost',
      deviceId: deviceId ?? null,
      platform: platform ?? null,
      connected: client.isConnected(),
      enabledDomains: [...client.getEnabledDomains()],
      loadedScripts: client.getLoadedScripts().size,
      targets: targets.map((t) => ({
        title: t.title ?? null,
        deviceName: t.deviceName ?? null,
        appId: t.appId ?? null,
        id: t.id ?? null,
      })),
    };
    client.close();
    if (opts.json) printData(info, opts);
    else {
      console.log(
        `port:           ${info.port}\n` +
          `deviceId:       ${info.deviceId ?? '(none)'}\n` +
          `platform:       ${info.platform ?? '(none)'}\n` +
          `connected:      ${info.connected}\n` +
          `enabledDomains: ${info.enabledDomains.join(', ')}\n` +
          `loadedScripts:  ${info.loadedScripts}\n` +
          `targets (${info.targets.length}):\n` +
          info.targets
            .map((t, i) => `  ${i}: ${t.title ?? '(no title)'}  device=${t.deviceName}`)
            .join('\n')
      );
    }
    return 0;
  } catch (err) {
    printError(`debug status — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}

export async function debugEvaluate(
  expr: string,
  opts: OutputOptions,
  sessionName: string,
  debugOpts: DebugOptions
): Promise<number> {
  if (!expr) {
    printError('debug evaluate requires a JS expression', opts);
    return 1;
  }
  const port = debugOpts.port ?? 8081;
  const { deviceId, platformPromise } = resolveSession(sessionName);
  try {
    const platform = await platformPromise;
    const client = new MetroCdpClient();
    await client.connect({ port, deviceId, platform, targetIndex: debugOpts.targetIndex });
    const value = await client.evaluate(expr);
    client.close();
    if (opts.json) printData({ result: value }, opts);
    else console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    return 0;
  } catch (err) {
    printError(`debug evaluate — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ComponentNode {
  name: string;
  depth: number;
  testID: string | null;
  label: string | null;
  text: string | null;
  rect: Rect | null;
}

interface ComponentTreePayload {
  requestId: string;
  screenW?: number;
  screenH?: number;
  fabric?: boolean;
  components?: ComponentNode[];
  error?: string;
}

export async function debugComponentTree(
  opts: OutputOptions,
  sessionName: string,
  debugOpts: DebugOptions
): Promise<number> {
  const port = debugOpts.port ?? 8081;
  const { deviceId, platformPromise } = resolveSession(sessionName);
  try {
    const platform = await platformPromise;
    const client = new MetroCdpClient();
    await client.connect({ port, deviceId, platform, targetIndex: debugOpts.targetIndex });
    const awaitCallback = await client.installCallbackBinding();
    const requestId = newRequestId();
    const pending = awaitCallback(requestId, 15_000);
    await client.evaluate<string>(makeComponentTreeScript(requestId), false);
    const result = (await pending) as ComponentTreePayload;
    client.close();

    if (result.error) {
      printError(`debug component-tree — ${result.error}`, opts);
      return 1;
    }
    const components = result.components ?? [];
    // Filter to on-screen components: rect present and inside the screen.
    const screenW = result.screenW ?? 0;
    const screenH = result.screenH ?? 0;
    const onScreen = components.filter((c) => {
      if (!c.rect) return false;
      const { x, y, w, h } = c.rect;
      if (w <= 0 || h <= 0) return false;
      if (screenW > 0 && (x + w < 0 || x > screenW)) return false;
      if (screenH > 0 && (y + h < 0 || y > screenH)) return false;
      return true;
    });

    if (opts.json) {
      printData(
        {
          count: onScreen.length,
          total: components.length,
          fabric: result.fabric ?? false,
          screenW,
          screenH,
          components: onScreen,
        },
        opts
      );
    } else {
      for (const c of onScreen) {
        const parts = ['  '.repeat(c.depth) + c.name];
        if (c.testID) parts.push(`testID=${c.testID}`);
        if (c.label) parts.push(`label=${JSON.stringify(c.label)}`);
        if (c.text) parts.push(`text=${JSON.stringify(c.text.slice(0, 40))}`);
        if (c.rect) {
          const r = c.rect;
          parts.push(
            `[${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}]`
          );
        }
        console.log(parts.join(' '));
      }
      console.log(
        `\n${onScreen.length} on-screen / ${components.length} total (${result.fabric ? 'Fabric' : 'Paper'})`
      );
    }
    return 0;
  } catch (err) {
    printError(`debug component-tree — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}

interface InspectFrame {
  fn: string;
  file: string;
  line: number;
  col: number;
  original?: boolean;
}

interface InspectItem {
  name: string;
  depth: number;
  frame: InspectFrame | null;
}

interface InspectPayload {
  requestId: string;
  x?: number;
  y?: number;
  items?: InspectItem[];
  error?: string;
}

export async function debugInspectElement(
  at: string,
  opts: OutputOptions,
  sessionName: string,
  debugOpts: DebugOptions
): Promise<number> {
  const m = at.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) {
    printError('debug inspect-element expects "<x>,<y>"', opts);
    return 1;
  }
  const x = Number(m[1]);
  const y = Number(m[2]);
  const port = debugOpts.port ?? 8081;
  const { deviceId, platformPromise } = resolveSession(sessionName);
  try {
    const platform = await platformPromise;
    const client = new MetroCdpClient();
    await client.connect({ port, deviceId, platform, targetIndex: debugOpts.targetIndex });
    const awaitCallback = await client.installCallbackBinding();
    const requestId = newRequestId();
    const pending = awaitCallback(requestId, 8_000);
    await client.evaluate<string>(makeInspectElementScript(x, y, requestId), false);
    const result = (await pending) as InspectPayload;
    client.close();

    if (result.error) {
      printError(`debug inspect-element — ${result.error}`, opts);
      return 1;
    }
    if (opts.json) printData(result, opts);
    else {
      console.log(`Components at (${x}, ${y}) — closest first:`);
      for (const item of result.items ?? []) {
        const src = item.frame
          ? `  (${item.frame.file}:${item.frame.line}${item.frame.original ? ' [original]' : ''})`
          : '';
        console.log(`${'  '.repeat(item.depth)}${item.name}${src}`);
      }
    }
    return 0;
  } catch (err) {
    printError(`debug inspect-element — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}

export async function debugLogRegistry(opts: OutputOptions, sessionName: string): Promise<number> {
  // Delegate to the existing `logs` command in summary mode (--list).
  return logsCmd(opts, sessionName, { source: 'metro', list: true });
}

export async function debugReload(
  opts: OutputOptions,
  sessionName: string,
  debugOpts: DebugOptions
): Promise<number> {
  const port = debugOpts.port ?? 8081;
  const { deviceId, platformPromise } = resolveSession(sessionName);
  try {
    const platform = await platformPromise;
    await cdpCall<void>('Page.reload', undefined, {
      port,
      deviceId,
      platform,
      targetIndex: debugOpts.targetIndex,
    });
    if (opts.json) printData({ reloaded: true, port, method: 'cdp' }, opts);
    else console.log(`reloaded port=${port}`);
    return 0;
  } catch (err) {
    printError(`debug reload — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}
