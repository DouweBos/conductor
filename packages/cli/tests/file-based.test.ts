import path from 'path';
import { parseFlowFile, executeFlow } from '../src/drivers/flow-runner.js';
import { TestSuite, assert, runAll } from './runner.js';
import { MockIOSDriver, makeIOSHierarchy } from './mock-driver.js';

const FLOWS = path.join(__dirname, '../../tests/flows');

export const fileBased = new TestSuite('File-based flows');

fileBased.test('basic.yaml: tapOn + inputText + assertVisible', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([
    { label: 'Submit' },
    { label: 'Hello' },
  ]));
  const flow = await parseFlowFile(path.join(FLOWS, 'basic.yaml'));
  await executeFlow(flow, driver);
  assert(driver.callsTo('tap').length === 1, 'expected 1 tap (tapOn Submit)');
  assert(driver.callsTo('inputText').length === 1, 'expected 1 inputText');
});

fileBased.test('env-vars.yaml: env vars interpolated before execution', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([
    { label: 'Submit' },
    { label: 'Hello World' },
  ]));
  const flow = await parseFlowFile(path.join(FLOWS, 'env-vars.yaml'));
  const tapCmd = flow.commands[0] as Record<string, unknown>;
  assert(tapCmd['tapOn'] === 'Submit', `tapOn should be "Submit", got "${tapCmd['tapOn']}"`);
  await executeFlow(flow, driver);
  assert(driver.callsTo('tap').length === 1, 'expected 1 tap');
  assert(driver.callsTo('inputText')[0].args[0] === 'Hello World', 'inputText should be "Hello World"');
});

fileBased.test('scroll.yaml: 4 swipe calls with correct directions', async () => {
  const driver = new MockIOSDriver();
  const flow = await parseFlowFile(path.join(FLOWS, 'scroll.yaml'));
  await executeFlow(flow, driver);
  const swipes = driver.callsTo('swipe');
  assert(swipes.length === 4, `expected 4 swipes, got ${swipes.length}`);
  const [, sy0, , ey0] = swipes[0].args as number[];
  assert(sy0 > ey0, 'first swipe (DOWN) should have startY > endY');
  const [, sy1, , ey1] = swipes[1].args as number[];
  assert(sy1 < ey1, 'second swipe (UP) should have startY < endY');
  const [sx2, , ex2] = swipes[2].args as number[];
  assert(sx2 > ex2, 'third swipe (LEFT) should have startX > endX');
  const [sx3, , ex3] = swipes[3].args as number[];
  assert(sx3 < ex3, 'fourth swipe (RIGHT) should have startX < endX');
});

fileBased.test('app-lifecycle.yaml: launchApp then terminateApp', async () => {
  const driver = new MockIOSDriver();
  const flow = await parseFlowFile(path.join(FLOWS, 'app-lifecycle.yaml'));
  await executeFlow(flow, driver);
  assert(driver.callsTo('launchApp').length === 1, 'expected 1 launchApp');
  assert(driver.callsTo('terminateApp').length === 1, 'expected 1 terminateApp');
  assert(driver.callsTo('launchApp')[0].args[0] === 'com.example.target', 'launchApp appId mismatch');
});

fileBased.test('repeat.yaml: tapOn "Next" called 3 times', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'Next' }]));
  const flow = await parseFlowFile(path.join(FLOWS, 'repeat.yaml'));
  await executeFlow(flow, driver);
  assert(driver.callsTo('tap').length === 3, `expected 3 taps, got ${driver.callsTo('tap').length}`);
});

fileBased.test('nested.yaml: runFlow resolves sub-flow.yaml relative to cwd', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([
    { label: 'Start' },
    { label: 'OK' },
  ]));
  const filePath = path.join(FLOWS, 'nested.yaml');
  const flow = await parseFlowFile(filePath);
  await executeFlow(flow, driver, { cwd: FLOWS });
  assert(driver.callsTo('tap').length === 2, `expected 2 taps (Start + OK from sub-flow), got ${driver.callsTo('tap').length}`);
});

if (require.main === module) runAll([fileBased]);
