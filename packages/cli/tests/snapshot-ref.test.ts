/**
 * Unit tests for snapshot-scoped ephemeral element refs (`@eN`).
 *
 * Covers ref-query detection, building a stored snapshot from an a11y snapshot,
 * the save/load round-trip, and `resolveRef` (including staleness detection).
 */
import fs from 'fs/promises';
import { TestSuite, assert } from './runner.js';
import {
  isRefQuery,
  buildStoredSnapshot,
  saveSnapshot,
  loadSnapshot,
  resolveRef,
  snapshotFilePath,
  SNAPSHOT_STALE_MS,
} from '../src/snapshot-store.js';
import type { A11ySnapshotEntry } from '../src/drivers/a11y.js';

export const snapshotRef = new TestSuite('snapshot-ref');

function entry(ref: string, x: number, y: number, label: string): A11ySnapshotEntry {
  const order = Number(ref.replace(/\D/g, '')) - 1;
  return {
    nodeId: `0.${order}`,
    ref,
    order,
    frame: { x, y, w: 100, h: 40 },
    label,
    hint: '',
    role: 'button',
    traits: ['button'],
    announcement: label,
    value: '',
    state: { enabled: true, selected: false, focused: false },
  };
}

snapshotRef.test('isRefQuery accepts @eN, rejects everything else', async () => {
  assert(isRefQuery('@e1'), '@e1 is a ref');
  assert(isRefQuery('@e42'), '@e42 is a ref');
  assert(isRefQuery('  @e3  '), 'surrounding whitespace is tolerated');
  assert(isRefQuery('@E5'), 'ref matching is case-insensitive');
  assert(!isRefQuery('e3'), 'missing @ is not a ref');
  assert(!isRefQuery('@e'), '@e with no digits is not a ref');
  assert(!isRefQuery('@email'), '@email is not a ref');
  assert(!isRefQuery('Sign in'), 'plain text is not a ref');
});

snapshotRef.test('buildStoredSnapshot maps refs to center points', async () => {
  const snap = buildStoredSnapshot(
    [entry('@e1', 10, 20, 'First'), entry('@e2', 0, 100, 'Second')],
    { deviceId: 'sess', platform: 'ios' }
  );
  assert(Object.keys(snap.refs).length === 2, 'two refs stored');
  assert(snap.refs['@e1'].centerX === 60, 'center x = x + w/2 (10 + 50)');
  assert(snap.refs['@e1'].centerY === 40, 'center y = y + h/2 (20 + 20)');
  assert(snap.refs['@e2'].label === 'Second', 'label is carried through');
  assert(snap.version === 1 && snap.platform === 'ios', 'metadata is set');
});

snapshotRef.test('saveSnapshot / loadSnapshot round-trip', async () => {
  const session = `__conductor_test_${process.pid}__`;
  try {
    const snap = buildStoredSnapshot([entry('@e1', 10, 20, 'OK')], {
      deviceId: session,
      platform: 'android',
    });
    await saveSnapshot(session, snap);
    const loaded = await loadSnapshot(session);
    assert(loaded !== null, 'snapshot loads back');
    assert(loaded!.refs['@e1'].label === 'OK', 'round-tripped ref is intact');
  } finally {
    await fs.unlink(snapshotFilePath(session)).catch(() => {});
  }
});

snapshotRef.test('loadSnapshot returns null when no snapshot exists', async () => {
  const loaded = await loadSnapshot(`__conductor_missing_${process.pid}__`);
  assert(loaded === null, 'missing snapshot resolves to null');
});

snapshotRef.test('resolveRef returns the entry for a known fresh ref', async () => {
  const snap = buildStoredSnapshot([entry('@e3', 0, 0, 'Go')], {
    deviceId: 'sess',
    platform: 'ios',
  });
  const res = resolveRef(snap, '@e3', { deviceId: 'sess' });
  assert(res.entry.label === 'Go', 'resolves to the right entry');
  assert(res.staleReason === null, 'a just-built snapshot is not stale');
});

snapshotRef.test('resolveRef is case-insensitive on the ref', async () => {
  const snap = buildStoredSnapshot([entry('@e1', 0, 0, 'A')], {
    deviceId: 'sess',
    platform: 'ios',
  });
  assert(resolveRef(snap, '@E1').entry.ref === '@e1', '@E1 resolves @e1');
});

snapshotRef.test('resolveRef throws when there is no snapshot', async () => {
  let threw = false;
  try {
    resolveRef(null, '@e1');
  } catch (err) {
    threw = true;
    assert(err instanceof Error && /capture-ui/.test(err.message), 'message points at capture-ui');
  }
  assert(threw, 'should throw with no snapshot');
});

snapshotRef.test('resolveRef throws for an unknown ref', async () => {
  const snap = buildStoredSnapshot([entry('@e1', 0, 0, 'A')], {
    deviceId: 'sess',
    platform: 'ios',
  });
  let threw = false;
  try {
    resolveRef(snap, '@e9');
  } catch (err) {
    threw = true;
    assert(err instanceof Error && /not in the last snapshot/.test(err.message), 'clear message');
  }
  assert(threw, 'should throw for a ref outside the snapshot');
});

snapshotRef.test('resolveRef flags an aged snapshot as stale', async () => {
  const snap = buildStoredSnapshot([entry('@e1', 0, 0, 'A')], {
    deviceId: 'sess',
    platform: 'ios',
  });
  snap.capturedAt = new Date(Date.now() - SNAPSHOT_STALE_MS - 5_000).toISOString();
  const res = resolveRef(snap, '@e1');
  assert(res.staleReason !== null && /old/.test(res.staleReason), 'age staleness is reported');
  assert(res.entry.label === 'A', 'still resolves the entry despite staleness');
});

snapshotRef.test('resolveRef flags a device mismatch as stale', async () => {
  const snap = buildStoredSnapshot([entry('@e1', 0, 0, 'A')], {
    deviceId: 'deviceA',
    platform: 'ios',
  });
  const res = resolveRef(snap, '@e1', { deviceId: 'deviceB' });
  assert(
    res.staleReason !== null && /different device/.test(res.staleReason),
    'device mismatch is reported'
  );
});
