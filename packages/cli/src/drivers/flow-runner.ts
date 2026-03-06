/**
 * Native Conductor YAML flow parser and executor.
 * Parses flow YAML files and executes commands directly using IOSDriver / AndroidDriver.
 */
import fs from 'fs/promises';
import path from 'path';
import vm from 'node:vm';
import yaml from 'js-yaml';
import { IOSDriver, AXElement } from './ios.js';
import { AndroidDriver } from './android.js';
import {
  waitForIOSElement,
  waitForAndroidElement,
  waitForIOSTransitionToSettle,
  waitForIOSHierarchyToSettle,
  waitForAndroidHierarchyToSettle,
  OPTIONAL_TIMEOUT_MS,
} from './wait.js';
import { performance } from 'perf_hooks';
import { executeScript } from './js-engine.js';
import { sleep } from '../utils.js';

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

type AnyDriver = IOSDriver | AndroidDriver;

// ── Selector ──────────────────────────────────────────────────────────────────

type FlowSelector = string | { text?: string; id?: string; index?: number; optional?: boolean };

function toElementSelector(sel: FlowSelector) {
  // A bare string matches text OR id (Maestro's query semantics).
  // Only object form with explicit `text:` or `id:` keys forces one field.
  if (typeof sel === 'string') return { query: sel };
  return { text: sel.text, id: sel.id, index: sel.index };
}

// ── Flow file ─────────────────────────────────────────────────────────────────

export interface FlowFile {
  appId?: string;
  env: Record<string, string>;
  commands: FlowCommand[];
  onFlowStart?: FlowCommand[];
  onFlowComplete?: FlowCommand[];
}

export type FlowCommand = string | Record<string, unknown>;

// ── Parsing ───────────────────────────────────────────────────────────────────

function isSimpleIdentifier(s: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
}

function evalInlineExpr(expr: string, env: Record<string, string>): string {
  // output.xxx references are resolved later by resolveDeep — leave them
  if (/^output\./.test(expr)) return `\${${expr}}`;
  // Simple env var name — handle here too
  if (isSimpleIdentifier(expr) && expr in env) return env[expr];
  // Try JS evaluation with env vars in scope
  try {
    const ctx = { ...env, undefined };
    const result = vm.runInNewContext(expr, ctx);
    return result !== undefined ? String(result) : '';
  } catch {
    return `\${${expr}}`; // leave as-is if eval fails
  }
}

function interpolate(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, key: string) => {
    // Check env var first (simple identifier lookup)
    if (key in env) return env[key];
    // Check process.env
    if (key in process.env) return process.env[key]!;
    // Try inline JS evaluation
    return evalInlineExpr(key.trim(), env);
  });
}

function interpolateDeep(obj: unknown, env: Record<string, string>): unknown {
  if (typeof obj === 'string') return interpolate(obj, env);
  if (Array.isArray(obj)) return obj.map((item) => interpolateDeep(item, env));
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = interpolateDeep(v, env);
    }
    return out;
  }
  return obj;
}

export async function parseFlowFile(
  filePath: string,
  extraEnv?: Record<string, string>
): Promise<FlowFile> {
  const content = await fs.readFile(filePath, 'utf-8');
  return parseFlowString(content, extraEnv);
}

export function parseFlowString(content: string, extraEnv?: Record<string, string>): FlowFile {
  const docs: unknown[] = [];
  yaml.loadAll(content, (doc) => docs.push(doc));

  let header: Record<string, unknown> = {};
  let rawCommands: unknown;

  if (docs.length >= 2) {
    header = (docs[0] as Record<string, unknown>) ?? {};
    rawCommands = docs[1];
  } else if (docs.length === 1) {
    const doc = docs[0];
    if (Array.isArray(doc)) {
      rawCommands = doc;
    } else if (doc && typeof doc === 'object') {
      // Single-document flow: either a header-only or treat as single command
      const keys = Object.keys(doc as object);
      const headerKeys = new Set(['appId', 'url', 'env', 'tags', 'onFlowStart', 'onFlowComplete']);
      if (keys.every((k) => headerKeys.has(k))) {
        header = doc as Record<string, unknown>;
        rawCommands = [];
      } else {
        rawCommands = [doc];
      }
    }
  }

  // CLI-supplied extraEnv overrides the flow's own env block (mirrors real Maestro behaviour)
  const env: Record<string, string> = {
    ...((header['env'] as Record<string, string>) ?? {}),
    ...(extraEnv ?? {}),
  };

  const commandList = Array.isArray(rawCommands) ? rawCommands : rawCommands ? [rawCommands] : [];

  const onFlowStart = header['onFlowStart'];
  const onFlowComplete = header['onFlowComplete'];

  return {
    appId: typeof header['appId'] === 'string' ? interpolate(header['appId'], env) : undefined,
    env,
    commands: interpolateDeep(commandList, env) as FlowCommand[],
    onFlowStart: Array.isArray(onFlowStart)
      ? (interpolateDeep(onFlowStart, env) as FlowCommand[])
      : undefined,
    onFlowComplete: Array.isArray(onFlowComplete)
      ? (interpolateDeep(onFlowComplete, env) as FlowCommand[])
      : undefined,
  };
}

// ── Execution helpers ─────────────────────────────────────────────────────────

async function getScreenSize(driver: AnyDriver): Promise<{ w: number; h: number }> {
  if (driver instanceof IOSDriver) {
    const info = await driver.deviceInfo();
    return { w: info.widthPoints, h: info.heightPoints };
  } else {
    const info = await driver.deviceInfo();
    return { w: info.widthPixels, h: info.heightPixels };
  }
}

// Key used to persist the iOS permission dismissal setting across flow boundaries
// via the shared output object.
const OUTPUT_IOS_SHOULD_ALLOW = '__iosShouldAllow';

