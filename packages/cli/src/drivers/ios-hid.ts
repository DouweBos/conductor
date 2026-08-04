/**
 * Node client for the host-side CoreSimulator HID injector
 * (`packages/ios-hid`, built to `drivers/ios-hid/conductor-hid`).
 *
 * This is the streaming pointer backend: unlike XCUITest's atomic
 * `_XCT_synthesizeEvent`, it holds a touch DOWN and streams moves, so a live
 * drag animates on-device as the finger moves. Opt-in (CONDUCTOR_IOS_HID=1) and
 * single-touch — multitouch/discrete gestures stay on the XCUITest path.
 *
 * Talks newline-delimited JSON over the binary's stdio, one request in flight
 * at a time (FIFO correlation, mirroring the XCTest driver's simplicity).
 */
import { spawn, ChildProcess } from 'child_process';
import readline from 'readline';
import type { LivePointerBackend } from '../daemon/input-router.js';
import type { PointerPhase } from '../daemon/input-protocol.js';

interface HidResponse {
  ok: boolean;
  rc?: number;
  error?: string;
}

const PHASE_TO_TYPE: Record<PointerPhase, number> = {
  down: 0,
  move: 1,
  up: 2,
  cancel: 2, // release the held touch
};

export class IOSHidClient {
  private proc: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private readonly pending: Array<(r: HidResponse) => void> = [];

  constructor(
    private readonly binaryPath: string,
    private readonly udid: string
  ) {}

  start(): void {
    if (this.proc) return;
    this.proc = spawn(this.binaryPath, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.rl = readline.createInterface({ input: this.proc.stdout! });
    this.rl.on('line', (line) => {
      const resolve = this.pending.shift();
      if (!resolve) return;
      try {
        resolve(JSON.parse(line) as HidResponse);
      } catch {
        resolve({ ok: false, error: `bad response: ${line}` });
      }
    });
    this.proc.on('exit', () => {
      this.proc = null;
      this.rl = null;
      // Fail any in-flight requests so callers don't hang.
      while (this.pending.length) this.pending.shift()!({ ok: false, error: 'hid process exited' });
    });
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
    this.rl = null;
  }

  private send(req: Record<string, unknown>): Promise<HidResponse> {
    if (!this.proc) this.start();
    return new Promise((resolve) => {
      this.pending.push(resolve);
      this.proc!.stdin!.write(JSON.stringify(req) + '\n');
    });
  }

  async ping(): Promise<boolean> {
    const r = await this.send({ cmd: 'ping' });
    return r.ok;
  }

  /** Inject a touch phase at normalized coords. */
  async touch(nx: number, ny: number, phase: PointerPhase): Promise<void> {
    const r = await this.send({
      cmd: 'touch',
      udid: this.udid,
      x: nx,
      y: ny,
      type: PHASE_TO_TYPE[phase],
    });
    if (!r.ok) throw new Error(`hid touch failed (rc=${r.rc ?? '?'}) ${r.error ?? ''}`.trim());
  }

  /** Adapter for the router's live-pointer path (single finger; id ignored). */
  asLivePointer(): LivePointerBackend {
    return {
      pointer: (_id: number, phase: PointerPhase, nx: number, ny: number) =>
        this.touch(nx, ny, phase),
    };
  }
}
