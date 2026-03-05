import { parseFlowString, executeFlow } from '../src/drivers/flow-runner.js';
import { TestSuite, assert, runAll } from './runner.js';
import { MockIOSDriver, MockAndroidDriver, makeIOSHierarchy } from './mock-driver.js';

async function writeTempScript(content: string): Promise<string> {
  const { writeFile } = await import('fs/promises');
  const p = `/tmp/conductor-test-${Date.now()}-${Math.random().toString(36).slice(2)}.js`;
  await writeFile(p, content);
  return p;
}

export const scriptSuite = new TestSuite('runScript');

scriptSuite.test('script sets output value, subsequent tapOn resolves ${output.x}', async () => {
  const { unlink } = await import('fs/promises');
  const script = await writeTempScript(`output.label = 'dynamic-button';`);
  try {
    const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'dynamic-button' }]));
    const output: Record<string, unknown> = {};
    await executeFlow(
      parseFlowString(`---\n- runScript: ${script}\n- tapOn: "\${output.label}"`),
      driver, { output },
    );
    assert(driver.callsTo('tap').length === 1, 'expected tap driven by output value');
    assert(output['label'] === 'dynamic-button', `output.label should be "dynamic-button", got "${output['label']}"`);
  } finally { await unlink(script).catch(() => {}); }
});

scriptSuite.test('flow env vars are injected as globals', async () => {
  const { unlink } = await import('fs/promises');
  const script = await writeTempScript(`output.greeting = 'hello ' + NAME;`);
  try {
    const driver = new MockIOSDriver();
    const output: Record<string, unknown> = {};
    await executeFlow(
      parseFlowString(`env:\n  NAME: world\n---\n- runScript: ${script}`),
      driver, { output },
    );
    assert(output['greeting'] === 'hello world', `expected "hello world", got "${output['greeting']}"`);
  } finally { await unlink(script).catch(() => {}); }
});

scriptSuite.test('command-level env overrides flow env', async () => {
  const { unlink } = await import('fs/promises');
  const script = await writeTempScript(`output.val = FRUIT;`);
  try {
    const driver = new MockIOSDriver();
    const output: Record<string, unknown> = {};
    const yaml = `env:\n  FRUIT: apple\n---\n- runScript:\n    file: ${script}\n    env:\n      FRUIT: banana`;
    await executeFlow(parseFlowString(yaml), driver, { output });
    assert(output['val'] === 'banana', `expected "banana", got "${output['val']}"`);
  } finally { await unlink(script).catch(() => {}); }
});

scriptSuite.test('top-level await works in scripts', async () => {
  const { unlink } = await import('fs/promises');
  const script = await writeTempScript(`const val = await Promise.resolve(42);\noutput.answer = val;`);
  try {
    const driver = new MockIOSDriver();
    const output: Record<string, unknown> = {};
    await executeFlow(parseFlowString(`---\n- runScript: ${script}`), driver, { output });
    assert(output['answer'] === 42, `expected 42, got ${output['answer']}`);
  } finally { await unlink(script).catch(() => {}); }
});

scriptSuite.test('json() helper parses JSON string', async () => {
  const { unlink } = await import('fs/promises');
  const script = await writeTempScript(`const obj = json('{"key":"value"}');\noutput.key = obj.key;`);
  try {
    const driver = new MockIOSDriver();
    const output: Record<string, unknown> = {};
    await executeFlow(parseFlowString(`---\n- runScript: ${script}`), driver, { output });
    assert(output['key'] === 'value', `expected "value", got "${output['key']}"`);
  } finally { await unlink(script).catch(() => {}); }
});

scriptSuite.test('output object persists across multiple runScript commands', async () => {
  const { unlink } = await import('fs/promises');
  const s1 = await writeTempScript(`output.counter = 1;`);
  const s2 = await writeTempScript(`output.counter = output.counter + 1;`);
  try {
    const driver = new MockIOSDriver();
    const output: Record<string, unknown> = {};
    await executeFlow(parseFlowString(`---\n- runScript: ${s1}\n- runScript: ${s2}`), driver, { output });
    assert(output['counter'] === 2, `expected 2, got ${output['counter']}`);
  } finally {
    await unlink(s1).catch(() => {});
    await unlink(s2).catch(() => {});
  }
});

