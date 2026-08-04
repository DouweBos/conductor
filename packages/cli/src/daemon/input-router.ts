/**
 * Routes decoded input frames to a platform backend.
 *
 * Owns the pointer-buffering fallback: because XCUITest's synthesizeEvent is
 * atomic (a touch can't be held open across frames), an open-ended drag is
 * buffered `down → move… → up` and replayed as one gesture on `up`. When a
 * native held-touch backend (`livePointer`) is present, pointer frames stream
 * straight through instead and `liveDrag` is advertised as `native`.
 */
import type { InputBackend, NormPath } from './input-backends.js';
import type {
  ClientFrame,
  InputCapabilities,
  LiveDragMode,
  PointerPhase,
} from './input-protocol.js';

/** A held-touch injector (native CoreSimulator HID). Streams pointer frames with the touch held down. */
export interface LivePointerBackend {
  pointer(id: number, phase: PointerPhase, nx: number, ny: number): Promise<void>;
}

interface PointerSession {
  steps: NormPath['steps'];
  lastStepAt: number;
  startNx: number;
  startNy: number;
  moved: boolean;
  done: boolean;
  canceled: boolean;
}

/** Movement below this (normalized) counts as a tap, not a drag. */
const TAP_EPSILON = 0.01;
/** Default scroll gesture duration. */
const SCROLL_DURATION_MS = 200;

export class InputRouter {
  private readonly sessions = new Map<number, PointerSession>();
  private readonly liveOpen = new Set<number>();
  private readonly now: () => number;

  constructor(
    private readonly backend: InputBackend,
    private readonly opts: { livePointer?: LivePointerBackend; now?: () => number } = {}
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  get liveDrag(): LiveDragMode {
    return this.opts.livePointer ? 'native' : 'buffered';
  }

  capabilities(): InputCapabilities {
    return this.backend.capabilities(this.liveDrag);
  }

  /** Dispatch one frame. `select` is handled by the server, not here. */
  async dispatch(frame: ClientFrame): Promise<void> {
    switch (frame.t) {
      case 'pointer':
        return this.handlePointer(frame.id ?? 0, frame.phase, frame.x, frame.y);
      case 'key':
        return this.backend.key(frame.code, { down: frame.down, mods: frame.mods });
      case 'text':
        return this.backend.text(frame.value);
      case 'button':
        return this.backend.button(frame.name, frame.holdMs);
      case 'scroll':
        return this.backend.swipe(
          frame.x,
          frame.y,
          frame.x - frame.dx,
          frame.y - frame.dy,
          SCROLL_DURATION_MS
        );
      case 'tvremote':
        return this.backend.button(frame.button, frame.holdMs);
      case 'select':
        return;
    }
  }

  private async handlePointer(
    id: number,
    phase: PointerPhase,
    nx: number,
    ny: number
  ): Promise<void> {
    // Native held-touch path: stream straight through.
    if (this.opts.livePointer) {
      if (phase === 'down') this.liveOpen.add(id);
      if (phase === 'up' || phase === 'cancel') this.liveOpen.delete(id);
      return this.opts.livePointer.pointer(id, phase, nx, ny);
    }

    // Buffered path.
    const t = this.now();
    if (phase === 'down') {
      this.sessions.set(id, {
        steps: [{ nx, ny, tMs: 0 }],
        lastStepAt: t,
        startNx: nx,
        startNy: ny,
        moved: false,
        done: false,
        canceled: false,
      });
      return;
    }

    const s = this.sessions.get(id);
    if (!s) return; // move/up without a down — ignore

    s.steps.push({ nx, ny, tMs: Math.max(0, t - s.lastStepAt) });
    s.lastStepAt = t;
    if (Math.hypot(nx - s.startNx, ny - s.startNy) > TAP_EPSILON) s.moved = true;

    if (phase === 'up' || phase === 'cancel') {
      s.done = true;
      s.canceled = phase === 'cancel';
      if ([...this.sessions.values()].every((x) => x.done)) await this.flush();
    }
  }

  private async flush(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    const active = sessions.filter((s) => !s.canceled);
    if (active.length === 0) return;

    if (active.length === 1 && !active[0].moved) {
      await this.backend.tap(active[0].startNx, active[0].startNy);
      return;
    }
    await this.backend.gesture(active.map((s) => ({ steps: s.steps })));
  }

  /**
   * Release any touch still held when the socket closes, so no finger is left
   * stuck down. Buffered sessions flush as-is; live touches get a cancel.
   */
  async onClose(): Promise<void> {
    if (this.opts.livePointer) {
      const open = [...this.liveOpen];
      this.liveOpen.clear();
      for (const id of open) {
        await this.opts.livePointer.pointer(id, 'cancel', 0, 0).catch(() => {});
      }
      return;
    }
    if (this.sessions.size > 0) {
      for (const s of this.sessions.values()) s.done = true;
      await this.flush().catch(() => {});
    }
  }
}
