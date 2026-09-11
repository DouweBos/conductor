/**
 * Unit tests for the N-way parity matrix.
 *
 * Covers target parsing, the checkpoint × target grid, and the cross-target
 * rollup — in particular the universal-finding signal, which is the one thing a
 * matrix can tell you that N separate two-way comparisons cannot.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TestSuite, assert } from './runner.js';
import { buildMatrix, findingSignature, renderMatrixText } from '../src/parity/matrix.js';
import { parseTargets, uniqueCheckpointName } from '../src/commands/parity.js';
import { RunWriter } from '../src/parity/store.js';
import type { A11ySnapshotEntry } from '../src/drivers/a11y.js';
import type { CapturePlatform } from '../src/parity/capture.js';

export const parityMatrix = new TestSuite('parity-matrix');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

function el(
  order: number,
  identifier: string,
  label: string,
  y: number,
  focused = false
): A11ySnapshotEntry {
  return {
    nodeId: `n${order}`,
    identifier,
    ref: `@e${order + 1}`,
    order,
    frame: { x: 100, y, w: 400, h: 80 },
    label,
    hint: '',
    role: 'button',
    traits: ['button'],
    announcement: label,
    value: '',
    state: { enabled: true, selected: false, focused },
  };
}

/** Write a run directory with the given checkpoints. */
function writeRun(
  root: string,
  name: string,
  role: 'reference' | 'candidate',
  platform: CapturePlatform,
  checkpoints: Array<[string, A11ySnapshotEntry[]]>
): string {
  const dir = path.join(root, name);
  const w = new RunWriter(dir, { role, deviceId: name, label: name });
  for (const [cpName, entries] of checkpoints) {
    w.add(cpName, {
      platform,
      width: 1920,
      height: 1080,
      hierarchy: {},
      a11ySnapshot: entries,
      screenshot: PNG,
    });
  }
  w.finish();
  return dir;
}

/** The reference home screen: three rows, focus on the first. */
function home(): A11ySnapshotEntry[] {
  return [
    el(0, 'continue-button', 'Continue Watching', 200, true),
    el(1, 'browse-button', 'Browse', 300),
    el(2, 'settings-button', 'Settings', 400),
  ];
}

