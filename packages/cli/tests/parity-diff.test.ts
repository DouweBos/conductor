/**
 * Unit tests for the parity diff engine.
 *
 * Covers element matching (exact and positional), each finding kind, the
 * blocking/advisory policy, geometry normalisation, and the run store's
 * write → read round-trip.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TestSuite, assert } from './runner.js';
import {
  ALL_KINDS,
  DEFAULT_BLOCKING,
  diffCheckpoint,
  longestIncreasingSubsequence,
  matchElements,
  missingCheckpoint,
  normalizeText,
  overlap,
  type DiffInput,
  type FindingKind,
} from '../src/parity/diff.js';
import { RunWriter, loadRun, setActiveRun, slugify } from '../src/parity/store.js';
import { executeFlow, parseFlowString } from '../src/drivers/flow-runner.js';
import { MockIOSDriver, makeIOSHierarchy } from './mock-driver.js';
import type { A11ySnapshotEntry } from '../src/drivers/a11y.js';

export const parityDiff = new TestSuite('parity-diff');

let orderCounter = 0;

function el(
  label: string,
  role: string,
  frame: { x: number; y: number; w: number; h: number },
  extra: Partial<A11ySnapshotEntry> = {}
): A11ySnapshotEntry {
  const order = extra.order ?? orderCounter++;
  return {
    nodeId: `n${order}`,
    ref: `@e${order + 1}`,
    order,
    frame,
    label,
    hint: '',
    role,
    traits: [role],
    announcement: label,
    value: '',
    state: { enabled: true, selected: false, focused: false },
    ...extra,
  };
}

/** Build a diff input from two element lists on an identical 390×844 screen. */
function input(
  reference: A11ySnapshotEntry[],
  candidate: A11ySnapshotEntry[],
  over: Partial<DiffInput> = {}
): DiffInput {
  return {
    name: 'screen',
    reference: { a11ySnapshot: reference, width: 390, height: 844, platform: 'ios' },
    candidate: { a11ySnapshot: candidate, width: 390, height: 844, platform: 'ios' },
    ...over,
  };
}

function kinds(findings: Array<{ kind: FindingKind }>): FindingKind[] {
  return findings.map((f) => f.kind);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

parityDiff.test('normalizeText collapses whitespace and respects ignoreCase', async () => {
  assert(normalizeText('  Buy   now \n', false) === 'Buy now', 'collapses and trims');
  assert(normalizeText('Buy Now', true) === 'buy now', 'lowercases when asked');
  assert(normalizeText('Buy Now', false) === 'Buy Now', 'preserves case by default');
});

parityDiff.test('overlap is 1 for identical frames and 0 for disjoint ones', async () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  assert(overlap(a, a) === 1, 'identical frames fully overlap');
  assert(overlap(a, { x: 100, y: 100, w: 10, h: 10 }) === 0, 'disjoint frames do not overlap');
  const half = overlap(a, { x: 5, y: 0, w: 10, h: 10 });
  assert(half > 0.3 && half < 0.4, `half-overlapping frames give IoU 1/3, got ${half}`);
});

parityDiff.test('longestIncreasingSubsequence returns indices of the longest run', async () => {
  assert(JSON.stringify(longestIncreasingSubsequence([0, 1, 2, 3])) === '[0,1,2,3]', 'sorted');
  assert(longestIncreasingSubsequence([]).length === 0, 'empty');
  // 3,0,1,2 → the increasing run is 0,1,2 at indices 1,2,3
  assert(JSON.stringify(longestIncreasingSubsequence([3, 0, 1, 2])) === '[1,2,3]', 'one outlier');
});

// ── Matching ─────────────────────────────────────────────────────────────────

parityDiff.test('identical screens produce no findings', async () => {
  const build = (): A11ySnapshotEntry[] => {
    orderCounter = 0;
    return [
      el('Cart', 'heading', { x: 16, y: 60, w: 120, h: 32 }),
      el('Checkout', 'button', { x: 16, y: 700, w: 358, h: 48 }),
    ];
  };
  const result = diffCheckpoint(input(build(), build()));
  assert(result.passed, `expected pass, got ${JSON.stringify(result.findings)}`);
  assert(result.findings.length === 0, 'no findings on an identical screen');
});

