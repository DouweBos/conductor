/**
 * Unit tests for the flow recorder.
 *
 * Covers the `commandToYamlStep` CLI→Maestro-YAML mapping and the
 * start/finish recording lifecycle — in particular that `finishRecording`
 * actually clears the active recording from the session.
 */
import fs from 'fs/promises';
import { TestSuite, assert } from './runner.js';
import {
  commandToYamlStep,
  startRecording,
  finishRecording,
  getActiveRecording,
} from '../src/drivers/flow-recorder.js';
import { clearSession } from '../src/session.js';

export const flowRecorder = new TestSuite('flow-recorder');

flowRecorder.test('commandToYamlStep maps tap-on by positional text', async () => {
  assert(commandToYamlStep('tap-on', ['Sign', 'in'], {}) === '- tapOn: "Sign in"', 'joins words');
});

flowRecorder.test('commandToYamlStep maps tap-on --id and --text to object form', async () => {
  assert(
    commandToYamlStep('tap-on', [], { id: 'submitBtn' }) === '- tapOn:\n    id: "submitBtn"',
    '--id → id selector'
  );
  assert(
    commandToYamlStep('tap-on', ['ignored'], { text: 'OK' }) === '- tapOn:\n    text: "OK"',
    '--text wins over the positional arg'
  );
});

flowRecorder.test('commandToYamlStep returns null for an empty tap-on', async () => {
  assert(commandToYamlStep('tap-on', [], {}) === null, 'no selector → not recorded');
});

flowRecorder.test('commandToYamlStep maps input-text and press-key', async () => {
  assert(commandToYamlStep('input-text', ['hello'], {}) === '- inputText: "hello"', 'input-text');
  assert(commandToYamlStep('press-key', ['enter'], {}) === '- pressKey: "enter"', 'press-key');
});

flowRecorder.test('commandToYamlStep maps launch-app with --clear-state', async () => {
  assert(
    commandToYamlStep('launch-app', ['com.example'], {}) === '- launchApp:\n    appId: com.example',
    'launch-app without flags'
  );
  assert(
    commandToYamlStep('launch-app', ['com.example'], { 'clear-state': true }) ===
      '- launchApp:\n    appId: com.example\n    clearState: true',
    '--clear-state is recorded'
  );
});

flowRecorder.test('commandToYamlStep maps set-location, or skips it when incomplete', async () => {
  assert(
    commandToYamlStep('set-location', [], { lat: 1, lng: 2 }) ===
      '- setLocation:\n    latitude: 1\n    longitude: 2',
    'lat+lng → setLocation'
  );
  assert(commandToYamlStep('set-location', [], { lat: 1 }) === null, 'missing lng → not recorded');
});

flowRecorder.test('commandToYamlStep maps bare commands and ignores unknowns', async () => {
  assert(commandToYamlStep('back', [], {}) === '- back', 'back');
  assert(commandToYamlStep('hide-keyboard', [], {}) === '- hideKeyboard', 'hide-keyboard');
  assert(commandToYamlStep('take-screenshot', [], {}) === null, 'non-action command → null');
});

flowRecorder.test('startRecording / finishRecording lifecycle clears the session', async () => {
  const session = `__conductor_rec_test_${process.pid}__`;
  let recordingPath: string | undefined;
  try {
    recordingPath = await startRecording(session, undefined, 'com.example.app');
    const active = await getActiveRecording(session);
    assert(active === recordingPath, 'recording is active after start');

    const header = await fs.readFile(recordingPath, 'utf-8');
    assert(header.includes('appId: com.example.app'), 'recording file carries the appId header');

    const finished = await finishRecording(session);
    assert(finished === recordingPath, 'finishRecording returns the closed path');

    // The bug this guards: finishRecording must actually clear the active
    // recording, not leave a stale recordingPath in the session file.
    const afterFinish = await getActiveRecording(session);
    assert(afterFinish === null, 'no active recording after finish');

    assert((await finishRecording(session)) === null, 'a second finish is a no-op');
  } finally {
    if (recordingPath) await fs.unlink(recordingPath).catch(() => {});
    await clearSession(session);
  }
});
