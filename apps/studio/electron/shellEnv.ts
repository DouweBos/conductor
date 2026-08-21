import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * When launched from Finder, a macOS .app inherits a minimal PATH that omits
 * Homebrew, mise, and user shims — so `maestro`, `conductor`, and `claude` can't
 * be found. Resolve the interactive login shell's PATH once and merge it into
 * process.env. No-op on non-darwin or when already run from a terminal.
 */
export async function fixProcessPath(): Promise<void> {
  if (process.platform !== "darwin") return;
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const { stdout } = await execFileAsync(shell, ["-ilc", "echo -n \"$PATH\""], {
      timeout: 5000,
    });
    const resolved = stdout.trim();
    if (resolved && resolved.includes("/")) {
      const merged = new Set([
        ...resolved.split(":"),
        ...(process.env.PATH ?? "").split(":"),
      ]);
      process.env.PATH = [...merged].filter(Boolean).join(":");
    }
  } catch {
    // Fall back to common install locations so the CLIs are still discoverable.
    const extra = ["/opt/homebrew/bin", "/usr/local/bin"];
    const merged = new Set([...(process.env.PATH ?? "").split(":"), ...extra]);
    process.env.PATH = [...merged].filter(Boolean).join(":");
  }
}
