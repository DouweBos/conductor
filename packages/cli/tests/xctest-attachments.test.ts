import fs from 'fs';
import os from 'os';
import path from 'path';
import { findAttachmentDirs, pruneXctestAttachments } from '../src/drivers/xctest-attachments.js';
import { TestSuite, assert } from './runner.js';

export const xctestAttachments = new TestSuite('XCTest attachment cleanup');

const HOUR = 60 * 60 * 1000;

function makeRoot(): { root: string; attachments: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-attach-'));
  const attachments = path.join(
    root,
    'UDID-1',
    'data',
    'Containers',
    'Data',
    'InternalDaemon',
    'DAEMON-1',
    'tmp',
    'Attachments'
  );
  fs.mkdirSync(attachments, { recursive: true });
  return { root, attachments };
}

function writeFile(file: string, bytes: number, ageMs: number): void {
  fs.writeFileSync(file, Buffer.alloc(bytes));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
}

xctestAttachments.test('finds Attachments dirs under every simulator', () => {
  const { root, attachments } = makeRoot();
  fs.mkdirSync(path.join(root, 'UDID-2', 'data'), { recursive: true });
  const dirs = findAttachmentDirs(root);
  assert(dirs.length === 1 && dirs[0] === attachments, `got ${JSON.stringify(dirs)}`);
  fs.rmSync(root, { recursive: true });
  return Promise.resolve();
});

xctestAttachments.test('deletes old closed files, keeps open and recent ones', async () => {
  const { root, attachments } = makeRoot();
  const old = path.join(attachments, 'old.sb-1');
  const openOld = path.join(attachments, 'recording.sb-2');
  const recent = path.join(attachments, 'recent');
  const nested = path.join(attachments, 'sub', 'nested');
  fs.mkdirSync(path.dirname(nested));
  writeFile(old, 100, 2 * HOUR);
  writeFile(openOld, 50, 2 * HOUR);
  writeFile(recent, 10, 0);
  writeFile(nested, 7, 2 * HOUR);

  const r = await pruneXctestAttachments({
    devicesRoot: root,
    findOpenInodes: () => Promise.resolve(new Set([fs.statSync(openOld).ino])),
  });

  assert(r.deleted === 2, `deleted ${r.deleted}`);
  assert(r.freedBytes === 107, `freed ${r.freedBytes}`);
  assert(r.skippedOpen === 1, `skippedOpen ${r.skippedOpen}`);
  assert(!fs.existsSync(old) && !fs.existsSync(nested), 'old files should be gone');
  assert(fs.existsSync(openOld), 'open file must be kept');
  assert(fs.existsSync(recent), 'recent file must be kept');
  fs.rmSync(root, { recursive: true });
});

xctestAttachments.test('deletes nothing when open files cannot be determined', async () => {
  const { root, attachments } = makeRoot();
  const old = path.join(attachments, 'old');
  writeFile(old, 100, 2 * HOUR);
  const r = await pruneXctestAttachments({
    devicesRoot: root,
    findOpenInodes: () => Promise.resolve(null),
  });
  assert(r.deleted === 0 && fs.existsSync(old), 'must not delete without lsof info');
  fs.rmSync(root, { recursive: true });
});

xctestAttachments.test('real lsof keeps a file this process holds open', async () => {
  const { root, attachments } = makeRoot();
  const held = path.join(attachments, 'held');
  const loose = path.join(attachments, 'loose');
  writeFile(held, 10, 2 * HOUR);
  writeFile(loose, 10, 2 * HOUR);
  const fd = fs.openSync(held, 'r');
  try {
    const r = await pruneXctestAttachments({ devicesRoot: root });
    assert(fs.existsSync(held), 'held file must survive');
    assert(!fs.existsSync(loose), 'loose file should be deleted');
    assert(r.skippedOpen === 1, `skippedOpen ${r.skippedOpen}`);
  } finally {
    fs.closeSync(fd);
    fs.rmSync(root, { recursive: true });
  }
});
