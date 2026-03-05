import path from 'path';
import { parseFlowFile, parseFlowString } from '../src/drivers/flow-runner.js';
import { TestSuite, runAll } from './runner.js';

const FLOWS = path.join(__dirname, '../../tests/flows');

export const parser = new TestSuite('YAML Parser');

parser.test('parses appId from two-document flow', async () => {
  const flow = parseFlowString('appId: com.example.app\n---\n- tapOn: "OK"');
  if (flow.appId !== 'com.example.app') throw new Error(`expected appId, got "${flow.appId}"`);
  if (flow.commands.length !== 1) throw new Error(`expected 1 command, got ${flow.commands.length}`);
});

parser.test('parses list of commands', async () => {
  const flow = parseFlowString('appId: com.example.app\n---\n- tapOn: "A"\n- inputText: "B"');
  if (flow.commands.length !== 2) throw new Error(`expected 2 commands, got ${flow.commands.length}`);
});

parser.test('wraps single non-list command in an array', async () => {
  const flow = parseFlowString('appId: com.example.app\n---\ntapOn: "OK"');
  if (flow.commands.length !== 1) throw new Error(`expected 1 command, got ${flow.commands.length}`);
});

parser.test('commands-only document (no appId header)', async () => {
  const flow = parseFlowString('- tapOn: "OK"\n- inputText: "Hi"');
  if (flow.commands.length !== 2) throw new Error(`expected 2 commands, got ${flow.commands.length}`);
  if (flow.appId !== undefined) throw new Error('expected no appId');
});

parser.test('interpolates ${VAR} from header env block', async () => {
  const yaml = 'appId: com.example\nenv:\n  BTN: Submit\n---\n- tapOn: "${BTN}"';
  const flow = parseFlowString(yaml);
  const cmd = flow.commands[0] as Record<string, unknown>;
  if (cmd['tapOn'] !== 'Submit') throw new Error(`expected "Submit", got "${cmd['tapOn']}"`);
});

parser.test('interpolates ${VAR} from extraEnv argument', async () => {
  const yaml = 'appId: com.example\n---\n- tapOn: "${LABEL}"';
  const flow = parseFlowString(yaml, { LABEL: 'Confirm' });
  const cmd = flow.commands[0] as Record<string, unknown>;
  if (cmd['tapOn'] !== 'Confirm') throw new Error(`expected "Confirm", got "${cmd['tapOn']}"`);
});

parser.test('leaves unknown ${VAR} unreplaced', async () => {
  const yaml = 'appId: com.example\n---\n- tapOn: "${MISSING}"';
  const flow = parseFlowString(yaml);
  const cmd = flow.commands[0] as Record<string, unknown>;
  if (cmd['tapOn'] !== '${MISSING}') throw new Error(`expected literal placeholder, got "${cmd['tapOn']}"`);
});

parser.test('parseFlowFile reads file from disk (basic.yaml)', async () => {
  const flow = await parseFlowFile(path.join(FLOWS, 'basic.yaml'));
  if (flow.appId !== 'com.example.app') throw new Error(`appId mismatch: "${flow.appId}"`);
  if (flow.commands.length !== 3) throw new Error(`expected 3 commands, got ${flow.commands.length}`);
});

parser.test('parseFlowFile reads env-vars.yaml and resolves env', async () => {
  const flow = await parseFlowFile(path.join(FLOWS, 'env-vars.yaml'));
  const cmd = flow.commands[0] as Record<string, unknown>;
  if (cmd['tapOn'] !== 'Submit') throw new Error(`expected "Submit", got "${cmd['tapOn']}"`);
});

parser.test('${1 + 1} evaluates to "2"', async () => {
  const flow = parseFlowString('---\n- tapOn: "${1 + 1}"');
  const cmd = flow.commands[0] as Record<string, unknown>;
  if (cmd['tapOn'] !== '2') throw new Error(`expected "2", got "${cmd['tapOn']}"`);
});

parser.test('${expr with env var} evaluates using env', async () => {
  const flow = parseFlowString("env:\n  NAME: world\n---\n- tapOn: \"${'Hello ' + NAME}\"");
  const cmd = flow.commands[0] as Record<string, unknown>;
  if (cmd['tapOn'] !== 'Hello world') throw new Error(`expected "Hello world", got "${cmd['tapOn']}"`);
});

parser.test('${output.x} is NOT evaluated at parse time', async () => {
  const flow = parseFlowString('---\n- tapOn: "${output.label}"');
  const cmd = flow.commands[0] as Record<string, unknown>;
  if (cmd['tapOn'] !== '${output.label}') throw new Error(`expected literal placeholder, got "${cmd['tapOn']}"`);
});

parser.test('invalid JS expression leaves placeholder intact', async () => {
  const flow = parseFlowString('---\n- tapOn: "${!!@@}"');
  const cmd = flow.commands[0] as Record<string, unknown>;
  if (!(typeof cmd['tapOn'] === 'string' && (cmd['tapOn'] as string).includes('!!@@'))) {
    throw new Error(`expected placeholder, got "${cmd['tapOn']}"`);
  }
});

if (require.main === module) runAll([parser]);