scriptSuite.test('http.get returns status 200 and parseable JSON body', async () => {
  const { unlink } = await import('fs/promises');
  const script = await writeTempScript(`
    const res = await http.get('https://postman-echo.com/get', { params: { hello: 'world' } });
    const data = json(res.body);
    output.ok = res.ok;
    output.status = res.status;
    output.param = data.args.hello;
  `);
  try {
    const driver = new MockIOSDriver();
    const output: Record<string, unknown> = {};
    await executeFlow(parseFlowString(`---\n- runScript: ${script}`), driver, { output });
    assert(output['ok'] === true, `expected ok=true, got ${output['ok']}`);
    assert(output['status'] === 200, `expected status=200, got ${output['status']}`);
    assert(output['param'] === 'world', `expected param="world", got "${output['param']}"`);
  } finally { await unlink(script).catch(() => {}); }
});

scriptSuite.test('http.post echoes request body back', async () => {
  const { unlink } = await import('fs/promises');
  const script = await writeTempScript(`
    const res = await http.post('https://postman-echo.com/post', { body: { ping: 'pong' } });
    const data = json(res.body);
    output.ok = res.ok;
    output.status = res.status;
    output.echoed = data.json.ping;
  `);
  try {
    const driver = new MockIOSDriver();
    const output: Record<string, unknown> = {};
    await executeFlow(parseFlowString(`---\n- runScript: ${script}`), driver, { output });
    assert(output['ok'] === true, `expected ok=true, got ${output['ok']}`);
    assert(output['status'] === 200, `expected status=200, got ${output['status']}`);
    assert(output['echoed'] === 'pong', `expected echoed="pong", got "${output['echoed']}"`);
  } finally { await unlink(script).catch(() => {}); }
});

scriptSuite.test('maestro.copiedText is available in subsequent runScript', async () => {
  const { writeFile, unlink } = await import('fs/promises');
  const script = `/tmp/conductor-test-copiedtext-${Date.now()}.js`;
  await writeFile(script, `output.copied = maestro.copiedText;`);
  try {
    const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'Copied Text' }]));
    const output: Record<string, unknown> = {};
    await executeFlow(
      parseFlowString(`---\n- copyTextFrom: "Copied Text"\n- runScript: ${script}`),
      driver, { output }
    );
    assert(output['copied'] === 'Copied Text', `expected maestro.copiedText="Copied Text", got "${output['copied']}"`);
  } finally { await unlink(script).catch(() => {}); }
});

scriptSuite.test('maestro.platform is "ios" for iOS driver', async () => {
  const { writeFile, unlink } = await import('fs/promises');
  const script = `/tmp/conductor-test-platform-${Date.now()}.js`;
  await writeFile(script, `output.platform = maestro.platform;`);
  try {
    const driver = new MockIOSDriver();
    const output: Record<string, unknown> = {};
    await executeFlow(parseFlowString(`---\n- runScript: ${script}`), driver, { output });
    assert(output['platform'] === 'ios', `expected platform="ios", got "${output['platform']}"`);
  } finally { await unlink(script).catch(() => {}); }
});

scriptSuite.test('maestro.platform is "android" for Android driver', async () => {
  const { writeFile, unlink } = await import('fs/promises');
  const script = `/tmp/conductor-test-platform-android-${Date.now()}.js`;
  await writeFile(script, `output.platform = maestro.platform;`);
  try {
    const driver = new MockAndroidDriver();
    const output: Record<string, unknown> = {};
    await executeFlow(parseFlowString(`---\n- runScript: ${script}`), driver, { output });
    assert(output['platform'] === 'android', `expected platform="android", got "${output['platform']}"`);
  } finally { await unlink(script).catch(() => {}); }
});

scriptSuite.test('unknown command throws descriptive error', async () => {
  const driver = new MockIOSDriver();
  let threw = false;
  try {
    await executeFlow(parseFlowString('---\n- unknownCmd: foo'), driver);
  } catch (err) {
    threw = true;
    const msg = err instanceof Error ? err.message : String(err);
    assert(msg.includes('unknownCmd'), `error should mention command name, got: "${msg}"`);
  }
  assert(threw, 'expected error for unknown command');
});

if (require.main === module) runAll([scriptSuite]);
