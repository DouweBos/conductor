/**
 * JavaScript execution engine for runScript commands.
 *
 * Mirrors Maestro's GraalJsEngine behaviour using Node's built-in vm module:
 *  - All flow env vars injected as globals
 *  - `output` object shared with the rest of the flow (mutations persist)
 *  - `http` client with get/post/put/delete/request
 *  - `json(text)` and `relativePoint(x, y)` helpers
 *  - Top-level `await` supported (script is wrapped in an async IIFE)
 */
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

// ── HTTP binding ───────────────────────────────────────────────────────────────

interface HttpOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  params?: Record<string, string>;
}

interface HttpResponse {
  ok: boolean;
  status: number;
  body: string;
  headers: Record<string, string>;
}

/**
 * Synchronous HTTP request — matches Maestro's GraalVM behaviour where http.*
 * calls block until the response arrives (no await needed in scripts).
 *
 * Implemented via spawnSync so the VM thread blocks while fetch runs in a
 * child Node process, keeping script semantics identical to the JVM engine.
 */
function httpRequest(url: string, method: string, options: HttpOptions = {}): HttpResponse {
  let fullUrl = url;
  if (options.params && Object.keys(options.params).length > 0) {
    fullUrl += '?' + new URLSearchParams(options.params as Record<string, string>).toString();
  }

  const headers: Record<string, string> = { ...(options.headers ?? {}) };

  const bodyStr =
    options.body !== undefined
      ? typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body)
      : undefined;

  if (bodyStr !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const fetchOpts: Record<string, unknown> = { method };
  if (Object.keys(headers).length > 0) fetchOpts.headers = headers;
  if (bodyStr !== undefined) fetchOpts.body = bodyStr;

  // Run fetch in a child process so this call is synchronous from the script's
  // perspective (mirrors the blocking Java HTTP client in Maestro's GraalVM).
  const childScript = `(async () => {
  try {
    const res = await fetch(${JSON.stringify(fullUrl)}, ${JSON.stringify(fetchOpts)});
    const body = await res.text();
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    process.stdout.write(JSON.stringify({ ok: res.ok, status: res.status, body, headers }));
  } catch (e) {
    process.stderr.write(String(e));
    process.exit(1);
  }
})();`;

  const result = spawnSync(process.execPath, ['-e', childScript], {
    encoding: 'utf8',
    timeout: 30_000,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'HTTP request failed');

  return JSON.parse(result.stdout) as HttpResponse;
}

const httpBinding = {
  get: (url: string, opts?: HttpOptions) => httpRequest(url, 'GET', opts),
  post: (url: string, opts?: HttpOptions) => httpRequest(url, 'POST', opts),
  put: (url: string, opts?: HttpOptions) => httpRequest(url, 'PUT', opts),
  delete: (url: string, opts?: HttpOptions) => httpRequest(url, 'DELETE', opts),
  request: (url: string, opts?: HttpOptions) => httpRequest(url, opts?.method ?? 'GET', opts),
};

// ── Script execution ──────────────────────────────────────────────────────────

/**
 * Execute a JavaScript script in an isolated VM context.
 *
 * @param script     JS source code
 * @param env        Flow env vars injected as global variables (read-only by convention)
 * @param output     Shared output object — mutations persist back to the flow
 * @param sourceName Path shown in stack traces
 * @param maestroObj Optional maestro object injected as `maestro` global
 */
export async function executeScript(
  script: string,
  env: Record<string, string>,
  output: Record<string, unknown>,
  sourceName = 'script',
  maestroObj?: Record<string, unknown>
): Promise<void> {
  const sandbox: Record<string, unknown> = {
    // Env vars as globals (mirrors Maestro GraalJsEngine behaviour)
    ...env,

    // Output properties as globals so conditions can reference them directly
    // (e.g. `auth` in a when.true condition refers to `output.auth`)
    ...output,

    // Shared output — mutations are visible to subsequent commands
    output,

    // Maestro object (platform, copiedText, etc.)
    maestro: maestroObj ?? {},

    // API surface
    http: httpBinding,
    json: (text: string) => JSON.parse(text) as unknown,
    relativePoint: (x: number, y: number) => `${Math.ceil(x * 100)}%,${Math.ceil(y * 100)}%`,

    console: {
      log: (...args: unknown[]) => {
        console.log(...args);
      },
      warn: (...args: unknown[]) => {
        console.warn(...args);
      },
      error: (...args: unknown[]) => {
        console.error(...args);
      },
    },

    // Standard JS globals (not available in vm context by default)
    Date,
    Math,
    JSON,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    Error,
    TypeError,
    RangeError,
    Map,
    Set,
    Symbol,
    Uint8Array,

    // Async plumbing
    Promise,
    setTimeout,
    clearTimeout,
  };

  // Proxy prevents ReferenceError for undeclared variables (e.g. ${auth == 'sign-in'}
  // when `auth` is an optional env param not passed by the caller). Matches Maestro's
  // GraalJS behaviour where undeclared vars resolve to undefined instead of throwing.
  const proxy = new Proxy(sandbox, {
    has: () => true,
    get: (target, key) => (key in target ? target[key as string] : undefined),
  });
  vm.createContext(proxy);

  // Wrap in async IIFE so scripts can use top-level await
  const wrapped = `(async () => {\n${script}\n})()`;
  const promise = vm.runInContext(wrapped, proxy, { filename: sourceName }) as Promise<void>;
  await promise;
}