parityDiff.test('duplicate labels pair by frame proximity, not array order', async () => {
  orderCounter = 0;
  const reference = [
    el('Add', 'button', { x: 300, y: 100, w: 60, h: 30 }),
    el('Add', 'button', { x: 300, y: 200, w: 60, h: 30 }),
  ];
  orderCounter = 0;
  // Same two buttons, listed in the opposite order.
  const candidate = [
    el('Add', 'button', { x: 300, y: 200, w: 60, h: 30 }, { order: 1 }),
    el('Add', 'button', { x: 300, y: 100, w: 60, h: 30 }, { order: 0 }),
  ];
  const result = diffCheckpoint(input(reference, candidate));
  assert(
    !kinds(result.findings).includes('missing') && !kinds(result.findings).includes('moved'),
    `each Add should pair with the one at its own position, got ${JSON.stringify(result.findings)}`
  );
});

parityDiff.test('a changed label reads as a text finding, not missing + added', async () => {
  orderCounter = 0;
  const reference = [el('Buy now', 'button', { x: 16, y: 700, w: 358, h: 48 })];
  orderCounter = 0;
  const candidate = [el('Buy Now!', 'button', { x: 16, y: 700, w: 358, h: 48 })];
  const result = diffCheckpoint(input(reference, candidate));
  assert(kinds(result.findings).includes('text'), 'reports a text finding');
  assert(!kinds(result.findings).includes('missing'), 'does not report it as missing');
  assert(!kinds(result.findings).includes('added'), 'does not report it as added');
  assert(!result.passed, 'a text difference blocks by default');
});

parityDiff.test('an element only in the reference is missing and blocks', async () => {
  orderCounter = 0;
  const reference = [
    el('Title', 'heading', { x: 16, y: 60, w: 200, h: 32 }),
    el('Apply promo code', 'button', { x: 16, y: 400, w: 358, h: 44 }),
  ];
  orderCounter = 0;
  const candidate = [el('Title', 'heading', { x: 16, y: 60, w: 200, h: 32 })];
  const result = diffCheckpoint(input(reference, candidate));
  const missing = result.findings.filter((f) => f.kind === 'missing');
  assert(missing.length === 1, `exactly one missing finding, got ${missing.length}`);
  assert(missing[0].label === 'Apply promo code', 'names the dropped element');
  assert(missing[0].severity === 'blocking', 'missing blocks');
  assert(!result.passed, 'checkpoint fails');
});

parityDiff.test('an element only in the candidate is added and is advisory', async () => {
  orderCounter = 0;
  const reference = [el('Title', 'heading', { x: 16, y: 60, w: 200, h: 32 })];
  orderCounter = 0;
  const candidate = [
    el('Title', 'heading', { x: 16, y: 60, w: 200, h: 32 }),
    el('New badge', 'text', { x: 250, y: 60, w: 60, h: 20 }),
  ];
  const result = diffCheckpoint(input(reference, candidate));
  const added = result.findings.filter((f) => f.kind === 'added');
  assert(added.length === 1, 'one added finding');
  assert(added[0].severity === 'advisory', 'added is advisory');
  assert(result.passed, 'an extra element alone does not fail the checkpoint');
});

// ── Layout ───────────────────────────────────────────────────────────────────

parityDiff.test('small drift is tolerated, larger drift reports moved', async () => {
  const ref = (): A11ySnapshotEntry[] => {
    orderCounter = 0;
    return [el('Checkout', 'button', { x: 16, y: 700, w: 358, h: 48 })];
  };
  const shifted = (dy: number): A11ySnapshotEntry[] => {
    orderCounter = 0;
    return [el('Checkout', 'button', { x: 16, y: 700 + dy, w: 358, h: 48 })];
  };

  const within = diffCheckpoint(input(ref(), shifted(4)));
  assert(!kinds(within.findings).includes('moved'), '4pt is inside the default 8pt tolerance');

  const beyond = diffCheckpoint(input(ref(), shifted(40)));
  assert(kinds(beyond.findings).includes('moved'), '40pt drift is reported');
  assert(beyond.passed, 'moved is advisory by default');
});

