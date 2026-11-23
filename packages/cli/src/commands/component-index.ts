/**
 * Map component names to where they are defined in the app's source, so
 * findings can point at `src/screens/Home.tsx:42` instead of a bare name.
 * A regex scan rather than a parser: PascalCase function/class/const
 * declarations cover the way components are written in practice.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'ios',
  'android',
  'build',
  'dist',
  '.expo',
  '.next',
  'coverage',
  'Pods',
  '__tests__',
  '__mocks__',
]);
const EXT = /\.(tsx|jsx|ts|js)$/;
const MAX_FILES = 30_000;
const MAX_BYTES = 512 * 1024;

const PATTERNS = [
  /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Z][A-Za-z0-9_]*)\s*[(<]/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*(?:React\.)?(?:memo|forwardRef|observer)?\s*\(?\s*(?:async\s*)?(?:\(|function\b|[a-z_]\w*\s*=>)/,
  /^\s*(?:export\s+(?:default\s+)?)?class\s+([A-Z][A-Za-z0-9_]*)\s+extends\s+(?:React\.)?(?:Pure)?Component\b/,
];

export type ComponentIndex = Map<string, string[]>;

/** `Name:file:line` per component definition found under `root`. */
export async function buildComponentIndex(root: string): Promise<ComponentIndex> {
  const index: ComponentIndex = new Map();
  let files = 0;
  const walk = async (dir: string): Promise<void> => {
    if (files >= MAX_FILES) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files >= MAX_FILES) return;
      if (e.name.startsWith('.') && e.name !== '.') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full);
      } else if (EXT.test(e.name) && !/\.(test|spec|stories|d)\.[jt]sx?$/.test(e.name)) {
        files++;
        const stat = await fs.stat(full).catch(() => null);
        if (!stat || stat.size > MAX_BYTES) continue;
        const text = await fs.readFile(full, 'utf8').catch(() => '');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          for (const re of PATTERNS) {
            const m = lines[i].match(re);
            if (!m) continue;
            const loc = `${path.relative(root, full)}:${i + 1}`;
            const arr = index.get(m[1]) ?? [];
            if (arr.length < 5) arr.push(loc);
            index.set(m[1], arr);
            break;
          }
        }
      }
    }
  };
  await walk(root);
  return index;
}

/**
 * Where a rendered component is defined. Handles display names such as
 * `ProfileScreen(./profile.tsx)` (expo-router) and `Memo(Row)` / `ForwardRef(Row)`.
 * Ambiguous names return every candidate, joined, rather than guessing.
 */
export function locateComponent(index: ComponentIndex, displayName: string): string | undefined {
  const base = displayName
    .replace(/^(?:Memo|ForwardRef|Observer|withRouter)\((.+)\)$/, '$1')
    .replace(/\(.*\)$/, '')
    .trim();
  const hits = index.get(base);
  if (!hits || hits.length === 0) return undefined;
  const hint = displayName.match(/\(\.\/([^)]+)\)$/)?.[1];
  if (hint) {
    const exact = hits.find((h) => h.includes(hint.replace(/\.[jt]sx?$/, '')));
    if (exact) return exact;
  }
  return hits.length === 1 ? hits[0] : hits.join(' | ');
}
