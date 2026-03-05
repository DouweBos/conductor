import { parseFlowString, executeFlow } from '../src/drivers/flow-runner.js';
import { TestSuite, assert, runAll } from './runner.js';
import {
  MockIOSDriver, MockAndroidDriver,
  makeIOSHierarchy, makeAndroidHierarchyWithAttrs,
} from './mock-driver.js';

function approx(a: number, b: number, eps = 1): boolean {
  return Math.abs(a - b) <= eps;
}

export const iosExec = new TestSuite('Flow Executor (iOS)');

iosExec.test('tapOn by text calls driver.tap at element center', async () => {
  // Element at x=50, y=100, w=100, h=44 → center (100, 122)
  const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'Submit', x: 50, y: 100, w: 100, h: 44 }]));
  await executeFlow(parseFlowString('---\n- tapOn: "Submit"'), driver);
  const taps = driver.callsTo('tap');
  assert(taps.length === 1, `expected 1 tap, got ${taps.length}`);
  const [x, y] = taps[0].args as number[];
  assert(approx(x, 100), `centerX should be ~100, got ${x}`);
  assert(approx(y, 122), `centerY should be ~122, got ${y}`);
});

iosExec.test('tapOn with object selector { text }', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'OK', x: 10, y: 20, w: 80, h: 40 }]));
  await executeFlow(parseFlowString('---\n- tapOn:\n    text: "OK"'), driver);
  assert(driver.callsTo('tap').length === 1, 'expected one tap');
});

iosExec.test('doubleTapOn calls tap twice', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'Btn', x: 0, y: 0, w: 100, h: 50 }]));
  await executeFlow(parseFlowString('---\n- doubleTapOn: "Btn"'), driver);
  const taps = driver.callsTo('tap');
  assert(taps.length === 2, `expected 2 taps for doubleTapOn, got ${taps.length}`);
});

iosExec.test('longPressOn calls tap with duration 1.5', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'Hold', x: 0, y: 0, w: 100, h: 50 }]));
  await executeFlow(parseFlowString('---\n- longPressOn: "Hold"'), driver);
  const taps = driver.callsTo('tap');
  assert(taps.length === 1, 'expected one tap');
  assert(taps[0].args[2] === 1.5, `expected duration=1.5, got ${taps[0].args[2]}`);
});

iosExec.test('inputText calls driver.inputText', async () => {
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('---\n- inputText: "Hello World"'), driver);
  const calls = driver.callsTo('inputText');
  assert(calls.length === 1, 'expected one inputText call');
  assert(calls[0].args[0] === 'Hello World', `expected "Hello World", got "${calls[0].args[0]}"`);
});

iosExec.test('eraseText:N calls pressKey("delete") N times', async () => {
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('---\n- eraseText: 3'), driver);
  const calls = driver.callsTo('pressKey');
  assert(calls.length === 3, `expected 3 pressKey calls, got ${calls.length}`);
  assert(calls.every((c) => c.args[0] === 'delete'), 'all pressKey calls should be "delete"');
});

iosExec.test('eraseText with object { charactersToErase }', async () => {
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('---\n- eraseText:\n    charactersToErase: 5'), driver);
  assert(driver.callsTo('pressKey').length === 5, 'expected 5 pressKey calls');
});

iosExec.test('scroll DOWN calls swipe from lower to upper', async () => {
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('---\n- scroll:\n    direction: DOWN'), driver);
  const swipes = driver.callsTo('swipe');
  assert(swipes.length === 1, 'expected 1 swipe');
  const [, startY, , endY] = swipes[0].args as number[];
  assert(startY > endY, `DOWN scroll should have startY(${startY}) > endY(${endY})`);
});

iosExec.test('scroll UP calls swipe from upper to lower', async () => {
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('---\n- scroll:\n    direction: UP'), driver);
  const [, startY, , endY] = driver.callsTo('swipe')[0].args as number[];
  assert(startY < endY, `UP scroll should have startY(${startY}) < endY(${endY})`);
});

iosExec.test('bare scroll command defaults to DOWN', async () => {
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('---\n- scroll:'), driver);
  const swipes = driver.callsTo('swipe');
  assert(swipes.length === 1, 'expected 1 swipe');
  const [, startY, , endY] = swipes[0].args as number[];
  assert(startY > endY, 'bare scroll should default to DOWN direction');
});

