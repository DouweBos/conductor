import fs from 'fs';
import path from 'path';

/**
 * Walk up from __dirname to find the package root (the directory containing
 * package.json). This handles both the normal build (dist/...) and the test
 * build (dist-tests/packages/cli/src/...) where __dirname has extra path
 * levels, making a fixed relative path incorrect.
 */
export function findPkgRoot(fromDir: string): string {
  let dir = fromDir;
  while (true) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: two levels up from the file's directory (dist/commands/ → pkg root)
  return path.join(fromDir, '..', '..');
}
