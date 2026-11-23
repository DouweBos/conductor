/**
 * Minimal source map v3 lookup, enough to turn a Metro bundle `line:column`
 * from a Hermes CPU profile into the original `file:line`.
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Int8Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64_INDEX[B64.charCodeAt(i)] = i;

export interface RawSourceMap {
  version: number;
  sources: string[];
  names?: string[];
  mappings: string;
  sourceRoot?: string;
  /** Indexed map: one sub-map per module (Metro serves these for lazy bundles). */
  sections?: Array<{ offset: { line: number; column: number }; map: RawSourceMap }>;
}

export interface OriginalPosition {
  source: string;
  /** 1-based. */
  line: number;
  /** 0-based. */
  column: number;
  name?: string;
}

/**
 * Decoded mappings, one sorted segment array per generated line:
 * [genColumn, sourceIndex, origLine(0-based), origColumn, nameIndex | -1].
 */
export class SourceMapLookup {
  private lines: Int32Array[] = [];
  /** Indexed maps: sections decoded on first lookup. */
  private sections?: Array<{
    line: number;
    column: number;
    map: RawSourceMap;
    lookup?: SourceMapLookup;
  }>;

  constructor(private readonly map: RawSourceMap) {
    if (map.sections) {
      this.sections = map.sections.map((sec) => ({
        line: sec.offset.line,
        column: sec.offset.column,
        map: sec.map,
      }));
      return;
    }
    this.decode(map.mappings);
  }

  private decode(mappings: string): void {
    let genCol = 0;
    let src = 0;
    let origLine = 0;
    let origCol = 0;
    let name = 0;
    let line: number[] = [];
    let i = 0;
    const n = mappings.length;
    const fields: number[] = [];
    while (i <= n) {
      const ch = i < n ? mappings.charCodeAt(i) : 59; /* ; */
      if (ch === 59 || ch === 44 /* , */) {
        if (fields.length > 0) {
          genCol += fields[0];
          if (fields.length >= 4) {
            src += fields[1];
            origLine += fields[2];
            origCol += fields[3];
            if (fields.length >= 5) name += fields[4];
            line.push(genCol, src, origLine, origCol, fields.length >= 5 ? name : -1);
          }
          fields.length = 0;
        }
        if (ch === 59) {
          this.lines.push(Int32Array.from(line));
          line = [];
          genCol = 0;
        }
        i++;
        continue;
      }
      // One base64 VLQ value.
      let value = 0;
      let shift = 0;
      let digit: number;
      do {
        digit = B64_INDEX[mappings.charCodeAt(i++)];
        if (digit < 0) throw new Error('invalid source map mappings');
        value += (digit & 31) << shift;
        shift += 5;
      } while (digit & 32);
      fields.push(value & 1 ? -(value >>> 1) : value >>> 1);
    }
  }

  /** `line` is 1-based, `column` 0-based (Chrome cpuprofile values + 1 / as-is). */
  originalPositionFor(line: number, column: number): OriginalPosition | null {
    if (this.sections) {
      // Section offsets are 0-based; take the last one starting at or before the position.
      const l0 = line - 1;
      let pick: (typeof this.sections)[number] | undefined;
      for (const sec of this.sections) {
        if (sec.line < l0 || (sec.line === l0 && sec.column <= column)) pick = sec;
        else break;
      }
      if (!pick) return null;
      pick.lookup ??= new SourceMapLookup(pick.map);
      return pick.lookup.originalPositionFor(
        l0 - pick.line + 1,
        l0 === pick.line ? column - pick.column : column
      );
    }
    const segs = this.lines[line - 1];
    if (!segs || segs.length === 0) return null;
    // Last segment whose generated column is <= column.
    let lo = 0;
    let hi = segs.length / 5 - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid * 5] <= column) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found < 0) found = 0;
    const o = found * 5;
    const source = this.map.sources[segs[o + 1]];
    if (source === undefined) return null;
    return {
      source: this.map.sourceRoot ? `${this.map.sourceRoot}${source}` : source,
      line: segs[o + 2] + 1,
      column: segs[o + 3],
      name: segs[o + 4] >= 0 ? this.map.names?.[segs[o + 4]] : undefined,
    };
  }
}

/**
 * Metro serves the map of `…/index.bundle?…` at `…/index.map?…`. Returns
 * undefined for URLs that are not Metro bundles.
 */
export function metroSourceMapUrl(bundleUrl: string): string | undefined {
  try {
    // Hermes reports RN bundle URLs as `…/entry.bundle//&platform=ios…` (query after `//&`).
    const u = new URL(bundleUrl.replace(/\.bundle\/\/&/, '.bundle?'));
    if (!/^https?:$/.test(u.protocol) || !/\.bundle$/.test(u.pathname)) return undefined;
    u.pathname = u.pathname.replace(/\.bundle$/, '.map');
    // Android emulators reach the host as 10.0.2.2 (10.0.3.2 on Genymotion); from the host it is loopback.
    if (u.hostname === '10.0.2.2' || u.hostname === '10.0.3.2') u.hostname = '127.0.0.1';
    return u.toString();
  } catch {
    return undefined;
  }
}

/**
 * Make an absolute source path readable: project-relative when under `cwd`,
 * otherwise trimmed to the part from `node_modules/` on.
 */
export function shortSourcePath(source: string, cwd = process.cwd()): string {
  let s = source.replace(/^webpack:\/\/\/?|^file:\/\//, '').replace(/^\/\[metro-project\]\//, '');
  if (cwd && s.startsWith(`${cwd}/`)) s = s.slice(cwd.length + 1);
  const nm = s.lastIndexOf('node_modules/');
  if (nm > 0) s = s.slice(nm);
  return s;
}

/** Display name of a script URL: the file name, without query or RN's `//&…` suffix. */
export function scriptFileName(url: string | undefined): string {
  const u = (url ?? '').replace(/\/\/&.*$/, '').replace(/[?#].*$/, '');
  return u.includes('/') ? u.slice(u.lastIndexOf('/') + 1) : u;
}