iosExec.test('swipe LEFT calls swipe with startX > endX', async () => {
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('---\n- swipe:\n    direction: LEFT'), driver);
  const [startX, , endX] = driver.callsTo('swipe')[0].args as number[];
  assert(startX > endX, `LEFT swipe should have startX(${startX}) > endX(${endX})`);
});

iosExec.test('back is noop on iOS (no driver call)', async () => {
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('---\n- back:'), driver);
  assert(driver.calls.length === 0, `expected no calls on iOS back, got ${driver.calls.length}`);
});

iosExec.test('assertVisible succeeds when element is in hierarchy', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'Welcome' }]));
  await executeFlow(parseFlowString('---\n- assertVisible: "Welcome"'), driver);
});

iosExec.test('assertNotVisible throws when element is present', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'Banner' }]));
  let threw = false;
  try {
    await executeFlow(parseFlowString('---\n- assertNotVisible: "Banner"'), driver);
  } catch { threw = true; }
  assert(threw, 'assertNotVisible should throw when element is visible');
});

iosExec.test('assertNotVisible succeeds when element is absent', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'Other' }]));
  await executeFlow(parseFlowString('---\n- assertNotVisible: "Banner"'), driver);
});

iosExec.test('launchApp calls driver.launchApp with appId', async () => {
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('---\n- launchApp: com.example.myapp'), driver);
  const calls = driver.callsTo('launchApp');
  assert(calls.length === 1, 'expected one launchApp call');
  assert(calls[0].args[0] === 'com.example.myapp', `expected "com.example.myapp", got "${calls[0].args[0]}"`);
});

iosExec.test('stopApp calls driver.terminateApp', async () => {
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('---\n- stopApp: com.example.myapp'), driver);
  const calls = driver.callsTo('terminateApp');
  assert(calls.length === 1, 'expected one terminateApp call');
  assert(calls[0].args[0] === 'com.example.myapp', `expected "com.example.myapp", got "${calls[0].args[0]}"`);
});

iosExec.test('launchApp with no argument uses flow appId from header', async () => {
  const driver = new MockIOSDriver();
  const flow = parseFlowString('appId: com.example.target\n---\n- launchApp:');
  await executeFlow(flow, driver);
  const calls = driver.callsTo('launchApp');
  assert(calls.length === 1, 'expected one launchApp call');
  assert(calls[0].args[0] === 'com.example.target', `expected "com.example.target", got "${calls[0].args[0]}"`);
});

iosExec.test('stopApp with no argument uses flow appId from header', async () => {
  const driver = new MockIOSDriver();
  const flow = parseFlowString('appId: com.example.target\n---\n- stopApp:');
  await executeFlow(flow, driver);
  const calls = driver.callsTo('terminateApp');
  assert(calls.length === 1, 'expected one terminateApp call');
  assert(calls[0].args[0] === 'com.example.target', `expected "com.example.target", got "${calls[0].args[0]}"`);
});

iosExec.test('launchApp stopApp: false still launches the app', async () => {
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('appId: com.example.app\n---\n- launchApp:\n    stopApp: false'), driver);
  const calls = driver.callsTo('launchApp');
  assert(calls.length === 1, 'expected launchApp to be called with stopApp: false');
  assert(calls[0].args[0] === 'com.example.app', 'appId should be correct');
});

iosExec.test('pressKey Home calls pressButton("home") on iOS', async () => {
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('---\n- pressKey: Home'), driver);
  const calls = driver.callsTo('pressButton');
  assert(calls.length === 1, 'expected one pressButton call');
  assert(calls[0].args[0] === 'home', `expected "home", got "${calls[0].args[0]}"`);
  assert(driver.callsTo('pressKey').length === 0, 'pressKey should NOT be called for Home on iOS');
});

iosExec.test('pressKey ENTER maps to pressKey("return")', async () => {
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('---\n- pressKey: ENTER'), driver);
  const calls = driver.callsTo('pressKey');
  assert(calls.length === 1, 'expected one pressKey call');
  assert(calls[0].args[0] === 'return', `expected "return", got "${calls[0].args[0]}"`);
});

