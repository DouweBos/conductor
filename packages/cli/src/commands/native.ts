// iOS/tvOS simulator only; the app must be launched with `launch-app --inject`.
export const PING_HELP = `  native-ping                          Check the injected in-process control library is alive`;
export const INSPECT_HELP = `  native-inspect                       Full native view tree: colors, fonts, text, layer visuals, absFrame`;
export const NAV_HELP = `  native-nav                           Navigation state: view-controller stacks, tabs, presented`;
export const SCREENSHOT_HELP = `  native-screenshot --output <p.png>   In-process PNG of the key window`;
export const IMAGE_HELP = `  native-image <x,y,w,h> --output <p>  PNG crop of a window-absolute rect (use a node's absFrame)`;
export const SNAPSHOT_HELP = `  native-snapshot <id> --output <p>    Isolated PNG of one view (own content, transparent) for 3D-explosion layers; --with-subviews for the composited view`;
export const RAW_HELP = `  native-raw <path>                    GET any in-process endpoint (e.g. '/get?id=..&keyPath=layer.cornerRadius'); --output <f> saves image endpoints. See packages/ios-inproc/README.md for the full list`;
export const CONSOLE_HELP = `  native-console [--since <n>]         App stdout/stderr + logs (poll with the returned cursor)`;
export const NETWORK_HELP = `  native-network [--since <n>]         Captured HTTP requests/responses (poll with cursor)`;
export const HEAP_HELP = `  native-heap --class <name> | --pattern <s> | --read <addr> [--key <keyPath>]   Live object browser`;
export const APPEARANCE_HELP = `  native-appearance <light|dark|system> | --direction <ltr|rtl> | --content-size <cat> | --anim-speed <n>`;
export const EVAL_HELP = `  native-eval <swift>                  Compile & run arbitrary Swift inside the app; --mode full for a whole function body. e.g. native-eval 'UIApplication.shared.connectedScenes.count'`;
export const VIEW_HELP = `  native-view <id>                     Full property detail for a view (id from native-inspect)`;
export const SET_HELP = `  native-set <id> <key> <value>        Live-edit a view property (alpha, hidden, backgroundColor, tintColor, cornerRadius, borderWidth, borderColor, frame, text)`;
export const CONSTRAINTS_HELP = `  native-constraints <id>              Auto Layout constraints affecting a view + ambiguity`;
export const HITTEST_HELP = `  native-hittest <x,y>                 Topmost view at a screen point + ancestor chain`;
export const HIGHLIGHT_HELP = `  native-highlight <id>                Flash a highlight over the view on the device`;
export const FIND_HELP = `  native-find [--class <name>] [--text <s>]  Search views by class and/or text`;

import fs from 'fs';
import { getDriver } from '../runner.js';
import { getSession } from '../session.js';
import { printSuccess, printError, OutputOptions } from '../output.js';
import { IOSDriver } from '../drivers/ios.js';
import { getInprocPort, InprocClient } from '../drivers/ios-inproc.js';
import { compileEval } from '../drivers/eval-compiler.js';

/** Resolve the in-process client for the current iOS/tvOS session, or print why not. */
async function resolveClient(
  sessionName: string,
  opts: OutputOptions
): Promise<InprocClient | null> {
  const driver = await getDriver(sessionName);
  if (!(driver instanceof IOSDriver)) {
    printError('native commands are iOS/tvOS simulator only', opts);
    return null;
  }
  const deviceId = driver.deviceId;
  if (!deviceId) {
    printError('native commands require a resolved simulator device', opts);
    return null;
  }
  return new InprocClient(getInprocPort(deviceId));
}

export async function nativePing(
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  try {
    const client = await resolveClient(sessionName, opts);
    if (!client) return 1;
    const res = await client.ping().catch(() => null);
    if (!res || res.status !== 'ok') {
      printError('no in-process server. Launch the app with: launch-app <appId> --inject', opts);
      return 1;
    }
    if (opts.json) {
      console.log(JSON.stringify({ ...res, status: 'ok' }));
    } else {
      printSuccess(`in-process control alive — pid ${res.pid}, app ${res.app}`, opts);
    }
    return 0;
  } catch (err) {
    printError(`native-ping failed: ${(err as Error).message}`, opts);
    return 1;
  }
}

export async function nativeInspect(
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  return runQuery('native-inspect', (c) => c.inspect(), opts, sessionName);
}

