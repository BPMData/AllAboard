/**
 * What a misbehaving client can't do: crash the server, flood a room, grow a board without bound, guess the
 * Teacher PIN, or read another board's chat. Plus unit tests for socketGuards.ts.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { io as ioClient, Socket } from 'socket.io-client';
import { startServer } from '../server';
import {
  MAX_BATCH_ELEMENTS,
  MAX_BOARD_ELEMENTS,
  MAX_STROKE_NUMBERS,
  createFailureLimiter,
  createTokenBucket,
  elementFieldsOk,
  hashPin,
  isHashedPin,
  verifyPin,
} from '../socketGuards.ts';

type ServerHandle = Awaited<ReturnType<typeof startServer>>;

function waitForEvent<T = any>(socket: Socket, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}
const emitAck = <T = any>(socket: Socket, event: string, payload?: any): Promise<T> =>
  new Promise((resolve) => socket.emit(event, payload, (res: T) => resolve(res)));
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const stroke = (id: string, userId: string, points = [0, 0, 1, 1], boardId = 'main') => ({
  id, boardId, userId, userName: userId, tool: 'solid', color: '#000', strokeWidth: 3, points,
});

describe('socketGuards (unit)', () => {
  it('token bucket allows a burst, then the steady rate', () => {
    let t = 0;
    const b = createTokenBucket(10, 5, () => t);
    let ok = 0;
    for (let i = 0; i < 20; i++) if (b.take()) ok++;
    assert.equal(ok, 5, 'burst');
    t += 1000;
    ok = 0;
    for (let i = 0; i < 20; i++) if (b.take()) ok++;
    assert.equal(ok, 5, 'refills at 10/s but never above the burst');
  });

  it('failure limiter blocks after N failures and forgets them after the window', () => {
    let t = 0;
    const f = createFailureLimiter(3, 1000, () => t);
    for (let i = 0; i < 3; i++) f.fail('room');
    assert.equal(f.isBlocked('room'), true);
    assert.equal(f.isBlocked('other'), false);
    t += 1001;
    assert.equal(f.isBlocked('room'), false);
  });

  it('elementFieldsOk rejects bad points, huge text and blobs', () => {
    assert.equal(elementFieldsOk(stroke('a', 'u')), true);
    assert.equal(elementFieldsOk({ ...stroke('a', 'u'), points: [0, 'x'] }), false);
    assert.equal(elementFieldsOk({ ...stroke('a', 'u'), points: [0, NaN] }), false);
    assert.equal(elementFieldsOk({ ...stroke('a', 'u'), points: new Array(MAX_STROKE_NUMBERS + 2).fill(0) }), false);
    assert.equal(elementFieldsOk({ id: 't', tool: 'text', text: 'x'.repeat(30_000) }), false);
    assert.equal(elementFieldsOk({ id: 't', tool: 'rect', color: 'x'.repeat(5_000) }), false);
    assert.equal(elementFieldsOk({ id: 't', tool: 'rect', extra: { blob: 'x'.repeat(5_000) } }), false);
    assert.equal(elementFieldsOk(null), false);
  });

  it('hashes PINs with a per-call salt and verifies them (and legacy plain text)', async () => {
    const a = await hashPin('4829');
    const b = await hashPin('4829');
    assert.ok(isHashedPin(a) && a !== b, 'salted');
    assert.notEqual(a, '4829');
    assert.equal(await verifyPin('4829', a), true);
    assert.equal(await verifyPin('4828', a), false);
    assert.equal(await verifyPin('123', '123'), true, 'legacy plain text still verifies');
    assert.equal(await verifyPin('124', '123'), false);
  });
});

describe('server guards (integration)', () => {
  let tmpDir: string;
  let srv: ServerHandle;
  const sockets: Socket[] = [];

  async function join(roomId: string, userId: string, extra: Record<string, unknown> = {}, port = srv.port) {
    const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(socket);
    await waitForEvent(socket, 'connect');
    const init = waitForEvent<any>(socket, 'init');
    socket.emit('join-room', { roomId, userId, name: userId, color: '#000', ...extra });
    return { socket, init: await init };
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allaboard-guards-'));
    srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmpDir, skipVite: true, overviewSyncMs: 100 });
  });
  afterEach(async () => {
    for (const s of sockets.splice(0)) if (s.connected) s.disconnect();
    await srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('crash and flood', () => {
    it('survives a 500k-point append (this used to crash the process) and ignores it', async () => {
      const { socket: kid } = await join('crash', 'kid');
      const { socket: peer } = await join('crash', 'peer');
      kid.emit('element-start', stroke('e1', 'kid'));
      await delay(100);
      kid.emit('element-append-points', { id: 'e1', boardId: 'main', newPoints: new Array(500_000).fill(1) });
      kid.emit('element-append-points', { id: 'e1', boardId: 'main', newPoints: [5, 'x'] });
      await delay(200);
      const check = await emitAck<any>(peer, 'check-room', { roomId: 'crash' });
      assert.ok(check, 'server still answers');
      const { init } = await join('crash', 'late');
      assert.deepEqual(init.elements.find((e: any) => e.id === 'e1').points, [0, 0, 1, 1]);
    });

    it('drops a flood of chat beyond the per-socket allowance, without disconnecting the sender', async () => {
      const { socket: kid } = await join('flood', 'kid');
      const { socket: peer } = await join('flood', 'peer');
      let got = 0;
      peer.on('chat-message', () => got++);
      for (let i = 0; i < 200; i++) kid.emit('chat-message', { text: `spam ${i}`, boardId: 'main' });
      await delay(400);
      assert.ok(got >= 8 && got <= 10, `peer got ${got} of 200`);
      assert.equal(kid.connected, true);
    });

    it('answers a rate-limited ack instead of leaving the caller hanging', async () => {
      const { socket: kid } = await join('ack', 'kid');
      const replies = await Promise.all(
        Array.from({ length: 100 }, () => emitAck<any>(kid, 'check-room', { roomId: 'ack' }))
      );
      assert.ok(replies.some((r) => r && r.ok === false && /slow down/i.test(r.error)));
    });

    it('caps a board at MAX_BOARD_ELEMENTS and tells the sender', async () => {
      const { socket: kid } = await join('full', 'kid');
      for (let n = 0; n < MAX_BOARD_ELEMENTS; n += MAX_BATCH_ELEMENTS) {
        const elements = Array.from({ length: MAX_BATCH_ELEMENTS }, (_, i) => stroke(`b${n + i}`, 'kid'));
        kid.emit('elements-batch-add', { boardId: 'main', elements });
      }
      await delay(300);
      const full = waitForEvent<any>(kid, 'board-full');
      kid.emit('element-start', stroke('one-too-many', 'kid'));
      assert.equal((await full).max, MAX_BOARD_ELEMENTS);
      const { init } = await join('full', 'late');
      assert.equal(init.elements.length, MAX_BOARD_ELEMENTS);
    });
  });

  describe('Teacher PIN', () => {
    it('requires 4+ characters for a new PIN and never stores it in plain text', async () => {
      const { socket: t } = await join('pin-new', 't1');
      const short = await emitAck<any>(t, 'teacher:auth', { pin: '123' });
      assert.equal(short.ok, false);
      assert.match(short.error, /at least 4/);
      const ok = await emitAck<any>(t, 'teacher:auth', { pin: '4829' });
      assert.equal(ok.mode, 'claimed');
      await srv.flushRoomsToDiskAsync();
      const stored = srv.store.loadRoom<{ teacherPinHash?: string | null; teacherPin?: string | null }>('pin-new');
      const raw = JSON.stringify(stored);
      assert.ok(!raw.includes('"4829"'), 'PIN not in SQLite');
      assert.equal(stored?.state.teacherPin ?? null, null);
      assert.match(stored?.state.teacherPinHash ?? '', /^scrypt:/);

      const { socket: other } = await join('pin-new', 't2');
      assert.equal((await emitAck<any>(other, 'teacher:auth', { pin: '4829' })).mode, 'verified');
      const { init } = await join('pin-new', 't3', { teacherPin: '4829' });
      assert.equal(init.isTeacher, true, 'join-room with the PIN verifies too');
    });

    it('migrates a legacy plain-text PIN (even a 3-character one) on load', async () => {
      srv.store.saveRoom('legacy', { id: 'legacy', elements: [], messages: [], background: null, isCanvasLocked: false, teacherPin: '777', lastActiveAt: Date.now() }, Date.now());
      const { socket: t } = await join('legacy', 't1');
      assert.equal((await emitAck<any>(t, 'teacher:auth', { pin: '777' })).mode, 'verified');
      await srv.flushRoomsToDiskAsync();
      const raw = JSON.stringify(srv.store.loadRoom('legacy'));
      assert.ok(!raw.includes('"777"'), 'plain text rewritten');
      assert.ok(raw.includes('scrypt:'));
    });

    it('rewrites a legacy plain-text PIN in the backup bucket at boot, not just in SQLite', async () => {
      const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allaboard-guards-backup-'));
      fs.mkdirSync(path.join(backupDir, 'rooms'), { recursive: true });
      const legacy = { id: 'old-room', elements: [], messages: [], background: null, isCanvasLocked: false, teacherPin: '777', lastActiveAt: Date.now() };
      fs.writeFileSync(path.join(backupDir, 'rooms', 'old-room.json.gz'), gzipSync(JSON.stringify(legacy)));
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allaboard-guards-data-'));
      const booted = await startServer({ port: 0, host: '127.0.0.1', dataDir, skipVite: true, backupDir });
      try {
        await booted.backup!.flushNow();
        const raw = gunzipSync(fs.readFileSync(path.join(backupDir, 'rooms', 'old-room.json.gz'))).toString();
        assert.ok(!raw.includes('"777"'), 'plain text gone from the bucket copy');
        assert.ok(raw.includes('scrypt:'));
        const { socket: t } = await join('old-room', 't1', {}, booted.port);
        assert.equal((await emitAck<any>(t, 'teacher:auth', { pin: '777' })).mode, 'verified');
      } finally {
        for (const s of sockets.splice(0)) if (s.connected) s.disconnect();
        await booted.close();
        fs.rmSync(backupDir, { recursive: true, force: true });
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });

    it('blocks guessing after 10 wrong PINs per room, across sockets', async () => {
      const { socket: t } = await join('guess', 't1');
      await emitAck(t, 'teacher:auth', { pin: '4829' });
      for (let i = 0; i < 10; i++) {
        const { socket: kid } = await join('guess', `kid${i}`); // fresh socket each time: per-socket limits don't help
        const res = await emitAck<any>(kid, 'teacher:auth', { pin: String(1000 + i) });
        assert.match(res.error, /Incorrect/);
      }
      const { socket: kid } = await join('guess', 'kid-final');
      const blocked = await emitAck<any>(kid, 'teacher:auth', { pin: '4829' });
      assert.equal(blocked.ok, false, 'even the right PIN is refused while blocked');
      assert.match(blocked.error, /Too many wrong/);
      const { init } = await join('guess', 'kid-join', { teacherPin: '4829' });
      assert.equal(init.isTeacher, false, 'join-room PIN checks are blocked too');
      const { socket: other } = await join('other-room', 'x');
      assert.equal((await emitAck<any>(other, 'teacher:auth', { pin: '5555' })).mode, 'claimed', 'other rooms unaffected');
    });
  });

  describe('board-scoped chat', () => {
    async function boardClass(roomId: string) {
      const { socket: teacher } = await join(roomId, 't1');
      await emitAck(teacher, 'teacher:auth', { pin: '1234' });
      const { socket: s1 } = await join(roomId, 's1');
      const { socket: s2 } = await join(roomId, 's2');
      const synced = waitForEvent<any>(s2, 'breakout-sync');
      await emitAck(teacher, 'teacher:configure-breakout', { mode: 'individual', allowSelfSelect: false, chatScope: 'board', copyWorksheet: false });
      await synced;
      await delay(100);
      return { teacher, s1, s2 };
    }

    it('reaches only that board and teachers; students cannot post to another board', async () => {
      const { teacher, s1, s2 } = await boardClass('chat-scope');
      const heard = { t: [] as any[], s2: [] as any[] };
      teacher.on('chat-message', (m) => heard.t.push(m));
      s2.on('chat-message', (m) => heard.s2.push(m));
      s1.emit('chat-message', { text: 'private to my board', boardId: 'r1_ind_s1' });
      s1.emit('chat-message', { text: 'sneaking into s2', boardId: 'r1_ind_s2' });
      await delay(200);
      assert.deepEqual(heard.t.map((m) => m.text), ['private to my board']);
      assert.deepEqual(heard.s2, [], 's2 hears nothing from another board');

      const { init } = await join('chat-scope', 's1'); // s1 rejoining sees its own board's chat
      assert.equal(init.subBoards['r1_ind_s1'].messages.length, 1);
      const { init: s2init } = await join('chat-scope', 's2');
      assert.deepEqual(s2init.subBoards['r1_ind_s1'].messages, [], "other boards' chat is stripped");
    });
  });
});
