/**
 * Roku driver unit tests — the app-ui → uiautomator adapter, the ECP key map, the
 * ECP client's retry/launch/encoding behavior (against a throwaway local server),
 * and SSDP/digest parsing. Ports the upstream Maestro Roku test suite onto
 * conductor's Android-resolver hierarchy path.
 */
import http from 'http';
import { AddressInfo } from 'net';
import { TestSuite, assert } from './runner.js';
import { parseRokuAppUI } from '../src/drivers/roku/app-ui-parser.js';
import { rokuEcpKey, rokuSwipeKey, ROKU_ECP_KEYS } from '../src/drivers/roku/key-mapping.js';
import {
  RokuEcpClient,
  RokuEcpError,
  encodePathSegment,
  parseDigestChallenge,
  hintForStatus,
  md5Hex,
} from '../src/drivers/roku/ecp-client.js';
import { parseSsdpLocation } from '../src/drivers/roku/discovery.js';
import { parseAndroidHierarchy, findAndroidElement } from '../src/drivers/element-resolver.js';

export const roku = new TestSuite('Roku');

// ── app-ui → uiautomator XML ──────────────────────────────────────────────────

// Mirrors the ECP /query/app-ui shape: topscreen > screen > RenderableNode tree,
// curly-brace bounds/translation arrays, `name` node ids, and RowListItem's
// trailing duplicate Group (the pattern the parser must drop).
const APP_UI = `<?xml version="1.0" encoding="UTF-8" ?>
<app-ui>
  <status>OK</status>
  <topscreen>
    <plugin id="dev" name="Conductor Roku Demo"/>
    <screen focused="true" type="screen">
      <RenderableNode name="rootGroup" subtype="Group" bounds="{0, 0, 1920, 1080}">
        <Label name="titleLabel" text="Roku Demo" bounds="{100, 50, 400, 60}" color="#FFFFFFFF"/>
        <RenderableNode name="menu" subtype="Group" translation="{100, 200}" bounds="{100, 200, 400, 400}">
          <Button name="button-one" text="Button One" focusable="true" focused="true" bounds="{0, 0, 400, 100}"/>
          <Button name="button-two" text="Button Two" focusable="true" focused="false" bounds="{0, 120, 400, 100}"/>
          <Label name="hiddenLabel" text="Hidden" visible="false" bounds="{0, 240, 400, 100}"/>
          <Label name="fadedLabel" text="Faded" opacity="0" bounds="{0, 360, 400, 100}"/>
        </RenderableNode>
        <RenderableNode name="hiddenKeyboard" subtype="Group" visible="false" bounds="{0, 900, 1920, 180}">
          <Button name="keyboard-key-a" text="A" focusable="true" bounds="{0, 0, 100, 100}"/>
        </RenderableNode>
        <RenderableNode name="hero" subtype="LayoutGroup" bounds="{0, 480, 1920, 100}"/>
        <Label name="truncatedBounds" text="Truncated" bounds="{40}" translation="{80}"/>
        <RowListItem name="row0" bounds="{0, 600, 1920, 300}">
          <MarkupGrid name="grid0" bounds="{60, 0, 1800, 300}">
            <Poster name="poster0" uri="pkg:/images/poster.png" bounds="{0, 0, 300, 300}"/>
          </MarkupGrid>
          <RenderableNode name="rtaDuplicate" subtype="Group" bounds="{0, 0, 1920, 300}"/>
        </RowListItem>
      </RenderableNode>
    </screen>
  </topscreen>
</app-ui>`;

function nodeById(xml: string, id: string) {
  return parseAndroidHierarchy(xml).find((n) => n.resourceId === id);
}

roku.test('root is a full-screen node the screenshot cropper can anchor to', async () => {
  const xml = parseRokuAppUI(APP_UI);
  const m = xml.match(/<node[^>]*bounds="\[0,0\]\[(\d+),(\d+)\]"/);
  assert(m !== null, 'expected a root node spanning the screen');
  assert(m![1] === '1920' && m![2] === '1080', `root bounds were ${m![1]}x${m![2]}`);
});

// `<screen focused="true">` means the screen holds device focus, not that it is
// the focused element — claiming it would make `focused` report the whole screen.
roku.test('the root node never shadows the real focused element', async () => {
  const xml = parseRokuAppUI(APP_UI);
  const focused = parseAndroidHierarchy(xml).filter((n) => n.focused);
  assert(focused.length === 1, `expected exactly one focused node, got ${focused.length}`);
  assert(focused[0].resourceId === 'button-one', `focus was on ${focused[0].resourceId}`);
});

