/** Structural diff of two JSON values, for `debug watch`. */

export interface JsonChange {
  path: string;
  op: 'add' | 'remove' | 'change';
  from?: unknown;
  to?: unknown;
}

/** Fields that identify an array element across snapshots (query hash, route key, …). */
const IDENTITY_KEYS = ['queryHash', 'key', 'id', 'name'];

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Identity field shared by every element of both arrays, with unique values; else null. */
function identityKey(a: unknown[], b: unknown[]): string | null {
  const all = [...a, ...b];
  if (all.length === 0 || !all.every(isObj)) return null;
  for (const k of IDENTITY_KEYS) {
    const ok = [a, b].every((arr) => {
      const vals = arr.map((e) => (e as Record<string, unknown>)[k]);
      return (
        vals.every((v) => typeof v === 'string' || typeof v === 'number') &&
        new Set(vals).size === vals.length
      );
    });
    if (ok) return k;
  }
  return null;
}

function childPath(base: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;
}

export function diffJson(a: unknown, b: unknown, maxChanges = 200): JsonChange[] {
  const out: JsonChange[] = [];
  const walk = (x: unknown, y: unknown, path: string): void => {
    if (out.length >= maxChanges) return;
    if (x === y) return;
    if (Array.isArray(x) && Array.isArray(y)) {
      const id = identityKey(x, y);
      if (id) {
        const byId = (arr: unknown[]) =>
          new Map(arr.map((e) => [String((e as Record<string, unknown>)[id]), e]));
        const mx = byId(x);
        const my = byId(y);
        for (const [k, v] of mx) {
          const p = `${path}[${id}=${JSON.stringify(k)}]`;
          if (!my.has(k)) out.push({ path: p, op: 'remove', from: v });
          else walk(v, my.get(k), p);
        }
        for (const [k, v] of my) {
          if (!mx.has(k))
            out.push({ path: `${path}[${id}=${JSON.stringify(k)}]`, op: 'add', to: v });
        }
        return;
      }
      const n = Math.max(x.length, y.length);
      for (let i = 0; i < n; i++) {
        const p = `${path}[${i}]`;
        if (i >= x.length) out.push({ path: p, op: 'add', to: y[i] });
        else if (i >= y.length) out.push({ path: p, op: 'remove', from: x[i] });
        else walk(x[i], y[i], p);
      }
      return;
    }
    if (isObj(x) && isObj(y)) {
      for (const k of Object.keys(x)) {
        const p = childPath(path, k);
        if (!(k in y)) out.push({ path: p, op: 'remove', from: x[k] });
        else walk(x[k], y[k], p);
      }
      for (const k of Object.keys(y)) {
        if (!(k in x)) out.push({ path: childPath(path, k), op: 'add', to: y[k] });
      }
      return;
    }
    out.push({ path, op: 'change', from: x, to: y });
  };
  walk(a, b, '$');
  return out;
}

/** One-line rendering of a change, values clipped. */
export function formatChange(c: JsonChange, width = 120): string {
  const clip = (v: unknown): string => {
    const s = v === undefined ? 'undefined' : JSON.stringify(v);
    return s.length > width ? `${s.slice(0, width - 1)}…` : s;
  };
  if (c.op === 'add') return `+ ${c.path} = ${clip(c.to)}`;
  if (c.op === 'remove') return `- ${c.path} (was ${clip(c.from)})`;
  return `~ ${c.path}: ${clip(c.from)} → ${clip(c.to)}`;
}
