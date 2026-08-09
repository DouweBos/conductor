import { execFile } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a binary and capture its output. Never rejects on a non-zero exit — the
 * caller inspects `code`. Rejects only when the binary can't be spawned.
 */
export function run(
  bin: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { cwd: opts.cwd, timeout: opts.timeout ?? 60_000, env: opts.env, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error(`Command not found: ${bin}`));
          return;
        }
        const code = err && typeof (err as { code?: unknown }).code === "number"
          ? (err as { code: number }).code
          : err
            ? 1
            : 0;
        resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() });
      },
    );
  });
}

/** Resolve whether a binary exists on PATH. */
export async function which(bin: string): Promise<string | null> {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const res = await run(finder, [bin], { timeout: 5000 });
    if (res.code === 0) {
      return res.stdout.split(/\r?\n/).find((l) => l.trim())?.trim() ?? null;
    }
  } catch {
    // ignore
  }
  return null;
}
