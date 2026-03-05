import { installPlugin } from './commands/install.js';

// Runs as `postinstall` after `npm install -g @houwert/conductor`.
// Silent on failure so it never breaks the npm install.
try {
  installPlugin();
  process.stdout.write('✓ Conductor Claude Code plugin installed\n');
} catch {
  // Silent on failure — never break npm install
}
