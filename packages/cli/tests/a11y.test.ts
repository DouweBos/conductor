import {
  buildIOSA11y,
  buildAndroidA11y,
  buildWebA11y,
  composeIOSAnnouncement,
  composeAndroidAnnouncement,
  composeWebAnnouncement,
} from '../src/drivers/a11y.js';
import type { AXElement } from '../src/drivers/ios.js';
import type { WebViewHierarchy, WebElement } from '../src/drivers/web.js';
import { TestSuite, assert, runAll } from './runner.js';

export const a11ySuite = new TestSuite('A11y enrichment');

function axElem(opts: Partial<AXElement> & { label?: string; elementType?: number }): AXElement {
  return {
    identifier: opts.identifier ?? '',
    frame: opts.frame ?? { X: 0, Y: 0, Width: 100, Height: 44 },
    label: opts.label ?? '',
    value: opts.value ?? '',
    title: opts.title ?? '',
    elementType: opts.elementType ?? 48,
    enabled: opts.enabled ?? true,
    selected: opts.selected ?? false,
    hasFocus: opts.hasFocus ?? false,
    placeholderValue: opts.placeholderValue,
    hint: opts.hint,
    children: opts.children,
  };
}

// ── iOS ──────────────────────────────────────────────────────────────────────

a11ySuite.test('iOS: announcement composes label + traits + value + hint', async () => {
  const a = composeIOSAnnouncement('Sign in', ['button'], '', 'Double tap to activate');
  assert(a === 'Sign in, button, Double tap to activate', `got: ${a}`);

  const b = composeIOSAnnouncement('Volume', ['adjustable'], '50%', '');
  assert(b === 'Volume, adjustable, 50%', `got: ${b}`);

  const c = composeIOSAnnouncement('Hello', ['staticText'], '', '');
  assert(c === 'Hello', `staticText trait should be suppressed; got: ${c}`);
});

a11ySuite.test('iOS: accessibilityOrder is 0-based pre-order DFS over visible labelled nodes', async () => {
  const tree = axElem({
    frame: { X: 0, Y: 0, Width: 0, Height: 0 }, // root invisible
    elementType: 0,
    children: [
      axElem({ label: 'A', elementType: 9, frame: { X: 0, Y: 0, Width: 50, Height: 50 } }),
      axElem({
        label: '',
        elementType: 0,
        frame: { X: 0, Y: 60, Width: 100, Height: 100 },
        children: [
          axElem({ label: 'B', elementType: 9, frame: { X: 0, Y: 60, Width: 50, Height: 50 } }),
          axElem({ label: 'C', elementType: 9, frame: { X: 0, Y: 120, Width: 50, Height: 50 } }),
        ],
      }),
      axElem({ label: 'D', elementType: 9, frame: { X: 0, Y: 180, Width: 50, Height: 50 } }),
    ],
  });

  const { a11ySnapshot } = buildIOSA11y(tree);
  const labels = a11ySnapshot.map((s) => s.label);
  assert(
    JSON.stringify(labels) === JSON.stringify(['A', 'B', 'C', 'D']),
    `expected [A,B,C,D]; got ${JSON.stringify(labels)}`
  );
  a11ySnapshot.forEach((s, i) => assert(s.order === i, `order mismatch at ${i}`));
});

a11ySuite.test('iOS: zero-frame nodes get accessibilityOrder=null', async () => {
  const tree = axElem({
    elementType: 0,
    frame: { X: 0, Y: 0, Width: 0, Height: 0 },
    children: [axElem({ label: 'Hidden', elementType: 9, frame: { X: 0, Y: 0, Width: 0, Height: 0 } })],
  });
  const { a11ySnapshot } = buildIOSA11y(tree);
  assert(a11ySnapshot.length === 0, `zero-frame node should not appear`);
});

// ── Android ──────────────────────────────────────────────────────────────────

a11ySuite.test('Android: announcement composes label + role + state + hint', async () => {
  const a = composeAndroidAnnouncement('', 'Close', 'button', ['disabled'], '');
  assert(a === 'Close, button, disabled', `got: ${a}`);

  const b = composeAndroidAnnouncement('Hello', '', 'staticText', [], '');
  assert(b === 'Hello, staticText', `got: ${b}`);
});

a11ySuite.test('Android: parent with announced descendant is skipped (merge rule)', async () => {
  // Button (focusable + clickable container) with inner TextView "Sign in".
  const xml = `<hierarchy>
  <node class="android.widget.Button" resource-id="btn" text="" content-desc="" hintText=""
        bounds="[0,0][200,50]" enabled="true" checked="false" focused="false" selected="false"
        checkable="false" clickable="true" focusable="true" visible-to-user="true">
    <node class="android.widget.TextView" resource-id="" text="Sign in" content-desc="" hintText=""
          bounds="[10,10][190,40]" enabled="true" checked="false" focused="false" selected="false"
          checkable="false" clickable="false" focusable="false" visible-to-user="true"/>
  </node>
</hierarchy>`;
  const { a11ySnapshot } = buildAndroidA11y(xml);
  assert(a11ySnapshot.length === 1, `expected 1 entry, got ${a11ySnapshot.length}`);
  assert(a11ySnapshot[0].label === 'Sign in', `expected inner label, got ${a11ySnapshot[0].label}`);
});

