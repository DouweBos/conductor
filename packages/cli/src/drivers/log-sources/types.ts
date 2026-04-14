/** Unified log entry emitted by all log sources. */
export interface LogEntry {
  timestamp: string;
  level: 'verbose' | 'debug' | 'log' | 'info' | 'warning' | 'error';
  message: string;
  stackTrace: string | null;
  source: 'metro' | 'device' | 'console';
}

/** Common interface for all platform log sources. */
export interface LogSource {
  /** Open the underlying connection / process. */
  connect(): Promise<void>;
  /** Register a callback for incoming log entries. */
  onEntry(callback: (entry: LogEntry) => void): void;
  /** Tear down the connection / process. */
  disconnect(): void;
}

/** Numeric severity for level filtering. Includes short aliases. */
export const LEVEL_SEVERITY: Record<string, number> = {
  verbose: 0,
  debug: 1,
  log: 2,
  info: 3,
  warning: 4,
  warn: 4,
  error: 5,
};
