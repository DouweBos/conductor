import {
  findIOSElement,
  findAndroidElement,
  findWebElement,
} from '../src/drivers/element-resolver.js';
import type { AXElement } from '../src/drivers/ios.js';
import type { WebElement, WebViewHierarchy } from '../src/drivers/web.js';
import { TestSuite, assert, runAll } from './runner.js';
import { makeAndroidHierarchyWithAttrs } from './mock-driver.js';

export const elementResolver = new TestSuite('Element Resolver');

function makeRootAX(children: AXElement[]): AXElement {
  return {
    identifier: 'root',
    frame: { X: 0, Y: 0, Width: 0, Height: 0 },
    label: '',
    value: '',
    title: '',
    elementType: 0,
    enabled: true,
    selected: false,
    hasFocus: false,
    children,
  };
}

function makeWebHierarchy(elements: WebElement[]): WebViewHierarchy {
  return {
    url: 'https://test.invalid/',
    title: 'Test',
    elements,
    ariaSnapshot: '',
  };
}

function webEl(
  role: string,
  name: string,
  ref: string,
  bounds: { x: number; y: number; width: number; height: number } = {
    x: 0,
    y: 0,
    width: 80,
    height: 32,
  }
): WebElement {
  return {
    role,
    name,
    ref,
    bounds,
    enabled: true,
    focused: false,
  };
}

function makeAXElem(opts: {
  label: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  enabled?: boolean;
  selected?: boolean;
  hasFocus?: boolean;
}): AXElement {
  return {
    identifier: '',
    frame: { X: opts.x ?? 0, Y: opts.y ?? 0, Width: opts.w ?? 100, Height: opts.h ?? 44 },
    label: opts.label,
    value: '',
    title: '',
    elementType: 48,
    enabled: opts.enabled ?? true,
    selected: opts.selected ?? false,
    hasFocus: opts.hasFocus ?? false,
    children: [],
  };
}

// ── State selectors — iOS ─────────────────────────────────────────────────────

elementResolver.test('iOS: enabled: false skips enabled elements', async () => {
  const root = makeRootAX([
    makeAXElem({ label: 'Btn', y: 0, enabled: true }),
    makeAXElem({ label: 'Disabled', y: 50, enabled: false }),
  ]);
  const result = findIOSElement(root, { text: 'Disabled', enabled: false });
  assert(result !== null, 'should find the disabled element');
  assert(result!.centerY > 50, 'should resolve to the disabled element (lower on screen)');
});

elementResolver.test('iOS: enabled: true skips disabled elements', async () => {
  const root = makeRootAX([makeAXElem({ label: 'Btn', y: 0, enabled: false })]);
  const result = findIOSElement(root, { text: 'Btn', enabled: true });
  assert(result === null, 'should not find a disabled element when enabled: true is required');
});

elementResolver.test('iOS: selected: true finds selected element', async () => {
  const root = makeRootAX([
    makeAXElem({ label: 'Tab', x: 0, y: 0, selected: false }),
    makeAXElem({ label: 'Tab', x: 100, y: 0, selected: true }),
  ]);
  const result = findIOSElement(root, { text: 'Tab', selected: true });
  assert(result !== null, 'should find the selected tab');
  assert(result!.centerX > 100, 'should find the second Tab (selected one, at x=100)');
});

// ── Relative position selectors — iOS ────────────────────────────────────────

elementResolver.test('iOS: below finds element below reference', async () => {
  const root = makeRootAX([
    makeAXElem({ label: 'Label', x: 0, y: 0, w: 200, h: 44 }),
    makeAXElem({ label: 'Input', x: 0, y: 60, w: 200, h: 44 }),
  ]);
  const result = findIOSElement(root, { text: 'Input', below: { text: 'Label' } });
  assert(result !== null, 'should find Input below Label on iOS');
  assert(result!.centerY > 44, 'Input center should be below Label bottom edge');
});

// ── State selectors — Android ─────────────────────────────────────────────────

elementResolver.test('Android: enabled: false finds disabled node', async () => {
  const xml = makeAndroidHierarchyWithAttrs([
    { text: 'Btn', y1: 0, y2: 44, enabled: true },
    { text: 'Btn', y1: 50, y2: 94, enabled: false },
  ]);
  const result = findAndroidElement(xml, { text: 'Btn', enabled: false });
  assert(result !== null, 'should find the disabled node');
  assert(result!.centerY > 50, 'should be the second (disabled) node');
});

elementResolver.test('Android: checked: true finds checked node', async () => {
  const xml = makeAndroidHierarchyWithAttrs([
    { text: 'Option', y1: 0, y2: 44, checked: false },
    { text: 'Option', y1: 50, y2: 94, checked: true },
  ]);
  const result = findAndroidElement(xml, { text: 'Option', checked: true });
  assert(result !== null, 'should find the checked node');
  assert(result!.centerY > 50, 'should be the second (checked) node');
});

elementResolver.test('Android: selected: true finds selected node', async () => {
  const xml = makeAndroidHierarchyWithAttrs([
    { text: 'Item', y1: 0, y2: 44, selected: false },
    { text: 'Item', y1: 50, y2: 94, selected: true },
  ]);
  const result = findAndroidElement(xml, { text: 'Item', selected: true });
  assert(result !== null, 'should find the selected node');
  assert(result!.centerY > 50, 'should be the second (selected) node');
});

// ── Relative position selectors — Android ────────────────────────────────────