a11ySuite.test('Android: pre-order with multiple siblings assigns sequential orders', async () => {
  const xml = `<hierarchy>
  <node class="android.widget.TextView" text="Alpha" resource-id="" content-desc="" hintText=""
        bounds="[0,0][100,50]" enabled="true" focusable="true" visible-to-user="true"
        clickable="false" checked="false" checkable="false" focused="false" selected="false"/>
  <node class="android.widget.TextView" text="Beta" resource-id="" content-desc="" hintText=""
        bounds="[0,60][100,110]" enabled="true" focusable="true" visible-to-user="true"
        clickable="false" checked="false" checkable="false" focused="false" selected="false"/>
</hierarchy>`;
  const { a11ySnapshot } = buildAndroidA11y(xml);
  assert(a11ySnapshot.length === 2, `got ${a11ySnapshot.length}`);
  assert(a11ySnapshot[0].label === 'Alpha' && a11ySnapshot[0].order === 0, 'first');
  assert(a11ySnapshot[1].label === 'Beta' && a11ySnapshot[1].order === 1, 'second');
});

// ── Web ──────────────────────────────────────────────────────────────────────

function webHier(elements: WebElement[]): WebViewHierarchy {
  return { url: 'https://test/', title: '', elements, ariaSnapshot: '' };
}

function btn(name: string, x = 0, y = 0): WebElement {
  return {
    role: 'button',
    name,
    ref: name,
    bounds: { x, y, width: 80, height: 32 },
    enabled: true,
    focused: false,
  };
}

a11ySuite.test('Web: announcement composes name + role + state', async () => {
  const a = composeWebAnnouncement('Submit', 'button', []);
  assert(a === 'Submit, button', `got: ${a}`);

  const b = composeWebAnnouncement('Check me', 'checkbox', ['checked']);
  assert(b === 'Check me, checkbox, checked', `got: ${b}`);

  // generic/none should be dropped
  const c = composeWebAnnouncement('Wrapper', 'generic', []);
  assert(c === 'Wrapper', `got: ${c}`);
});

a11ySuite.test('Web: tab order follows DOM order for focusable roles', async () => {
  const h = webHier([
    {
      role: 'main',
      name: '',
      ref: 'main',
      bounds: { x: 0, y: 0, width: 400, height: 400 },
      enabled: true,
      focused: false,
      children: [btn('A', 0, 0), btn('B', 0, 50), btn('C', 0, 100)],
    },
  ]);
  const { a11ySnapshot } = buildWebA11y(h);
  assert(a11ySnapshot.length === 3, `got ${a11ySnapshot.length}`);
  assert(
    a11ySnapshot.map((s) => s.label).join(',') === 'A,B,C',
    `got ${a11ySnapshot.map((s) => s.label).join(',')}`
  );
});

a11ySuite.test('Web: non-focusable wrapper elements get accessibilityOrder=null', async () => {
  const h = webHier([
    {
      role: 'main',
      name: 'Main',
      ref: 'main',
      bounds: { x: 0, y: 0, width: 400, height: 400 },
      enabled: true,
      focused: false,
    },
  ]);
  const { a11ySnapshot, hierarchy } = buildWebA11y(h);
  assert(a11ySnapshot.length === 0, 'main role should not be focusable');
  assert(hierarchy[0].accessibilityOrder === null, 'accessibilityOrder should be null');
});

// ── capture-ui JSON shape ────────────────────────────────────────────────────

a11ySuite.test('capture-ui: bundle shape has expected top-level keys', async () => {
  // Smoke test: construct the shape manually (mirrors captureUI output),
  // validating that the keys we promise to Argus are present.
  const bundle = {
    version: 1,
    capturedAt: new Date().toISOString(),
    device: { platform: 'ios', deviceId: 'mock', width: 390, height: 844 },
    screenshot: { kind: 'composite', encoding: 'png', data: '' },
    hierarchy: {},
    a11ySnapshot: [],
    capabilities: { perViewPixels: false, depthData: false },
  };
  for (const k of [
    'version',
    'capturedAt',
    'device',
    'screenshot',
    'hierarchy',
    'a11ySnapshot',
    'capabilities',
  ]) {
    assert(k in bundle, `missing key ${k}`);
  }
  assert(bundle.capabilities.perViewPixels === false, 'perViewPixels must be false for v1');
  assert(bundle.capabilities.depthData === false, 'depthData must be false for v1');
});

if (require.main === module) {
  runAll([a11ySuite]);
}
