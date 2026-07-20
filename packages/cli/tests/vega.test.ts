import { TestSuite, assert } from './runner.js';
import { VegaCli } from '../src/drivers/vega/cli.js';
import { parseVegaPageSource } from '../src/drivers/vega/page-source-parser.js';
import { VEGA_BUTTON_KEYS, shellQuote } from '../src/drivers/vega/input.js';
import { parseAndroidHierarchy, findAndroidElement } from '../src/drivers/element-resolver.js';

export const vega = new TestSuite('Vega');

// ── parseDeviceList ────────────────────────────────────────────────────────────

vega.test('parseDeviceList extracts serial before " : " and flags virtual', async () => {
  const out = [
    'Found the following device(s):',
    'VirtualDevice : tv - aarch64 - OS - amazon-host',
    'RealStick : tv - aarch64 - OS - amazon-fire',
  ].join('\n');
  const devices = VegaCli.parseDeviceList(out);
  assert(devices.length === 2, `expected 2 devices, got ${devices.length}`);
  assert(devices[0].serial === 'VirtualDevice', `serial was ${devices[0].serial}`);
  assert(devices[0].isVirtual === true, 'VirtualDevice should be virtual');
  assert(devices[1].serial === 'RealStick', `serial was ${devices[1].serial}`);
  assert(devices[1].isVirtual === false, 'RealStick should not be virtual');
});

vega.test('parseDeviceList ignores lines without " : "', async () => {
  const devices = VegaCli.parseDeviceList('header line\n\nnoise');
  assert(devices.length === 0, `expected 0 devices, got ${devices.length}`);
});

// ── page source parser → uiautomator XML ────────────────────────────────────────

const SAMPLE = `<?xml version="1.0"?>
<root>
  <app appName="com.amazon.keplerlauncherapp">
    <window x="0" y="0" width="1920" height="1080">
      <child role="Button" test_id="launcher_btn" x="0" y="0" width="100" height="40" clickable="true"><text>Launcher</text></child>
    </window>
  </app>
  <app appName="com.example.app">
    <window x="0" y="0" width="1920" height="1080">
      <child x="0" y="0" width="1920" height="1080">
        <child role="Button" test_id="sign_in" x="860" y="500" width="200" height="80" focusable="true" focused="true"><text>Sign In</text></child>
        <child role="Text" x="800" y="200" width="320" height="40"><text>Welcome</text></child>
      </child>
    </window>
  </app>
</root>`;

vega.test('parseVegaPageSource excludes the launcher app', async () => {
  const xml = parseVegaPageSource(SAMPLE);
  assert(!xml.includes('Launcher'), 'launcher content should be filtered out');
  assert(xml.includes('Sign In'), 'foreground app content should be present');
});

vega.test('parseVegaPageSource emits Android-resolvable nodes with bounds', async () => {
  const xml = parseVegaPageSource(SAMPLE);
  const nodes = parseAndroidHierarchy(xml);
  assert(nodes.length >= 2, `expected >=2 nodes, got ${nodes.length}`);
  const signIn = nodes.find((n) => n.text === 'Sign In');
  assert(!!signIn, 'Sign In node should parse');
  assert(signIn!.resourceId === 'sign_in', `resource-id was ${signIn!.resourceId}`);
  assert(signIn!.clickable === true, 'focusable node should be clickable');
  assert(signIn!.focused === true, 'focused should carry through');
  assert(
    signIn!.bounds.x1 === 860 &&
      signIn!.bounds.y1 === 500 &&
      signIn!.bounds.x2 === 1060 &&
      signIn!.bounds.y2 === 580,
    `bounds were ${JSON.stringify(signIn!.bounds)}`
  );
});

vega.test('findAndroidElement resolves a Vega-emitted element by text', async () => {
  const xml = parseVegaPageSource(SAMPLE);
  const el = findAndroidElement(xml, { query: 'Sign In' });
  assert(!!el, 'element should resolve');
  assert(el!.centerX === 960 && el!.centerY === 540, `center was ${el!.centerX},${el!.centerY}`);
});

vega.test('parseVegaPageSource escapes XML-special characters in labels', async () => {
  const xml = parseVegaPageSource(
    '<root><app appName="a"><window x="0" y="0" width="10" height="10">' +
      '<child role="Text" x="0" y="0" width="10" height="10"><text>Tom &amp; "Jerry"</text></child>' +
      '</window></app></root>'
  );
  // The emitted XML must stay well-formed (a bare & or " would truncate the
  // attribute in the Android regex parser). Entities are preserved escaped —
  // consistent with how the Android adapter treats uiautomator XML.
  const nodes = parseAndroidHierarchy(xml);
  const node = nodes.find((n) => n.text.includes('Tom'));
  assert(!!node, 'node with special chars should parse');
  assert(node!.text === 'Tom &amp; &quot;Jerry&quot;', `text was ${node!.text}`);
});

// ── key mapping & quoting ───────────────────────────────────────────────────────

vega.test('remote button map uses verified KEY_ names', async () => {
  assert(VEGA_BUTTON_KEYS.select === 'KEY_ENTER', 'select must map to KEY_ENTER');
  assert(VEGA_BUTTON_KEYS.home === 'KEY_HOMEPAGE', 'home must map to KEY_HOMEPAGE');
  assert(VEGA_BUTTON_KEYS.back === 'KEY_BACK', 'back must map to KEY_BACK');
  assert(VEGA_BUTTON_KEYS.up === 'KEY_UP', 'up must map to KEY_UP');
});

vega.test('shellQuote escapes single quotes for a POSIX shell', async () => {
  assert(shellQuote('abc') === "'abc'", `got ${shellQuote('abc')}`);
  assert(shellQuote("a'b") === "'a'\\''b'", `got ${shellQuote("a'b")}`);
});

// ── CLI binary resolution ───────────────────────────────────────────────────────

vega.test('resolveBinary returns a stable non-empty binary name', async () => {
  const first = VegaCli.resolveBinary();
  assert(typeof first === 'string' && first.length > 0, `got ${JSON.stringify(first)}`);
  // Resolution is cached, so repeated calls are stable within a process.
  assert(VegaCli.resolveBinary() === first, 'resolveBinary should be stable across calls');
});
