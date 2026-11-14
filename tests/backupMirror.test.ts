import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { BackupMirror, sniffMime } from '../backupMirror.ts';

const HASH = 'a'.repeat(64);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

describe('BackupMirror', () => {
  let dir: string;
  let localAssets: Map<string, Uint8Array>;
  let mirror: BackupMirror;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-'));
    localAssets = new Map([[HASH, JPEG]]);
    mirror = new BackupMirror(dir, (h) => localAssets.get(h) ?? null, 60_000);
  });
  afterEach(async () => {
    await mirror.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a gzipped room file and its assets on flush', async () => {
    const state = { id: 'r1', lastActiveAt: 123, background: { pages: [{ dataUrl: `/api/assets/${HASH}` }] } };
    mirror.scheduleRoom('r1', () => state);
    assert.equal(fs.existsSync(path.join(dir, 'rooms', 'r1.json.gz')), false); // batched, not written yet
    await mirror.flushNow();
    const onDisk = JSON.parse(gunzipSync(fs.readFileSync(path.join(dir, 'rooms', 'r1.json.gz'))).toString());
    assert.deepEqual(onDisk, state);
    assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(dir, 'assets', HASH))), JPEG);
  });

  it('uses the latest state at write time', async () => {
    let n = 1;
    mirror.scheduleRoom('r1', () => ({ id: 'r1', n, lastActiveAt: 1 }));
    n = 2;
    mirror.scheduleRoom('r1', () => ({ id: 'r1', n, lastActiveAt: 2 }));
    await mirror.flushNow();
    assert.equal(mirror.loadAllRoomsSync()[0].state.n, 2);
  });

  it('round-trips rooms through loadAllRoomsSync, including odd room ids', async () => {
    mirror.scheduleRoom('a', () => ({ id: 'a', lastActiveAt: 10 }));
    mirror.scheduleRoom('b c/d', () => ({ id: 'b c/d', lastActiveAt: 20 }));
    await mirror.flushNow();
    const rooms = mirror.loadAllRoomsSync().sort((x, y) => x.lastActiveAt - y.lastActiveAt);
    assert.deepEqual(rooms.map((r) => [r.roomId, r.lastActiveAt]), [['a', 10], ['b c/d', 20]]);
  });

  it('deletes a room file', async () => {
    mirror.scheduleRoom('r1', () => ({ id: 'r1', lastActiveAt: 1 }));
    await mirror.flushNow();
    mirror.deleteRoom('r1');
    await mirror.flushNow();
    assert.equal(mirror.loadAllRoomsSync().length, 0);
  });

  it('reads assets back and rejects bad hashes', async () => {
    mirror.scheduleRoom('r1', () => ({ id: 'r1', lastActiveAt: 1, u: `/api/assets/${HASH}` }));
    await mirror.flushNow();
    assert.deepEqual(new Uint8Array((await mirror.readAsset(HASH))!), JPEG);
    assert.equal(await mirror.readAsset('b'.repeat(64)), null);
    assert.equal(await mirror.readAsset('../etc/passwd'), null);
  });

  it('skips unreadable room files instead of crashing', async () => {
    fs.writeFileSync(path.join(dir, 'rooms', 'broken.json.gz'), 'not gzip');
    mirror.scheduleRoom('ok', () => ({ id: 'ok', lastActiveAt: 1 }));
    await mirror.flushNow();
    assert.deepEqual(mirror.loadAllRoomsSync().map((r) => r.roomId), ['ok']);
  });

  it('sniffs common image types', () => {
    assert.equal(sniffMime(JPEG), 'image/jpeg');
    assert.equal(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
    assert.equal(sniffMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), 'image/svg+xml');
    assert.equal(sniffMime(new Uint8Array([1, 2, 3])), 'application/octet-stream');
  });
});
