import { TestSuite } from './runner.js';
import { assertTrue } from '../src/commands/assert-true.js';

export const maestroParity = new TestSuite('Maestro-parity commands');

maestroParity.test('assert-true: truthy expression exits 0', async () => {
  const code = await assertTrue('1 + 1 === 2', { json: false });
  if (code !== 0) throw new Error(`expected exit 0, got ${code}`);
});

maestroParity.test('assert-true: falsy expression exits 1', async () => {
  const code = await assertTrue('1 > 2', { json: false });
  if (code !== 1) throw new Error(`expected exit 1, got ${code}`);
});

maestroParity.test('assert-true: reads injected env var', async () => {
  const pass = await assertTrue('Number(N) > 5', { json: false }, { N: '10' });
  const fail = await assertTrue('Number(N) > 5', { json: false }, { N: '2' });
  if (pass !== 0) throw new Error(`expected pass exit 0, got ${pass}`);
  if (fail !== 1) throw new Error(`expected fail exit 1, got ${fail}`);
});

maestroParity.test('assert-true: empty expression exits 1', async () => {
  const code = await assertTrue('', { json: false });
  if (code !== 1) throw new Error(`expected exit 1 for empty expr, got ${code}`);
});

maestroParity.test('assert-true: syntax error is caught, exits 1', async () => {
  const code = await assertTrue('this is not js', { json: false });
  if (code !== 1) throw new Error(`expected exit 1 for bad expr, got ${code}`);
});