roku.test('honors an explicit design resolution', async () => {
  const xml = parseRokuAppUI(APP_UI, 1280, 720);
  assert(xml.includes('bounds="[0,0][1280,720]"'), 'root should use the given resolution');
});

roku.test('surfaces node ids, text and scene-absolute bounds', async () => {
  const xml = parseRokuAppUI(APP_UI);

  const title = nodeById(xml, 'titleLabel');
  assert(!!title, 'titleLabel should parse');
  assert(title!.text === 'Roku Demo', `text was ${title!.text}`);
  const b = title!.bounds;
  assert(
    b.x1 === 100 && b.y1 === 50 && b.x2 === 500 && b.y2 === 110,
    `titleLabel bounds were ${JSON.stringify(b)}`
  );

  // Children accumulate the parent's translation offset.
  const two = nodeById(xml, 'button-two')!;
  assert(
    two.bounds.x1 === 100 && two.bounds.y1 === 320 && two.bounds.x2 === 500 && two.bounds.y2 === 420,
    `button-two bounds were ${JSON.stringify(two.bounds)}`
  );
});

roku.test('maps focusable and focused state onto the Android resolver fields', async () => {
  const xml = parseRokuAppUI(APP_UI);

  const focused = nodeById(xml, 'button-one')!;
  assert(focused.clickable, 'a focusable node is clickable');
  assert(focused.focused, 'button-one is focused');
  assert(focused.selected, 'focus is also reported as selection');

  const unfocused = nodeById(xml, 'button-two')!;
  assert(unfocused.clickable, 'button-two is clickable');
  assert(!unfocused.focused, 'button-two is not focused');
});

// Visibility is judged from bounds alone downstream, so an unrendered node left in
// the tree would satisfy assert-visible and break assert-not-visible.
roku.test('nodes the device is not rendering are dropped', async () => {
  const xml = parseRokuAppUI(APP_UI);
  assert(!nodeById(xml, 'hiddenLabel'), 'visible="false" node should be dropped');
  assert(!nodeById(xml, 'fadedLabel'), 'opacity="0" node should be dropped');
});

roku.test('an invisible node takes its subtree with it', async () => {
  const xml = parseRokuAppUI(APP_UI);
  assert(!nodeById(xml, 'hiddenKeyboard'), 'hidden group should be dropped');
  assert(!nodeById(xml, 'keyboard-key-a'), 'its child should be dropped too');
});

roku.test('reports the SceneGraph subtype the device sent', async () => {
  const xml = parseRokuAppUI(APP_UI);
  // The attribute wins over the element name, which says nothing for a generic
  // RenderableNode...
  assert(nodeById(xml, 'hero')!.className === 'LayoutGroup', 'subtype attribute wins');
  // ...and the element name is the fallback when there is no attribute.
  assert(nodeById(xml, 'titleLabel')!.className === 'Label', 'element name is the fallback');
});

roku.test('a truncated bounds array is ignored, not indexed', async () => {
  const xml = parseRokuAppUI(APP_UI);
  assert(xml.includes('resource-id="truncatedBounds"'), 'node is still emitted');
  assert(!nodeById(xml, 'truncatedBounds'), 'but it has no bounds to resolve against');
});

roku.test('drops the trailing duplicate group under RowListItem', async () => {
  const xml = parseRokuAppUI(APP_UI);
  assert(!nodeById(xml, 'rtaDuplicate'), 'trailing duplicate should be dropped');
  assert(!!nodeById(xml, 'poster0'), 'the real content should survive');
});

roku.test('missing screen yields an empty hierarchy', async () => {
  const xml = parseRokuAppUI('<app-ui><status>OK</status></app-ui>');
  assert(parseAndroidHierarchy(xml).length === 0, 'no nodes without a screen');
});

roku.test('output is resolvable by the Android element resolver', async () => {
  const xml = parseRokuAppUI(APP_UI);
  const el = findAndroidElement(xml, { query: 'Button One' });
  assert(!!el, 'text lookup should find the button');
  const byId = findAndroidElement(xml, { id: 'button-two' });
  assert(!!byId, 'id lookup should find the button');
});

// ── Key mapping ───────────────────────────────────────────────────────────────

roku.test('maps D-pad and media keys to ECP key names', async () => {
  assert(rokuEcpKey('Remote Dpad Up') === 'Up', 'dpad up');
  assert(rokuEcpKey('Remote Dpad Center') === 'Select', 'dpad center');
  assert(rokuEcpKey('Enter') === 'Select', 'enter activates focus');
  assert(rokuEcpKey('Remote Media Fast Forward') === 'Fwd', 'fast forward');
  assert(rokuEcpKey('Remote Menu') === 'Info', 'the * options button is Roku\'s menu');
  assert(rokuEcpKey('Remote Instant Replay') === 'InstantReplay', 'instant replay');
});

