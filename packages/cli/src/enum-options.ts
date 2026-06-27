// Central registry of commands/parameters that only accept a fixed set of
// enumerated values. The `list-options` command and the global `--options`
// flag read from here so agents (and humans) can discover valid values without
// trial-and-error.
//
// Where a value list already exists as the canonical source elsewhere, we
// import it so this registry can never drift from what the command validates.
// Small, stable 2–4 value lists are inlined with a pointer to their source.

import { VALID_KEYS } from './commands/press-key.js';
import { PRESETS } from './commands/set-viewport.js';
import { DIRECTIONS } from './utils.js';
import { LEVEL_SEVERITY } from './drivers/log-sources/types.js';

export interface EnumValue {
  value: string;
  description?: string;
}

export interface EnumParam {
  /** Command the parameter belongs to, e.g. "press-key". */
  command: string;
  /** Parameter name as the user types it, e.g. "--direction" or "<key>". */
  param: string;
  /** One-line description of what the parameter controls. */
  description: string;
  /** Valid values. */
  values: EnumValue[];
  /** Optional caveat, e.g. platform availability. */
  note?: string;
}

const DIRECTION_VALUES: EnumValue[] = DIRECTIONS.map((d) => ({ value: d }));

// `--level` accepts every key of LEVEL_SEVERITY (includes the `warn` alias).
const LOG_LEVELS: EnumValue[] = Object.keys(LEVEL_SEVERITY).map((value) => ({ value }));

export const ENUM_PARAMS: EnumParam[] = [
  {
    command: 'press-key',
    param: '<key>',
    description: 'Key, hardware button, or remote button to press',
    values: VALID_KEYS.map((value) => ({ value })),
    note: 'Matched case-insensitively. Availability varies by platform: "Remote …" / "TV …" keys target tvOS and Android TV; hardware buttons (Home, Lock, Power, Volume…) target iOS/Android.',
  },
  {
    command: 'scroll',
    param: '--direction',
    description: 'Scroll direction (default: down)',
    values: DIRECTION_VALUES,
  },
  {
    command: 'swipe',
    param: '--direction',
    description: 'Swipe direction (required unless --start/--end are given)',
    values: DIRECTION_VALUES,
  },
  {
    command: 'scroll-until-visible',
    param: '--direction',
    description: 'Scroll direction while searching (default: down)',
    values: DIRECTION_VALUES,
  },
  {
    command: 'set-orientation',
    param: '<orientation>',
    description: 'Device orientation',
    // Source: VALID in commands/set-orientation.ts
    values: [{ value: 'portrait' }, { value: 'landscape' }],
  },
  {
    command: 'start-device',
    param: '--platform',
    description: 'Platform of the device to start',
    // Source: switch in commands/start-device.ts
    values: [{ value: 'ios' }, { value: 'android' }, { value: 'tvos' }, { value: 'web' }],
  },
  {
    command: 'install-web',
    param: '[browser]',
    description: 'Playwright browser to install (default: chromium)',
    // Source: validBrowsers in commands/install.ts
    values: [{ value: 'chromium' }, { value: 'firefox' }, { value: 'webkit' }],
  },
  {
    command: 'set-viewport',
    param: '--preset',
    description: 'Device size preset instead of explicit width/height (web only)',
    values: Object.entries(PRESETS).map(([value, p]) => ({
      value,
      description: `${p.width}x${p.height} @${p.deviceScaleFactor}x${p.isMobile ? ', mobile' : ''}`,
    })),
  },
  {
    command: 'set-viewport',
    param: '--color-scheme',
    description: 'Emulate prefers-color-scheme (web only)',
    values: [{ value: 'dark' }, { value: 'light' }],
  },
  {
    command: 'logs',
    param: '--source',
    description: 'Filter logs by source (default: both)',
    // Source: sourceFilter in commands/logs.ts
    values: [{ value: 'metro' }, { value: 'device' }],
  },
  {
    command: 'logs',
    param: '--level',
    description: 'Minimum log level to show',
    values: LOG_LEVELS,
    note: '"warn" is an alias for "warning".',
  },
  {
    command: 'list-devices',
    param: '--platform',
    description: 'Filter listed devices by platform (also a global filter on most commands)',
    values: [{ value: 'ios' }, { value: 'android' }, { value: 'tvos' }, { value: 'web' }],
  },
];

/** All distinct command names that have at least one enumerated parameter. */
export function commandsWithEnums(): string[] {
  return [...new Set(ENUM_PARAMS.map((p) => p.command))];
}

/**
 * Find enumerated parameters matching a query. Matches a command name (e.g.
 * "press-key"), a bare parameter name (e.g. "direction", "--level"), or a
 * value (e.g. "tvos"). Returns all params when query is empty.
 */
export function findEnumParams(query?: string): EnumParam[] {
  if (!query) return ENUM_PARAMS;
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/^-+/, '')
      .replace(/[<>[\]]/g, '');
  const q = norm(query);

  // Exact matches (command, param, or value) take precedence so that an exact
  // command name like "scroll" doesn't also drag in "scroll-until-visible".
  const exact = ENUM_PARAMS.filter(
    (p) =>
      p.command.toLowerCase() === q ||
      norm(p.param) === q ||
      p.values.some((v) => v.value.toLowerCase() === q)
  );
  if (exact.length > 0) return exact;

  // Otherwise fall back to substring matching to forgive partial queries.
  return ENUM_PARAMS.filter(
    (p) => p.command.toLowerCase().includes(q) || norm(p.param).includes(q)
  );
}