parityDiff.test('a resized element is reported separately from a moved one', async () => {
  orderCounter = 0;
  const reference = [el('Banner', 'image', { x: 0, y: 0, w: 390, h: 200 })];
  orderCounter = 0;
  const candidate = [el('Banner', 'image', { x: 0, y: 0, w: 390, h: 120 })];
  const result = diffCheckpoint(input(reference, candidate));
  assert(kinds(result.findings).includes('resized'), 'reports resized');
});

parityDiff.test('different screen sizes with matching aspect ratio are rescaled', async () => {
  orderCounter = 0;
  const reference = [el('Checkout', 'button', { x: 16, y: 700, w: 358, h: 48 })];
  orderCounter = 0;
  // Same layout on a screen at exactly 2x — frames should normalise to a match.
  const candidate = [el('Checkout', 'button', { x: 32, y: 1400, w: 716, h: 96 })];
  const result = diffCheckpoint(
    input(reference, candidate, {
      candidate: { a11ySnapshot: candidate, width: 780, height: 1688, platform: 'android' },
    })
  );
  assert(result.scaled, 'marks the run as rescaled');
  assert(
    !kinds(result.findings).includes('moved') && !kinds(result.findings).includes('resized'),
    `a proportional layout should not read as moved, got ${JSON.stringify(result.findings)}`
  );
  assert(result.passed, 'checkpoint passes');
});

parityDiff.test('incomparable aspect ratios report geometry and suppress frame findings', async () => {
  orderCounter = 0;
  const reference = [el('Checkout', 'button', { x: 16, y: 700, w: 358, h: 48 })];
  orderCounter = 0;
  const candidate = [el('Checkout', 'button', { x: 500, y: 100, w: 358, h: 48 })];
  const result = diffCheckpoint(
    input(reference, candidate, {
      candidate: { a11ySnapshot: candidate, width: 1280, height: 800, platform: 'web' },
    })
  );
  assert(kinds(result.findings).includes('geometry'), 'reports the geometry mismatch');
  assert(!kinds(result.findings).includes('moved'), 'suppresses position findings');
  assert(!result.passed, 'geometry blocks by default');
});

// ── Other finding kinds ──────────────────────────────────────────────────────

parityDiff.test('a differing value blocks; a differing state is advisory', async () => {
  orderCounter = 0;
  const reference = [
    el('Quantity', 'textfield', { x: 16, y: 300, w: 100, h: 40 }, { value: '2' }),
    el('Gift wrap', 'switch', { x: 16, y: 360, w: 100, h: 40 }, {
      state: { enabled: true, selected: false, focused: false, checked: true },
    }),
  ];
  orderCounter = 0;
  const candidate = [
    el('Quantity', 'textfield', { x: 16, y: 300, w: 100, h: 40 }, { value: '1' }),
    el('Gift wrap', 'switch', { x: 16, y: 360, w: 100, h: 40 }, {
      state: { enabled: true, selected: false, focused: false, checked: false },
    }),
  ];
  const result = diffCheckpoint(input(reference, candidate));
  const value = result.findings.find((f) => f.kind === 'value');
  const state = result.findings.find((f) => f.kind === 'state');
  assert(value !== undefined && value.severity === 'blocking', 'value differences block');
  assert(state !== undefined && state.severity === 'advisory', 'state differences are advisory');
  assert(!result.passed, 'the value difference fails the checkpoint');
});

parityDiff.test('a swapped reading order reports only the element that moved', async () => {
  orderCounter = 0;
  const reference = [
    el('First', 'text', { x: 16, y: 100, w: 100, h: 20 }),
    el('Second', 'text', { x: 16, y: 140, w: 100, h: 20 }),
    el('Third', 'text', { x: 16, y: 180, w: 100, h: 20 }),
  ];
  // Same frames, but "Third" is announced first.
  const candidate = [
    el('Third', 'text', { x: 16, y: 180, w: 100, h: 20 }, { order: 0 }),
    el('First', 'text', { x: 16, y: 100, w: 100, h: 20 }, { order: 1 }),
    el('Second', 'text', { x: 16, y: 140, w: 100, h: 20 }, { order: 2 }),
  ];
  const result = diffCheckpoint(input(reference, candidate));
  const reordered = result.findings.filter((f) => f.kind === 'reordered');
  assert(reordered.length === 1, `only the displaced element is reported, got ${reordered.length}`);
  assert(reordered[0].label === 'Third', `expected Third, got ${reordered[0].label}`);
});