roku.test('key lookup is case- and separator-insensitive', async () => {
  assert(rokuEcpKey('REMOTE DPAD LEFT') === 'Left', 'flow-normalised name');
  assert(rokuEcpKey('remote dpad right') === 'Right', 'lowercase');
  assert(rokuEcpKey('VOLUME_UP') === 'VolumeUp', 'underscore spelling');
});

roku.test('an unmapped key resolves to nothing rather than a wrong press', async () => {
  assert(rokuEcpKey('TV Input HDMI 1') === undefined, 'unmapped key');
  assert(rokuEcpKey('Camera') === undefined, 'no camera on a TV');
});

roku.test('every mapped ECP key name is non-empty', async () => {
  for (const [name, key] of Object.entries(ROKU_ECP_KEYS)) {
    assert(key.length > 0, `${name} maps to an empty ECP key`);
  }
});

// A swipe drags the content, so it reveals what lies on the far side: every
// direction inverts into the D-pad press that moves focus that way.
roku.test('swipe directions invert into D-pad presses', async () => {
  assert(rokuSwipeKey('up') === 'Down', 'swipe up reveals what is below');
  assert(rokuSwipeKey('down') === 'Up', 'swipe down reveals what is above');
  assert(rokuSwipeKey('left') === 'Right', 'swipe left');
  assert(rokuSwipeKey('right') === 'Left', 'swipe right');
});

// ── ECP client ────────────────────────────────────────────────────────────────

interface Recorded {
  method: string;
  url: string;
}

/** Serve `handler` on a loopback port, run `body`, then shut down. */
async function withServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, hits: Recorded[]) => void,
  body: (client: RokuEcpClient, hits: Recorded[]) => Promise<void>
): Promise<void> {
  const hits: Recorded[] = [];
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method ?? '', url: req.url ?? '' });
    handler(req, res, hits);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  // No keypress delay: these tests assert on request behavior, not pacing.
  const client = new RokuEcpClient('127.0.0.1', { ecpPort: port, keypressDelayMs: 0 });
  try {
    await body(client, hits);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// A device with ECP access set to anything but Permissive serves /query/app-ui
// while 403-ing every keypress. If that only warned, a flow would pass green
// having never touched the device.
roku.test('a rejected input command fails instead of warning', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(403);
      res.end();
    },
    async (client) => {
      let err: unknown;
      await client.sendKeypress('Up').catch((e) => (err = e));
      assert(err instanceof RokuEcpError, `expected RokuEcpError, got ${err}`);
      assert((err as RokuEcpError).statusCode === 403, 'status should survive into the error');
      assert(
        (err as Error).message.includes('Permissive'),
        `error should carry the setup hint: ${(err as Error).message}`
      );
    }
  );
});

roku.test('a 4xx is reported without retrying', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(404);
      res.end();
    },
    async (client, hits) => {
      await client.sendKeypress('Up').catch(() => {});
      assert(hits.length === 1, `a 4xx should not be retried, saw ${hits.length} requests`);
    }
  );
});

roku.test('a 5xx is retried and the final status is reported', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(503);
      res.end();
    },
    async (client, hits) => {
      let err: unknown;
      await client.sendKeypress('Up').catch((e) => (err = e));
      assert(hits.length === 3, `expected 3 attempts, saw ${hits.length}`);
      assert((err as RokuEcpError).statusCode === 503, 'final status is reported');
    }
  );
});

roku.test('a transient failure is retried and then succeeds', async () => {
  await withServer(
    (_req, res, hits) => {
      if (hits.length === 1) {
        res.writeHead(500);
        res.end();
        return;
      }
      res.writeHead(200);
      res.end();
    },
    async (client, hits) => {
      await client.sendKeypress('Up');
      assert(hits.length === 2, `expected a retry then success, saw ${hits.length}`);
    }
  );
});

roku.test('launch sends only the parameters it was given', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200);
      res.end();
    },
    async (client, hits) => {
      await client.launchChannel('dev', { contentId: 'abc 123', mediaType: 'movie' });
      assert(hits.length === 1, 'one launch request');
      assert(
        hits[0].url === '/launch/dev?contentId=abc%20123&mediaType=movie',
        `unexpected launch url: ${hits[0].url}`
      );
      assert(!hits[0].url.includes('RTA_LAUNCH'), 'no extra flags ride along');
    }
  );
});

roku.test('a launch with no parameters sends no query string', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200);
      res.end();
    },
    async (client, hits) => {
      await client.launchChannel('dev');
      assert(hits[0].url === '/launch/dev', `unexpected launch url: ${hits[0].url}`);
    }
  );
});

