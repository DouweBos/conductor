import { parseFlowString, executeFlow } from '../src/drivers/flow-runner.js';
import { TestSuite, assert, runAll } from './runner.js';
import {
  MockAndroidDriver,
  makeAndroidHierarchy, makeAndroidHierarchyWithAttrs,
} from './mock-driver.js';

function approx(a: number, b: number, eps = 1): boolean {
  return Math.abs(a - b) <= eps;
}

export const androidExec = new TestSuite('Flow Executor (Android)');

androidExec.test('tapOn by text calls driver.tap at element center', async () => {
  // Element bounds [50,100][150,144] → center (100, 122)
  const driver = new MockAndroidDriver(makeAndroidHierarchy([{ text: 'Submit', x1: 50, y1: 100, x2: 150, y2: 144 }]));
  await executeFlow(parseFlowString('---\n- tapOn: "Submit"'), driver);
  const taps = driver.callsTo('tap');
  assert(taps.length === 1, `expected 1 tap, got ${taps.length}`);
  const [x, y] = taps[0].args as number[];
  assert(approx(x, 100), `centerX should be ~100, got ${x}`);
  assert(approx(y, 122), `centerY should be ~122, got ${y}`);
});

androidExec.test('inputText calls driver.inputText', async () => {
  const driver = new MockAndroidDriver();
  await executeFlow(parseFlowString('---\n- inputText: "Android text"'), driver);
  const calls = driver.callsTo('inputText');
  assert(calls.length === 1 && calls[0].args[0] === 'Android text', 'inputText mismatch');
});

androidExec.test('eraseText calls driver.eraseAllText with count', async () => {
  const driver = new MockAndroidDriver();
  await executeFlow(parseFlowString('---\n- eraseText: 7'), driver);
  const calls = driver.callsTo('eraseAllText');
  assert(calls.length === 1, `expected 1 eraseAllText call, got ${calls.length}`);
  assert(calls[0].args[0] === 7, `expected 7, got ${calls[0].args[0]}`);
});

androidExec.test('scroll DOWN calls driver.swipe from lower to upper', async () => {
  // Device: 1080x1920. DOWN = swipe finger from y*0.7→y*0.3
  const driver = new MockAndroidDriver();
  await executeFlow(parseFlowString('---\n- scroll:\n    direction: DOWN'), driver);
  const swipes = driver.callsTo('swipe');
  assert(swipes.length === 1, 'expected 1 swipe');
  const [, startY, , endY] = swipes[0].args as number[];
  assert(startY > endY, `DOWN should have startY(${startY}) > endY(${endY})`);
});

androidExec.test('back calls driver.back', async () => {
  const driver = new MockAndroidDriver();
  await executeFlow(parseFlowString('---\n- back:'), driver);
  assert(driver.callsTo('back').length === 1, 'expected one back call');
});

androidExec.test('assertVisible succeeds when element is present', async () => {
  const driver = new MockAndroidDriver(makeAndroidHierarchy([{ text: 'Loading' }]));
  await executeFlow(parseFlowString('---\n- assertVisible: "Loading"'), driver);
});

androidExec.test('launchApp calls driver.launchApp', async () => {
  const driver = new MockAndroidDriver();
  await executeFlow(parseFlowString('---\n- launchApp: com.example.android'), driver);
  const calls = driver.callsTo('launchApp');
  assert(calls.length === 1 && calls[0].args[0] === 'com.example.android', 'launchApp mismatch');
});

androidExec.test('stopApp calls driver.stopApp', async () => {
  const driver = new MockAndroidDriver();
  await executeFlow(parseFlowString('---\n- stopApp: com.example.android'), driver);
  const calls = driver.callsTo('stopApp');
  assert(calls.length === 1 && calls[0].args[0] === 'com.example.android', 'stopApp mismatch');
});

androidExec.test('pressKey ENTER → pressKeyEvent(66)', async () => {
  const driver = new MockAndroidDriver();
  await executeFlow(parseFlowString('---\n- pressKey: ENTER'), driver);
  const calls = driver.callsTo('pressKeyEvent');
  assert(calls.length === 1 && calls[0].args[0] === 66, `expected keycode 66, got ${calls[0].args[0]}`);
});