async function waitForElement(
  driver: AnyDriver,
  sel: FlowSelector,
  timeoutMs?: number,
  appIds?: string[],
  opts?: ExecOpts
) {
  const elSel = toElementSelector(sel);
  if (driver instanceof IOSDriver) {
    const iosShouldAllow = opts?.output[OUTPUT_IOS_SHOULD_ALLOW] as boolean | undefined;
    return waitForIOSElement(
      () => iosGetHierarchy(driver, appIds ?? [], iosShouldAllow),
      elSel,
      timeoutMs
    );
  } else {
    return waitForAndroidElement(() => driver.viewHierarchy(), elSel, timeoutMs);
  }
}

// ── iOS permission dialog dismissal ───────────────────────────────────────────

// XCTest element type numbers (XCUIElementType raw values)
const IOS_ELEMENT_TYPE_ALERT = 7; // XCUIElementType.alert
const IOS_ELEMENT_TYPE_DIALOG = 8; // XCUIElementType.dialog (some system prompts)
const IOS_ELEMENT_TYPE_SHEET = 5; // XCUIElementType.sheet (action sheets)
const IOS_ELEMENT_TYPE_BUTTON = 9; // XCUIElementType.button

// SpringBoard button labels for granting / denying permissions
const ALLOW_BUTTON_LABELS = new Set([
  'Allow',
  'Allow While Using App',
  'Allow Once',
  'Allow Full Access',
]);
const DENY_BUTTON_LABELS = new Set(["Don't Allow", 'Ask App Not to Track']);

function walkAXElements(root: AXElement, visit: (el: AXElement) => void): void {
  visit(root);
  for (const child of root.children ?? []) walkAXElements(child, visit);
}

/**
 * If `root` contains a recognisable SpringBoard permission dialog, tap the
 * appropriate Allow/Deny button and return true. Returns false if no dialog found.
 */
async function tapPermissionDialog(
  driver: IOSDriver,
  root: AXElement,
  shouldAllow: boolean
): Promise<boolean> {
  const targetLabels = shouldAllow ? ALLOW_BUTTON_LABELS : DENY_BUTTON_LABELS;
  const alerts: AXElement[] = [];
  walkAXElements(root, (el) => {
    if (
      el.elementType === IOS_ELEMENT_TYPE_ALERT ||
      el.elementType === IOS_ELEMENT_TYPE_DIALOG ||
      el.elementType === IOS_ELEMENT_TYPE_SHEET
    )
      alerts.push(el);
  });

  for (const alert of alerts) {
    const buttons: AXElement[] = [];
    walkAXElements(alert, (el) => {
      if (el.elementType === IOS_ELEMENT_TYPE_BUTTON) buttons.push(el);
    });

    const isPermissionDialog = buttons.some(
      (b) => ALLOW_BUTTON_LABELS.has(b.label) || DENY_BUTTON_LABELS.has(b.label)
    );
    if (!isPermissionDialog) continue;

    const button = buttons.find((b) => targetLabels.has(b.label));
    if (button) {
      await driver.tap(
        button.frame.X + button.frame.Width / 2,
        button.frame.Y + button.frame.Height / 2
      );
      await sleep(500);
      return true;
    }
  }
  return false;
}

/**
 * Fetch the iOS view hierarchy. If shouldAllow is set, dismiss one permission
 * dialog (if present) before returning so the caller sees a clean hierarchy.
 * The waitForIOSElement retry loop handles multiple dialogs across iterations.
 */
async function iosGetHierarchy(
  driver: IOSDriver,
  appIds: string[],
  shouldAllow?: boolean
): Promise<AXElement> {
  const root = (await driver.viewHierarchy(false, appIds)).axElement;
  if (shouldAllow !== undefined) {
    const tapped = await tapPermissionDialog(driver, root, shouldAllow);
    if (tapped) return (await driver.viewHierarchy(false, appIds)).axElement;
  }
  return root;
}

/**
 * After launchApp on iOS, eagerly dismiss all pending permission dialogs.
 * Repeats up to maxRounds to handle apps that show multiple dialogs in sequence.
 */
async function dismissIOSPermissionDialogs(
  driver: IOSDriver,
  shouldAllow: boolean,
  appIds: string[]
): Promise<void> {
  for (let round = 0; round < 8; round++) {
    let root: AXElement;
    try {
      root = (await driver.viewHierarchy(false, appIds)).axElement;
    } catch {
      return;
    }
    const tapped = await tapPermissionDialog(driver, root, shouldAllow);
    if (!tapped) return;
  }
}

/**
 * Wait for the screen to settle after any navigation action (tap, swipe, link).
 * iOS: two-phase — waits for the transition to start, then for it to finish.
 *   Uses the /isScreenStatic endpoint (two back-to-back screenshots, SHA256 hash compare).
 * Android: falls back to hierarchy-based settle.
 */
async function waitForSettle(driver: AnyDriver): Promise<void> {
  if (driver instanceof IOSDriver) {
    await waitForIOSTransitionToSettle(() => driver.isScreenStatic());
  } else {
    await waitForAndroidHierarchyToSettle(() => driver.viewHierarchy());
  }
}

async function findElementNoThrow(
  driver: AnyDriver,
  sel: FlowSelector,
  timeoutMs = 1000,
  appIds?: string[],
  opts?: ExecOpts
) {
  try {
    return await waitForElement(driver, sel, timeoutMs, appIds, opts);
  } catch {
    return null;
  }
}

function parseCoords(s: string): { x: number; y: number } {
  const [xs, ys] = s.split(',').map((p) => p.trim());
  return { x: parseFloat(xs), y: parseFloat(ys) };
}