iosExec.test('pressKey DELETE maps to pressKey("delete")', async () => {
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('---\n- pressKey: DELETE'), driver);
  const calls = driver.callsTo('pressKey');
  assert(calls[0].args[0] === 'delete', `expected "delete", got "${calls[0].args[0]}"`);
});

iosExec.test('hideKeyboard calls pressKey("return") on iOS', async () => {
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('---\n- hideKeyboard:'), driver);
  const calls = driver.callsTo('pressKey');
  assert(calls.length === 1, 'expected one pressKey call');
  assert(calls[0].args[0] === 'return', `expected "return", got "${calls[0].args[0]}"`);
});

iosExec.test('repeat:3 executes nested command 3 times', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'Next' }]));
  const yaml = '---\n- repeat:\n    times: 3\n    commands:\n      - tapOn: "Next"';
  await executeFlow(parseFlowString(yaml), driver);
  assert(driver.callsTo('tap').length === 3, `expected 3 taps, got ${driver.callsTo('tap').length}`);
});

iosExec.test('retry succeeds after transient failure', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'Save' }]));
  driver.failNextNTaps = 1;
  const yaml = '---\n- retry:\n    maxRetries: 2\n    commands:\n      - tapOn: "Save"';
  await executeFlow(parseFlowString(yaml), driver);
  assert(driver.callsTo('tap').length === 1, 'exactly one successful tap after retry');
});

iosExec.test('retry throws after exhausting retries', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'Save' }]));
  driver.failNextNTaps = 99;
  const yaml = '---\n- retry:\n    maxRetries: 1\n    commands:\n      - tapOn: "Save"';
  let threw = false;
  try {
    await executeFlow(parseFlowString(yaml), driver);
  } catch { threw = true; }
  assert(threw, 'retry should throw after maxRetries exceeded');
});

iosExec.test('runFlow with inline commands executes them', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'Go' }]));
  const yaml = '---\n- runFlow:\n    commands:\n      - tapOn: "Go"';
  await executeFlow(parseFlowString(yaml), driver);
  assert(driver.callsTo('tap').length === 1, 'expected tap from inline runFlow commands');
});

iosExec.test('bare string "back" is treated as back command', async () => {
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('---\n- back'), driver);
});

iosExec.test('bare string "launchApp" uses flow appId from header', async () => {
  const driver = new MockIOSDriver();
  const flow = parseFlowString('appId: com.example.bare\n---\n- launchApp');
  await executeFlow(flow, driver);
  const calls = driver.callsTo('launchApp');
  assert(calls.length === 1, 'expected one launchApp call');
  assert(calls[0].args[0] === 'com.example.bare', `expected "com.example.bare", got "${calls[0].args[0]}"`);
});

iosExec.test('scrollUntilVisible returns immediately if element already visible', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'Target' }]));
  const yaml = '---\n- scrollUntilVisible:\n    element: "Target"\n    direction: DOWN';
  await executeFlow(parseFlowString(yaml), driver);
  assert(driver.callsTo('swipe').length === 0, 'should not scroll when element is already visible');
});

iosExec.test('takeScreenshot writes file', async () => {
  const fs = await import('fs/promises');
  const tmp = `/tmp/conductor-test-screenshot-${Date.now()}.png`;
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString(`---\n- takeScreenshot: "${tmp}"`), driver);
  assert(driver.callsTo('screenshot').length === 1, 'screenshot should be called');
  const stat = await fs.stat(tmp).catch(() => null);
  assert(stat !== null, `screenshot file should be written to ${tmp}`);
  await fs.unlink(tmp).catch(() => {});
});

iosExec.test('label attribute does not break execution', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'Submit' }]));
  await executeFlow(
    parseFlowString('---\n- tapOn:\n    text: "Submit"\n    label: "Tap the submit button"'),
    driver
  );
  assert(driver.callsTo('tap').length === 1, 'expected tap to execute despite label attribute');
});

iosExec.test('optional: true suppresses failure — unknown command', async () => {
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('---\n- doesNotExist:\n    text: foo\n    optional: true'), driver);
});

