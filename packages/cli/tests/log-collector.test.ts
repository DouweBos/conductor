/**
 * Tests for LogCollector.query()'s `since` filter across mixed timestamp formats.
 */
import { LogCollector, parseLogTime } from '../src/daemon/log-collector.js';
import type { LogEntry } from '../src/drivers/log-sources/types.js';
import { TestSuite, assert } from './runner.js';

export const logCollector = new TestSuite('log collector');

function collectorWith(timestamps: string[]): LogCollector {
  const c = new LogCollector('ios', 'TEST-UDID', 0);
  const push = (c as unknown as { pushEntry(e: LogEntry): void }).pushEntry.bind(c);
  for (const timestamp of timestamps) {
    push({ timestamp, level: 'info', message: timestamp, stackTrace: null, source: 'device' });
  }
  return c;
}

logCollector.test('parseLogTime normalizes simctl timestamps', () => {
  const simctl = parseLogTime('2026-10-04 20:58:54.12+0200');
  const iso = parseLogTime('2026-10-04T18:58:54.120Z');
  assert(simctl === iso, `expected ${iso}, got ${simctl}`);
  assert(Number.isNaN(parseLogTime('garbage')), 'garbage should be NaN');
  return Promise.resolve();
});

logCollector.test('ISO-UTC since matches later simctl entries', () => {
  const c = collectorWith([
    '2026-10-04 20:58:53.900000+0200',
    '2026-10-04 20:58:54.000000+0200',
    '2026-10-04 20:58:54.120000+0200',
    '2026-10-04 21:00:00.000000+0200',
  ]);
  const got = c.query({ since: '2026-10-04T18:58:54Z' }).map((e) => e.timestamp);
  assert(
    got.length === 2 &&
      got[0] === '2026-10-04 20:58:54.120000+0200' &&
      got[1] === '2026-10-04 21:00:00.000000+0200',
    `unexpected entries: ${JSON.stringify(got)}`
  );
  return Promise.resolve();
});

logCollector.test('simctl since (last-seen entry) excludes itself', () => {
  const c = collectorWith(['2026-10-04 20:58:54.120000+0200', '2026-10-04 20:58:55.000000+0200']);
  const got = c.query({ since: '2026-10-04 20:58:54.120000+0200' });
  assert(got.length === 1 && got[0].message.includes('20:58:55'), `got ${got.length} entries`);
  return Promise.resolve();
});

logCollector.test('unparsable timestamps fall back to lexical comparison', () => {
  const c = collectorWith(['10-04 20:58:54.120', '10-04 20:58:55.000']);
  const got = c.query({ since: '10-04 20:58:54.120' });
  assert(got.length === 1 && got[0].timestamp === '10-04 20:58:55.000', `got ${got.length} entries`);
  return Promise.resolve();
});