elementResolver.test('Android: below finds element below reference', async () => {
  const xml = makeAndroidHierarchyWithAttrs([
    { text: 'Label', x1: 0, y1: 0, x2: 200, y2: 44 },
    { text: 'Input', x1: 0, y1: 50, x2: 200, y2: 94 },
  ]);
  const result = findAndroidElement(xml, { text: 'Input', below: { text: 'Label' } });
  assert(result !== null, 'should find Input below Label');
  assert(result!.centerY > 44, 'Input center should be below Label bottom edge');
});

elementResolver.test('Android: above finds element above reference', async () => {
  const xml = makeAndroidHierarchyWithAttrs([
    { text: 'Header', x1: 0, y1: 0, x2: 200, y2: 44 },
    { text: 'Footer', x1: 0, y1: 500, x2: 200, y2: 544 },
  ]);
  const result = findAndroidElement(xml, { text: 'Header', above: { text: 'Footer' } });
  assert(result !== null, 'should find Header above Footer');
  assert(result!.centerY < 500, 'Header center should be above Footer top edge');
});

elementResolver.test('Android: rightOf finds element to the right of reference', async () => {
  const xml = makeAndroidHierarchyWithAttrs([
    { text: 'Left', x1: 0, y1: 0, x2: 100, y2: 44 },
    { text: 'Right', x1: 120, y1: 0, x2: 220, y2: 44 },
  ]);
  const result = findAndroidElement(xml, { text: 'Right', rightOf: { text: 'Left' } });
  assert(result !== null, 'should find Right element rightOf Left');
  assert(result!.centerX > 100, 'Right element center should be to the right of Left element');
});

elementResolver.test('Android: leftOf finds element to the left of reference', async () => {
  const xml = makeAndroidHierarchyWithAttrs([
    { text: 'Left', x1: 0, y1: 0, x2: 100, y2: 44 },
    { text: 'Right', x1: 120, y1: 0, x2: 220, y2: 44 },
  ]);
  const result = findAndroidElement(xml, { text: 'Left', leftOf: { text: 'Right' } });
  assert(result !== null, 'should find Left element leftOf Right');
  assert(result!.centerX < 120, 'Left element should be left of Right element');
});

elementResolver.test('Android: below returns null when reference not found', async () => {
  const xml = makeAndroidHierarchyWithAttrs([
    { text: 'Input', x1: 0, y1: 50, x2: 200, y2: 94 },
  ]);
  const result = findAndroidElement(xml, { text: 'Input', below: { text: 'NonExistentLabel' } });
  assert(result === null, 'should return null when reference element does not exist');
});

// ── Full-string selector matching (YAML flow parity) ─────────────────────────

elementResolver.test('query "Nouns" does not match label "Pronouns" (iOS)', async () => {
  const root = makeRootAX([makeAXElem({ label: 'Pronouns', y: 0 })]);
  const result = findIOSElement(root, { query: 'Nouns' });
  assert(result === null, 'full-regex match: Pronouns is not entirely Nouns');
});

elementResolver.test('regex Episode 26.* matches full title (iOS)', async () => {
  const root = makeRootAX([
    {
      identifier: '',
      frame: { X: 0, Y: 0, Width: 200, Height: 44 },
      label: '',
      value: '',
      title: 'Episode 26 — The Finale',
      elementType: 48,
      enabled: true,
      selected: false,
      hasFocus: false,
      children: [],
    },
  ]);
  const result = findIOSElement(root, { query: 'Episode 26.*' });
  assert(result !== null, 'pattern should match entire title string');
});

elementResolver.test('hintText matches when text empty (Android)', async () => {
  const xml = makeAndroidHierarchyWithAttrs([
    { text: '', hintText: 'Search shows', y1: 0, y2: 44 },
  ]);
  const result = findAndroidElement(xml, { text: 'Search shows' });
  assert(result !== null, 'hintText is included in text-bearing fields');
});

elementResolver.test('id matches suffix after last slash (Android)', async () => {
  const xml = makeAndroidHierarchyWithAttrs([
    { text: 'Go', id: 'com.example.app:id/submit_btn', y1: 0, y2: 44 },
  ]);
  const bySuffix = findAndroidElement(xml, { id: 'submit_btn' });
  assert(bySuffix !== null, 'match on segment after last /');
  const byFull = findAndroidElement(xml, { id: 'com.example.app:id/submit_btn' });
  assert(byFull !== null, 'match on full resource-id');
});

elementResolver.test('invalid regex pattern falls back to literal (iOS)', async () => {
  const label = '(unclosed';
  const root = makeRootAX([makeAXElem({ label, y: 0 })]);
  const found = findIOSElement(root, { text: label });
  assert(found !== null, 'invalid pattern compiles as escaped literal');
});

elementResolver.test('newline in label matches pattern with space (iOS)', async () => {
  const root = makeRootAX([makeAXElem({ label: 'Hello\nWorld', y: 0 })]);
  const result = findIOSElement(root, { query: 'Hello World' });
  assert(result !== null, 'newlines normalized to spaces for matching');
});

elementResolver.test('Web: query "Nouns" does not match name "Pronouns"', async () => {
  const h = makeWebHierarchy([webEl('button', 'Pronouns', 'e1')]);
  assert(findWebElement(h, { query: 'Nouns' }) === null, 'full-string regex on name');
});

elementResolver.test('Web: regex on name and id suffix on ref', async () => {
  const h = makeWebHierarchy([
    webEl('link', 'Episode 12 — Cold Open', 'e2'),
    webEl('button', '', 'aria/panel/ok_btn'),
  ]);
  const ep = findWebElement(h, { query: 'Episode 12.*' });
  assert(ep !== null, 'name field matches pattern');
  const byRef = findWebElement(h, { id: 'ok_btn' });
  assert(byRef !== null, 'ref: suffix after last /');
});

if (require.main === module) runAll([elementResolver]);
