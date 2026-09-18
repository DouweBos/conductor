/**
 * Unit tests for the fold helpers. Injection and hinge feeding need a booted
 * foldable, so what's covered here is the pure logic: how an angle maps to a
 * pose name, and the pose vocabulary the CLI accepts.
 */
import { TestSuite, assert } from './runner.js';
import {
  FOLD_POSES,
  RELAY_ORIENTATIONS,
  poseForAngle,
  resolveFoldAngle,
} from '../src/drivers/ios-fold.js';

export const foldSuite = new TestSuite('fold helpers');

foldSuite.test('named poses map to the angles Device Hub uses', async () => {
  assert(FOLD_POSES.closed === 0, `closed: ${FOLD_POSES.closed}`);
  assert(FOLD_POSES.book === 130, `book: ${FOLD_POSES.book}`);
  assert(FOLD_POSES.open === 180, `open: ${FOLD_POSES.open}`);
});

foldSuite.test('angles at or near a pose report that pose', async () => {
  assert(poseForAngle(0) === 'closed', `0: ${poseForAngle(0)}`);
  assert(poseForAngle(8) === 'closed', `8: ${poseForAngle(8)}`);
  assert(poseForAngle(130) === 'book', `130: ${poseForAngle(130)}`);
  assert(poseForAngle(175) === 'open', `175: ${poseForAngle(175)}`);
  assert(poseForAngle(180) === 'open', `180: ${poseForAngle(180)}`);
});

foldSuite.test('angles between poses are partial, not rounded to a pose', async () => {
  // 45 is nearest to closed, but calling it "closed" would misdescribe a hinge
  // that is visibly open, so anything outside the tolerance is partial.
  assert(poseForAngle(45) === 'partial', `45: ${poseForAngle(45)}`);
  assert(poseForAngle(90) === 'partial', `90: ${poseForAngle(90)}`);
  assert(poseForAngle(155) === 'partial', `155: ${poseForAngle(155)}`);
});

foldSuite.test("relay orientation tokens use the relay spelling, not devicectl's", async () => {
  // The relay has its own vocabulary; sending devicectl's spelling is a no-op.
  assert(RELAY_ORIENTATIONS.portraitUpsideDown === 'pud', RELAY_ORIENTATIONS.portraitUpsideDown);
  assert(RELAY_ORIENTATIONS.landscapeLeft === 'landscape-left', RELAY_ORIENTATIONS.landscapeLeft);
  assert(RELAY_ORIENTATIONS.faceDown === 'facedown', RELAY_ORIENTATIONS.faceDown);
});

foldSuite.test('fold values resolve to angles, and bad ones are rejected', async () => {
  assert(resolveFoldAngle('closed') === 0, 'closed');
  assert(resolveFoldAngle('OPEN') === 180, 'case-insensitive pose');
  assert(resolveFoldAngle('45') === 45, 'numeric angle');
  assert(resolveFoldAngle(' 130 ') === 130, 'surrounding whitespace');
  assert(resolveFoldAngle('200') === null, 'above the hinge range');
  assert(resolveFoldAngle('banana') === null, 'not a pose or a number');
  // Number('') is 0, so an empty value would otherwise fold the device shut.
  assert(resolveFoldAngle('') === null, 'empty value');
});
