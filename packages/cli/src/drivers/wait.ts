/**
 * Retry-until-element-appears helper.
 * Polls the view hierarchy until an element matching the selector is found,
 * or times out with a descriptive error.
 */
import { AXElement } from './ios.js';
import {
  ElementSelector,
  ResolvedElement,
  findIOSElement,
  findAndroidElement,
} from './element-resolver.js';
import { sleep } from '../utils.js';

const DEFAULT_TIMEOUT_MS = 17000;
const DEFAULT_INTERVAL_MS = 500;

export const OPTIONAL_TIMEOUT_MS = 7000;

export async function waitForIOSElement(
  getHierarchy: () => Promise<AXElement>,
  selector: ElementSelector,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS
): Promise<ResolvedElement> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const root = await getHierarchy();
      const el = findIOSElement(root, selector);
      if (el) return el;
    } catch {
      // Hierarchy fetch failed; keep retrying
    }
    await sleep(intervalMs);
  }

  const desc = selectorDesc(selector);
  throw new Error(`Element not found after ${timeoutMs}ms: ${desc}`);
}

export async function waitForAndroidElement(
  getHierarchy: () => Promise<string>,
  selector: ElementSelector,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS
): Promise<ResolvedElement> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const xml = await getHierarchy();
      const el = findAndroidElement(xml, selector);
      if (el) return el;
    } catch {
      // Hierarchy fetch failed; keep retrying
    }
    await sleep(intervalMs);
  }

  const desc = selectorDesc(selector);
  throw new Error(`Element not found after ${timeoutMs}ms: ${desc}`);
}

/**
 * Wait until an iOS element is gone from the hierarchy.
 * Fast path: if element is absent on the first check, resolves immediately.
 * Otherwise polls every 500 ms until absent or outer timeout (default 7 s) expires.
 */
export async function waitUntilIOSElementGone(
  getHierarchy: () => Promise<AXElement>,
  selector: ElementSelector,
  timeoutMs = OPTIONAL_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const root = await getHierarchy();
      if (!findIOSElement(root, selector)) return; // fast path or gone
    } catch {
      return; // hierarchy fetch failed — treat as gone
    }
    await sleep(DEFAULT_INTERVAL_MS);
  } while (Date.now() < deadline);

  const desc = selectorDesc(selector);
  throw new Error(`Element still visible after ${timeoutMs}ms: ${desc}`);
}

/**
 * Wait until an Android element is gone from the hierarchy.
 * Fast path: if element is absent on the first check, resolves immediately.
 * Otherwise polls every 500 ms until absent or outer timeout (default 7 s) expires.
 */
export async function waitUntilAndroidElementGone(
  getHierarchy: () => Promise<string>,
  selector: ElementSelector,
  timeoutMs = OPTIONAL_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const xml = await getHierarchy();
      if (!findAndroidElement(xml, selector)) return; // fast path or gone
    } catch {
      return; // hierarchy fetch failed — treat as gone
    }
    await sleep(DEFAULT_INTERVAL_MS);
  } while (Date.now() < deadline);

  const desc = selectorDesc(selector);
  throw new Error(`Element still visible after ${timeoutMs}ms: ${desc}`);
}

/**
 * Wait until the iOS screen is visually static, mirroring Maestro's `waitUntilScreenIsStatic`.
 * Calls the XCTest runner's /isScreenStatic endpoint, which takes two back-to-back screenshots
 * and returns true when their SHA256 hashes match. Retries until stable or timeout.
 * Times out silently — the next command's waitForElement will handle any remaining delay.
 */
export async function waitForIOSScreenToSettle(
  isScreenStatic: () => Promise<boolean>,
  timeoutMs = 3000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      if (await isScreenStatic()) return;
    } catch {
      // request failed — keep retrying
    }
  } while (Date.now() < deadline);
  // Timed out — proceed anyway
}

/**
 * Two-phase settle for any action that triggers a screen transition.
 *
 * A plain `waitForIOSScreenToSettle` can return false-positive immediately if
 * called before the transition animation has started.
 *
 * Phase 1 — wait for transition to START (screen becomes non-static), up to `changeTimeoutMs`.
 *   If the screen never moves, the action completed without animation; proceed immediately.
 * Phase 2 — wait for transition to FINISH (screen becomes static again), up to `settleTimeoutMs`.
 */
export async function waitForIOSTransitionToSettle(
  isScreenStatic: () => Promise<boolean>,
  changeTimeoutMs = 1500,
  settleTimeoutMs = 3000
): Promise<void> {
  // Phase 1: wait until screen starts changing
  const changeDeadline = Date.now() + changeTimeoutMs;
  let navigationStarted = false;
  do {
    try {
      if (!(await isScreenStatic())) {
        navigationStarted = true;
        break;
      }
    } catch {
      // request failed — keep retrying
    }
  } while (Date.now() < changeDeadline);

  if (!navigationStarted) return; // link opened without visible navigation animation

  // Phase 2: wait until screen stops changing
  await waitForIOSScreenToSettle(isScreenStatic, settleTimeoutMs);
}

/**
 * Wait until the iOS view hierarchy stops changing between consecutive polls.
 * Mirrors Maestro's `waitForAppToSettle` / `waitUntilScreenIsStatic` logic.
 * Times out silently so the next command (which retries on its own) can proceed.
 */
export async function waitForIOSHierarchyToSettle(
  getHierarchy: () => Promise<AXElement>,
  timeoutMs = 3000,
  intervalMs = 200
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let prev: string | null = null;

  while (Date.now() < deadline) {
    try {
      const root = await getHierarchy();
      const curr = JSON.stringify(root);
      if (curr === prev) return; // stable
      prev = curr;
    } catch {
      // hierarchy fetch failed — keep waiting
    }
    await sleep(intervalMs);
  }
  // Timed out — proceed anyway; the next assertVisible will retry
}

/**
 * Wait until the Android view hierarchy XML stops changing between consecutive polls.
 */
export async function waitForAndroidHierarchyToSettle(
  getHierarchy: () => Promise<string>,
  timeoutMs = 3000,
  intervalMs = 200
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let prev: string | null = null;

  while (Date.now() < deadline) {
    try {
      const xml = await getHierarchy();
      if (xml === prev) return; // stable
      prev = xml;
    } catch {
      // ignore
    }
    await sleep(intervalMs);
  }
}

function selectorDesc(sel: ElementSelector): string {
  const parts: string[] = [];
  if (sel.query) parts.push(`query="${sel.query}"`);
  if (sel.text) parts.push(`text="${sel.text}"`);
  if (sel.id) parts.push(`id="${sel.id}"`);
  if (sel.index !== undefined) parts.push(`index=${sel.index}`);
  if (sel.enabled !== undefined) parts.push(`enabled=${sel.enabled}`);
  if (sel.checked !== undefined) parts.push(`checked=${sel.checked}`);
  if (sel.focused !== undefined) parts.push(`focused=${sel.focused}`);
  if (sel.selected !== undefined) parts.push(`selected=${sel.selected}`);
  if (sel.below) parts.push(`below(${selectorDesc(sel.below)})`);
  if (sel.above) parts.push(`above(${selectorDesc(sel.above)})`);
  if (sel.leftOf) parts.push(`leftOf(${selectorDesc(sel.leftOf)})`);
  if (sel.rightOf) parts.push(`rightOf(${selectorDesc(sel.rightOf)})`);
  return parts.join(', ') || '(no selector)';
}
