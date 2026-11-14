import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { BackupMirror, DirBackend, GcsBackend, sniffMime, type BackupBackend } from '../backupMirror.ts';
import { createFakeGcs, type FakeGcs } from './fakeGcs.ts';

const HASH = 'a'.repeat(64);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

// Run the same mirror behaviour tests against both backends.
const backends: Array<{ name: string; make: () => { backend: BackupBackend; cleanup: () => void } }> = [
  {
    name: 'DirBackend',
    make: () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-'));
      return { backend: new DirBackend(dir), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
    },
  },
  {
    name: 'GcsBackend (fake API)',
    make: () => {
      const fake = createFakeGcs('test-bucket', { pageSize: 1 }); // pageSize 1 forces list paging
      const backend = new GcsBackend('test-bucket', {
        fetchImpl: fake.fetch,
        apiBase: 'https://gcs.test',
        getToken: async () => 'test-token',
      });
      return { backend, cleanup: () => {} };
    },
  },
];

for (const { name, make } of backends) {
  describe(`BackupMirror on ${name}`, () => {
    let backend: BackupBackend;
    let cleanup: () => void;
    let localAssets: Map<string, Uint8Array>;
    let mirror: BackupMirror;

    beforeEach(async () => {
      ({ backend, cleanup } = make());
      await backend.probe();
      localAssets = new Map([[HASH, JPEG]]);
      mirror = new BackupMirror(backend, (h) => localAssets.get(h) ?? null, 60_000);
    });
    afterEach(async () => {
      await mirror.stop();
      cleanup();
    });

    it('writes a gzipped room and its assets on flush', async () => {
      const state = { id: 'r1', lastActiveAt: 123, background: { pages: [{ dataUrl: `/api/assets/${HASH}` }] } };
      mirror.scheduleRoom('r1', () => state);
      assert.equal(await backend.exists('rooms/r1.json.gz'), false); // batched, not written yet
      await mirror.flushNow();
      const onDisk = JSON.parse(gunzipSync((await backend.read('rooms/r1.json.gz'))!).toString());
      assert.deepEqual(onDisk, state);
      assert.deepEqual(new Uint8Array((await backend.read(`assets/${HASH}`))!), JPEG);
    });

    it('uses the latest state at write time', async () => {
      let n = 1;
      mirror.scheduleRoom('r1', () => ({ id: 'r1', n, lastActiveAt: 1 }));
      n = 2;
      mirror.scheduleRoom('r1', () => ({ id: 'r1', n, lastActiveAt: 2 }));
      await mirror.flushNow();
      assert.equal((await mirror.loadAllRooms())[0].state.n, 2);
    });

    it('round-trips rooms through loadAllRooms, including odd room ids', async () => {
      mirror.scheduleRoom('a', () => ({ id: 'a', lastActiveAt: 10 }));
      mirror.scheduleRoom('b c/d', () => ({ id: 'b c/d', lastActiveAt: 20 }));
      await mirror.flushNow();
      const rooms = (await mirror.loadAllRooms()).sort((x, y) => x.lastActiveAt - y.lastActiveAt);
      assert.deepEqual(rooms.map((r) => [r.roomId, r.lastActiveAt]), [['a', 10], ['b c/d', 20]]);
    });

    it('deletes a room', async () => {
      mirror.scheduleRoom('r1', () => ({ id: 'r1', lastActiveAt: 1 }));
      await mirror.flushNow();
      mirror.deleteRoom('r1');
      await mirror.flushNow();
      assert.equal((await mirror.loadAllRooms()).length, 0);
    });

    it('reads assets back and rejects bad hashes', async () => {
      mirror.scheduleRoom('r1', () => ({ id: 'r1', lastActiveAt: 1, u: `/api/assets/${HASH}` }));
      await mirror.flushNow();
      assert.deepEqual(new Uint8Array((await mirror.readAsset(HASH))!), JPEG);
      assert.equal(await mirror.readAsset('b'.repeat(64)), null);
      assert.equal(await mirror.readAsset('../etc/passwd'), null);
    });

    it('skips unreadable room files instead of crashing', async () => {
      await backend.write('rooms/broken.json.gz', new TextEncoder().encode('not gzip'), 'application/gzip');
      mirror.scheduleRoom('ok', () => ({ id: 'ok', lastActiveAt: 1 }));
      await mirror.flushNow();
      assert.deepEqual((await mirror.loadAllRooms()).map((r) => r.roomId), ['ok']);
    });
  });
}

describe('GcsBackend specifics', () => {
  let fake: FakeGcs;
  beforeEach(() => {
    fake = createFakeGcs('allaboard-data', { token: 'tok-1' });
  });

  it('gets its token from the Cloud Run metadata server and caches it', async () => {
    let tokenCalls = 0;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (url.startsWith('http://metadata.google.internal/')) {
        tokenCalls++;
        assert.equal(new Headers(init?.headers).get('Metadata-Flavor'), 'Google');
        return Response.json({ access_token: 'tok-1', expires_in: 3600 });
      }
      return fake.fetch(url, init);
    };
    const gcs = new GcsBackend('allaboard-data', { fetchImpl, apiBase: 'https://gcs.test' });
    await gcs.probe();
    await gcs.write('rooms/x.json.gz', new Uint8Array([1]), 'application/gzip');
    assert.equal(await gcs.exists('rooms/x.json.gz'), true);
    assert.equal(tokenCalls, 1);
  });

  it('probe throws on 403 so the server can run without backups', async () => {
    const gcs = new GcsBackend('allaboard-data', { fetchImpl: fake.fetch, apiBase: 'https://gcs.test', getToken: async () => 'tok-1' });
    fake.failWith = 403;
    await assert.rejects(gcs.probe(), /HTTP 403/);
  });

  it('a failed write is retried on the next flush', async () => {
    const gcs = new GcsBackend('allaboard-data', { fetchImpl: fake.fetch, apiBase: 'https://gcs.test', getToken: async () => 'tok-1' });
    const mirror = new BackupMirror(gcs, () => null, 60_000);
    fake.failWith = 503;
    mirror.scheduleRoom('r1', () => ({ id: 'r1', lastActiveAt: 1 }));
    await mirror.flushNow();
    assert.equal(fake.objects.size, 0);
    fake.failWith = 0;
    await mirror.flushNow();
    assert.equal(fake.objects.has('rooms/r1.json.gz'), true);
    await mirror.stop();
  });
});

describe('sniffMime', () => {
  it('sniffs common image types', () => {
    assert.equal(sniffMime(JPEG), 'image/jpeg');
    assert.equal(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
    assert.equal(sniffMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), 'image/svg+xml');
    assert.equal(sniffMime(new Uint8Array([1, 2, 3])), 'application/octet-stream');
  });
});