export async function nativeNav(
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  return runQuery('native-nav', (c) => c.nav(), opts, sessionName);
}

export async function nativeScreenshot(
  output: string | undefined,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  return saveImage('native-screenshot', (c) => c.screenshot(), output, opts, sessionName);
}

export async function nativeImage(
  frameArg: string | undefined,
  output: string | undefined,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  const parts = (frameArg ?? '').split(',').map((n) => Number(n.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    printError('native-image needs a rect: native-image <x,y,w,h> --output <file>', opts);
    return 1;
  }
  const [x, y, w, h] = parts;
  return saveImage('native-image', (c) => c.image({ x, y, w, h }), output, opts, sessionName);
}

export async function nativeRaw(
  reqPath: string | undefined,
  output: string | undefined,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  if (!reqPath) {
    printError("native-raw needs a path, e.g. native-raw '/get?id=0x..&keyPath=alpha'", opts);
    return 1;
  }
  try {
    const client = await resolveClient(sessionName, opts);
    if (!client) return 1;
    const { contentType, body } = await client.rawRequest(reqPath);
    if (contentType.startsWith('image/')) {
      const dest = output ?? `native-raw-${Date.now()}.png`;
      fs.writeFileSync(dest, body);
      printSuccess(`saved ${body.length} bytes → ${dest}`, opts);
    } else {
      // Pretty-print JSON when possible.
      const text = body.toString('utf-8');
      try {
        console.log(JSON.stringify(JSON.parse(text), null, opts.json ? 0 : 2));
      } catch {
        console.log(text);
      }
    }
    return 0;
  } catch (err) {
    printError(
      `native-raw failed: ${(err as Error).message}. Is the app launched with --inject?`,
      opts
    );
    return 1;
  }
}

export async function nativeConsole(
  since: number | undefined,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  return runQuery(
    'native-console',
    (c) => c.rawJson(`/console?since=${since ?? 0}`),
    opts,
    sessionName
  );
}

export async function nativeNetwork(
  since: number | undefined,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  return runQuery(
    'native-network',
    (c) => c.rawJson(`/network?since=${since ?? 0}`),
    opts,
    sessionName
  );
}

export async function nativeHeap(
  filters: { className?: string; pattern?: string; read?: string; key?: string },
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  let path: string;
  if (filters.read) {
    path = `/heap/read?address=${encodeURIComponent(filters.read)}`;
    if (filters.key) path += `&keyPath=${encodeURIComponent(filters.key)}`;
  } else if (filters.className) {
    path = `/heap/instances?class=${encodeURIComponent(filters.className)}`;
  } else {
    path = `/heap/classes?pattern=${encodeURIComponent(filters.pattern ?? '')}`;
  }
  return runQuery('native-heap', (c) => c.rawJson(path), opts, sessionName);
}

export async function nativeAppearance(
  args: { style?: string; direction?: string; contentSize?: string; animSpeed?: string },
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  let path: string;
  if (args.direction) path = `/direction?direction=${encodeURIComponent(args.direction)}`;
  else if (args.contentSize) path = `/contentsize?category=${encodeURIComponent(args.contentSize)}`;
  else if (args.animSpeed) path = `/animspeed?speed=${encodeURIComponent(args.animSpeed)}`;
  else if (args.style) path = `/appearance?style=${encodeURIComponent(args.style)}`;
  else {
    printError(
      'native-appearance needs <light|dark|system> or --direction/--content-size/--anim-speed',
      opts
    );
    return 1;
  }
  return runQuery('native-appearance', (c) => c.rawJson(path), opts, sessionName);
}

export async function nativeEval(
  code: string | undefined,
  mode: 'expr' | 'full',
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  if (!code) {
    printError("native-eval needs Swift code, e.g. native-eval 'UIScreen.main.bounds'", opts);
    return 1;
  }
  try {
    const driver = await getDriver(sessionName);
    if (!(driver instanceof IOSDriver)) {
      printError('native-eval is iOS/tvOS simulator only', opts);
      return 1;
    }
    const deviceId = driver.deviceId;
    const bundleId = (await getSession(sessionName)).appId;
    if (!deviceId || !bundleId) {
      printError(
        'native-eval needs a resolved device and a launched app (launch-app <appId> --inject)',
        opts
      );
      return 1;
    }

    const compiled = await compileEval(code, mode, driver.platform, deviceId, bundleId);
    if (!compiled.ok || !compiled.dylibPath) {
      printError(compiled.error ?? 'compile failed', opts);
      return 1;
    }

    const client = new InprocClient(getInprocPort(deviceId));
    const res = await client
      .rawJson(`/eval?dylib=${encodeURIComponent(compiled.dylibPath)}`, 30000)
      .catch((err: Error) => {
        throw new Error(`${err.message}. Is the app running with launch-app --inject?`);
      });

    if (res.status !== 'ok') {
      printError(`eval error: ${res.message ?? JSON.stringify(res)}`, opts);
      return 1;
    }
    if (opts.json) {
      console.log(JSON.stringify({ status: 'ok', result: res.result, info: compiled.info }));
    } else {
      printSuccess(`[${compiled.info}] ${res.result}`, opts);
    }
    return 0;
  } catch (err) {
    printError(`native-eval failed: ${(err as Error).message}`, opts);
    return 1;
  }
}

export async function nativeSnapshot(
  id: string | undefined,
  withSubviews: boolean,
  output: string | undefined,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  if (!id) {
    printError('native-snapshot needs a view id (from native-inspect)', opts);
    return 1;
  }
  return saveImage(
    'native-snapshot',
    (c) => c.snapshot(id, withSubviews),
    output,
    opts,
    sessionName
  );
}

export async function nativeView(
  id: string | undefined,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  if (!id) {
    printError('native-view needs a view id (from native-inspect)', opts);
    return 1;
  }
  return runQuery('native-view', (c) => c.view(id), opts, sessionName);
}

export async function nativeSet(
  args: string[],
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  const [id, key, ...valueParts] = args;
  const value = valueParts.join(' ');
  if (!id || !key || value === '') {
    printError('usage: native-set <id> <key> <value>', opts);
    return 1;
  }
  return runQuery('native-set', (c) => c.set(id, key, value), opts, sessionName);
}

export async function nativeConstraints(
  id: string | undefined,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  if (!id) {
    printError('native-constraints needs a view id', opts);
    return 1;
  }
  return runQuery('native-constraints', (c) => c.constraints(id), opts, sessionName);
}

export async function nativeHittest(
  point: string | undefined,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  const [x, y] = (point ?? '').split(',').map((n) => Number(n.trim()));
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    printError('usage: native-hittest <x,y>', opts);
    return 1;
  }
  return runQuery('native-hittest', (c) => c.hittest(x, y), opts, sessionName);
}

