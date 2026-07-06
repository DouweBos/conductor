/**
 * List the CDP page targets exposed by an external browser (e.g. an Electron app
 * launched with `--remote-debugging-port`). Each target is a controllable page —
 * for the Lightning emulator, one per tile plus its control/remote chrome.
 *
 * Reads the DevTools HTTP endpoint (`/json/list`) directly, so it needs no
 * Playwright browser and works before any daemon session exists. Use the printed
 * target IDs with `--cdp-url` / `--cdp-target` to bind a session to a tile.
 */
import http from 'http';
import { printData } from '../output.js';

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** Derive the `http://host:port` base from a CDP URL (which may be ws:// or include a path). */
function httpBase(cdpUrl: string): string {
  const u = new URL(cdpUrl);
  const proto = u.protocol === 'https:' || u.protocol === 'wss:' ? 'https:' : 'http:';
  return `${proto}//${u.host}`;
}

function fetchTargets(cdpUrl: string): Promise<CdpTarget[]> {
  const url = `${httpBase(cdpUrl)}/json/list`;
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        if ((res.statusCode ?? 0) >= 300) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as CdpTarget[]);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error(`Timed out fetching ${url}`)));
    req.on('error', reject);
  });
}

export async function webTargets(
  cdpUrl: string | undefined,
  opts: { json: boolean }
): Promise<number> {
  if (!cdpUrl) {
    console.error(
      'web-targets requires --cdp-url <url> (e.g. --cdp-url http://127.0.0.1:9222).\n' +
        'Launch the browser/Electron app with --remote-debugging-port to expose it.'
    );
    return 1;
  }

  let targets: CdpTarget[];
  try {
    targets = await fetchTargets(cdpUrl);
  } catch (err) {
    console.error(
      `Could not reach CDP endpoint at ${cdpUrl}: ${err instanceof Error ? err.message : String(err)}`
    );
    return 1;
  }

  // Only type="page" targets are controllable as Playwright Pages.
  const pages = targets.filter((t) => t.type === 'page');

  if (opts.json) {
    printData(
      pages.map((t) => ({ id: t.id, title: t.title, url: t.url })),
      opts
    );
    return 0;
  }

  if (pages.length === 0) {
    console.log(
      'No page targets found. Is the app loaded and started with --remote-debugging-port?'
    );
    return 0;
  }

  console.log(`Found ${pages.length} page target(s) at ${cdpUrl}:\n`);
  pages.forEach((t, i) => {
    console.log(`  [${i}] ${t.title || '(untitled)'}`);
    console.log(`      url:    ${t.url}`);
    console.log(`      target: ${t.id}`);
    console.log(
      `      bind:   conductor --device web:chromium:t${i} --cdp-url ${cdpUrl} --cdp-target ${t.id} inspect`
    );
    console.log('');
  });
  console.log(
    'Bind a session to a target once (any command), then drop the --cdp-* flags on later\n' +
      'commands for that --device — the attachment is remembered per session.'
  );
  return 0;
}

export const HELP =
  '  web-targets --cdp-url <url>          List controllable CDP page targets (one per Electron webview/tile)';