iosExec.test('optional: true on one command — next commands still run', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'Next' }]));
  await executeFlow(
    parseFlowString('---\n- doesNotExist:\n    text: x\n    optional: true\n- tapOn: "Next"'),
    driver
  );
  assert(driver.callsTo('tap').length === 1, 'commands after optional failure should still run');
});

iosExec.test('optional: true suppresses assertNotVisible failure (Android driver)', async () => {
  const driver = new MockAndroidDriver(makeAndroidHierarchyWithAttrs([{ text: 'Banner' }]));
  await executeFlow(
    parseFlowString('---\n- assertNotVisible:\n    text: "Banner"\n    optional: true\n    label: "Check banner gone"'),
    driver
  );
});

iosExec.test('assertFalse passes when expression is false', async () => {
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('---\n- assertFalse: "1 === 2"'), driver);
});

iosExec.test('assertFalse throws when expression is true', async () => {
  const driver = new MockIOSDriver();
  let threw = false;
  try {
    await executeFlow(parseFlowString('---\n- assertFalse: "1 === 1"'), driver);
  } catch { threw = true; }
  assert(threw, 'assertFalse should throw when expression is true');
});

iosExec.test('assertFalse with object { condition } form', async () => {
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('---\n- assertFalse:\n    condition: "false"'), driver);
});

iosExec.test('assertFalse with output reference', async () => {
  const driver = new MockIOSDriver();
  const output: Record<string, unknown> = { done: false };
  await executeFlow(parseFlowString('---\n- assertFalse: "output.done === true"'), driver, { output });
});

iosExec.test('tapOn point: "50%,50%" taps at center of screen', async () => {
  // iOS device: 390x844
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('---\n- tapOn:\n    point: "50%,50%"'), driver);
  const taps = driver.callsTo('tap');
  assert(taps.length === 1, 'expected one tap');
  const [x, y] = taps[0].args as number[];
  assert(approx(x, 195, 2), `expected x≈195 (50% of 390), got ${x}`);
  assert(approx(y, 422, 2), `expected y≈422 (50% of 844), got ${y}`);
});

iosExec.test('tapOn point: "100,200" taps at absolute pixels', async () => {
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('---\n- tapOn:\n    point: "100,200"'), driver);
  const [x, y] = driver.callsTo('tap')[0].args as number[];
  assert(approx(x, 100, 2), `expected x=100, got ${x}`);
  assert(approx(y, 200, 2), `expected y=200, got ${y}`);
});

iosExec.test('tapOn point: "0%,0%" taps at top-left corner', async () => {
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('---\n- tapOn:\n    point: "0%,0%"'), driver);
  const [x, y] = driver.callsTo('tap')[0].args as number[];
  assert(approx(x, 0, 2), `expected x=0, got ${x}`);
  assert(approx(y, 0, 2), `expected y=0, got ${y}`);
});

iosExec.test('tapOn point: "100%,100%" taps at bottom-right corner', async () => {
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('---\n- tapOn:\n    point: "100%,100%"'), driver);
  const [x, y] = driver.callsTo('tap')[0].args as number[];
  assert(approx(x, 390, 2), `expected x=390, got ${x}`);
  assert(approx(y, 844, 2), `expected y=844, got ${y}`);
});

iosExec.test('tapOn point: fractional "0.5,0.5" taps at center', async () => {
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('---\n- tapOn:\n    point: "0.5,0.5"'), driver);
  const [x, y] = driver.callsTo('tap')[0].args as number[];
  assert(approx(x, 195, 2), `expected x≈195, got ${x}`);
  assert(approx(y, 422, 2), `expected y≈422, got ${y}`);
});

iosExec.test('doubleTapOn with point calls tap twice at coordinates', async () => {
  const driver = new MockIOSDriver();
  await executeFlow(parseFlowString('---\n- doubleTapOn:\n    point: "50%,50%"'), driver);
  const taps = driver.callsTo('tap');
  assert(taps.length === 2, `expected 2 taps for doubleTapOn with point, got ${taps.length}`);
  const [x0, y0] = taps[0].args as number[];
  const [x1, y1] = taps[1].args as number[];
  assert(approx(x0, x1, 2) && approx(y0, y1, 2), 'both taps should be at same point');
});

