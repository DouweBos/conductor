export const HELP = `  focused [--poll [interval_ms]]       Print metadata of the currently focused element
                                       --poll continuously watches for focus changes (default 500ms)`;

import { getDriver } from '../runner.js';
import { printError, OutputOptions } from '../output.js';
import { IOSDriver, AXElement } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { WebDriver, WebElement } from '../drivers/web.js';
import { parseAndroidHierarchy } from '../drivers/element-resolver.js';

// XCUIElementType rawValue → human-readable name.
// Source: XCUIElementType enum in XCTest framework.
const IOS_ELEMENT_TYPE_NAMES: Record<number, string> = {
  0: 'Any',
  1: 'Other',
  2: 'Application',
  3: 'Group',
  4: 'Window',
  5: 'Sheet',
  6: 'Drawer',
  7: 'Alert',
  8: 'Dialog',
  9: 'Button',
  10: 'RadioButton',
  11: 'RadioGroup',
  12: 'CheckBox',
  13: 'DisclosureTriangle',
  14: 'PopUpButton',
  15: 'ComboBox',
  16: 'MenuButton',
  17: 'ToolbarButton',
  18: 'Popover',
  19: 'Keyboard',
  20: 'Key',
  21: 'NavigationBar',
  22: 'TabBar',
  23: 'TabGroup',
  24: 'Toolbar',
  25: 'StatusBar',
  26: 'Table',
  27: 'TableRow',
  28: 'TableColumn',
  29: 'Outline',
  30: 'OutlineRow',
  31: 'Browser',
  32: 'CollectionView',
  33: 'Slider',
  34: 'PageIndicator',
  35: 'ProgressIndicator',
  36: 'ActivityIndicator',
  37: 'SegmentedControl',
  38: 'Picker',
  39: 'PickerWheel',
  40: 'Switch',
  41: 'Toggle',
  42: 'Link',
  43: 'Image',
  44: 'Icon',
  45: 'SearchField',
  46: 'ScrollView',
  47: 'ScrollBar',
  48: 'StaticText',
  49: 'TextField',
  50: 'SecureTextField',
  51: 'DatePicker',
  52: 'TextView',
  53: 'Menu',
  54: 'MenuItem',
  55: 'MenuBar',
  56: 'MenuBarItem',
  57: 'Map',
  58: 'WebView',
  59: 'IncrementArrow',
  60: 'DecrementArrow',
  61: 'Timeline',
  62: 'RatingIndicator',
  63: 'ValueIndicator',
  64: 'SplitGroup',
  65: 'Splitter',
  66: 'RelevanceIndicator',
  67: 'ColorWell',
  68: 'HelpTag',
  69: 'Matte',
  70: 'DockItem',
  71: 'Ruler',
  72: 'RulerMarker',
  73: 'Grid',
  74: 'LevelIndicator',
  75: 'Cell',
  76: 'LayoutArea',
  77: 'LayoutItem',
  78: 'Handle',
  79: 'Stepper',
  80: 'Tab',
  81: 'TouchBar',
  82: 'StatusItem',
};

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
    elementTypeName: IOS_ELEMENT_TYPE_NAMES[node.elementType] ?? `Unknown(${node.elementType})`,
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
  className: string;
  packageName: string;
  bounds: { x1: number; y1: number; x2: number; y2: number };
  clickable: boolean;
  enabled: boolean;
  checked: boolean;
  focused: boolean;
  focusable: boolean;
  selected: boolean;
  checkable: boolean;
  longClickable: boolean;
  scrollable: boolean;
  password: boolean;
  visibleToUser: boolean;
  hintText: string;
  error: string;
}): Record<string, unknown> {
  const { x1, y1, x2, y2 } = node.bounds;
  return {
    text: node.text,
    resourceId: node.resourceId,
    contentDesc: node.contentDesc,
    className: node.className,
    packageName: node.packageName,
    hintText: node.hintText || null,
    error: node.error || null,
    clickable: node.clickable,
    enabled: node.enabled,
    checked: node.checked,
    focused: node.focused,
    focusable: node.focusable,
    selected: node.selected,
    checkable: node.checkable,
    longClickable: node.longClickable,
    scrollable: node.scrollable,
    password: node.password,
    visibleToUser: node.visibleToUser,
    bounds: { x1, y1, x2, y2 },
    center: {
      x: Math.round((x1 + x2) / 2),
      y: Math.round((y1 + y2) / 2),
    },
  };
}

function findFocusedWeb(elements: WebElement[]): WebElement | null {
  for (const el of elements) {
    if (el.children) {
      const found = findFocusedWeb(el.children);
      if (found) return found;
    }
    if (el.focused) return el;
  }
  return null;
}

function formatWebElement(node: WebElement): Record<string, unknown> {
  const b = node.bounds;
  return {
    text: node.name || '',
    ref: node.ref || '',
    role: node.role,
    enabled: node.enabled,
    focused: node.focused,
    checked: node.checked ?? null,
    selected: node.selected ?? null,
    bounds: b
      ? {
          x: Math.round(b.x),
          y: Math.round(b.y),
          width: Math.round(b.width),
          height: Math.round(b.height),
        }
      : null,
    center: b ? { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } : null,
  };
}

async function queryFocused(
  driver: IOSDriver | AndroidDriver | WebDriver
): Promise<Record<string, unknown> | null> {
  if (driver instanceof IOSDriver) {
    const hierarchy = await driver.viewHierarchy(false);
    const node = findFocusedIOS(hierarchy.axElement);
    return node ? formatIOSElement(node) : null;
  } else if (driver instanceof WebDriver) {
    const hierarchy = await driver.viewHierarchy();
    const node = findFocusedWeb(hierarchy.elements);
    return node ? formatWebElement(node) : null;
  } else if (driver instanceof AndroidDriver) {
    const xml = await driver.viewHierarchy();
    const nodes = parseAndroidHierarchy(xml);
    const node = nodes.find((n) => n.focused);
    return node ? formatAndroidNode(node) : null;
  }
  throw new Error('Unknown driver type');
}

export interface FocusedOptions {
  poll?: boolean;
  interval?: number;
}

export async function focused(
  opts: OutputOptions = {},
  sessionName = 'default',
  { poll = false, interval = 500 }: FocusedOptions = {}
): Promise<number> {
  try {
    const driver = await getDriver(sessionName);

    if (!poll) {
      const data = await queryFocused(driver);

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
    }

    // --poll mode: repeatedly query and log on change
    let lastJson = '';

    const onSignal = () => process.exit(0);
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    while (true) {
      const data = await queryFocused(driver);
      const currentJson = JSON.stringify(data);

      if (currentJson !== lastJson) {
        lastJson = currentJson;
        if (!data) {
          if (opts.json) {
            console.log(JSON.stringify({ status: 'ok', focused: null }));
          } else {
            console.log('No element is currently focused');
          }
        } else if (opts.json) {
          console.log(JSON.stringify({ status: 'ok', focused: data }));
        } else {
          console.log(JSON.stringify(data, null, 2));
        }
      }

      await new Promise((r) => setTimeout(r, interval));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printError(`focused — failed\n${msg}`, opts);
    return 1;
  }
}
