/**
 * Turns the parsed `--device` / `--device-name` / `--cdp-*` flags into the
 * session name (= device ID) a command runs against. Any ambiguity is an error:
 * falling through to "the first booted device" is how web/CDP commands used to
 * land on an unrelated Android emulator.
 */

export interface DeviceSelectionDeps {
  /** Auto-pick when no device was named; throws when the choice is ambiguous. */
  pick: (platform?: string) => Promise<string | undefined>;
  /** Booted devices, for `--device-name`. */
  discover: () => Promise<Array<{ id: string; name: string }>>;
}

export class DeviceSelectionError extends Error {}

export function isWebDeviceId(id: string): boolean {
  return id === 'web' || id.startsWith('web:');
}

/**
 * Flags glued into one argument (e.g. zsh expanding an unquoted `$FLAGS`
 * without word-splitting) parse as a single bogus option, dropping `--device`.
 */
export function findJoinedFlags(rawArgs: string[]): string[] {
  return rawArgs.filter((a) => a.startsWith('-') && /\s--[a-z]/i.test(a));
}

export async function resolveSessionName(
  argv: Record<string, unknown>,
  rawArgs: string[],
  deps: DeviceSelectionDeps
): Promise<string> {
  const joined = findJoinedFlags(rawArgs);
  if (joined.length > 0) {
    throw new DeviceSelectionError(
      `Several flags arrived as one argument: ${joined.map((j) => `"${j}"`).join(', ')}.\n` +
        `A shell variable holding flags was probably expanded without word-splitting ` +
        `(zsh does not split "$VAR"). Pass each flag as its own argument, e.g. use an ` +
        `array ("\${FLAGS[@]}") or \${=FLAGS} in zsh.`
    );
  }

  const explicitDevice = argv['device'] as string | undefined;
  const deviceName = argv['device-name'] as string | undefined;
  const cdpUrl = argv['cdp-url'] as string | undefined;
  const cdpTarget = argv['cdp-target'] as string | undefined;

  if (explicitDevice !== undefined && deviceName !== undefined) {
    throw new DeviceSelectionError('--device and --device-name are mutually exclusive.');
  }
  if (explicitDevice === '' || (explicitDevice as unknown) === true) {
    throw new DeviceSelectionError('--device needs a value.');
  }

  let sessionName: string;
  if (deviceName !== undefined) {
    const match = (await deps.discover()).find((d) => d.name === deviceName);
    if (!match) {
      throw new DeviceSelectionError(
        `No booted device found with name "${deviceName}". Run \`conductor list-devices\` to see booted devices.`
      );
    }
    sessionName = match.id;
  } else if (explicitDevice !== undefined) {
    sessionName = explicitDevice;
  } else {
    let picked: string | undefined;
    try {
      picked = await deps.pick(argv['platform'] as string | undefined);
    } catch (err) {
      throw new DeviceSelectionError((err as Error).message);
    }
    sessionName = picked ?? 'default';
  }

  // CDP flags only mean something to a web session; anywhere else they'd be
  // silently ignored while the command runs on another device.
  if ((cdpUrl !== undefined || cdpTarget !== undefined) && !isWebDeviceId(sessionName)) {
    const flags = [cdpUrl !== undefined && '--cdp-url', cdpTarget !== undefined && '--cdp-target']
      .filter(Boolean)
      .join(' and ');
    throw new DeviceSelectionError(
      `${flags} only work with web devices, but the command resolved to ` +
        `${sessionName === 'default' ? 'no explicit device' : `"${sessionName}"`}.\n` +
        `Pass --device web:chromium:<label> (or a web:cdp:<port>:<target> id from \`conductor web-targets\`).`
    );
  }

  return sessionName;
}
