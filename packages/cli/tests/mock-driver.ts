/**
 * In-memory mock drivers for unit-testing the flow runner.
 * Both extend the real driver classes so that `instanceof` checks in flow-runner.ts work correctly.
 */
import { IOSDriver, IOSViewHierarchy, AXElement } from '../src/drivers/ios.js';
import { AndroidDriver } from '../src/drivers/android.js';

export type Call = { method: string; args: unknown[] };

// ── iOS helpers ───────────────────────────────────────────────────────────────

export interface FakeIOSElement {
  label?: string;
  identifier?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export function makeIOSHierarchy(elements: FakeIOSElement[]): IOSViewHierarchy {
  const children: AXElement[] = elements.map(({ label = '', identifier = '', x = 50, y = 100, w = 100, h = 44 }) => ({
    identifier,
    frame: { X: x, Y: y, Width: w, Height: h },
    label,
    value: '',
    title: '',
    elementType: 48,
    enabled: true,
    selected: false,
    hasFocus: false,
    children: [],
  }));

  return {
    axElement: {
      identifier: 'Application',
      frame: { X: 0, Y: 0, Width: 0, Height: 0 }, // root has zero-size frame
      label: '',
      value: '',
      title: '',
      elementType: 0,
      enabled: true,
      selected: false,
      hasFocus: false,
      children,
    },
    depth: 0,
  };
}

// ── iOS mock ──────────────────────────────────────────────────────────────────

export class MockIOSDriver extends IOSDriver {
  calls: Call[] = [];
  failNextNTaps = 0;
  private _hierarchy: IOSViewHierarchy;

  constructor(hierarchy?: IOSViewHierarchy) {
    super(0); // port=0; all network methods are overridden
    this._hierarchy = hierarchy ?? makeIOSHierarchy([]);
  }

  setHierarchy(h: IOSViewHierarchy): void { this._hierarchy = h; }

  override isAlive(): Promise<boolean> { return Promise.resolve(true); }

  override deviceInfo() {
    return Promise.resolve({ widthPoints: 390, heightPoints: 844, widthPixels: 1179, heightPixels: 2556 });
  }

  override viewHierarchy(): Promise<IOSViewHierarchy> {
    return Promise.resolve(this._hierarchy);
  }

  override tap(x: number, y: number, duration?: number): Promise<void> {
    if (this.failNextNTaps > 0) {
      this.failNextNTaps--;
      return Promise.reject(new Error('Mock tap failure'));
    }
    this.calls.push({ method: 'tap', args: [x, y, duration] });
    return Promise.resolve();
  }

  override swipe(startX: number, startY: number, endX: number, endY: number, duration: number): Promise<void> {
    this.calls.push({ method: 'swipe', args: [startX, startY, endX, endY, duration] });
    return Promise.resolve();
  }

  override inputText(text: string): Promise<void> {
    this.calls.push({ method: 'inputText', args: [text] });
    return Promise.resolve();
  }

  override pressKey(key: 'delete' | 'return' | 'enter' | 'tab' | 'space'): Promise<void> {
    this.calls.push({ method: 'pressKey', args: [key] });
    return Promise.resolve();
  }

  override pressButton(button: 'home' | 'lock'): Promise<void> {
    this.calls.push({ method: 'pressButton', args: [button] });
    return Promise.resolve();
  }

  override launchApp(bundleId: string): Promise<void> {
    this.calls.push({ method: 'launchApp', args: [bundleId] });
    return Promise.resolve();
  }

  override terminateApp(appId: string): Promise<void> {
    this.calls.push({ method: 'terminateApp', args: [appId] });
    return Promise.resolve();
  }

  override screenshot(): Promise<Buffer> {
    this.calls.push({ method: 'screenshot', args: [] });
    return Promise.resolve(Buffer.alloc(0));
  }

