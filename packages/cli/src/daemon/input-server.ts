/**
 * Streaming input WebSocket server (one per device daemon).
 *
 * Bound to loopback; the host IDE opens one long-lived socket per active device
 * and streams pointer/key/button frames. Frames are processed in-order on a
 * single-consumer queue per connection; consecutive pointer moves for the same
 * finger are coalesced so a fast drag never backs up the injector. Phase
 * transitions (down/up/cancel) are never dropped.
 */
import { WebSocketServer, WebSocket } from 'ws';
import {
  INPUT_PROTOCOL_VERSION,
  decodeClientFrame,
  type ClientFrame,
  type InputPlatform,
  type ServerFrame,
} from './input-protocol.js';
import type { InputRouter } from './input-router.js';

export interface InputServerHandle {
  readonly port: number;
  close(): Promise<void>;
}

export interface InputServerOptions {
  port: number;
  host?: string;
  device: string;
  platform: InputPlatform;
  /** Build a fresh router (and its per-connection pointer state) for each client. */
  makeRouter: () => InputRouter | Promise<InputRouter>;
  dlog?: (msg: string) => void;
}

const STAT_INTERVAL_MS = 500;

function send(ws: WebSocket, frame: ServerFrame): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

export function startInputServer(opts: InputServerOptions): Promise<InputServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const dlog = opts.dlog ?? (() => {});

  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host, port: opts.port });

    wss.on('error', reject);

    wss.on('listening', () => {
      const addr = wss.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : opts.port;
      dlog(`input socket ready at ws://${host}:${boundPort}/input (${opts.platform})`);
      resolve({
        port: boundPort,
        close: () =>
          new Promise<void>((res) => {
            for (const client of wss.clients) client.close();
            wss.close(() => res());
          }),
      });
    });

    wss.on('connection', (ws) => {
      handleConnection(ws, opts, dlog).catch((err) => {
        dlog(`input connection error: ${err instanceof Error ? err.message : String(err)}`);
        try {
          ws.close();
        } catch {
          /* ok */
        }
      });
    });
  });
}

async function handleConnection(
  ws: WebSocket,
  opts: InputServerOptions,
  dlog: (m: string) => void
): Promise<void> {
  const router = await opts.makeRouter();

  send(ws, {
    t: 'hello',
    protocol: INPUT_PROTOCOL_VERSION,
    device: opts.device,
    platform: opts.platform,
    capabilities: router.capabilities(),
  });

  const queue: ClientFrame[] = [];
  let draining = false;
  let dropped = 0;

  const statTimer = setInterval(() => {
    if (dropped > 0) {
      send(ws, { t: 'stat', dropped });
      dropped = 0;
    }
  }, STAT_INTERVAL_MS);
  statTimer.unref?.();

  const pump = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    while (queue.length > 0) {
      const frame = queue.shift()!;
      try {
        await router.dispatch(frame);
        if (frame.t !== 'select' && frame.ack && typeof frame.seq === 'number') {
          send(ws, { t: 'ok', seq: frame.seq });
        }
      } catch (err) {
        send(ws, {
          t: 'error',
          seq: frame.t !== 'select' ? frame.seq : undefined,
          code: 'dispatch_failed',
          msg: err instanceof Error ? err.message : String(err),
        });
      }
    }
    draining = false;
  };

  ws.on('message', (data) => {
    const frame = decodeClientFrame(data.toString());
    if (!frame) {
      send(ws, { t: 'error', code: 'bad_frame', msg: 'malformed or unknown frame' });
      return;
    }
    if (frame.t === 'select') return; // handshake reply; nothing to enqueue

    // Coalesce consecutive moves for the same finger — keep only the latest.
    if (frame.t === 'pointer' && frame.phase === 'move') {
      const last = queue[queue.length - 1];
      if (
        last &&
        last.t === 'pointer' &&
        last.phase === 'move' &&
        (last.id ?? 0) === (frame.id ?? 0)
      ) {
        queue[queue.length - 1] = frame;
        dropped++;
        return;
      }
    }
    queue.push(frame);
    void pump();
  });

  ws.on('close', () => {
    clearInterval(statTimer);
    void router.onClose();
  });

  ws.on('error', (err) => {
    dlog(`input socket error: ${err instanceof Error ? err.message : String(err)}`);
  });
}
