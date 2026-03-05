export interface OutputOptions {
  json?: boolean;
}

export function printSuccess(message: string, opts?: OutputOptions): void {
  if (opts?.json) {
    console.log(JSON.stringify({ status: 'ok', message }));
  } else {
    console.log(`✓ ${message}`);
  }
}

export function printError(message: string, opts?: OutputOptions): void {
  if (opts?.json) {
    console.log(JSON.stringify({ status: 'error', message }));
  } else {
    console.error(`✗ ${message}`);
  }
}

export function printData(data: unknown, opts?: OutputOptions): void {
  if (opts?.json) {
    console.log(JSON.stringify(data));
  } else if (typeof data === 'string') {
    console.log(data);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

export function exit(code: number): never {
  process.exit(code);
}
