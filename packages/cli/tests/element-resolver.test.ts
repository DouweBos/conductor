import { findIOSElement, findAndroidElement } from '../src/drivers/element-resolver.js';
import type { AXElement } from '../src/drivers/ios.js';
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

if (require.main === module) runAll([elementResolver]);