  /** Return all calls to a specific method. */
  callsTo(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }
}

// ── Android helpers ───────────────────────────────────────────────────────────

export interface FakeAndroidElement {
  text?: string;
  id?: string;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

export function makeAndroidHierarchy(elements: FakeAndroidElement[]): string {
  const nodes = elements.map(({ text = '', id = '', x1 = 50, y1 = 100, x2 = 150, y2 = 144 }) =>
    `  <node text="${text}" resource-id="${id}" content-desc="" bounds="[${x1},${y1}][${x2},${y2}]" enabled="true"/>`,
  );
  return `<hierarchy>\n${nodes.join('\n')}\n</hierarchy>`;
}

export function makeAndroidHierarchyWithAttrs(
  elements: Array<{
    text?: string;
    id?: string;
    contentDesc?: string;
    hintText?: string;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
    enabled?: boolean;
    checked?: boolean;
    focused?: boolean;
    selected?: boolean;
  }>
): string {
  const nodes = elements.map(
    ({
      text = '',
      id = '',
      contentDesc = '',
      hintText = '',
      x1 = 50,
      y1 = 100,
      x2 = 150,
      y2 = 144,
      enabled = true,
      checked = false,
      focused = false,
      selected = false,
    }) =>
      `  <node text="${text}" resource-id="${id}" content-desc="${contentDesc}" hintText="${hintText}" bounds="[${x1},${y1}][${x2},${y2}]" enabled="${enabled}" checked="${checked}" focused="${focused}" selected="${selected}"/>`
  );
  return `<hierarchy>\n${nodes.join('\n')}\n</hierarchy>`;
}

// ── Android mock ──────────────────────────────────────────────────────────────

export class MockAndroidDriver extends AndroidDriver {
  calls: Call[] = [];
  failNextNTaps = 0;
  private _hierarchy: string;

  constructor(hierarchy?: string) {
    super('mock-device', 0);
    this._hierarchy = hierarchy ?? makeAndroidHierarchy([]);
  }

  setHierarchy(h: string): void { this._hierarchy = h; }

  override connect(): Promise<void> { return Promise.resolve(); }
  override isAlive(): Promise<boolean> { return Promise.resolve(true); }

  override deviceInfo() {
    return Promise.resolve({ widthPixels: 1080, heightPixels: 1920 });
  }

  override viewHierarchy(): Promise<string> {
    return Promise.resolve(this._hierarchy);
  }

  override tap(x: number, y: number): Promise<void> {
    if (this.failNextNTaps > 0) {
      this.failNextNTaps--;
      return Promise.reject(new Error('Mock tap failure'));
    }
    this.calls.push({ method: 'tap', args: [x, y] });
    return Promise.resolve();
  }

  override swipe(startX: number, startY: number, endX: number, endY: number, durationMs: number): Promise<void> {
    this.calls.push({ method: 'swipe', args: [startX, startY, endX, endY, durationMs] });
    return Promise.resolve();
  }

  override inputText(text: string): Promise<void> {
    this.calls.push({ method: 'inputText', args: [text] });
    return Promise.resolve();
  }

  override eraseAllText(n: number): Promise<void> {
    this.calls.push({ method: 'eraseAllText', args: [n] });
    return Promise.resolve();
  }

  override launchApp(pkg: string): Promise<void> {
    this.calls.push({ method: 'launchApp', args: [pkg] });
    return Promise.resolve();
  }

  override stopApp(pkg: string): Promise<void> {
    this.calls.push({ method: 'stopApp', args: [pkg] });
    return Promise.resolve();
  }

  override back(): Promise<void> {
    this.calls.push({ method: 'back', args: [] });
    return Promise.resolve();
  }

  override pressKeyEvent(keycode: number): Promise<void> {
    this.calls.push({ method: 'pressKeyEvent', args: [keycode] });
    return Promise.resolve();
  }

  override screenshot(): Promise<Buffer> {
    this.calls.push({ method: 'screenshot', args: [] });
    return Promise.resolve(Buffer.alloc(0));
  }

  callsTo(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }
}
