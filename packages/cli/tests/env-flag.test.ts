/**
 * Tests for --env flag support on run-flow.
 *
 * Covers:
 *  - CLI env vars are interpolated into the flow at parse time
 *  - CLI env overrides the flow's own env block
 *  - Multiple --env values are all injected
 *  - CLI env is available in evalScript at runtime
 *  - CLI env is threaded into inline sub-flows (runFlow with commands)
 *  - runFlow object form passes its inline env block to the file sub-flow
 *  - Undeclared variables in when.true conditions evaluate to undefined (no throw)
 *  - ${output.nested.key} dotted paths are resolved at runtime
 */
import { writeFile, unlink } from 'fs/promises';
import { parseFlowString, executeFlow } from '../src/drivers/flow-runner.js';
import { TestSuite, assert, runAll } from './runner.js';
import { MockIOSDriver, makeIOSHierarchy } from './mock-driver.js';

async function writeTempFlow(content: string): Promise<string> {
  const p = `/tmp/conductor-test-flow-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`;
  await writeFile(p, content);
  return p;
}

export const envFlag = new TestSuite('--env flag');

// ── Parse-time interpolation ───────────────────────────────────────────────

envFlag.test('single --env var is interpolated into a flow command', () => {
  const flow = parseFlowString('---\n- tapOn: "${BTN}"', { BTN: 'Login' });
  const cmd = flow.commands[0] as Record<string, unknown>;
  assert(cmd['tapOn'] === 'Login', `expected "Login", got "${cmd['tapOn']}"`);
  return Promise.resolve();
});

envFlag.test('multiple --env vars are all injected', () => {
  const flow = parseFlowString(
    '---\n- inputText: "${USER}"\n- tapOn: "${PASS}"',
    { USER: 'alice', PASS: 'secret' }
  );
  const [a, b] = flow.commands as Record<string, unknown>[];
  assert(a['inputText'] === 'alice', `expected "alice", got "${a['inputText']}"`);
  assert(b['tapOn'] === 'secret', `expected "secret", got "${b['tapOn']}"`);
  return Promise.resolve();
});

envFlag.test('--env overrides the flow\'s own env block', () => {
  const yaml = 'env:\n  ENV: production\n---\n- tapOn: "${ENV}"';
  const flow = parseFlowString(yaml, { ENV: 'staging' });
  const cmd = flow.commands[0] as Record<string, unknown>;
  assert(cmd['tapOn'] === 'staging', `CLI env should win; got "${cmd['tapOn']}"`);
  return Promise.resolve();
});

envFlag.test('--env value that is not overriding coexists with flow env block', () => {
  const yaml = 'env:\n  APP: com.example\n---\n- tapOn: "${APP} ${LABEL}"';
  const flow = parseFlowString(yaml, { LABEL: 'Start' });
  const cmd = flow.commands[0] as Record<string, unknown>;
  assert(cmd['tapOn'] === 'com.example Start', `got "${cmd['tapOn']}"`);
  return Promise.resolve();
});

// ── Runtime availability (evalScript) ─────────────────────────────────────

envFlag.test('--env vars are available in evalScript at runtime', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([]));
  const flow = parseFlowString('---\n- evalScript: "output.result = GREETING;"', { GREETING: 'hello' });
  const output: Record<string, unknown> = {};
  await executeFlow(flow, driver, { env: { GREETING: 'hello' }, output });
  assert(output['result'] === 'hello', `expected "hello", got "${output['result']}"`);
});

// ── Threading into sub-flows ───────────────────────────────────────────────

envFlag.test('--env is threaded into inline runFlow sub-flow', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'staging', x: 0, y: 0, w: 100, h: 44 }]));
  // outer flow runs a sub-flow inline; the sub-flow uses ${ENV}
  const flow = parseFlowString(
    '---\n- runFlow:\n    commands:\n      - tapOn: "${ENV}"',
    { ENV: 'staging' }
  );
  const output: Record<string, unknown> = {};
  await executeFlow(flow, driver, { env: { ENV: 'staging' }, output });
  const taps = driver.callsTo('tap');
  assert(taps.length === 1, `expected 1 tap, got ${taps.length}`);
});

// ── runFlow object form: inline env passed to file sub-flow ───────────────

envFlag.test('runFlow inline env is passed to file sub-flow', async () => {
  // Child flow uses ${USERNAME} — only set via the parent's inline env block
  const child = await writeTempFlow('---\n- evalScript: "output.captured = USERNAME;"');
  try {
    const driver = new MockIOSDriver();
    const output: Record<string, unknown> = {};
    const yaml = [
      '---',
      '- runFlow:',
      `    file: ${child}`,
      '    env:',
      '      USERNAME: alice',
    ].join('\n');
    await executeFlow(parseFlowString(yaml), driver, { output });
    assert(output['captured'] === 'alice', `expected "alice", got "${output['captured']}"`);
  } finally { await unlink(child).catch(() => {}); }
});

envFlag.test('runFlow inline env resolves ${output.x} before passing to sub-flow', async () => {
  // Script sets output.user; parent passes it via inline env; child reads USERNAME
  const { writeFile: wf, unlink: ul } = await import('fs/promises');
  const script = `/tmp/conductor-test-s-${Date.now()}.js`;
  const child = await writeTempFlow('---\n- evalScript: "output.captured = USERNAME;"');
  await wf(script, 'output.user = "bob";');
  try {
    const driver = new MockIOSDriver();
    const output: Record<string, unknown> = {};
    const yaml = [
      '---',
      `- runScript: ${script}`,
      '- runFlow:',
      `    file: ${child}`,
      '    env:',
      '      USERNAME: "${output.user}"',
    ].join('\n');
    await executeFlow(parseFlowString(yaml), driver, { output });
    assert(output['captured'] === 'bob', `expected "bob", got "${output['captured']}"`);
  } finally {
    await ul(script).catch(() => {});
    await unlink(child).catch(() => {});
  }
});

// ── Undeclared env var in when.true condition ──────────────────────────────

envFlag.test('undeclared var in when.true evaluates to false without throwing', async () => {
  const driver = new MockIOSDriver();
  const output: Record<string, unknown> = {};
  // `auth` is never defined; the when.true should evaluate to false and skip the command
  const yaml = [
    '---',
    '- runFlow:',
    "    when:",
    "      true: \"${auth == 'sign-in'}\"",
    '    commands:',
    '      - evalScript: "output.ran = true;"',
  ].join('\n');
  await executeFlow(parseFlowString(yaml), driver, { output });
  assert(output['ran'] === undefined, `conditional block should have been skipped, but ran`);
});

// ── ${output.nested.key} dotted-path resolution ───────────────────────────

envFlag.test('${output.nested.key} resolves nested output object at runtime', async () => {
  const { writeFile: wf, unlink: ul } = await import('fs/promises');
  const script = `/tmp/conductor-test-nested-${Date.now()}.js`;
  await wf(script, 'output.profile = { username: "charlie", role: "admin" };');
  try {
    const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'charlie' }]));
    const output: Record<string, unknown> = {};
    const yaml = [
      '---',
      `- runScript: ${script}`,
      '- tapOn: "${output.profile.username}"',
    ].join('\n');
    await executeFlow(parseFlowString(yaml), driver, { output });
    assert(driver.callsTo('tap').length === 1, 'expected tap driven by nested output value');
  } finally { await ul(script).catch(() => {}); }
});

if (require.main === module) runAll([envFlag]);
