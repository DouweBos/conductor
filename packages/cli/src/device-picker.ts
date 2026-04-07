import { createInterface } from 'readline';
import { discoverBootedDevices } from './commands/list-devices.js';

/**
 * Discover booted devices and let the user pick one interactively
 * when multiple are found.
 *
 * - 0 devices → returns undefined
 * - 1 device  → returns it automatically
 * - N devices + TTY → shows a numbered picker
 * - N devices + no TTY → returns undefined (caller should error)
 */
export async function pickDevice(): Promise<string | undefined> {
  const devices = await discoverBootedDevices();

  if (devices.length === 0) return undefined;
  if (devices.length === 1) return devices[0].id;

  // Non-interactive context — can't prompt
  if (!process.stdin.isTTY) {
    console.error(
      `Multiple devices found but stdin is not a TTY. Use --device to specify one:\n` +
        devices.map((d) => `  ${d.id}  ${d.name} (${d.platform})`).join('\n')
    );
    return undefined;
  }

  console.log('Multiple devices detected — pick one:\n');
  for (let i = 0; i < devices.length; i++) {
    const d = devices[i];
    console.log(`  ${i + 1}) ${d.name}  (${d.platform}, ${d.id})`);
  }
  console.log();

  const choice = await promptChoice(devices.length);
  if (choice === null) return undefined;

  const picked = devices[choice];
  console.log(`Using ${picked.name} (${picked.id})\n`);
  return picked.id;
}

function promptChoice(max: number): Promise<number | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let resolved = false;

    const done = (value: number | null) => {
      if (resolved) return;
      resolved = true;
      rl.close();
      resolve(value);
    };

    const ask = () => {
      rl.question(`Enter 1–${max}: `, (answer) => {
        const n = parseInt(answer.trim(), 10);
        if (n >= 1 && n <= max) {
          done(n - 1);
        } else {
          ask();
        }
      });
    };

    rl.on('close', () => done(null));
    ask();
  });
}
