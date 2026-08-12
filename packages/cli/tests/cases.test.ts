import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { casesReport, casesResult, loadCases, parseJunit, storeDir } from '../src/commands/cases.js';
import { TestSuite } from './runner.js';

export const cases = new TestSuite('Test cases');

/** A project with three cases, in a throwaway Studio store. */
function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'conductor-cases-'));
  // Cases live outside the repo; point the store somewhere disposable.
  process.env.__CONDUCTOR_STUDIO_DIR = path.join(root, 'studio');
  mkdirSync(storeDir(root), { recursive: true });
  writeFileSync(
    path.join(storeDir(root), 'DT-1.yaml'),
    [
      'id: DT-1',
      "title: 'Playback works'",
      'altIds: [DM-101]',
      'tags:',
      "  platform: [tv, mobile]",
      'flows:',
      '  tv: flows/player/vod-playback.tv.yaml',
      '  mobile: flows/player/vod-playback.responsive.yaml',
      '',
    ].join('\n')
  );
  writeFileSync(
    path.join(storeDir(root), 'DT-9.yaml'),
    ['id: DT-9', "title: 'Watchlist hub'", 'flow: flows/discover/watchlist.yaml', ''].join('\n')
  );
  writeFileSync(
    path.join(storeDir(root), 'DT-97.yaml'),
    ['id: DT-97', "title: 'Search returns results'", ''].join('\n')
  );
  return root;
}

function results(root: string): Record<string, unknown>[] {
  const file = path.join(storeDir(root), 'results.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

cases.test('reads ids, titles and per-platform flows', async () => {
  const loaded = await loadCases(fixture());
  if (loaded.length !== 3) throw new Error(`expected 3 cases, got ${loaded.length}`);
  const dt1 = loaded.find((c) => c.id === 'DT-1');
  if (dt1?.flows?.tv !== 'flows/player/vod-playback.tv.yaml') {
    throw new Error(`flows block not parsed: ${JSON.stringify(dt1)}`);
  }
  if (loaded.find((c) => c.id === 'DT-9')?.flow !== 'flows/discover/watchlist.yaml') {
    throw new Error('bare flow not parsed');
  }
});

cases.test('still reads cases an older version left in the repo', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conductor-legacy-'));
  process.env.__CONDUCTOR_STUDIO_DIR = path.join(root, 'studio');
  mkdirSync(path.join(root, 'test-cases'), { recursive: true });
  writeFileSync(
    path.join(root, 'test-cases', 'OLD-1.yaml'),
    ['id: OLD-1', "title: 'Left in the repo'", ''].join('\n')
  );
  const loaded = await loadCases(root);
  if (loaded.length !== 1 || loaded[0].id !== 'OLD-1') {
    throw new Error(`expected the in-repo case, got ${JSON.stringify(loaded)}`);
  }
});

cases.test('parses JUnit testcases with failures and skips', async () => {
  const parsed = parseJunit(
    `<testsuite>
       <testcase classname="a" name="one.yaml"/>
       <testcase classname="a" name="two.yaml"><failure message="x">boom</failure></testcase>
       <testcase name="three.yaml"><skipped/></testcase>
     </testsuite>`
  );
  if (parsed.length !== 3) throw new Error(`expected 3 entries, got ${parsed.length}`);
  if (!parsed[1].failed) throw new Error('failure not detected');
  if (!parsed[2].skipped) throw new Error('skip not detected');
});

cases.test('binds report entries to the right case and column', async () => {
  const root = fixture();
  const junit = path.join(root, 'report.xml');
  writeFileSync(
    junit,
    `<testsuite>
       <testcase name="flows/player/vod-playback.tv.yaml"/>
       <testcase name="vod-playback.responsive.yaml"><failure>nope</failure></testcase>
     </testsuite>`
  );
  await casesReport(root, junit, { json: true, build: '1.2.3' });
  const filed = results(root);
  if (filed.length !== 2) throw new Error(`expected 2 results, got ${filed.length}`);
  const tv = filed.find((r) => r.column === 'tv');
  const mobile = filed.find((r) => r.column === 'mobile');
  if (tv?.caseId !== 'DT-1' || tv?.verdict !== 'passed') throw new Error('tv result wrong');
  if (mobile?.verdict !== 'failed') throw new Error('mobile result wrong');
  if (tv?.build !== '1.2.3') throw new Error('build not recorded');
});

cases.test('id match is whole-word and case-wide, not per column', async () => {
  const root = fixture();
  const junit = path.join(root, 'report.xml');
  writeFileSync(junit, `<testsuite><testcase name="DT-97 search returns results"/></testsuite>`);
  await casesReport(root, junit, { json: true });
  const filed = results(root);
  // DT-9 must not claim a test named for DT-97, and an id match names no column.
  if (filed.length !== 1) throw new Error(`expected 1 result, got ${JSON.stringify(filed)}`);
  if (filed[0].caseId !== 'DT-97') throw new Error(`bound to ${filed[0].caseId}`);
  if (filed[0].column !== undefined) throw new Error('id match should not pick a column');
});

cases.test('unmatched tests are reported, not recorded', async () => {
  const root = fixture();
  const junit = path.join(root, 'report.xml');
  writeFileSync(junit, `<testsuite><testcase name="something-else.yaml"/></testsuite>`);
  await casesReport(root, junit, { json: true });
  if (results(root).length !== 0) throw new Error('recorded a result for an unmatched test');
});

cases.test('records a single verdict and rejects unknown ids', async () => {
  const root = fixture();
  if ((await casesResult(root, 'DT-1', 'failed', { json: true, note: 'flaky' })) !== 0) {
    throw new Error('expected success');
  }
  const [filed] = results(root);
  if (filed.caseId !== 'DT-1' || filed.verdict !== 'failed' || filed.note !== 'flaky') {
    throw new Error(`bad record: ${JSON.stringify(filed)}`);
  }
  if ((await casesResult(root, 'NOPE-1', 'passed', { json: true })) === 0) {
    throw new Error('expected failure for an unknown case id');
  }
});
