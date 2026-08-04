/**
 * Streaming video WebSocket server (one per device daemon).
 *
 * The capture counterpart to input-server.ts. Bound to loopback; N clients open
 * a socket and receive one JSON `config` frame followed by binary H.264 Annex B
 * access units. All subscribers share one capture via a VideoHub — the first
 * connection starts the capture backend, the last one out stops it. A late
 * joiner gets the cached config + keyframe immediately (hub responsibility).
 */
import { WebSocketServer, WebSocket } from 'ws';
import {
  toConfigFrame,
  type VideoConfig,
  type VideoPlatform,
  type VideoServerFrame,
} from './video-protocol.js';
import { VideoHub } from './video-hub.js';
import type { VideoSource } from './video-source.js';

export interface VideoServerHandle {
  readonly port: number;
  readonly hub: VideoHub;
  close(): Promise<void>;
}

export interface VideoServerOptions {
  port: number;
  host?: string;
  device: string;
  platform: VideoPlatform;
  /** Build the capture source bound to the shared hub. Called once, lazily. */
  makeSource: (hub: VideoHub) => VideoSource;
  dlog?: (msg: string) => void;
}

function sendJson(ws: WebSocket, frame: VideoServerFrame): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

export function startVideoServer(opts: VideoServerOptions): Promise<VideoServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const dlog = opts.dlog ?? (() => {});
  const hub = new VideoHub();
  const source = opts.makeSource(hub);

  // Serialize start/stop so a rapid connect/disconnect churn can't race the
  // capture backend into an inconsistent state.
  let lifecycle: Promise<void> = Promise.resolve();
  const runExclusive = (fn: () => Promise<void>): Promise<void> => {
    lifecycle = lifecycle.then(fn, fn);
    return lifecycle;
  };

  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host, port: opts.port });
    wss.on('error', reject);

    wss.on('listening', () => {
      const addr = wss.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : opts.port;
      dlog(`video socket ready at ws://${host}:${boundPort}/stream (${opts.platform})`);
      resolve({
        port: boundPort,
        hub,
        close: () =>
          runExclusive(async () => {
            for (const client of wss.clients) client.close();
            await source.stop().catch(() => {});
            await new Promise<void>((res) => wss.close(() => res()));
          }),
      });
    });

    wss.on('connection', (ws) => {
      const listener = {
        onConfig: (config: VideoConfig) =>
          sendJson(ws, toConfigFrame(config, opts.device, opts.platform)),
        onFrame: (annexB: Buffer, _keyFrame: boolean) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(annexB);
        },
      };

      const unsubscribe = hub.subscribe(listener);
      const wasFirst = hub.subscriberCount === 1;
      if (wasFirst) {
        void runExclusive(async () => {
          try {
            await source.start();
          } catch (err) {
            dlog(`capture start error: ${err instanceof Error ? err.message : String(err)}`);
            sendJson(ws, {
              t: 'notice',
              code: 'capture_failed',
              msg: 'capture backend failed to start',
            });
          }
        });
      }

      const teardown = (): void => {
        unsubscribe();
        if (hub.subscriberCount === 0) {
          void runExclusive(() => source.stop().catch(() => {}));
        }
      };

      ws.on('close', teardown);
      ws.on('error', (err) => {
        dlog(`video socket error: ${err instanceof Error ? err.message : String(err)}`);
      });
      // Clients are pure subscribers; inbound messages are ignored.
    });
  });
}
