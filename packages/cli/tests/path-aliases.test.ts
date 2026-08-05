import path from 'path';
import { TestSuite } from './runner.js';
import { resolvePath } from '../src/drivers/flow-runner.js';

const WS = path.join(__dirname, '../../tests/flows/path-aliases');
const DEEP = path.join(WS, 'feature/deep'); // where flowA.yaml lives — walk-up root for aliases

export const pathAliases = new TestSuite('Flow path aliases');

pathAliases.test('@alias/rest resolves via nearest config.yaml paths map', async () => {
  const got = resolvePath('@commands/login.yaml', DEEP);
  const want = path.join(WS, 'shared/commands/login.yaml');
  if (got !== want) throw new Error(`expected ${want}, got ${got}`);
});

pathAliases.test('alias with no remainder resolves to the target directory', async () => {
  const got = resolvePath('@commands', DEEP);
  const want = path.join(WS, 'shared/commands');
  if (got !== want) throw new Error(`expected ${want}, got ${got}`);
});

pathAliases.test('config.yaml is found by walking up from a nested flow dir', async () => {
  const got = resolvePath('@media/pic.png', DEEP);
  const want = path.join(WS, 'media/pic.png');
  if (got !== want) throw new Error(`expected ${want}, got ${got}`);
});

pathAliases.test('non-alias relative paths are unchanged (relative to cwd)', async () => {
  const got = resolvePath('sub/x.yaml', DEEP);
  const want = path.join(DEEP, 'sub/x.yaml');
  if (got !== want) throw new Error(`expected ${want}, got ${got}`);
});

pathAliases.test('absolute paths pass through untouched', async () => {
  const abs = path.join(WS, 'shared/commands/login.yaml');
  if (resolvePath(abs, DEEP) !== abs) throw new Error('absolute path should be unchanged');
});

pathAliases.test('unknown alias throws with the known-alias list', async () => {
  try {
    resolvePath('@nope/x.yaml', DEEP);
  } catch (e) {
    const msg = (e as Error).message;
    if (!msg.includes("Unknown path alias '@nope'") || !msg.includes('commands')) {
      throw new Error(`unexpected message: ${msg}`);
    }
    return;
  }
  throw new Error('expected unknown-alias error');
});

pathAliases.test('alias pointing at a missing directory throws', async () => {
  try {
    resolvePath('@broken/x.yaml', DEEP);
  } catch (e) {
    if (!(e as Error).message.includes('not an existing directory')) {
      throw new Error(`unexpected message: ${(e as Error).message}`);
    }
    return;
  }
  throw new Error('expected missing-directory error');
});

pathAliases.test('alias without any config.yaml in the tree throws a clear error', async () => {
  try {
    resolvePath('@commands/x.yaml', path.join(__dirname, '../../..')); // repo root: no config.yaml
  } catch (e) {
    if (!(e as Error).message.includes('no config.yaml was found')) {
      throw new Error(`unexpected message: ${(e as Error).message}`);
    }
    return;
  }
  throw new Error('expected no-config error');
});
