/**
 * Unit tests for the tvOS remote key map.
 *
 * The Siri Remote is the only way to drive an Apple TV — XCTest refuses
 * touch-surface swipe gestures on tvOS — so these names are the whole
 * navigation surface, and a typo in one is a silently unreachable button.
 */
import { TestSuite, assert } from './runner.js';
import { VALID_KEYS, TVOS_REMOTE_BUTTONS, type Key } from '../src/commands/press-key.js';

export const pressKeyTvos = new TestSuite('tvOS remote keys');

pressKeyTvos.test('every mapped remote key is a declared key name', async () => {
  for (const name of Object.keys(TVOS_REMOTE_BUTTONS)) {
    assert(
      (VALID_KEYS as readonly string[]).includes(name),
      `"${name}" is mapped but missing from VALID_KEYS, so the CLI would reject it`
    );
  }
});

pressKeyTvos.test('d-pad, select and menu are mapped', async () => {
  const expected: Array<[Key, string]> = [
    ['Remote Dpad Up', 'up'],
    ['Remote Dpad Down', 'down'],
    ['Remote Dpad Left', 'left'],
    ['Remote Dpad Right', 'right'],
    ['Remote Dpad Center', 'select'],
    ['Remote Menu', 'menu'],
    ['Remote Media Play Pause', 'playPause'],
  ];
  for (const [key, button] of expected) {
    assert(TVOS_REMOTE_BUTTONS[key] === button, `${key} → ${TVOS_REMOTE_BUTTONS[key]}`);
  }
});

pressKeyTvos.test('paging and newer remote buttons are mapped', async () => {
  // Page Up/Down are the only fast way through a long list without a swipe.
  const expected: Array<[Key, string]> = [
    ['Remote Page Up', 'pageUp'],
    ['Remote Page Down', 'pageDown'],
    ['Remote Guide', 'guide'],
    ['Remote TV Provider', 'tvProvider'],
    ['Remote One Two Three', 'oneTwoThree'],
    ['Remote Four Colors', 'fourColors'],
  ];
  for (const [key, button] of expected) {
    assert(TVOS_REMOTE_BUTTONS[key] === button, `${key} → ${TVOS_REMOTE_BUTTONS[key]}`);
  }
});

pressKeyTvos.test('no two key names map to the same button', async () => {
  const seen = new Map<string, string>();
  for (const [name, button] of Object.entries(TVOS_REMOTE_BUTTONS)) {
    const previous = seen.get(button!);
    assert(previous === undefined, `${button} is mapped by both "${previous}" and "${name}"`);
    seen.set(button!, name);
  }
});

pressKeyTvos.test('key names are unique', async () => {
  assert(
    new Set(VALID_KEYS).size === VALID_KEYS.length,
    'VALID_KEYS contains a duplicate, which would make one entry unreachable'
  );
});
