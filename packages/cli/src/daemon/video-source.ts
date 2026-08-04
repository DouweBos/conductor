/**
 * Capture sources — the producer half of the video stream. A source drives one
 * platform's capture and feeds decoded config/access-units into a VideoHub. The
 * video server ref-counts subscribers and calls start()/stop() so exactly one
 * capture runs while ≥1 subscriber is connected (last one out stops it).
 *
 * iOS/tvOS: spawns the host-side `conductor-capture` binary (packages/ios-capture),
 * which captures the Simulator framebuffer via SimulatorKit, VideoToolbox-encodes
 * H.264, and serves a raw Annex B TCP stream. We connect to that port, parse the
 * elementary stream, and forward.
 */
import { spawn, type ChildProcess } from 'child_process';
import net from 'net';
import readline from 'readline';
import { H264AnnexBParser } from './h264-annexb.js';
import type { VideoHub } from './video-hub.js';

export interface VideoSource {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface CaptureResponse {
  ok: boolean;
  port?: number;
  error?: string;
}

/** Restart the capture backend at most this often if the TCP stream drops. */
const RESTART_BACKOFF_MS = 1000;

export class IOSCaptureSource implements VideoSource {
  private proc: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private socket: net.Socket | null = null;
  private parser: H264AnnexBParser | null = null;
  private readonly pending: Array<(r: CaptureResponse) => void> = [];
  private active = false;
  private restarting = false;

  constructor(
    private readonly binaryPath: string,
    private readonly udid: string,
    private readonly hub: VideoHub,
    private readonly dlog: (m: string) => void = () => {}
  ) {}

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    await this.spawnAndCapture();
  }

  private async spawnAndCapture(): Promise<void> {
    this.proc = spawn(this.binaryPath, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.rl = readline.createInterface({ input: this.proc.stdout! });
    this.rl.on('line', (line) => {
      const resolve = this.pending.shift();
      if (!resolve) return;
      try {
        resolve(JSON.parse(line) as CaptureResponse);
      } catch {
        resolve({ ok: false, error: `bad response: ${line}` });
      }
    });
    this.proc.on('exit', (code) => {
      this.dlog(`capture backend exited (code=${code ?? '?'})`);
      this.proc = null;
      this.rl = null;
      while (this.pending.length) this.pending.shift()!({ ok: false, error: 'capture exited' });
      this.maybeRestart();
    });

    const res = await this.send({ cmd: 'start_capture', udid: this.udid });
    if (!res.ok || typeof res.port !== 'number') {
      throw new Error(`start_capture failed: ${res.error ?? 'no port returned'}`);
    }
    this.connectStream(res.port);
    this.dlog(`capture started, streaming H.264 from 127.0.0.1:${res.port}`);
  }

  private connectStream(port: number): void {
    const parser = new H264AnnexBParser({
      onConfig: (config) => {
        this.dlog(`H.264 config ${config.codecString} ${config.width}x${config.height}`);
        this.hub.emitConfig(config);
      },
      onFrame: (annexB, keyFrame) => this.hub.emitFrame(annexB, keyFrame),
    });
    this.parser = parser;

    const socket = net.connect(port, '127.0.0.1', () => {
      this.dlog(`connected to capture stream on ${port}`);
    });
    socket.on('data', (chunk: Buffer) => parser.push(chunk));
    socket.on('error', (err) => this.dlog(`capture stream error: ${err.message}`));
    socket.on('close', () => {
      this.dlog('capture stream closed');
      this.maybeRestart();
    });
    this.socket = socket;
  }

  /** If capture died while subscribers still want it, relaunch after a short backoff. */
  private maybeRestart(): void {
    if (!this.active || this.restarting) return;
    this.restarting = true;
    this.teardownTransport();
    setTimeout(() => {
      this.restarting = false;
      if (!this.active) return;
      this.dlog('restarting capture backend');
      this.spawnAndCapture().catch((err) => this.dlog(`capture restart failed: ${err.message}`));
    }, RESTART_BACKOFF_MS).unref?.();
  }

  private teardownTransport(): void {
    this.socket?.destroy();
    this.socket = null;
    this.parser?.reset();
    this.parser = null;
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    try {
      if (this.proc) await this.send({ cmd: 'stop_capture' }).catch(() => {});
    } finally {
      this.teardownTransport();
      this.rl?.close();
      this.rl = null;
      this.proc?.kill();
      this.proc = null;
      this.hub.clear();
      this.dlog('capture stopped');
    }
  }

  private send(req: Record<string, unknown>): Promise<CaptureResponse> {
    return new Promise((resolve) => {
      if (!this.proc || !this.proc.stdin?.writable) {
        resolve({ ok: false, error: 'capture process not running' });
        return;
      }
      this.pending.push(resolve);
      this.proc.stdin.write(JSON.stringify(req) + '\n');
    });
  }
}
