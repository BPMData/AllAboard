import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { GcsBackend, GenerationConflict } from '../backupMirror.ts';
import { startServer } from '../server.ts';
import { verifyRelease } from '../scripts/check-release.mjs';
import { createFakeGcs } from './fakeGcs.ts';
import { socketPool, emitAck, waitForEvent, worksheet, PNG, delay } from './socketHelpers.ts';

const student = { roomId: 'release-test', userId: 'student', name: 'Student' };

it(
  'plain Node drains a live class on SIGTERM and restores its last stroke and worksheet from empty local storage',
  { timeout: 25_000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-signal-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const pool = socketPool();
    t.after(() => pool.closeAll());
    async function boot(dir: string) {
      const child = spawn(process.execPath, ['server.ts'], {
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          NODE_ENV: 'production',
          PORT: '0',
          K_SERVICE: '',
          BACKUP_BUCKET: 'off',
          BACKUP_DIR: path.join(root, 'backup'),
          DATA_DIR: path.join(root, dir),
        },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      const exit = once(child, 'exit');
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await exit;
      });
      for await (const line of createInterface({ input: child.stdout })) {
        const match = /^Server running on http:\/\/localhost:(\d+)/.exec(line);
        if (match) return { port: Number(match[1]), child, exit };
      }
      throw new Error('Plain Node exited before listening');
    }
    const first = await boot('old');
    const teacher = await pool.join(first, { ...student, userId: 'teacher', name: 'Teacher' });
    const writer = await pool.join(first, student);
    assert.equal((await emitAck(teacher.socket, 'teacher:auth', { pin: '1234' })).ok, true);
    assert.equal(
      (await emitAck(teacher.socket, 'teacher:set-background', { boardId: 'main', background: worksheet() })).ok,
      true
    );
    const seen = waitForEvent(teacher.socket, 'element-start');
    writer.socket.emit('element-start', {
      id: 'last-stroke',
      tool: 'pen',
      points: [1, 2, 3, 4],
      color: '#111',
      strokeWidth: 2,
      boardId: 'main',
    });
    await seen;
    first.child.kill('SIGTERM');
    assert.deepEqual(await first.exit, [0, null]);
    const second = await boot('new');
    const { init } = await pool.join(second, student);
    assert.deepEqual(
      init.elements.map((e: { id: string }) => e.id),
      ['last-stroke']
    );
    const res = await fetch(`http://127.0.0.1:${second.port}${init.background.pages[0].dataUrl}`);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.from(PNG.split(',')[1], 'base64'));
  }
);

it('hands an active class to the next revision before accepting students there', { timeout: 20_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-handoff-'));
  const handles: Awaited<ReturnType<typeof startServer>>[] = [];
  const pool = socketPool();
  t.after(async () => {
    pool.closeAll();
    for (const handle of handles.reverse()) await handle.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const fake = createFakeGcs('test');
  const backend = () => new GcsBackend('test', { fetchImpl: fake.fetch, getToken: async () => 'test-token' });
  async function boot(sequence: number) {
    const server = await startServer({
      port: 0,
      host: '127.0.0.1',
      skipVite: true,
      dataDir: path.join(root, String(sequence)),
      backupBackend: backend(),
      releaseSequence: sequence,
    });
    handles.push(server);
    return server;
  }
  const old = await boot(1);
  const { socket } = await pool.join(old, student);
  assert.equal((await emitAck(socket, 'teacher:auth', { pin: '1234' })).ok, true);
  old.flushRoomsToDisk();
  await old.backup!.flushNow();
  const stale = backend();
  const key = 'rooms/release-test.json.gz';
  const snapshot = await stale.read(key);
  const next = await boot(2);
  const status = async (port: number) => (await (await fetch(`http://127.0.0.1:${port}/api/release`)).json()).writer;
  assert.equal(await status(next.port), 'waiting');
  const received = waitForEvent(socket, 'chat-message');
  socket.emit('chat-message', { text: 'Final edit', boardId: 'main' });
  await received;
  for (let attempt = 0; attempt < 160 && (await status(next.port)) !== 'active'; attempt++) await delay(75);
  assert.equal(await status(old.port), 'drained');
  const { init } = await pool.join(next, student);
  assert.equal(init.messages.at(-1).text, 'Final edit');
  await assert.rejects(stale.write(key, snapshot!, 'application/gzip'), GenerationConflict);
  await assert.rejects(stale.remove(key), GenerationConflict);
});

it('Cloud Run ignores a writable stale backup folder and reports bucket selection', async (t) => {
  const original = process.env.K_SERVICE;
  process.env.K_SERVICE = 'allaboard';
  t.after(() => {
    if (original === undefined) delete process.env.K_SERVICE;
    else process.env.K_SERVICE = original;
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-target-'));
  const fake = createFakeGcs('test');
  const srv = await startServer({
    port: 0,
    host: '127.0.0.1',
    skipVite: true,
    dataDir: path.join(root, 'data'),
    backupDir: root,
    backupBackend: new GcsBackend('test', { fetchImpl: fake.fetch, getToken: async () => 'test-token' }),
  });
  try {
    const info = await (await fetch(`http://127.0.0.1:${srv.port}/api/release`)).json();
    assert.equal(info.backup.backend, 'gcs');
    assert.equal(fs.existsSync(path.join(root, 'rooms')), false);
  } finally {
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('checks revision identity, traffic and backup health independently of liveness', () => {
  const revision = { metadata: { name: 'r2', labels: { 'commit-sha': 'sha' } } };
  const service = { status: { traffic: [{ revisionName: 'r2', percent: 100 }], latestReadyRevisionName: 'r2' } };
  const runtime = {
    revision: 'r2',
    writer: 'active',
    backup: { backend: 'gcs', target: 'bucket "gs://allaboard-data"', failed: 0, overdue: false, restoreErrors: 0 },
  };
  assert.equal(verifyRelease(service, revision, runtime, 'sha'), 'r2');
  assert.throws(() => verifyRelease(service, revision, runtime, 'old'));
  assert.throws(() => verifyRelease(service, revision, { ...runtime, revision: 'old' }, 'sha'));
  assert.throws(() => verifyRelease(service, revision, { ...runtime, writer: 'waiting' }, 'sha'));
  for (const patch of [{ failed: 1 }, { overdue: true }, { restoreErrors: 1 }, { backend: 'directory' }])
    assert.throws(() =>
      verifyRelease(service, revision, { ...runtime, backup: { ...runtime.backup, ...patch } }, 'sha')
    );
});