async function performSwipe(
  driver: AnyDriver,
  direction: string,
  startXY?: string,
  endXY?: string,
  durationMs = 500
): Promise<void> {
  const { w, h } = await getScreenSize(driver);
  let startX: number, startY: number, endX: number, endY: number;

  if (startXY && endXY) {
    const s = parseCoords(startXY);
    const e = parseCoords(endXY);
    // Support normalised (0–1) or absolute pixel coordinates
    startX = s.x <= 1 ? s.x * w : s.x;
    startY = s.y <= 1 ? s.y * h : s.y;
    endX = e.x <= 1 ? e.x * w : e.x;
    endY = e.y <= 1 ? e.y * h : e.y;
  } else {
    const cx = w / 2;
    const cy = h / 2;
    switch (direction.toUpperCase()) {
      case 'DOWN':
        startX = cx;
        startY = h * 0.7;
        endX = cx;
        endY = h * 0.3;
        break;
      case 'UP':
        startX = cx;
        startY = h * 0.3;
        endX = cx;
        endY = h * 0.7;
        break;
      case 'LEFT':
        startX = w * 0.8;
        startY = cy;
        endX = w * 0.2;
        endY = cy;
        break;
      case 'RIGHT':
        startX = w * 0.2;
        startY = cy;
        endX = w * 0.8;
        endY = cy;
        break;
      default:
        startX = cx;
        startY = h * 0.7;
        endX = cx;
        endY = h * 0.3;
        break;
    }
  }

  if (driver instanceof IOSDriver) {
    await driver.swipe(startX, startY, endX, endY, durationMs / 1000);
  } else {
    await driver.swipe(startX, startY, endX, endY, durationMs);
  }
}

// Map Conductor key names → Android keycodes
const ANDROID_KEYCODES: Record<string, number> = {
  BACK: 4,
  HOME: 3,
  ENTER: 66,
  RETURN: 66,
  DELETE: 67,
  BACKSPACE: 67,
  TAB: 61,
  SPACE: 62,
  ESCAPE: 111,
  SEARCH: 84,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  // Android TV remote D-pad keys only
  'REMOTE DPAD UP': 19,
  'REMOTE DPAD DOWN': 20,
  'REMOTE DPAD LEFT': 21,
  'REMOTE DPAD RIGHT': 22,
  'REMOTE DPAD CENTER': 23,
};

// ── Executor ──────────────────────────────────────────────────────────────────

// Internal opts — output and env are created in executeFlow and threaded through
type ExecOpts = {
  cwd?: string;
  appId?: string;
  env: Record<string, string>;
  cliEnv: Record<string, string>; // CLI --env vars, threaded into sub-flows
  output: Record<string, unknown>;
  depth: number; // nesting level for indented output
  benchmark?: boolean;
};

export async function executeFlow(
  flow: FlowFile,
  driver: AnyDriver,
  opts: {
    cwd?: string;
    appId?: string;
    env?: Record<string, string>;
    output?: Record<string, unknown>;
    depth?: number;
    benchmark?: boolean;
  } = {}
): Promise<void> {
  const cliEnv = opts.env ?? {};
  const execOpts: ExecOpts = {
    cwd: opts.cwd,
    appId: opts.appId ?? flow.appId,
    // CLI env overrides flow env at runtime (same priority as parse time)
    env: { ...flow.env, ...cliEnv },
    cliEnv,
    output: opts.output ?? {},
    depth: opts.depth ?? 0,
    benchmark: opts.benchmark,
  };
  const flowStart = opts.benchmark ? performance.now() : 0;

  if (flow.onFlowStart?.length) {
    console.log('[onFlowStart]');
    await executeCommands(flow.onFlowStart, driver, execOpts);
  }

  let mainError: unknown;
  try {
    await executeCommands(flow.commands, driver, execOpts);
  } catch (err) {
    mainError = err;
  } finally {
    if (flow.onFlowComplete?.length) {
      console.log('[onFlowComplete]');
      try {
        await executeCommands(flow.onFlowComplete, driver, execOpts);
      } catch (cleanupErr) {
        if (mainError !== undefined) {
          // Main flow already failed; log cleanup error but let original propagate
          console.error(
            `[onFlowComplete] cleanup error: ${cleanupErr instanceof Error ? cleanupErr.message : cleanupErr}`
          );
        } else {
          throw cleanupErr;
        }
      }
    }
  }

  if (mainError !== undefined) throw mainError;

  if (opts.benchmark && (opts.depth ?? 0) === 0) {
    console.log(`\nBenchmark: total ${fmtMs(performance.now() - flowStart)}`);
  }
}

async function executeCommands(
  commands: FlowCommand[],
  driver: AnyDriver,
  opts: ExecOpts
): Promise<void> {
  for (const cmd of commands) {
    await executeCommand(cmd, driver, opts);
  }
}

/** Resolve ${output.key} references at execution time (after scripts have run). */
function resolveDeep(val: unknown, output: Record<string, unknown>): unknown {
  if (typeof val === 'string') {
    return val.replace(/\$\{output\.([^}]+)\}/g, (match, key: string) => {
      // Support both flat keys and dotted paths (e.g. output.authProfile.username)
      if (key in output) return output[key] !== undefined ? String(output[key]) : '';
      const parts = key.split('.');
      let cur: unknown = output;
      for (const part of parts) {
        cur = (cur as Record<string, unknown>)?.[part];
        if (cur === undefined) return match;
      }
      return cur !== undefined ? String(cur) : match;
    });
  }
  if (Array.isArray(val)) return val.map((item) => resolveDeep(item, output));
  if (val && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = resolveDeep(v, output);
    }
    return out;
  }
  return val;
}

function selectorLabel(sel: FlowSelector): string {
  if (typeof sel === 'string') return JSON.stringify(sel);
  const parts: string[] = [];
  if (sel.text) parts.push(`text=${JSON.stringify(sel.text)}`);
  if (sel.id) parts.push(`id=${JSON.stringify(sel.id)}`);
  return parts.join(' ') || JSON.stringify(sel);
}

function describeCommand(key: string, val: unknown, customLabel?: string): string {
  if (customLabel) return customLabel;
  if (val === null || val === undefined || val === '') return key;
  if (typeof val === 'string') return `${key} ${JSON.stringify(val)}`;
  if (typeof val === 'number') return `${key} ${val}`;
  if (typeof val === 'object') {
    const v = val as Record<string, unknown>;
    const autoLabel =
      v['text'] ?? v['id'] ?? v['appId'] ?? v['file'] ?? v['direction'] ?? v['path'];
    return autoLabel ? `${key} ${JSON.stringify(autoLabel)}` : key;
  }
  return key;
}

