import { getSession, clearSession, sessionFilePath, listSessions } from '../session.js';
import { printData, printSuccess, OutputOptions } from '../output.js';

export async function sessionCmd(
  clear: boolean,
  list: boolean,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  if (list) {
    const sessions = await listSessions();
    if (opts.json) {
      printData({ status: 'ok', sessions }, opts);
    } else if (sessions.length === 0) {
      console.log('No sessions found.');
    } else {
      console.log('Sessions:');
      for (const name of sessions) {
        const s = await getSession(name);
        const marker = name === sessionName ? ' (current)' : '';
        console.log(`  ${name}${marker}  appId=${s.appId ?? '—'}  deviceId=${s.deviceId ?? '—'}`);
      }
    }
    return 0;
  }

  if (clear) {
    await clearSession(sessionName);
    printSuccess(`session "${sessionName}" cleared`, opts);
    return 0;
  }

  const session = await getSession(sessionName);
  const filePath = sessionFilePath(sessionName);

  if (opts.json) {
    printData({ status: 'ok', sessionName, session, file: filePath }, opts);
  } else {
    console.log(`Session:  ${sessionName}`);
    console.log(`File:     ${filePath}`);
    if (Object.keys(session).length === 0) {
      console.log('No active session.');
    } else {
      if (session.appId) console.log(`  appId:    ${session.appId}`);
      if (session.deviceId) console.log(`  deviceId: ${session.deviceId}`);
    }
  }
  return 0;
}