roku.test('parses a well-formed device-info response', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end(
        `<device-info><model-name>Roku Ultra</model-name>` +
          `<serial-number>X001</serial-number><ui-resolution>1080p</ui-resolution>` +
          `<friendly-device-name>Living Room</friendly-device-name></device-info>`
      );
    },
    async (client) => {
      const info = await client.getDeviceInfo();
      assert(info?.modelName === 'Roku Ultra', `model was ${info?.modelName}`);
      assert(info?.friendlyName === 'Living Room', `name was ${info?.friendlyName}`);
      assert(info?.widthPixels === 1920 && info?.heightPixels === 1080, '1080p screen size');
    }
  );
});

roku.test('a 720p device reports the smaller screen size', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end('<device-info><ui-resolution>720p</ui-resolution></device-info>');
    },
    async (client) => {
      const info = await client.getDeviceInfo();
      assert(info?.widthPixels === 1280 && info?.heightPixels === 720, '720p screen size');
    }
  );
});

roku.test('the active app is read from query/active-app', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end('<active-app><app id="dev" type="appl" version="1.0">My Channel</app></active-app>');
    },
    async (client) => {
      const app = await client.getActiveApp();
      assert(app?.id === 'dev', `id was ${app?.id}`);
      assert(app?.title === 'My Channel', `title was ${app?.title}`);
      assert(await client.isActiveApp('dev'), 'isActiveApp matches the id');
    }
  );
});

// Callers treat null as "hierarchy unavailable" and poll or report it themselves.
roku.test('a failed query returns null rather than throwing', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(500);
      res.end();
    },
    async (client) => {
      assert((await client.getDeviceInfo()) === null, 'device-info returns null');
      assert((await client.getAppUIRaw()) === null, 'app-ui returns null');
    }
  );
});

roku.test('typed text goes out as one LIT_ keypress per character', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200);
      res.end();
    },
    async (client, hits) => {
      await client.sendText('hi!');
      assert(hits.length === 3, `expected 3 keypresses, saw ${hits.length}`);
      assert(hits[0].url === '/keypress/LIT_h', `first was ${hits[0].url}`);
      assert(hits[2].url === '/keypress/LIT_%21', `'!' should be percent-encoded: ${hits[2].url}`);
    }
  );
});

// URL-form encoding would send a space as `+`, which ECP delivers as a literal
// plus — `LIT_+` types "+", not " ".
roku.test('encodes literal keypress path segments with percent-encoded spaces', async () => {
  assert(encodePathSegment('LIT_ ') === 'LIT_%20', `got ${encodePathSegment('LIT_ ')}`);
  assert(encodePathSegment('LIT_&') === 'LIT_%26', `got ${encodePathSegment('LIT_&')}`);
  assert(encodePathSegment('Up') === 'Up', 'plain keys pass through');
});

roku.test('parses the dev server digest challenge', async () => {
  const params = parseDigestChallenge(
    'realm="rokudev", qop=auth, nonce="1a2b3c", opaque="0000000000000000"'
  );
  assert(params['realm'] === 'rokudev', `realm was ${params['realm']}`);
  assert(params['nonce'] === '1a2b3c', `nonce was ${params['nonce']}`);
  assert(params['qop'] === 'auth', 'unquoted values parse too');
});

roku.test('md5 digest helper matches RFC 2617 test vectors', async () => {
  assert(
    md5Hex('Mufasa:testrealm@host.com:Circle Of Life') ===
      '939e7578ed9e3c518a452acee763bce9',
    'HA1 vector'
  );
});

roku.test('status hints name the setting that has to change', async () => {
  assert(hintForStatus(403).includes('Permissive'), '403 points at ECP network access');
  assert(hintForStatus(401).includes('CONDUCTOR_ROKU_PASSWORD'), '401 points at the password');
  assert(hintForStatus(500) === '', 'no hint for a server error');
});

// ── SSDP discovery ────────────────────────────────────────────────────────────

roku.test('extracts the device host from an SSDP response', async () => {
  const response = [
    'HTTP/1.1 200 OK',
    'Cache-Control: max-age=3600',
    'ST: roku:ecp',
    'LOCATION: http://192.168.1.100:8060/',
    '',
  ].join('\r\n');
  assert(parseSsdpLocation(response) === '192.168.1.100', 'host from the LOCATION header');
});

roku.test('an SSDP response without a usable location yields nothing', async () => {
  assert(parseSsdpLocation('HTTP/1.1 200 OK\r\nST: roku:ecp\r\n\r\n') === null, 'no LOCATION');
  assert(parseSsdpLocation('LOCATION: not a url\r\n') === null, 'unparseable LOCATION');
});
