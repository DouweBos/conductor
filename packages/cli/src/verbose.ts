let _verbose = false;

export function setVerbose(v: boolean): void {
  _verbose = v;
}

export function isVerbose(): boolean {
  return _verbose;
}

export function log(...args: unknown[]): void {
  if (_verbose) {
    console.error('[verbose]', ...args);
  }
}
