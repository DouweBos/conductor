export const HELP = `  focused                             Print metadata of the currently focused element`;

import { getDriver } from '../runner.js';
import { printError, OutputOptions } from '../output.js';
import { IOSDriver, AXElement } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { parseAndroidHierarchy } from '../drivers/element-resolver.js';

/** DFS children-first so the deepest focused node wins (matches deepestMatchingIOSElements pattern). */
function findFocusedIOS(node: AXElement): AXElement | null {
  for (const child of node.children ?? []) {
    const found = findFocusedIOS(child);
    if (found) return found;
  }
  if (node.hasFocus) return node;
  return null;
}

function formatIOSElement(node: AXElement): Record<string, unknown> {
  const { X, Y, Width, Height } = node.frame;
  return {
    text: node.label || node.title || node.value || node.placeholderValue || '',
    identifier: node.identifier || '',
    label: node.label,
    title: node.title ?? null,
    value: node.value ?? null,
    placeholderValue: node.placeholderValue ?? null,
    elementType: node.elementType,
    enabled: node.enabled,
    selected: node.selected,
    hasFocus: node.hasFocus,
    bounds: {
      x: Math.round(X),
      y: Math.round(Y),
      width: Math.round(Width),
      height: Math.round(Height),
    },
    center: {
      x: Math.round(X + Width / 2),
      y: Math.round(Y + Height / 2),
    },
  };
}

function formatAndroidNode(node: {
  text: string;
  resourceId: string;
  contentDesc: string;
  bounds: { x1: number; y1: number; x2: number; y2: number };
  clickable: boolean;
  enabled: boolean;
  checked: boolean;
  focused: boolean;
  selected: boolean;
}): Record<string, unknown> {
  const { x1, y1, x2, y2 } = node.bounds;
  return {
    text: node.text,
    resourceId: node.resourceId,
    contentDesc: node.contentDesc,
    clickable: node.clickable,
    enabled: node.enabled,
    checked: node.checked,
    focused: node.focused,
    selected: node.selected,
    bounds: { x1, y1, x2, y2 },
    center: {
      x: Math.round((x1 + x2) / 2),
      y: Math.round((y1 + y2) / 2),
    },
  };
}

export async function focused(opts: OutputOptions = {}, sessionName = 'default'): Promise<number> {
  try {
    const driver = await getDriver(sessionName);
    let data: Record<string, unknown> | null = null;

    if (driver instanceof IOSDriver) {
      const hierarchy = await driver.viewHierarchy(false);
      const node = findFocusedIOS(hierarchy.axElement);
      if (node) data = formatIOSElement(node);
    } else if (driver instanceof AndroidDriver) {
      const xml = await driver.viewHierarchy();
      const nodes = parseAndroidHierarchy(xml);
      const node = nodes.find((n) => n.focused);
      if (node) data = formatAndroidNode(node);
    } else {
      throw new Error('Unknown driver type');
    }

    if (!data) {
      if (opts.json) {
        console.log(JSON.stringify({ status: 'ok', focused: null }));
      } else {
        console.log('No element is currently focused');
      }
      return 0;
    }

    if (opts.json) {
      console.log(JSON.stringify({ status: 'ok', focused: data }));
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printError(`focused — failed\n${msg}`, opts);
    return 1;
  }
}