function withTempRoot<T>(fn: (root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-matrix-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ── Target parsing ───────────────────────────────────────────────────────────

parityMatrix.test('parseTargets reads label=device pairs', async () => {
  const parsed = parseTargets(['tvOS=ABC-123', 'Android TV=emulator-5554']);
  assert(parsed.length === 2, 'two targets');
  assert(parsed[0].label === 'tvOS' && parsed[0].device === 'ABC-123', 'first pair');
  assert(parsed[1].label === 'Android TV', 'labels may contain spaces');
});

parityMatrix.test('parseTargets keeps a device id containing =', async () => {
  // Web device ids can carry CDP coordinates, which contain '='.
  const [t] = parseTargets(['Lightning=web:cdp:9222:a=b']);
  assert(t.device === 'web:cdp:9222:a=b', `only the first = splits, got "${t.device}"`);
});

parityMatrix.test('parseTargets rejects malformed and duplicate targets', async () => {
  for (const bad of ['tvOS', '=device', 'tvOS=']) {
    let threw = false;
    try {
      parseTargets([bad]);
    } catch {
      threw = true;
    }
    assert(threw, `"${bad}" is rejected`);
  }
  let dup = false;
  try {
    parseTargets(['tvOS=a', 'tvOS=b']);
  } catch {
    dup = true;
  }
  assert(dup, 'a repeated label is rejected — it would collide in the grid');
});

parityMatrix.test('parseTargets returns nothing when the flag is absent', async () => {
  assert(parseTargets(undefined).length === 0, 'no targets');
});

// ── The grid ─────────────────────────────────────────────────────────────────

parityMatrix.test('a matrix reports each target independently', async () => {
  withTempRoot((root) => {
    const ref = writeRun(root, 'reference', 'reference', 'ios', [['home', home()]]);
    // tvOS matches; Android TV reworded a label.
    const tvos = writeRun(root, 'tvOS', 'candidate', 'tvos', [['home', home()]]);
    const androidtv = writeRun(root, 'Android TV', 'candidate', 'android', [
      [
        'home',
        [el(0, 'continue-button', 'Continue Watching', 200, true), el(1, 'browse-button', 'Browse', 300), el(2, 'settings-button', 'Preferences', 400)],
      ],
    ]);

    const m = buildMatrix(ref, [
      { label: 'tvOS', dir: tvos },
      { label: 'Android TV', dir: androidtv },
    ]);

    assert(!m.passed, 'the matrix fails when any target fails');
    assert(m.summary.targets === 2 && m.summary.targetsPassed === 1, '1 of 2 targets at parity');
    const row = m.rows.find((r) => r.checkpoint === 'home');
    assert(row !== undefined, 'the home row exists');
    assert(row.cells[0].status === 'pass', 'tvOS passes');
    assert(row.cells[1].status === 'fail', 'Android TV fails');
    assert(row.cells[1].blocking === 1, 'and carries one blocking finding');
  });
});

parityMatrix.test('a checkpoint a target never reached shows as a failure, not a gap', async () => {
  withTempRoot((root) => {
    const ref = writeRun(root, 'reference', 'reference', 'ios', [
      ['home', home()],
      ['detail', [el(0, 'play-button', 'Play', 700, true)]],
    ]);
    const vega = writeRun(root, 'VegaOS', 'candidate', 'vega', [['home', home()]]);

    const m = buildMatrix(ref, [{ label: 'VegaOS', dir: vega }]);
    const detail = m.rows.find((r) => r.checkpoint === 'detail');
    assert(detail !== undefined, 'the detail row is still in the grid');
    assert(detail.cells[0].status === 'fail', 'a journey that diverged is a failure');
    assert(
      m.shared.some((s) => s.kind === 'checkpoint-missing'),
      'and it surfaces in the rollup'
    );
  });
});

parityMatrix.test('rows follow the reference order, with target-only checkpoints appended', async () => {
  withTempRoot((root) => {
    const ref = writeRun(root, 'reference', 'reference', 'ios', [
      ['home', home()],
      ['detail', [el(0, 'play-button', 'Play', 700)]],
    ]);
    const t = writeRun(root, 'tvOS', 'candidate', 'tvos', [
      ['detail', [el(0, 'play-button', 'Play', 700)]],
      ['home', home()],
      ['extra-screen', [el(0, 'x-button', 'X', 100)]],
    ]);

    const m = buildMatrix(ref, [{ label: 'tvOS', dir: t }]);
    assert(
      m.rows.map((r) => r.checkpoint).join(',') === 'home,detail,extra-screen',
      `expected reference order then extras, got ${m.rows.map((r) => r.checkpoint).join(',')}`
    );
  });
});

// ── The cross-target rollup ──────────────────────────────────────────────────

parityMatrix.test('a finding on every target is marked universal', async () => {
  withTempRoot((root) => {
    const ref = writeRun(root, 'reference', 'reference', 'ios', [['home', home()]]);
    // All three rebuilds lack the same row. Independent teams rarely drop the
    // same control — this should point at the reference.
    const without = home().filter((e) => e.identifier !== 'browse-button');
    const dirs = (['tvOS', 'Android TV', 'VegaOS'] as const).map((label, i) => ({
      label,
      dir: writeRun(root, label, 'candidate', (['tvos', 'android', 'vega'] as const)[i], [
        ['home', without],
      ]),
    }));

    const m = buildMatrix(ref, dirs);
    const universal = m.shared.filter((s) => s.universal);
    assert(universal.length === 1, `exactly one universal finding, got ${universal.length}`);
    assert(universal[0].kind === 'missing', 'it is the dropped row');
    assert(universal[0].subject === 'browse-button', 'named by its identifier');
    assert(universal[0].targets.length === 3, 'all three targets report it');
    assert(m.summary.universal === 1, 'and the summary counts it');
    assert(m.shared[0].universal, 'universal findings sort first');
  });
});

parityMatrix.test('a finding on one target is not universal', async () => {
  withTempRoot((root) => {
    const ref = writeRun(root, 'reference', 'reference', 'ios', [['home', home()]]);
    const good = writeRun(root, 'tvOS', 'candidate', 'tvos', [['home', home()]]);
    const bad = writeRun(root, 'VegaOS', 'candidate', 'vega', [
      ['home', home().filter((e) => e.identifier !== 'browse-button')],
    ]);

    const m = buildMatrix(ref, [
      { label: 'tvOS', dir: good },
      { label: 'VegaOS', dir: bad },
    ]);
    const missing = m.shared.filter((s) => s.kind === 'missing');
    assert(missing.length === 1, 'one missing finding');
    assert(!missing[0].universal, 'it belongs to one target, not the reference');
    assert(missing[0].targets.join() === 'VegaOS', 'and names that target');
    assert(m.summary.universal === 0, 'nothing is universal');
  });
});

parityMatrix.test('a single target is never universal — there is nothing to agree with', async () => {
  withTempRoot((root) => {
    const ref = writeRun(root, 'reference', 'reference', 'ios', [['home', home()]]);
    const one = writeRun(root, 'tvOS', 'candidate', 'tvos', [
      ['home', home().filter((e) => e.identifier !== 'browse-button')],
    ]);
    const m = buildMatrix(ref, [{ label: 'tvOS', dir: one }]);
    assert(m.summary.universal === 0, 'one target cannot corroborate itself');
  });
});

parityMatrix.test('the same divergence on several targets collapses into one row', async () => {
  withTempRoot((root) => {
    const ref = writeRun(root, 'reference', 'reference', 'ios', [['home', home()]]);
    const reworded = home().map((e) =>
      e.identifier === 'settings-button' ? { ...e, label: 'Preferences' } : e
    );
    const a = writeRun(root, 'tvOS', 'candidate', 'tvos', [['home', reworded]]);
    const b = writeRun(root, 'VegaOS', 'candidate', 'vega', [['home', reworded]]);

    const m = buildMatrix(ref, [
      { label: 'tvOS', dir: a },
      { label: 'VegaOS', dir: b },
    ]);
    const text = m.shared.filter((s) => s.kind === 'text');
    assert(text.length === 1, `one grouped row, got ${text.length}`);
    assert(text[0].targets.length === 2, 'listing both targets');
  });
});

parityMatrix.test('findingSignature groups by subject and kind, not by wording', async () => {
  const base = { kind: 'missing' as const, severity: 'blocking' as const, detail: 'anything' };
  const a = findingSignature('home', { ...base, identifier: 'browse-button', role: 'button' });
  const b = findingSignature('home', {
    ...base,
    detail: 'worded differently',
    identifier: 'browse-button',
    role: 'button',
  });
  assert(a === b, 'the same element and kind share a signature');
  const other = findingSignature('detail', { ...base, identifier: 'browse-button', role: 'button' });
  assert(a !== other, 'a different checkpoint is a different signature');
});

parityMatrix.test('buildMatrix refuses an empty target list', async () => {
  withTempRoot((root) => {
    const ref = writeRun(root, 'reference', 'reference', 'ios', [['home', home()]]);
    let threw = false;
    try {
      buildMatrix(ref, []);
    } catch {
      threw = true;
    }
    assert(threw, 'a matrix needs at least one target');
  });
});

// ── Rendering ────────────────────────────────────────────────────────────────

parityMatrix.test('the text grid names every target and checkpoint', async () => {
  withTempRoot((root) => {
    const ref = writeRun(root, 'reference', 'reference', 'ios', [['home', home()]]);
    const t1 = writeRun(root, 'tvOS', 'candidate', 'tvos', [['home', home()]]);
    const t2 = writeRun(root, 'Lightning', 'candidate', 'web', [['home', home()]]);
    const text = renderMatrixText(
      buildMatrix(ref, [
        { label: 'tvOS', dir: t1 },
        { label: 'Lightning', dir: t2 },
      ])
    );
    assert(text.includes('tvOS') && text.includes('Lightning'), 'both columns are labelled');
    assert(text.includes('home'), 'the checkpoint row is present');
    assert(text.includes('2/2 targets at parity'), `summary line, got:\n${text}`);
  });
});

// ── Flow-less snaps ──────────────────────────────────────────────────────────

parityMatrix.test('a snap name is reused until it collides, then numbered', async () => {
  withTempRoot((root) => {
    const dir = path.join(root, 'reference');
    // Nothing recorded yet — the name is free.
    assert(uniqueCheckpointName(dir, 'home') === 'home', 'first snap keeps its name');

    const w = new RunWriter(dir, { role: 'reference', deviceId: 'ref', label: 'Reference' });
    w.add('home', {
      platform: 'ios',
      width: 1920,
      height: 1080,
      hierarchy: {},
      a11ySnapshot: home(),
      screenshot: PNG,
    });
    w.finish();

    assert(uniqueCheckpointName(dir, 'home') === 'home-2', 'a repeat is numbered');
    assert(uniqueCheckpointName(dir, 'detail') === 'detail', 'an unused name is untouched');
  });
});

parityMatrix.test('snapped screens pair across runs when the name matches', async () => {
  withTempRoot((root) => {
    // What a two-snap session leaves on disk: same names on both sides.
    const write = (name: string, role: 'reference' | 'candidate', second: A11ySnapshotEntry[]) =>
      writeRun(root, name, role, role === 'reference' ? 'ios' : 'tvos', [
        ['home', home()],
        ['detail', second],
      ]);

    const ref = write('reference', 'reference', [el(0, 'play-button', 'Play', 700)]);
    // The target's second screen lost the Play button.
    const target = write('tvOS', 'candidate', []);

    const m = buildMatrix(ref, [{ label: 'tvOS', dir: target }]);
    assert(m.rows.length === 2, `both snapped screens are rows, got ${m.rows.length}`);
    assert(m.rows[0].passed, 'the first screen matches');
    assert(!m.rows[1].passed, 'the second does not');
    assert(
      m.shared.some((s) => s.kind === 'missing' && s.subject === 'play-button'),
      'and the dropped control is named',
    );
  });
});

// ── Spec references ──────────────────────────────────────────────────────────

import { specToSnapshot, validateSpec } from '../src/commands/parity-spec.js';

parityMatrix.test('a spec becomes an a11y snapshot the diff can read', async () => {
  const snap = specToSnapshot({
    width: 1920,
    height: 1080,
    elements: [
      { identifier: 'browse-button', label: 'Browse', role: 'button', frame: { x: 100, y: 300, w: 400, h: 80 }, focused: true },
      { label: 'Title', frame: { x: 100, y: 100, w: 600, h: 60 } },
    ],
  });
  assert(snap.length === 2, 'one entry per element');
  assert(snap[0].identifier === 'browse-button' && snap[0].state.focused, 'identity and focus carry');
  assert(snap[1].role === '' && snap[1].label === 'Title', 'role is optional');
});

parityMatrix.test('a spec authored as a design pairs with a real target by identity and passes', async () => {
  withTempRoot((root) => {
    // The design says what the screen should hold; the tvOS build says what it does.
    const spec = specToSnapshot({
      width: 1920,
      height: 1080,
      elements: [
        { identifier: 'continue-button', label: 'Continue Watching', role: 'button', frame: { x: 100, y: 200, w: 400, h: 80 }, focused: true },
        { identifier: 'browse-button', label: 'Browse', role: 'button', frame: { x: 100, y: 300, w: 400, h: 80 } },
      ],
    });
    const refDir = path.join(root, 'design');
    const w = new RunWriter(refDir, { role: 'reference', deviceId: 'spec', label: 'Design' });
    w.add('home', { platform: 'design', width: 1920, height: 1080, hierarchy: {}, a11ySnapshot: spec, screenshot: PNG });
    w.finish();

    const tvos = writeRun(root, 'tvOS', 'candidate', 'tvos', [
      ['home', [el(0, 'continue-button', 'Continue Watching', 200, true), el(1, 'browse-button', 'Browse', 300)]],
    ]);
    const m = buildMatrix(refDir, [{ label: 'tvOS', dir: tvos }], { ignore: ['pixel'] });
    assert(m.passed, `a build that matches its design passes, got ${JSON.stringify(m.shared)}`);
    assert(m.targets[0].report.checkpoints[0].rolesRelaxed, 'roles are relaxed against a design, as across stacks');
  });
});

parityMatrix.test('a malformed spec is refused before it can produce a nonsense diff', async () => {
  for (const bad of [
    { width: 0, height: 10, elements: [{ frame: { x: 0, y: 0, w: 1, h: 1 }, label: 'x' }] },
    { width: 10, height: 10, elements: [] },
    { width: 10, height: 10, elements: [{ frame: { x: 0, y: 0, w: 1, h: 1 } }] },
    { width: 10, height: 10, elements: [{ label: 'x', frame: { x: 'a', y: 0, w: 1, h: 1 } }] },
  ]) {
    let threw = false;
    try {
      validateSpec(bad);
    } catch {
      threw = true;
    }
    assert(threw, `rejected: ${JSON.stringify(bad)}`);
  }
});