iosExec.test('tapOn repeat: 3 taps element three times', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'Like' }]));
  await executeFlow(parseFlowString('---\n- tapOn:\n    text: "Like"\n    repeat: 3'), driver);
  assert(driver.callsTo('tap').length === 3, `expected 3 taps, got ${driver.callsTo('tap').length}`);
});

iosExec.test('tapOn repeat: 1 (default) taps once', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'Btn' }]));
  await executeFlow(parseFlowString('---\n- tapOn:\n    text: "Btn"\n    repeat: 1'), driver);
  assert(driver.callsTo('tap').length === 1, 'repeat: 1 should tap exactly once');
});

iosExec.test('tapOn repeat: 2 with delay: 0 taps twice', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'X' }]));
  await executeFlow(parseFlowString('---\n- tapOn:\n    text: "X"\n    repeat: 2\n    delay: 0'), driver);
  assert(driver.callsTo('tap').length === 2, 'repeat: 2 should tap twice');
});

iosExec.test('all repeat taps land on the same element coordinates', async () => {
  // Element at x=50, y=100, w=100, h=44 → center (100, 122)
  const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'Target', x: 50, y: 100, w: 100, h: 44 }]));
  await executeFlow(parseFlowString('---\n- tapOn:\n    text: "Target"\n    repeat: 3'), driver);
  const taps = driver.callsTo('tap');
  assert(taps.length === 3, `expected 3 taps, got ${taps.length}`);
  for (const tap of taps) {
    const [x, y] = tap.args as number[];
    assert(approx(x, 100, 2), `tap x should be ~100, got ${x}`);
    assert(approx(y, 122, 2), `tap y should be ~122, got ${y}`);
  }
});

iosExec.test('copyTextFrom sets output.textContent', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'Hello World' }]));
  const output: Record<string, unknown> = {};
  await executeFlow(parseFlowString('---\n- copyTextFrom: "Hello World"'), driver, { output });
  assert(output['textContent'] === 'Hello World', `expected textContent="Hello World", got "${output['textContent']}"`);
});

iosExec.test('repeat while.true: loops until condition becomes false', async () => {
  const { writeFile, unlink } = await import('fs/promises');
  const ts = Date.now();
  const initScript = `/tmp/conductor-test-while-init-${ts}.js`;
  const incrScript = `/tmp/conductor-test-while-incr-${ts}.js`;
  await writeFile(initScript, 'output.counter = 0;');
  await writeFile(incrScript, 'output.counter = output.counter + 1;');
  try {
    const driver = new MockIOSDriver();
    const output: Record<string, unknown> = {};
    const yaml = [
      '---',
      `- runScript: ${initScript}`,
      '- repeat:',
      '    while:',
      '      true: "output.counter < 3"',
      '    commands:',
      `      - runScript: ${incrScript}`,
    ].join('\n');
    await executeFlow(parseFlowString(yaml), driver, { output });
    assert(output['counter'] === 3, `expected counter=3, got ${output['counter']}`);
  } finally {
    await unlink(initScript).catch(() => {});
    await unlink(incrScript).catch(() => {});
  }
});

iosExec.test('repeat while.notVisible: exits immediately when element is present', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'Done' }]));
  const yaml = [
    '---',
    '- repeat:',
    '    while:',
    '      notVisible: "Done"',
    '    commands:',
    '      - tapOn: "Done"',
  ].join('\n');
  await executeFlow(parseFlowString(yaml), driver);
  assert(driver.callsTo('tap').length === 0, 'should not tap since element was already visible');
});

iosExec.test('repeat times cap: limits iterations even when while condition stays true', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'Btn' }]));
  const yaml = [
    '---',
    '- repeat:',
    '    times: 4',
    '    while:',
    '      true: ${1 === 1}',
    '    commands:',
    '      - tapOn: "Btn"',
  ].join('\n');
  await executeFlow(parseFlowString(yaml), driver);
  assert(driver.callsTo('tap').length === 4, `expected exactly 4 taps, got ${driver.callsTo('tap').length}`);
});

if (require.main === module) runAll([iosExec]);