parityDiff.test('pixel ratio past the threshold is reported but does not block', async () => {
  orderCounter = 0;
  const same = (): A11ySnapshotEntry[] => {
    orderCounter = 0;
    return [el('Title', 'heading', { x: 16, y: 60, w: 200, h: 32 })];
  };
  const result = diffCheckpoint(
    input(same(), same(), { pixel: { diffPixels: 5000, ratio: 0.4 } })
  );
  assert(kinds(result.findings).includes('pixel'), 'reports the pixel difference');
  assert(result.passed, 'pixel alone is advisory');
});

parityDiff.test('a checkpoint the candidate never reached blocks', async () => {
  const result = missingCheckpoint('cart');
  assert(!result.passed, 'fails');
  assert(result.findings[0].kind === 'checkpoint-missing', 'reports checkpoint-missing');
});

// ── Policy ───────────────────────────────────────────────────────────────────

parityDiff.test('--ignore drops a kind entirely', async () => {
  orderCounter = 0;
  const reference = [el('Gone', 'button', { x: 16, y: 100, w: 100, h: 40 })];
  const result = diffCheckpoint(input(reference, []), { ignore: ['missing'] });
  assert(result.findings.length === 0, 'the ignored kind is dropped');
  assert(result.passed, 'and no longer blocks');
});

parityDiff.test('--blocking overrides which kinds fail', async () => {
  orderCounter = 0;
  const reference = [el('Title', 'heading', { x: 16, y: 60, w: 200, h: 32 })];
  orderCounter = 0;
  const candidate = [
    el('Title', 'heading', { x: 16, y: 60, w: 200, h: 32 }),
    el('Extra', 'text', { x: 250, y: 60, w: 60, h: 20 }),
  ];
  const lenient = diffCheckpoint(input(reference, candidate));
  assert(lenient.passed, 'added is advisory by default');

  const strictAdded = diffCheckpoint(input(reference, candidate), { blocking: ['added'] });
  assert(!strictAdded.passed, 'promoting added makes it block');
});

parityDiff.test('strict mode (every kind blocking) fails on an advisory-only diff', async () => {
  orderCounter = 0;
  const reference = [el('Checkout', 'button', { x: 16, y: 700, w: 358, h: 48 })];
  orderCounter = 0;
  const candidate = [el('Checkout', 'button', { x: 16, y: 640, w: 358, h: 48 })];
  const result = diffCheckpoint(input(reference, candidate), { blocking: [...ALL_KINDS] });
  assert(kinds(result.findings).includes('moved'), 'still reports moved');
  assert(!result.passed, 'strict mode fails on it');
});

parityDiff.test('blocking findings sort ahead of advisory ones', async () => {
  orderCounter = 0;
  const reference = [
    el('Dropped', 'button', { x: 16, y: 500, w: 100, h: 40 }),
    el('Kept', 'button', { x: 16, y: 700, w: 100, h: 40 }),
  ];
  orderCounter = 0;
  const candidate = [
    el('Kept', 'button', { x: 16, y: 600, w: 100, h: 40 }, { order: 1 }),
    el('Surprise', 'text', { x: 16, y: 200, w: 100, h: 20 }, { order: 0 }),
  ];
  const result = diffCheckpoint(input(reference, candidate));
  assert(result.findings[0].severity === 'blocking', 'the blocking finding reads first');
  assert(
    DEFAULT_BLOCKING.includes(result.findings[0].kind),
    'and it is one of the default blocking kinds'
  );
});

parityDiff.test('matchElements ignores elements with no text, role or area', async () => {
  orderCounter = 0;
  const reference = [
    el('', '', { x: 0, y: 0, w: 390, h: 844 }), // an unlabelled container
    el('Title', 'heading', { x: 16, y: 60, w: 200, h: 32 }),
  ];
  orderCounter = 0;
  const candidate = [el('Title', 'heading', { x: 16, y: 60, w: 200, h: 32 })];
  const { pairs, unmatchedRef } = matchElements(reference, candidate, {
    ignoreCase: false,
    minOverlap: 0.5,
  });
  assert(pairs.length === 1, 'the titled element pairs up');
  assert(unmatchedRef.length === 0, 'the unlabelled container is not reported as missing');
});