export async function nativeHighlight(
  id: string | undefined,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  if (!id) {
    printError('native-highlight needs a view id', opts);
    return 1;
  }
  return runQuery('native-highlight', (c) => c.highlight(id), opts, sessionName);
}

export async function nativeFind(
  filters: { className?: string; text?: string },
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  if (!filters.className && !filters.text) {
    printError('native-find needs --class <name> and/or --text <substring>', opts);
    return 1;
  }
  return runQuery('native-find', (c) => c.find(filters), opts, sessionName);
}

async function saveImage(
  label: string,
  fetch: (c: InprocClient) => Promise<Buffer>,
  output: string | undefined,
  opts: OutputOptions,
  sessionName: string
): Promise<number> {
  try {
    const client = await resolveClient(sessionName, opts);
    if (!client) return 1;
    const png = await fetch(client).catch((err: Error) => {
      throw new Error(`${err.message}. Is the app running with launch-app --inject?`);
    });
    const dest = output ?? `${label}-${Date.now()}.png`;
    fs.writeFileSync(dest, png);
    if (opts.json) {
      console.log(JSON.stringify({ status: 'ok', output: dest, bytes: png.length }));
    } else {
      printSuccess(`${label} → ${dest} (${png.length} bytes)`, opts);
    }
    return 0;
  } catch (err) {
    printError(`${label} failed: ${(err as Error).message}`, opts);
    return 1;
  }
}

async function runQuery(
  label: string,
  query: (c: InprocClient) => Promise<Record<string, unknown>>,
  opts: OutputOptions,
  sessionName: string
): Promise<number> {
  try {
    const client = await resolveClient(sessionName, opts);
    if (!client) return 1;
    const res = await query(client).catch((err: Error) => {
      throw new Error(`${err.message}. Is the app running with launch-app --inject?`);
    });
    // Always emit JSON — these payloads are structured data for the agent.
    console.log(JSON.stringify(res, null, opts.json ? 0 : 2));
    return 0;
  } catch (err) {
    printError(`${label} failed: ${(err as Error).message}`, opts);
    return 1;
  }
}