androidExec.test('pressKey HOME → pressKeyEvent(3)', async () => {
  const driver = new MockAndroidDriver();
  await executeFlow(parseFlowString('---\n- pressKey: HOME'), driver);
  const calls = driver.callsTo('pressKeyEvent');
  assert(calls.length === 1 && calls[0].args[0] === 3, `expected keycode 3, got ${calls[0].args[0]}`);
});

androidExec.test('hideKeyboard calls pressKeyEvent(111) on Android', async () => {
  const driver = new MockAndroidDriver();
  await executeFlow(parseFlowString('---\n- hideKeyboard:'), driver);
  const calls = driver.callsTo('pressKeyEvent');
  assert(calls.length === 1 && calls[0].args[0] === 111, `expected keycode 111 (ESCAPE), got ${calls[0].args[0]}`);
});

androidExec.test('launchApp with no argument uses flow appId from header', async () => {
  const driver = new MockAndroidDriver();
  const flow = parseFlowString('appId: com.example.android\n---\n- launchApp:');
  await executeFlow(flow, driver);
  const calls = driver.callsTo('launchApp');
  assert(calls.length === 1 && calls[0].args[0] === 'com.example.android', `launchApp appId mismatch: "${calls[0]?.args[0]}"`);
});

androidExec.test('longPressOn calls swipe at same point with 1500ms', async () => {
  const driver = new MockAndroidDriver(makeAndroidHierarchy([{ text: 'Hold', x1: 50, y1: 100, x2: 150, y2: 144 }]));
  await executeFlow(parseFlowString('---\n- longPressOn: "Hold"'), driver);
  const swipes = driver.callsTo('swipe');
  assert(swipes.length === 1, 'expected 1 swipe for long press');
  const [sx, sy, ex, ey, dur] = swipes[0].args as number[];
  assert(approx(sx, ex, 0), 'long press: startX should equal endX');
  assert(approx(sy, ey, 0), 'long press: startY should equal endY');
  assert(dur === 1500, `expected 1500ms duration, got ${dur}`);
});

androidExec.test('optional: true suppresses assertNotVisible failure', async () => {
  const driver = new MockAndroidDriver(makeAndroidHierarchyWithAttrs([{ text: 'Toast' }]));
  await executeFlow(
    parseFlowString('---\n- assertNotVisible:\n    text: "Toast"\n    optional: true'),
    driver
  );
});

androidExec.test('optional: false (default) propagates failure', async () => {
  const driver = new MockAndroidDriver(makeAndroidHierarchyWithAttrs([{ text: 'Present' }]));
  let threw = false;
  try {
    await executeFlow(parseFlowString('---\n- assertNotVisible: "Present"'), driver);
  } catch { threw = true; }
  assert(threw, 'expected failure to propagate without optional: true');
});

androidExec.test('tapOn point: "50%,50%" with Android (1080x1920)', async () => {
  const driver = new MockAndroidDriver();
  await executeFlow(parseFlowString('---\n- tapOn:\n    point: "50%,50%"'), driver);
  const [x, y] = driver.callsTo('tap')[0].args as number[];
  assert(approx(x, 540, 2), `expected x≈540 (50% of 1080), got ${x}`);
  assert(approx(y, 960, 2), `expected y≈960 (50% of 1920), got ${y}`);
});

androidExec.test('repeat while.visible: exits immediately when element is absent', async () => {
  const driver = new MockAndroidDriver(makeAndroidHierarchy([]));
  const yaml = [
    '---',
    '- repeat:',
    '    while:',
    '      visible: "Loading"',
    '    commands:',
    '      - tapOn: "Loading"',
  ].join('\n');
  await executeFlow(parseFlowString(yaml), driver);
  assert(driver.callsTo('tap').length === 0, 'should not tap since element was never visible');
});

if (require.main === module) runAll([androidExec]);