// ── Store round-trip ─────────────────────────────────────────────────────────

parityDiff.test('slugify produces safe, stable names', async () => {
  assert(slugify('Cart — empty state') === 'cart-empty-state', 'punctuation becomes dashes');
  assert(slugify('  ') === 'checkpoint', 'falls back for an empty name');
});

parityDiff.test('a run writes and reads back, and reopening appends', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-parity-'));
  try {
    const capture = {
      platform: 'ios' as const,
      width: 390,
      height: 844,
      hierarchy: {},
      a11ySnapshot: [el('Title', 'heading', { x: 16, y: 60, w: 200, h: 32 })],
      // A 1x1 PNG is enough to prove the bytes round-trip.
      screenshot: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      ),
    };

    const writer = new RunWriter(dir, { role: 'reference', deviceId: 'sim-1', label: 'rn' });
    writer.add('cart', capture);
    writer.finish();

    const first = loadRun(dir);
    assert(first.manifest.role === 'reference', 'role round-trips');
    assert(first.manifest.device.width === 390, 'screen size comes from the capture');
    assert(first.checkpoints.length === 1, 'one checkpoint');
    assert(first.checkpoints[0].snapshot.name === 'cart', 'name round-trips');
    assert(fs.existsSync(first.checkpoints[0].screenshotPath), 'screenshot written');

    // Reopening must continue the run rather than truncate it.
    const reopened = RunWriter.open(dir);
    reopened.add('checkout', capture);
    reopened.finish();

    const second = loadRun(dir);
    assert(second.checkpoints.length === 2, `expected 2 checkpoints, got ${second.checkpoints.length}`);
    assert(second.manifest.label === 'rn', 'label survives reopening');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

parityDiff.test('duplicate checkpoint names do not overwrite each other', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-parity-'));
  try {
    const capture = {
      platform: 'ios' as const,
      width: 390,
      height: 844,
      hierarchy: {},
      a11ySnapshot: [],
      screenshot: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      ),
    };
    const writer = new RunWriter(dir, { role: 'candidate', deviceId: 'sim-1' });
    const a = writer.add('step', capture);
    const b = writer.add('step', capture);
    writer.finish();
    assert(a.snapshotFile !== b.snapshotFile, 'the second capture gets its own file');
    assert(loadRun(dir).checkpoints.length === 2, 'both are readable');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── The `checkpoint` flow step ───────────────────────────────────────────────

parityDiff.test('a checkpoint step is a no-op outside a parity run', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'Submit', x: 50, y: 100 }]));
  // A flow carrying checkpoints must stay runnable under plain `run-flow`.
  await executeFlow(parseFlowString('---\n- checkpoint: cart\n- tapOn: "Submit"'), driver);
  assert(driver.callsTo('screenshot').length === 0, 'nothing was captured');
  assert(driver.callsTo('tap').length === 1, 'the rest of the flow still ran');
});

parityDiff.test('a checkpoint step captures into the active run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-parity-'));
  const writer = new RunWriter(dir, { role: 'reference', deviceId: 'sim-1' });
  try {
    const driver = new MockIOSDriver(makeIOSHierarchy([{ label: 'Checkout', x: 16, y: 700 }]));
    setActiveRun(writer);
    await executeFlow(parseFlowString('---\n- checkpoint: cart\n- checkpoint:\n    name: checkout'), driver);
  } finally {
    setActiveRun(null);
    writer.finish();
    const { checkpoints } = loadRun(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    assert(checkpoints.length === 2, `expected 2 checkpoints, got ${checkpoints.length}`);
    assert(checkpoints[0].snapshot.name === 'cart', 'string form works');
    assert(checkpoints[1].snapshot.name === 'checkout', 'mapping form works');
    assert(
      checkpoints[0].snapshot.a11ySnapshot.some((e) => e.label === 'Checkout'),
      'the captured a11y snapshot carries the on-screen elements'
    );
  }
});

parityDiff.test('a checkpoint step with no name fails the flow', async () => {
  const driver = new MockIOSDriver(makeIOSHierarchy([]));
  let threw = false;
  try {
    await executeFlow(parseFlowString('---\n- checkpoint: ""'), driver);
  } catch {
    threw = true;
  }
  assert(threw, 'an unnamed checkpoint is an error, not a silent skip');
});
