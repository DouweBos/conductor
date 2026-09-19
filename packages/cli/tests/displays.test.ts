/**
 * Unit tests for picking which panel to screenshot. The interesting case is a
 * foldable: the driver always captures XCUIScreen.main (the cover), which is
 * powered off while the device is unfolded, so a default screenshot would come
 * back black unless we redirect it to the live panel.
 */
import { TestSuite, assert } from './runner.js';
import { pickCaptureDisplay } from '../src/drivers/ios-displays.js';
import type { DeviceDisplay } from '../src/drivers/devicectl.js';

export const displaysSuite = new TestSuite('display selection');

const display = (over: Partial<DeviceDisplay>): DeviceDisplay => ({
  displayId: 1,
  name: 'LCD',
  active: false,
  primary: false,
  kind: 'integrated',
  integrated: true,
  ...over,
});

/** A Duo with CarPlay attached: more than just the two foldable panels. */
const withCarPlay = [
  display({ displayId: 1, primary: true, active: true }),
  display({ displayId: 3, name: 'LCD-1' }),
  display({ displayId: 4, name: 'Wireless', kind: 'carPlay', integrated: false }),
  display({ displayId: 2, name: 'TVOut', kind: 'tvOut', integrated: false }),
];

const phone = [display({ displayId: 1, primary: true, active: true })];
const foldableOpen = [
  display({ displayId: 1, primary: true, active: false }),
  display({ displayId: 3, name: 'LCD-1', active: true }),
];
const foldableShut = [
  display({ displayId: 1, primary: true, active: true }),
  display({ displayId: 3, name: 'LCD-1', active: false }),
];

displaysSuite.test('ordinary devices keep using the driver', async () => {
  assert(pickCaptureDisplay(phone).displayId === null, 'single display needs no redirect');
});

displaysSuite.test('an unfolded foldable captures the live inner panel', async () => {
  assert(pickCaptureDisplay(foldableOpen).displayId === 3, 'should follow the active panel');
});

displaysSuite.test('a folded foldable captures the cover panel', async () => {
  assert(pickCaptureDisplay(foldableShut).displayId === 1, 'cover is live when shut');
});

displaysSuite.test('an override wins over whichever panel is live', async () => {
  assert(pickCaptureDisplay(foldableOpen, 'cover').displayId === 1, 'cover override');
  assert(pickCaptureDisplay(foldableShut, 'inner').displayId === 3, 'inner override');
  assert(pickCaptureDisplay(foldableOpen, '1').displayId === 1, 'override by display id');
});

displaysSuite.test(
  'bad overrides explain themselves rather than capturing something else',
  async () => {
    const bogus = pickCaptureDisplay(foldableOpen, 'bogus');
    assert(bogus.displayId === null && !!bogus.error, 'unknown name is an error');
    const missing = pickCaptureDisplay(phone, 'inner');
    assert(missing.displayId === null && !!missing.error, 'no inner panel on a plain phone');
  }
);

displaysSuite.test('non-foldable displays are addressed by id, not device vocabulary', async () => {
  // CarPlay and external screens are reachable, but by id: a device's own class
  // and panel names are platform vocabulary that would not survive Android.
  assert(pickCaptureDisplay(withCarPlay, '4').displayId === 4, 'CarPlay by id');
  assert(pickCaptureDisplay(withCarPlay, '2').displayId === 2, 'external by id');
  assert(pickCaptureDisplay(withCarPlay, 'carPlay').displayId === null, 'class is not a selector');
  assert(pickCaptureDisplay(withCarPlay, 'LCD-1').displayId === null, 'name is not a selector');
});

displaysSuite.test('an unknown display reports what the device actually offers', async () => {
  const { displayId, error } = pickCaptureDisplay(withCarPlay, 'projector');
  assert(displayId === null, 'no guess');
  assert(
    !!error && error.includes('Wireless') && error.includes('TVOut'),
    `lists real panels: ${error}`
  );
});

displaysSuite.test('CarPlay being attached does not steal the default', async () => {
  // Both the phone screen and CarPlay are live; a screenshot means the phone.
  assert(pickCaptureDisplay(withCarPlay).displayId === 1, 'defaults to the live integrated panel');
});
