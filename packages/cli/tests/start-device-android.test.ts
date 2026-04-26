import { TestSuite, assert } from './runner.js';
import {
  pickAndroidArch,
  parseInstalledSystemImages,
  pickSystemImage,
  buildAvdmanagerCreateArgs,
} from '../src/commands/start-device.js';

export const startDeviceAndroid = new TestSuite('start-device (Android AVD creation)');

startDeviceAndroid.test('pickAndroidArch returns arm64-v8a on arm64', async () => {
  assert(pickAndroidArch('arm64') === 'arm64-v8a', 'arm64 should map to arm64-v8a');
});

startDeviceAndroid.test('pickAndroidArch returns x86_64 on x64', async () => {
  assert(pickAndroidArch('x64') === 'x86_64', 'x64 should map to x86_64');
});

startDeviceAndroid.test('parseInstalledSystemImages extracts system-image package paths', async () => {
  const sample = [
    'Installed packages:',
    '  Path                                              | Version | Description',
    '  -------                                           | ------- | -------',
    '  build-tools;34.0.0                                | 34.0.0  | Android SDK Build-Tools 34',
    '  platform-tools                                    | 35.0.2  | Android SDK Platform-Tools',
    '  system-images;android-34;google_apis;arm64-v8a    | 12      | Google APIs ARM 64 v8a System Image',
    '  system-images;android-33;default;x86_64           | 5       | Default x86_64 System Image',
    '',
  ].join('\n');
  const images = parseInstalledSystemImages(sample);
  assert(images.length === 2, `expected 2 images, got ${images.length}: ${JSON.stringify(images)}`);
  assert(images[0] === 'system-images;android-34;google_apis;arm64-v8a', `unexpected first image: ${images[0]}`);
  assert(images[1] === 'system-images;android-33;default;x86_64', `unexpected second image: ${images[1]}`);
});

startDeviceAndroid.test('pickSystemImage filters by arch and api level', async () => {
  const installed = [
    'system-images;android-33;google_apis;x86_64',
    'system-images;android-34;google_apis;arm64-v8a',
    'system-images;android-34;default;arm64-v8a',
  ];
  const picked = pickSystemImage(installed, '34', 'arm64-v8a');
  assert(
    picked === 'system-images;android-34;google_apis;arm64-v8a',
    `expected google_apis arm64 image, got ${picked}`
  );
});

startDeviceAndroid.test('pickSystemImage returns undefined when no match', async () => {
  const installed = ['system-images;android-33;default;x86_64'];
  const picked = pickSystemImage(installed, '34', 'arm64-v8a');
  assert(picked === undefined, `expected undefined, got ${picked}`);
});

startDeviceAndroid.test('pickSystemImage prefers google_apis over default', async () => {
  const installed = [
    'system-images;android-34;default;arm64-v8a',
    'system-images;android-34;google_apis;arm64-v8a',
  ];
  const picked = pickSystemImage(installed, undefined, 'arm64-v8a');
  assert(
    picked === 'system-images;android-34;google_apis;arm64-v8a',
    `expected google_apis variant, got ${picked}`
  );
});

startDeviceAndroid.test('pickSystemImage picks highest API when no level specified', async () => {
  const installed = [
    'system-images;android-31;google_apis;arm64-v8a',
    'system-images;android-34;google_apis;arm64-v8a',
    'system-images;android-33;google_apis;arm64-v8a',
  ];
  const picked = pickSystemImage(installed, undefined, 'arm64-v8a');
  assert(
    picked === 'system-images;android-34;google_apis;arm64-v8a',
    `expected android-34, got ${picked}`
  );
});

startDeviceAndroid.test('buildAvdmanagerCreateArgs constructs expected argv', async () => {
  const args = buildAvdmanagerCreateArgs(
    'my_pixel',
    'system-images;android-34;google_apis;arm64-v8a',
    'pixel_7'
  );
  assert(
    JSON.stringify(args) ===
      JSON.stringify([
        'create',
        'avd',
        '-n',
        'my_pixel',
        '-k',
        'system-images;android-34;google_apis;arm64-v8a',
        '-d',
        'pixel_7',
      ]),
    `unexpected argv: ${JSON.stringify(args)}`
  );
});
