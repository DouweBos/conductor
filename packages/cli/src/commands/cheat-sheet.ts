export const HELP = `  cheat-sheet                         Print command reference`;

import fs from 'fs/promises';
import path from 'path';

export async function cheatSheet(): Promise<number> {
  // Try to read SKILL.md from the package root
  const skillPath = path.join(__dirname, '../../skills/conductor/SKILL.md');
  try {
    const content = await fs.readFile(skillPath, 'utf-8');
    console.log(content);
  } catch {
    // Fallback: print inline reference
    console.log(INLINE_CHEAT_SHEET);
  }
  return 0;
}

const INLINE_CHEAT_SHEET = `
conductor — Command Reference
================================

DEVICE MANAGEMENT
  list-devices                              List connected devices/simulators
  foreground-app                            Print bundle ID / package of the foreground app
  list-apps                                 List installed app IDs / package names
  session                                   Show current session (appId, deviceId)
  session --clear                           Clear session state
  session --list                            List all device sessions

APP CONTROL
  download-app <appId> [--output <path>]     Download installed app binary from device
  install-app <path>                        Install .app / .ipa / .apk onto device
  launch-app <appId> [--device <id>]        Launch app and save to session
    --clear-state                           Wipe app data/state before launching
    --clear-keychain                        Wipe keychain before launching
    --argument key=value                    Set launch argument (repeatable)
  stop-app [<appId>]                        Stop app (uses session appId if omitted)
  clear-state [<appId>]                     Clear app data/state (uses session appId if omitted)
  uninstall-app <appId>                     Uninstall app from device

INTERACTIONS
  tap <element>                             Tap element by text
    --id <id>                               Match by accessibility ID instead of text
    --index <n>                             Pick the nth match (0-based)
    --long-press                            Hold instead of tap
    --double-tap                            Double-tap the element
  type <text>                               Type text into focused field
  back                                      Press back button (Android only)
  press-key <key>                           Press a key (Enter, Backspace, Home, ...)
  scroll [--direction down|up|left|right]   Scroll (default: down)
  swipe --direction <UP|DOWN|LEFT|RIGHT>    Directional swipe
    --start <x,y>                           Start coordinate (0–1 normalised or absolute px)
    --end <x,y>                             End coordinate (same)
    --duration <ms>                         Swipe duration (default: 500)

ASSERTIONS
  assert-visible <element>                  Assert element is visible
    --id <id>                               Match by accessibility ID instead of text
    --timeout <ms>                          Max wait time (default: 17000)
    --optional                              Succeed even if element is not found

SCREENSHOTS & INSPECTION
  screenshot [--output <path>]              Take screenshot (default: ./screenshot-<ts>.png)
  inspect                                   Print UI hierarchy

FLOW EXECUTION
  run-flow <file> [--device <id>]           Run a Maestro YAML flow file
  run-flow-inline <yaml>                    Run inline YAML commands

DAEMON (optional — keeps driver alive between commands)
  daemon-start [--device <id>]             Start background daemon
  daemon-stop [--device <id>] [--all]      Stop daemon (--all stops every daemon)
  daemon-status [--device <id>]            Show daemon status

MULTI-AGENT / PARALLEL
  device-pool --list                        List devices and pool status
  device-pool --acquire                     Claim a free device (prints device ID)
  device-pool --release <id>               Release a device back to the pool
  run-parallel --flows-dir <path>           Run flows in parallel across all devices

MISC
  install-plugin                            Register/update the global Claude Code plugin
  install-skills                            Install skill files into .claude/skills/
  install-web [browser]                     Install Playwright browser for web automation
  cheat-sheet                               Print this reference

GLOBAL FLAGS
  --device <id>                             Target device (auto-detected if omitted)
  --json                                    Machine-readable JSON output
  --verbose, -v                             Log daemon calls, fallbacks, raw output
  --help, -h                                Show help

EXAMPLES
  conductor launch-app com.example.app
  conductor tap "Sign In"
  conductor tap --id "btn_login"
  conductor type "hello@example.com"
  conductor swipe --start 0.5,0.8 --end 0.5,0.2
  conductor assert-visible "Dashboard" --timeout 30000
  conductor screenshot --output /tmp/screen.png
  conductor run-flow ./flows/login.yaml
`.trim();
