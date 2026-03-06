import { installPlugin } from './commands/install.js';

// Runs as `postinstall` after `npm install -g @houwert/conductor`.
// Silent on failure so it never breaks the npm install.
try {
  const version = installPlugin();
  process.stdout.write(`✓ Conductor Claude Code plugin installed (v${version})\n`);
} catch {
  // Silent on failure — never break npm install
}