async function executeCommand(cmd: FlowCommand, driver: AnyDriver, opts: ExecOpts): Promise<void> {
  // Bare string: `- launchApp`, `- back`, `- scroll`, etc. — treat as { commandName: null }
  if (typeof cmd === 'string') {
    return executeCommand({ [cmd]: null }, driver, opts);
  }

  const key = Object.keys(cmd)[0];
  if (!key) return;
  const val = cmd[key];

  // Resolve ${output.key} references that couldn't be resolved at parse time
  const resolvedVal = resolveDeep(val, opts.output);

  // Extract label and optional from the resolved value (if it's an object)
  const customLabel =
    typeof resolvedVal === 'object' && resolvedVal !== null
      ? ((resolvedVal as Record<string, unknown>)['label'] as string | undefined)
      : undefined;
  const optional =
    typeof resolvedVal === 'object' &&
    resolvedVal !== null &&
    (resolvedVal as Record<string, unknown>)['optional'] === true;

  const label = describeCommand(key, val, customLabel);
  const indent = '  '.repeat(opts.depth + 1);
  // Compound commands produce nested output — print header on its own line
  const isCompound =
    key === 'runFlow' || key === 'repeat' || key === 'retry' || key === 'extendedWaitUntil';

  if (isCompound) {
    console.log(`${indent}→ ${label}`);
  } else {
    process.stdout.write(`${indent}→ ${label} ... `);
  }

  const t0 = opts.benchmark ? performance.now() : 0;

  try {
    await executeCommandBody(key, resolvedVal, driver, opts);
    const elapsed = opts.benchmark ? `  (${fmtMs(performance.now() - t0)})` : '';
    if (!isCompound) {
      console.log(`ok${elapsed}`);
    } else if (opts.benchmark) {
      console.log(`${indent}  ↳ ${fmtMs(performance.now() - t0)}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const elapsed = opts.benchmark ? `  (${fmtMs(performance.now() - t0)})` : '';
    if (optional) {
      // For compound commands the sub-command already printed its warning/failure
      if (!isCompound) console.log(`warning (optional): ${msg}${elapsed}`);
    } else {
      if (!isCompound) console.log(`FAILED${elapsed}\n${indent}  ${msg}`);
      throw err;
    }
  }
}

function getConductorObj(
  driver: AnyDriver,
  output: Record<string, unknown>
): Record<string, unknown> {
  return {
    platform: driver instanceof IOSDriver ? 'ios' : 'android',
    copiedText: (output['__copiedText'] as string) ?? '',
  };
}

async function resolvePoint(point: string, driver: AnyDriver): Promise<{ x: number; y: number }> {
  const [xs, ys] = point.split(',').map((s) => s.trim());
  const xRaw = parseFloat(xs);
  const yRaw = parseFloat(ys);
  const isRelX = xs.endsWith('%');
  const isRelY = ys.endsWith('%');
  if (isRelX || isRelY) {
    const { w, h } = await getScreenSize(driver);
    return {
      x: isRelX ? (xRaw / 100) * w : xRaw,
      y: isRelY ? (yRaw / 100) * h : yRaw,
    };
  }
  // values <= 1.0 are treated as fractional
  if (xRaw <= 1.0 && yRaw <= 1.0) {
    const { w, h } = await getScreenSize(driver);
    return { x: xRaw * w, y: yRaw * h };
  }
  return { x: xRaw, y: yRaw };
}

async function evaluateWhen(
  when: Record<string, unknown>,
  driver: AnyDriver,
  opts: ExecOpts
): Promise<boolean> {
  if ('true' in when) {
    let expr = String(when['true']);
    // Strip ${...} wrapper left over from parse-time interpolation
    const match = /^\$\{(.+)\}$/.exec(expr);
    if (match) expr = match[1];
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    await executeScript(
      `output.__whenCond = !!(${expr});`,
      opts.env,
      opts.output,
      'when.true',
      getConductorObj(driver, opts.output)
    );
    const result = opts.output['__whenCond'] as boolean;
    delete opts.output['__whenCond'];
    return result;
  }
  const appIds = opts.appId ? [opts.appId] : undefined;
  if ('visible' in when) {
    return (
      (await findElementNoThrow(driver, when['visible'] as FlowSelector, 1000, appIds, opts)) !==
      null
    );
  }
  if ('notVisible' in when) {
    return (
      (await findElementNoThrow(driver, when['notVisible'] as FlowSelector, 1000, appIds, opts)) ===
      null
    );
  }
  return true;
}

async function executeCommandBody(
  key: string,
  val: unknown,
  driver: AnyDriver,
  opts: ExecOpts
): Promise<void> {
  const appIds = opts.appId ? [opts.appId] : undefined;
  switch (key) {
    // ── Element interactions ───────────────────────────────────────────────
    case 'tapOn': {
      const v = val as FlowSelector & { point?: string; repeat?: number; delay?: number };
      if (typeof v === 'object' && v !== null && v.point) {
        const { x, y } = await resolvePoint(v.point, driver);
        await driver.tap(x, y);
      } else {
        const isOptional =
          typeof v === 'object' && v !== null && (v as { optional?: boolean }).optional === true;
        const el = await waitForElement(
          driver,
          val as FlowSelector,
          isOptional ? OPTIONAL_TIMEOUT_MS : undefined,
          appIds,
          opts
        );
        const repeatCount = typeof v === 'object' && v?.repeat ? v.repeat : 1;
        const delay = typeof v === 'object' && v?.delay ? v.delay : 100;
        await driver.tap(el.centerX, el.centerY);
        for (let i = 1; i < repeatCount; i++) {
          await sleep(delay);
          await driver.tap(el.centerX, el.centerY);
        }
      }
      await waitForSettle(driver);
      break;
    }

    case 'doubleTapOn': {
      const v = val as FlowSelector & { point?: string };
      if (typeof v === 'object' && v !== null && v.point) {
        const { x, y } = await resolvePoint(v.point, driver);
        await driver.tap(x, y);
        await sleep(100);
        await driver.tap(x, y);
      } else {
        const isOptional =
          typeof v === 'object' && v !== null && (v as { optional?: boolean }).optional === true;
        const el = await waitForElement(
          driver,
          val as FlowSelector,
          isOptional ? OPTIONAL_TIMEOUT_MS : undefined,
          appIds,
          opts
        );
        await driver.tap(el.centerX, el.centerY);
        await sleep(100);
        await driver.tap(el.centerX, el.centerY);
      }
      await waitForSettle(driver);
      break;
    }

    case 'longPressOn': {
      const v = val as FlowSelector & { point?: string };
      if (typeof v === 'object' && v !== null && v.point) {
        const { x, y } = await resolvePoint(v.point, driver);
        if (driver instanceof IOSDriver) {
          await driver.tap(x, y, 1.5);
        } else {
          await driver.swipe(x, y, x, y, 1500);
        }
      } else {
        const isOptional =
          typeof v === 'object' && v !== null && (v as { optional?: boolean }).optional === true;
        const el = await waitForElement(
          driver,
          val as FlowSelector,
          isOptional ? OPTIONAL_TIMEOUT_MS : undefined,
          appIds,
          opts
        );
        if (driver instanceof IOSDriver) {
          await driver.tap(el.centerX, el.centerY, 1.5);
        } else {
          await driver.swipe(el.centerX, el.centerY, el.centerX, el.centerY, 1500);
        }
      }
      await waitForSettle(driver);
      break;
    }

    case 'inputText': {
      await driver.inputText(val as string);
      break;
    }

    case 'eraseText': {
      const n =
        typeof val === 'number'
          ? val
          : ((val as { charactersToErase?: number })?.charactersToErase ?? 50);
      if (driver instanceof AndroidDriver) {
        await driver.eraseAllText(n);
      } else {
        for (let i = 0; i < n; i++) await driver.pressKey('delete');
      }
      break;
    }

    case 'inputRandomText': {
      const length =
        typeof val === 'number' ? val : ((val as { length?: number } | null)?.length ?? 8);
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      let text = '';
      for (let i = 0; i < length; i++) text += chars[Math.floor(Math.random() * chars.length)];
      await driver.inputText(text);
      break;
    }

    case 'inputRandomNumber': {
      const length =
        typeof val === 'number' ? val : ((val as { length?: number } | null)?.length ?? 8);
      let num = '';
      for (let i = 0; i < length; i++) num += Math.floor(Math.random() * 10).toString();
      await driver.inputText(num);
      break;
    }

    case 'inputRandomEmail': {
      const local = Math.random().toString(36).slice(2, 10);
      await driver.inputText(`${local}@example.com`);
      break;
    }

    case 'inputRandomPersonName': {
      const firstNames = [
        'Alice',
        'Bob',
        'Charlie',
        'Diana',
        'Eve',
        'Frank',
        'Grace',
        'Henry',
        'Iris',
        'Jack',
      ];
      const lastNames = [
        'Smith',
        'Johnson',
        'Williams',
        'Brown',
        'Jones',
        'Garcia',
        'Miller',
        'Davis',
        'Wilson',
        'Moore',
      ];
      const name = `${firstNames[Math.floor(Math.random() * firstNames.length)]} ${lastNames[Math.floor(Math.random() * lastNames.length)]}`;
      await driver.inputText(name);
      break;
    }

    case 'inputRandomCityName': {
      const cities = [
        'New York',
        'Los Angeles',
        'Chicago',
        'Houston',
        'Phoenix',
        'Philadelphia',
        'San Antonio',
        'San Diego',
        'Dallas',
        'San Jose',
        'Austin',
        'Jacksonville',
        'Seattle',
        'Denver',
        'Boston',
      ];
      await driver.inputText(cities[Math.floor(Math.random() * cities.length)]);
      break;
    }

    case 'inputRandomCountryName': {
      const countries = [
        'United States',
        'Canada',
        'United Kingdom',
        'Australia',
        'Germany',
        'France',
        'Japan',
        'Brazil',
        'India',
        'Mexico',
        'Italy',
        'Spain',
        'Netherlands',
        'Sweden',
        'Norway',
      ];
      await driver.inputText(countries[Math.floor(Math.random() * countries.length)]);
      break;
    }

    case 'inputRandomColorName': {
      const colors = [
        'Red',
        'Blue',
        'Green',
        'Yellow',
        'Purple',
        'Orange',
        'Pink',
        'Brown',
        'Black',
        'White',
        'Gray',
        'Cyan',
        'Magenta',
        'Indigo',
        'Violet',
      ];
      await driver.inputText(colors[Math.floor(Math.random() * colors.length)]);
      break;
    }

    // ── Scroll / swipe ─────────────────────────────────────────────────────
    case 'scroll': {
      const direction = (val as { direction?: string } | null)?.direction ?? 'DOWN';
      await performSwipe(driver, direction);
      break;
    }

    case 'swipe': {
      if (typeof val === 'string') {
        await performSwipe(driver, val);
      } else {
        const v = val as { direction?: string; start?: string; end?: string; duration?: number };
        await performSwipe(driver, v.direction ?? 'DOWN', v.start, v.end, v.duration);
      }
      break;
    }

    // ── Navigation ─────────────────────────────────────────────────────────
    case 'back': {
      if (driver instanceof AndroidDriver) await driver.back();
      // iOS has no hardware back button — noop
      break;
    }

    case 'openLink': {
      // Accepts string URL or object { link: "...", browser?: bool }
      const url = typeof val === 'string' ? val : (val as { link: string }).link;
      await driver.openLink(url);
      await waitForSettle(driver);
      break;
    }

    case 'openBrowser': {
      await driver.openLink(val as string);
      await waitForSettle(driver);
      break;
    }

    case 'hide keyboard': {
      if (driver instanceof IOSDriver) {
        await driver.pressKey('return').catch(() => {
          /* noop if no keyboard */
        });
      } else {
        await (driver as AndroidDriver).pressKeyEvent(111); // KEYCODE_ESCAPE
      }
      break;
    }

    // ── Assertions ─────────────────────────────────────────────────────────
    case 'assertVisible': {
      const optional =
        typeof val === 'object' &&
        val !== null &&
        (val as { optional?: boolean }).optional === true;
      if (optional) {
        await findElementNoThrow(driver, val as FlowSelector, OPTIONAL_TIMEOUT_MS, appIds, opts);
      } else {
        await waitForElement(driver, val as FlowSelector, undefined, appIds, opts);
      }
      break;
    }

    case 'assertNotVisible': {
      const el = await findElementNoThrow(driver, val as FlowSelector, 1000, appIds, opts);
      if (el !== null) {
        throw new Error(`assertNotVisible failed: element is visible: ${JSON.stringify(val)}`);
      }
      break;
    }

    case 'assertTrue': {
      // Evaluate a JS expression; throw if falsy
      // Accepts string expression or { condition: "expr" }
      const expr = typeof val === 'string' ? val : (val as { condition: string }).condition;
      await executeScript(
        `output.__assertTrue = !!(${expr});`,
        opts.env,
        opts.output,
        'assertTrue',
        getConductorObj(driver, opts.output)
      );
      const result = opts.output['__assertTrue'];
      delete opts.output['__assertTrue'];
      if (!result) throw new Error(`assertTrue failed: ${expr}`);
      break;
    }

    case 'assertFalse': {
      // Evaluate a JS expression; throw if truthy
      // Accepts string expression or { condition: "expr" }
      const expr = typeof val === 'string' ? val : (val as { condition: string }).condition;
      await executeScript(
        `output.__assertFalse = !(${expr});`,
        opts.env,
        opts.output,
        'assertFalse',
        getConductorObj(driver, opts.output)
      );
      const result = opts.output['__assertFalse'];
      delete opts.output['__assertFalse'];
      if (!result) throw new Error(`assertFalse failed: ${expr}`);
      break;
    }

    case 'extendedWaitUntil': {
      const v = val as {
        visible?: FlowSelector;
        notVisible?: FlowSelector;
        timeout?: number;
      };
      const timeoutMs = v.timeout ?? 30000;
      const sub = '  '.repeat(opts.depth + 2);

      if (v.visible !== undefined) {
        const condLabel = selectorLabel(v.visible);
        process.stdout.write(`${sub}→ visible ${condLabel} ... `);
        try {
          await waitForElement(driver, v.visible, timeoutMs, appIds, opts);
          console.log('ok');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`FAILED\n${sub}  ${msg}`);
          throw err;
        }
      } else if (v.notVisible !== undefined) {
        const condLabel = selectorLabel(v.notVisible);
        process.stdout.write(`${sub}→ notVisible ${condLabel} ... `);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const el = await findElementNoThrow(driver, v.notVisible, 1000, appIds, opts);
          if (el === null) {
            console.log('ok');
            return;
          }
          await sleep(500);
        }
        const msg = `element still visible after ${timeoutMs}ms`;
        console.log(`FAILED\n${sub}  ${msg}`);
        throw new Error(`extendedWaitUntil.notVisible: ${msg}`);
      }
      break;
    }

    case 'copyTextFrom': {
      const el = await waitForElement(driver, val as FlowSelector, undefined, appIds, opts);
      const copiedText = el.text ?? '';
      opts.output['textContent'] = copiedText;
      opts.output['__copiedText'] = copiedText;
      break;
    }

    // ── App lifecycle ──────────────────────────────────────────────────────
    case 'launchApp': {
      let appId: string;
      let clearStateFlag = false;
      let clearKeychainFlag = false;
      let stopAppFlag = true;
      let permissions: Record<string, string> | undefined;
      let launchArgs: Record<string, string> | undefined;

      if (val == null || val === '') {
        appId =
          opts.appId ??
          (() => {
            throw new Error('launchApp: no appId in command or flow header');
          })();
      } else if (typeof val === 'string') {
        appId = val;
      } else {
        const v = val as {
          appId?: string;
          clearState?: boolean;
          clearKeychain?: boolean;
          permissions?: Record<string, string>;
          arguments?: Record<string, string>;
          stopApp?: boolean;
        };
        appId =
          v.appId ??
          opts.appId ??
          (() => {
            throw new Error('launchApp: no appId in command or flow header');
          })();
        clearStateFlag = v.clearState ?? false;
        clearKeychainFlag = v.clearKeychain ?? false;
        permissions = v.permissions;
        launchArgs = v.arguments;
        stopAppFlag = v.stopApp ?? true;
      }

      if (clearKeychainFlag) await driver.clearKeychain();
      if (clearStateFlag) await driver.clearAppState(appId);
      if (permissions) await driver.setPermissions(appId, permissions);
      if (stopAppFlag) {
        if (driver instanceof IOSDriver) await driver.terminateApp(appId);
        else if (driver instanceof AndroidDriver) await driver.stopApp(appId);
      }
      await driver.launchApp(appId, launchArgs);
      if (driver instanceof IOSDriver && permissions) {
        // Determine allow vs deny from the permissions map.
        // `all` is the canonical key; fall back to majority vote across explicit keys.
        const allValue = permissions['all'];
        let shouldAllow: boolean;
        if (allValue !== undefined) {
          shouldAllow = allValue === 'allow';
        } else {
          const vals = Object.values(permissions);
          shouldAllow =
            vals.filter((v) => v === 'allow').length >= vals.filter((v) => v === 'deny').length;
        }
        // Store in shared output so all subsequent hierarchy polls across flow boundaries
        // will also dismiss permission dialogs (dialogs can appear during metro loading etc.)
        opts.output[OUTPUT_IOS_SHOULD_ALLOW] = shouldAllow;
        // Also eagerly dismiss any dialogs that appeared immediately after launch
        await dismissIOSPermissionDialogs(driver, shouldAllow, appIds ?? []);
      }
      break;
    }

    case 'stopApp': {
      const appId =
        val == null || val === ''
          ? (opts.appId ??
            (() => {
              throw new Error('stopApp: no appId in command or flow header');
            })())
          : resolveAppId(val, 'stopApp');
      if (driver instanceof IOSDriver) {
        await driver.terminateApp(appId);
      } else {
        await driver.stopApp(appId);
      }
      break;
    }

    case 'killApp': {
      const appId =
        val == null || val === ''
          ? (opts.appId ??
            (() => {
              throw new Error('killApp: no appId in command or flow header');
            })())
          : resolveAppId(val, 'killApp');
      if (driver instanceof IOSDriver) {
        await driver.terminateApp(appId);
      } else {
        await (driver as AndroidDriver).stopApp(appId);
      }
      break;
    }

    case 'clearState': {
      const appId =
        val == null || val === ''
          ? (opts.appId ??
            (() => {
              throw new Error('clearState: no appId in command or flow header');
            })())
          : resolveAppId(val, 'clearState');
      await driver.clearAppState(appId);
      break;
    }

    case 'clearKeychain': {
      await driver.clearKeychain();
      break;
    }

    // ── Keys ───────────────────────────────────────────────────────────────
    case 'pressKey': {
      const keyName = (val as string).toUpperCase();
      if (driver instanceof IOSDriver) {
        // Home and Lock are hardware buttons on iOS, not software keys
        if (keyName === 'HOME') {
          await driver.pressButton('home');
        } else if (keyName === 'LOCK' || keyName === 'POWER') {
          await driver.pressButton('lock');
        } else {
          await driver.pressKey(mapIosKey(keyName));
        }
      } else {
        const keycode = ANDROID_KEYCODES[keyName];
        if (keycode === undefined) throw new Error(`pressKey: unknown key "${val}"`);
        await driver.pressKeyEvent(keycode);
      }
      break;
    }

    case 'hideKeyboard': {
      if (driver instanceof IOSDriver) {
        await driver.pressKey('return').catch(() => {
          /* noop if no keyboard */
        });
      } else {
        await driver.pressKeyEvent(111); // KEYCODE_ESCAPE
      }
      break;
    }

    case 'pasteText': {
      const clip = (opts.output['__clipboard'] as string) ?? '';
      if (clip) {
        await driver.inputText(clip);
      } else if (driver instanceof AndroidDriver) {
        await (driver as AndroidDriver).pressKeyEvent(279); // KEYCODE_PASTE
      }
      // iOS without stored clipboard: no-op (best effort)
      break;
    }

    case 'setClipboard': {
      // Store for use by pasteText within this flow
      opts.output['__clipboard'] = val as string;
      break;
    }

    // ── Device state ───────────────────────────────────────────────────────
    case 'setLocation': {
      const v = val as { latitude: number; longitude: number };
      await driver.setLocation(v.latitude, v.longitude);
      break;
    }

    case 'setOrientation': {
      await driver.setOrientation(val as string);
      break;
    }

    case 'setPermissions': {
      const v = val as
        | { appId?: string; permissions: Record<string, string> }
        | Record<string, string>;
      // Support both { permissions: {...} } and flat { camera: allow } forms
      let appId: string;
      let permissions: Record<string, string>;
      if (
        v &&
        typeof v === 'object' &&
        'permissions' in v &&
        typeof (v as { permissions?: unknown }).permissions === 'object'
      ) {
        const vv = v as { appId?: string; permissions: Record<string, string> };
        appId = vv.appId ?? opts.appId ?? '';
        permissions = vv.permissions;
      } else {
        appId = opts.appId ?? '';
        permissions = v as Record<string, string>;
      }
      await driver.setPermissions(appId, permissions);
      break;
    }

    case 'addMedia': {
      // Accepts string, { path: "..." }, or { files: [...] }
      const files: string[] =
        typeof val === 'string'
          ? [val]
          : Array.isArray((val as { files?: string[] }).files)
            ? (val as { files: string[] }).files
            : [(val as { path: string }).path];
      for (const f of files) await driver.addMedia(resolvePath(f, opts.cwd));
      break;
    }

    case 'setAirplaneMode': {
      // Accepts boolean, string, or { value: bool }
      const raw = val && typeof val === 'object' ? (val as { value: boolean }).value : val;
      const enabled = raw === true || raw === 'enable' || raw === 'enabled';
      await driver.setAirplaneMode(enabled);
      break;
    }

    case 'toggleAirplaneMode': {
      if (driver instanceof AndroidDriver) {
        const current = await driver.getAirplaneMode();
        await driver.setAirplaneMode(!current);
      } else {
        throw new Error('toggleAirplaneMode is not supported on iOS simulators');
      }
      break;
    }

    case 'travel': {
      // points can be objects { latitude, longitude } or "lat,lon" strings (Conductor format)
      const rawTravel = val as {
        points: Array<{ latitude: number; longitude: number } | string>;
        speed?: number; // m/s, used to calculate delay between points
      };
      const v = {
        speed: rawTravel.speed,
        points: rawTravel.points.map((p) => {
          if (typeof p === 'string') {
            const [lat, lon] = p.split(',').map(Number);
            return { latitude: lat, longitude: lon };
          }
          return p;
        }),
      };
      const EARTH_RADIUS = 6371000; // meters
      for (let i = 0; i < v.points.length; i++) {
        const pt = v.points[i];
        await driver.setLocation(pt.latitude, pt.longitude);
        if (i < v.points.length - 1 && v.speed && v.speed > 0) {
          const next = v.points[i + 1];
          // Haversine approximate distance
          const dLat = ((next.latitude - pt.latitude) * Math.PI) / 180;
          const dLon = ((next.longitude - pt.longitude) * Math.PI) / 180;
          const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos((pt.latitude * Math.PI) / 180) *
              Math.cos((next.latitude * Math.PI) / 180) *
              Math.sin(dLon / 2) ** 2;
          const distM = 2 * EARTH_RADIUS * Math.asin(Math.sqrt(a));
          const delayMs = Math.round((distM / v.speed) * 1000);
          await sleep(Math.min(delayMs, 10000)); // cap at 10s per step
        }
      }
      break;
    }

    case 'startRecording': {
      const outPath =
        typeof val === 'string'
          ? val
          : ((val as { path?: string } | null)?.path ?? `recording-${Date.now()}.mp4`);
      await driver.startRecording(resolvePath(outPath, opts.cwd));
      break;
    }

    case 'stopRecording': {
      await driver.stopRecording();
      break;
    }

    // ── Screenshot ─────────────────────────────────────────────────────────
    case 'takeScreenshot': {
      const outPath =
        typeof val === 'string'
          ? val
          : ((val as { path?: string } | null)?.path ?? `screenshot-${Date.now()}.png`);
      const buf = await driver.screenshot();
      await fs.writeFile(outPath, buf);
      break;
    }

    // ── Flow control ───────────────────────────────────────────────────────
    case 'runFlow': {
      const childDepth = opts.depth + 1;
      if (typeof val === 'string') {
        const resolved = resolvePath(val, opts.cwd);
        const sub = await parseFlowFile(resolved, opts.cliEnv);
        await executeFlow(sub, driver, {
          cwd: path.dirname(resolved),
          env: opts.cliEnv,
          output: opts.output,
          depth: childDepth,
          benchmark: opts.benchmark,
        });
      } else {
        const v = val as {
          file?: string;
          when?: Record<string, unknown>;
          env?: Record<string, string>;
          commands?: FlowCommand[];
        };
        if (v.when && !(await evaluateWhen(v.when, driver, opts))) break;
        if (v.commands) {
          await executeCommands(v.commands, driver, { ...opts, depth: childDepth });
        } else if (v.file) {
          const resolved = resolvePath(v.file, opts.cwd);
          // Merge: CLI env < inline env block from runFlow (already resolveDeep'd)
          const childEnv = { ...opts.cliEnv, ...(v.env ?? {}) };
          const sub = await parseFlowFile(resolved, childEnv);
          await executeFlow(sub, driver, {
            cwd: path.dirname(resolved),
            env: childEnv,
            output: opts.output,
            depth: childDepth,
            benchmark: opts.benchmark,
          });
        }
      }
      break;
    }

    case 'waitForAnimationToEnd': {
      // Optional timeout (ms); falls back to waitForSettle's own 3s budget
      const wfaTimeout =
        val && typeof val === 'object' ? (val as { timeout?: number }).timeout : undefined;
      if (driver instanceof IOSDriver) {
        await waitForIOSHierarchyToSettle(
          () => driver.viewHierarchy().then((h) => h.axElement),
          wfaTimeout
        );
      } else {
        await waitForAndroidHierarchyToSettle(
          () => (driver as AndroidDriver).viewHierarchy(),
          wfaTimeout
        );
      }
      break;
    }

    case 'scrollUntilVisible': {
      const r = val as { element: FlowSelector; direction?: string; timeout?: number };
      const timeoutMs = r.timeout ?? 30000;
      const direction = r.direction ?? 'DOWN';
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const el = await findElementNoThrow(driver, r.element, 1000, appIds, opts);
        if (el !== null) return;
        await performSwipe(driver, direction);
      }
      throw new Error(`scrollUntilVisible: element not found after ${timeoutMs}ms`);
    }

    case 'repeat': {
      const r = val as {
        times?: number;
        while?: { notVisible?: FlowSelector; visible?: FlowSelector; true?: string };
        commands: FlowCommand[];
      };
      const maxTimes = r.times ?? (r.while ? Infinity : 1);
      for (let i = 0; i < maxTimes; i++) {
        if (r.while) {
          const w = r.while;
          if (w.notVisible !== undefined) {
            const el = await findElementNoThrow(driver, w.notVisible, 1000, appIds, opts);
            if (el !== null) break; // element appeared → condition false → stop
          } else if (w.visible !== undefined) {
            const el = await findElementNoThrow(driver, w.visible, 1000, appIds, opts);
            if (el === null) break; // element gone → condition false → stop
          } else if (w.true !== undefined) {
            const expr = w.true;
            await executeScript(
              `output.__repeatCond = !!(${expr});`,
              opts.env,
              opts.output,
              'repeat.while',
              getConductorObj(driver, opts.output)
            );
            const cond = opts.output['__repeatCond'];
            delete opts.output['__repeatCond'];
            if (!cond) break;
          }
        }
        await executeCommands(r.commands, driver, { ...opts, depth: opts.depth + 1 });
      }
      break;
    }

    case 'retry': {
      const r = val as { maxRetries: number; commands: FlowCommand[] };
      let lastErr: unknown;
      for (let attempt = 0; attempt <= r.maxRetries; attempt++) {
        try {
          await executeCommands(r.commands, driver, { ...opts, depth: opts.depth + 1 });
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (lastErr !== undefined) throw lastErr;
      break;
    }

    // ── Scripting ──────────────────────────────────────────────────────────
    case 'runScript': {
      const { file, env: scriptEnv } =
        typeof val === 'string'
          ? { file: val as string, env: undefined }
          : (val as { file: string; env?: Record<string, string> });
      const scriptPath = resolvePath(file, opts.cwd);
      const script = await fs.readFile(scriptPath, 'utf-8');
      // Script env: flow env merged with command-level env overrides
      const mergedEnv = { ...opts.env, ...(scriptEnv ?? {}) };
      await executeScript(
        script,
        mergedEnv,
        opts.output,
        scriptPath,
        getConductorObj(driver, opts.output)
      );
      break;
    }

    case 'evalScript': {
      // Accepts inline string or { script: "..." }
      const script = typeof val === 'string' ? val : (val as { script: string }).script;
      await executeScript(
        script,
        opts.env,
        opts.output,
        'evalScript',
        getConductorObj(driver, opts.output)
      );
      break;
    }

    default:
      throw new Error(`Unknown flow command: "${key}"`);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function resolvePath(filePath: string, cwd?: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(cwd ?? process.cwd(), filePath);
}

function resolveAppId(val: unknown, cmdName: string): string {
  if (typeof val === 'string' && val) return val;
  if (val && typeof val === 'object') {
    const appId = (val as { appId?: string }).appId;
    if (appId) return appId;
  }
  throw new Error(`${cmdName}: no appId specified`);
}

function mapIosKey(key: string): 'delete' | 'return' | 'enter' | 'tab' | 'space' {
  switch (key) {
    case 'DELETE':
    case 'BACKSPACE':
      return 'delete';
    case 'RETURN':
    case 'ENTER':
      return 'return';
    case 'TAB':
      return 'tab';
    case 'SPACE':
      return 'space';
    default:
      // Best-effort cast; the driver will reject unknown keys at runtime
      return key.toLowerCase() as 'delete' | 'return' | 'enter' | 'tab' | 'space';
  }
}
