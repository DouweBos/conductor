/**
 * Active flow recording. When a path is registered for a session, successful
 * device-action commands append themselves to the file as YAML steps.
 *
 * This is a *command-level* recorder — Conductor's drivers don't expose an
 * input event channel (they receive commands, not user gestures), so we record
 * the commands the agent issues rather than user-driven taps. Pair with
 * `flow record start` to begin and `flow record finish` to close out.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { updateSession, getSession, type Session } from '../session.js';

interface SessionWithRecording extends Session {
  recordingPath?: string;
}

const FLOWS_DIR = path.join(os.homedir(), '.conductor', 'recordings');

export function defaultRecordingPath(sessionName: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(FLOWS_DIR, `${sessionName}-${ts}.yaml`);
}

export async function startRecording(
  sessionName: string,
  out: string | undefined,
  appId?: string
): Promise<string> {
  const target = out ? path.resolve(out) : defaultRecordingPath(sessionName);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const header =
    (appId ? `appId: ${appId}\n` : `# appId: <set me>\n`) +
    `---\n# Recording started ${new Date().toISOString()}\n`;
  fs.writeFileSync(target, header, 'utf-8');
  await updateSession({ recordingPath: target } as Partial<Session>, sessionName);
  return target;
}

export async function finishRecording(sessionName: string): Promise<string | null> {
  const session = (await getSession(sessionName)) as SessionWithRecording;
  if (!session.recordingPath) return null;
  const out = session.recordingPath;
  fs.appendFileSync(out, `# Recording finished ${new Date().toISOString()}\n`);
  delete session.recordingPath;
  await updateSession(session as Partial<Session>, sessionName);
  return out;
}

export async function getActiveRecording(sessionName: string): Promise<string | null> {
  const session = (await getSession(sessionName)) as SessionWithRecording;
  return session.recordingPath ?? null;
}

export function appendStep(filePath: string, yamlStep: string): void {
  fs.appendFileSync(filePath, yamlStep.endsWith('\n') ? yamlStep : yamlStep + '\n', 'utf-8');
}

export function appendEcho(filePath: string, text: string): void {
  fs.appendFileSync(
    filePath,
    `- runScript: |\n    console.log(${JSON.stringify(text)})\n`,
    'utf-8'
  );
}

/**
 * Map a conductor command + args into one or more Maestro-flavoured YAML
 * steps. Returns null for commands that should not be recorded (lifecycle,
 * inspection, status). The mapping is intentionally narrow — when we cannot
 * faithfully replay something, we omit it rather than emit a broken step.
 */
export function commandToYamlStep(
  cmd: string,
  rest: string[],
  argv: Record<string, unknown>
): string | null {
  switch (cmd) {
    case 'launch-app': {
      const appId = rest[0];
      if (!appId) return null;
      const lines = [`- launchApp:`, `    appId: ${appId}`];
      if (argv['clear-state']) lines.push(`    clearState: true`);
      return lines.join('\n');
    }
    case 'stop-app':
      return rest[0] ? `- stopApp: ${rest[0]}` : `- stopApp`;
    case 'clear-state':
      return rest[0] ? `- clearState:\n    appId: ${rest[0]}` : `- clearState`;
    case 'tap-on': {
      const text = rest.join(' ').trim();
      const id = argv['id'] as string | undefined;
      const t = argv['text'] as string | undefined;
      if (id) return `- tapOn:\n    id: ${JSON.stringify(id)}`;
      if (t) return `- tapOn:\n    text: ${JSON.stringify(t)}`;
      if (text) return `- tapOn: ${JSON.stringify(text)}`;
      return null;
    }
    case 'input-text':
      return `- inputText: ${JSON.stringify(rest.join(' '))}`;
    case 'erase-text': {
      const n = rest[0] ?? argv['characters'] ?? '50';
      return `- eraseText: ${n}`;
    }
    case 'back':
      return `- back`;
    case 'hide-keyboard':
      return `- hideKeyboard`;
    case 'press-key':
      return `- pressKey: ${JSON.stringify(rest[0] ?? '')}`;
    case 'scroll':
      return `- scroll`;
    case 'swipe': {
      const dir = (argv['direction'] as string | undefined) ?? 'up';
      return `- swipe:\n    direction: ${dir}`;
    }
    case 'open-link':
      return `- openLink: ${JSON.stringify(rest[0] ?? '')}`;
    case 'set-orientation':
      return `- setOrientation: ${rest[0] ?? argv['orientation'] ?? 'portrait'}`;
    case 'set-location': {
      const lat = argv['lat'] ?? argv['latitude'];
      const lng = argv['lng'] ?? argv['longitude'];
      if (lat === undefined || lng === undefined) return null;
      return `- setLocation:\n    latitude: ${lat}\n    longitude: ${lng}`;
    }
    case 'paste':
      return `- runScript: |\n    // paste — re-record manually if needed`;
    case 'assert-visible': {
      const text = rest.join(' ').trim();
      return text ? `- assertVisible: ${JSON.stringify(text)}` : null;
    }
    case 'assert-not-visible': {
      const text = rest.join(' ').trim();
      return text ? `- assertNotVisible: ${JSON.stringify(text)}` : null;
    }
    default:
      return null;
  }
}
