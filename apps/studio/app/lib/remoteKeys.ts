/**
 * Keyboard → tvOS remote mapping for the device stream.
 *
 * A TV is focus-driven: there is nothing to tap, so the arrow keys are the only
 * way to drive one. Names must match `conductor list-options press-key`.
 */
export const REMOTE_KEY_MAP: Record<string, string> = {
  ArrowUp: "Remote Dpad Up",
  ArrowDown: "Remote Dpad Down",
  ArrowLeft: "Remote Dpad Left",
  ArrowRight: "Remote Dpad Right",
  Enter: "Remote Dpad Center",
  " ": "Remote Dpad Center",
  Escape: "Remote Menu",
  Backspace: "Remote Menu",
  MediaPlayPause: "Remote Media Play Pause",
};

/** The remote key for a DOM `KeyboardEvent.key`, or null if unmapped. */
export function remoteKeyFor(key: string): string | null {
  return REMOTE_KEY_MAP[key] ?? null;
}
