/**
 * Streaming device-input protocol (conductor ⇄ Argus).
 *
 * A persistent per-device WebSocket carries pointer/key/button/scroll/remote
 * frames so continuous drags and fast typing stay low-latency, instead of the
 * per-event HTTP the web driver uses. Conductor owns coord→device translation
 * and keymaps; the client streams normalized 0..1 coordinates.
 *
 * See docs/device-input-migration.md for the design.
 */

export const INPUT_PROTOCOL_VERSION = 1;

export type InputPlatform = 'ios' | 'tvos' | 'android' | 'web' | 'vega';

/** How live open-ended drags are serviced: a held-touch backend, or buffered into one gesture on `up`. */
export type LiveDragMode = 'native' | 'buffered' | 'none';

export interface InputCapabilities {
  touch: boolean;
  drag: boolean;
  multitouch: boolean;
  /** Hardware buttons wired for this platform (allow-list; anything absent → client falls back). */
  buttons: string[];
  keyboard: boolean;
  text: boolean;
  tvRemote: boolean;
  /** Input works with no app attached (iOS home screen / SpringBoard). */
  springboard: boolean;
  liveDrag: LiveDragMode;
  binaryPointer: boolean;
  /** Coordinate space the client must send. Always normalized 0..1 for now. */
  coord: 'normalized';
}

// ── Server → client frames ────────────────────────────────────────────────────

export interface HelloFrame {
  t: 'hello';
  protocol: number;
  device: string;
  platform: InputPlatform;
  capabilities: InputCapabilities;
}

/** Ack for a frame that set `ack:true`. */
export interface OkFrame {
  t: 'ok';
  seq: number;
}

export interface ErrorFrame {
  t: 'error';
  seq?: number;
  code: string;
  msg: string;
}

/** Emitted periodically when the server coalesced/dropped intermediate moves. */
export interface StatFrame {
  t: 'stat';
  dropped: number;
}

export type ServerFrame = HelloFrame | OkFrame | ErrorFrame | StatFrame;

// ── Client → server frames ────────────────────────────────────────────────────

export interface SelectFrame {
  t: 'select';
  protocol: number;
  coalesce?: { pointerHz?: number };
}

export type PointerPhase = 'down' | 'move' | 'up' | 'cancel';

export interface PointerFrame {
  t: 'pointer';
  seq?: number;
  /** Finger id for multitouch; defaults to 0. */
  id?: number;
  phase: PointerPhase;
  x: number; // normalized 0..1
  y: number; // normalized 0..1
  ack?: boolean;
}

export interface KeyFrame {
  t: 'key';
  seq?: number;
  /** Web-style key name (e.g. "Backspace", "Enter", "ArrowUp") — conductor maps to the device keycode. */
  code: string;
  mods?: string[];
  down?: boolean;
  ack?: boolean;
}

export interface TextFrame {
  t: 'text';
  seq?: number;
  value: string;
  ack?: boolean;
}

export interface ButtonFrame {
  t: 'button';
  seq?: number;
  /** Hardware button name (e.g. "home", "lock", "back", "volumeUp"). */
  name: string;
  action?: 'press' | 'down' | 'up';
  holdMs?: number;
  ack?: boolean;
}

export interface ScrollFrame {
  t: 'scroll';
  seq?: number;
  x: number; // anchor, normalized
  y: number;
  dx: number; // normalized content delta
  dy: number;
  ack?: boolean;
}

export interface TvRemoteFrame {
  t: 'tvremote';
  seq?: number;
  button: string; // up|down|left|right|select|menu|playPause
  holdMs?: number;
  ack?: boolean;
}

export type ClientFrame =
  | SelectFrame
  | PointerFrame
  | KeyFrame
  | TextFrame
  | ButtonFrame
  | ScrollFrame
  | TvRemoteFrame;

const CLIENT_FRAME_TYPES = new Set([
  'select',
  'pointer',
  'key',
  'text',
  'button',
  'scroll',
  'tvremote',
]);

/** Parse and shallow-validate one text frame. Returns null on malformed input. */
export function decodeClientFrame(raw: string): ClientFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const t = (parsed as { t?: unknown }).t;
  if (typeof t !== 'string' || !CLIENT_FRAME_TYPES.has(t)) return null;
  return parsed as ClientFrame;
}
