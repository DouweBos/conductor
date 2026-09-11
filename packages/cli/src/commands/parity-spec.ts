export const HELP = `  parity spec <name> --out <dir> --spec <elements.json>
                                       Write a reference run from a hand-authored or design-exported
                                       element list, so a design can be the thing targets are held to
    --screenshot <png>                Image to show beside the targets (optional; pixel diff is
                                       meaningless without one — pair with --ignore pixel)
    --label <text>                    Name the reference (default "Spec")`;

import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';
import { printSuccess, printError, printData, OutputOptions } from '../output.js';
import type { A11ySnapshotEntry } from '../drivers/a11y.js';
import { RunWriter } from '../parity/store.js';

/**
 * The element list a spec file carries. Deliberately the same vocabulary the
 * diff already reads — label, role, identifier, frame, value, focus — so a
 * design tool's export needs no translation layer and the comparison stays
 * structural. A spec is *not* a screenshot: pixels are the weak instrument
 * this whole tool argues against, and a design-as-picture would collapse the
 * diff to them. This keeps the semantic comparison intact.
 */
export interface SpecFile {
  width: number;
  height: number;
  elements: SpecElement[];
}

export interface SpecElement {
  label?: string;
  role?: string;
  identifier?: string;
  frame: { x: number; y: number; w: number; h: number };
  value?: string;
  focused?: boolean;
  enabled?: boolean;
  selected?: boolean;
}

export function specToSnapshot(spec: SpecFile): A11ySnapshotEntry[] {
  return spec.elements.map((e, i) => ({
    nodeId: `spec.${i}`,
    identifier: e.identifier ?? '',
    ref: `@e${i + 1}`,
    order: i,
    frame: e.frame,
    label: e.label ?? '',
    hint: '',
    role: e.role ?? '',
    traits: e.role ? [e.role] : [],
    announcement: e.label ?? '',
    value: e.value ?? '',
    state: {
      enabled: e.enabled ?? true,
      selected: e.selected ?? false,
      focused: e.focused ?? false,
    },
  }));
}

/** Validate the shape early: a bad frame produces a diff full of nonsense, not an error. */
export function validateSpec(raw: unknown): SpecFile {
  const s = raw as Partial<SpecFile>;
  if (!s || typeof s !== 'object') throw new Error('spec must be a JSON object');
  if (!Number.isFinite(s.width) || !Number.isFinite(s.height) || s.width! <= 0 || s.height! <= 0) {
    throw new Error('spec needs positive numeric width and height');
  }
  if (!Array.isArray(s.elements) || s.elements.length === 0) {
    throw new Error('spec needs a non-empty elements array');
  }
  s.elements.forEach((e, i) => {
    const f = (e as SpecElement).frame;
    if (!f || ![f.x, f.y, f.w, f.h].every((n) => Number.isFinite(n))) {
      throw new Error(`elements[${i}] needs a numeric frame {x, y, w, h}`);
    }
    if (!(e as SpecElement).label && !(e as SpecElement).identifier && !(e as SpecElement).role) {
      throw new Error(`elements[${i}] needs at least a label, an identifier or a role`);
    }
  });
  return s as SpecFile;
}

/** A flat mid-grey image at the spec's size, for when no screenshot is given. */
function placeholderPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(0x80);
  for (let i = 3; i < png.data.length; i += 4) png.data[i] = 0xff;
  return PNG.sync.write(png);
}

export async function paritySpec(
  name: string,
  opts: OutputOptions = {},
  flags: { out?: string; spec?: string; screenshot?: string; label?: string } = {}
): Promise<number> {
  if (!name) {
    printError('parity spec requires <name> — what to call this screen', opts);
    return 1;
  }
  if (!flags.out || !flags.spec) {
    printError('parity spec requires --out <dir> and --spec <elements.json>', opts);
    return 1;
  }
  try {
    const spec = validateSpec(JSON.parse(fs.readFileSync(path.resolve(flags.spec), 'utf-8')));
    const screenshot = flags.screenshot
      ? fs.readFileSync(path.resolve(flags.screenshot))
      : placeholderPng(spec.width, spec.height);

    const dir = path.resolve(flags.out);
    const writer = fs.existsSync(path.join(dir, 'run.json'))
      ? RunWriter.open(dir)
      : new RunWriter(dir, { role: 'reference', deviceId: 'spec', label: flags.label ?? 'Spec' });
    writer.add(name, {
      platform: 'design',
      width: spec.width,
      height: spec.height,
      hierarchy: { spec: true },
      a11ySnapshot: specToSnapshot(spec),
      screenshot,
    });
    writer.finish();

    if (opts.json) printData({ status: 'ok', dir, name, elements: spec.elements.length }, opts);
    else
      printSuccess(
        `parity spec — "${name}" written to ${dir} (${spec.elements.length} element(s)` +
          `${flags.screenshot ? '' : ', placeholder image — diff with --ignore pixel'})`,
        opts
      );
    return 0;
  } catch (err) {
    printError(`parity spec — failed\n${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}
