import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { io as ioClient, Socket } from 'socket.io-client';
import { startServer } from '../server';
import { GcsBackend } from '../backupMirror.ts';
import { createFakeGcs } from './fakeGcs.ts';
import { getVisibleStrokeRuns } from '../src/lib/inkCore.ts';

type ServerHandle = Awaited<ReturnType<typeof startServer>>;

function waitForEvent<T = any>(socket: Socket, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for socket event "${event}"`));
    }, timeoutMs);
    const handler = (data: T) => {
      clearTimeout(timer);
      resolve(data);
    };
    socket.once(event, handler);
  });
}

function emitAck<T = any>(socket: Socket, event: string, payload?: any): Promise<T> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (res: T) => resolve(res));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectAndJoin(
  port: number,
  params: { roomId: string; userId: string; name: string; color?: string; teacherPin?: string }
): Promise<{ socket: Socket; init: any }> {
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  await waitForEvent(socket, 'connect');
  const initPromise = waitForEvent(socket, 'init');
  socket.emit('join-room', {
    color: '#2563eb',
    ...params,
  });
  const init = await initPromise;
  return { socket, init };
}

describe('AllAboard server & Socket.IO integration tests', () => {
  let tmpDir: string;
  let srv: ServerHandle;
  const openSockets: Socket[] = [];

  async function joinTracked(
    params: { roomId: string; userId: string; name: string; color?: string; teacherPin?: string },
    targetSrv: ServerHandle = srv
  ) {
    const joined = await connectAndJoin(targetSrv.port, params);
    openSockets.push(joined.socket);
    return joined;
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allaboard-test-'));
    srv = await startServer({
      port: 0,
      host: '127.0.0.1',
      dataDir: tmpDir,
      skipVite: true,
      overviewSyncMs: 100,
    });
  });

  afterEach(async () => {
    for (const s of openSockets.splice(0, openSockets.length)) {
      if (s.connected) s.disconnect();
    }
    await srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves /healthz and initializes room roster on join-room', async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });

    const { init } = await joinTracked({
      roomId: 'Room Alpha!',
      userId: 'u1',
      name: 'Alice',
    });
    assert.deepEqual(init.elements, []);
    assert.equal(init.isTeacher, false);
    assert.equal(init.roomSettings.isCanvasLocked, false);
    assert.equal(init.users.length, 1);
    assert.equal(init.users[0].name, 'Alice');
  });

  it('syncs valid student statuses and permits only teachers to clear one or all', async () => {
    const teacher = (await joinTracked({ roomId: 'statuses', userId: 't', name: 'Teacher' })).socket;
    await emitAck(teacher, 'teacher:auth', { pin: '1234' });
    const s1 = (await joinTracked({ roomId: 'statuses', userId: 's1', name: 'Sam' })).socket;
    const s2 = (await joinTracked({ roomId: 'statuses', userId: 's2', name: 'Ada' })).socket;
    await delay(50); // Drain the join roster broadcast before observing status updates.
    for (const status of ['need-help', 'got-it', 'done', 'none']) {
      const sync = waitForEvent<any[]>(teacher, 'roster-sync');
      s1.emit('user:set-status', { status });
      const user = (await sync).find((u) => u.userId === 's1');
      assert.equal(user.status, status);
      assert.equal(typeof user.statusUpdatedAt, 'number');
    }
    const first = waitForEvent<any[]>(teacher, 'roster-sync');
    s1.emit('user:set-status', { status: 'need-help' });
    await first;
    const second = waitForEvent<any[]>(teacher, 'roster-sync');
    s2.emit('user:set-status', { status: 'done' });
    await second;
    s1.emit('user:set-status', { status: 'invalid' });
    s1.emit('teacher:clear-status', {});
    await delay(50);
    const cleared = waitForEvent<any[]>(teacher, 'roster-sync');
    teacher.emit('teacher:clear-status', { targetUserId: 's2' });
    const single = await cleared;
    assert.equal(single.find((u) => u.userId === 's1').status, 'need-help');
    assert.equal(single.find((u) => u.userId === 's2').status, 'none');
    const all = waitForEvent<any[]>(teacher, 'roster-sync');
    teacher.emit('teacher:clear-status', {});
    assert.equal((await all).find((u) => u.userId === 's1').status, 'none');
  });

  it('restricts the student cursor setting to teachers and persists it', async () => {
    const { socket: teacher } = await joinTracked({ roomId: 'cursor-room', userId: 't1', name: 'Teacher' });
    await emitAck(teacher, 'teacher:auth', { pin: '1234' });
    const { socket: student, init } = await joinTracked({ roomId: 'cursor-room', userId: 's1', name: 'Student' });
    assert.equal(init.roomSettings.hideStudentCursors, false);

    const cursor = waitForEvent<any>(teacher, 'cursors-batch');
    student.emit('cursor-move', { userId: 't1', boardId: 'main', x: 1, y: 2 });
    assert.deepEqual((await cursor).cursors.map((c: any) => c.userId), ['s1']);

    const settings = waitForEvent<any>(student, 'room-settings');
    teacher.emit('teacher:set-hide-cursors', true);
    assert.equal((await settings).hideStudentCursors, true);
    student.emit('teacher:set-hide-cursors', false);
    await delay(100);
    await srv.flushRoomsToDiskAsync();
    for (const s of openSockets.splice(0, openSockets.length)) s.disconnect();
    await srv.close();
    srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmpDir, skipVite: true });
    const rejoined = await joinTracked({ roomId: 'cursor-room', userId: 's1', name: 'Student' });
    assert.equal(rejoined.init.roomSettings.hideStudentCursors, true);
  });

  it('batches cursors: one message per board per tick, latest position per user, none for other boards', async () => {
    const { socket: a } = await joinTracked({ roomId: 'cursor-batch', userId: 'a', name: 'A' });
    const { socket: b } = await joinTracked({ roomId: 'cursor-batch', userId: 'b', name: 'B' });
    await delay(400); // let any join-time batch go out
    const got: any[] = [];
    b.on('cursors-batch', (msg: any) => got.push(msg));
    for (let i = 0; i < 5; i++) a.emit('cursor-move', { boardId: 'main', x: i, y: i });
    b.emit('cursor-move', { boardId: 'main', x: 9, y: 9 });
    a.emit('cursor-move', { boardId: 'some-other-board', x: 50, y: 50 }); // not the board A is on: dropped
    await delay(400);
    // The moves can straddle one tick boundary, so allow two batches, never one message per move.
    assert.ok(got.length >= 1 && got.length <= 2, `got ${got.length} batches`);
    const all = got.flatMap((m) => m.cursors);
    assert.ok(all.length <= 4, 'at most one entry per user per batch');
    assert.equal(all.filter((c: any) => c.userId === 'a').at(-1).x, 4, 'latest position wins');
    assert.equal(all.find((c: any) => c.userId === 'b').x, 9, 'the batch includes the receiver; the client skips its own');
    assert.ok(all.every((c: any) => c.boardId === 'main'), 'moves claiming another board are dropped');

    // A lone mover isn't echoed back to itself (a student alone on an individual board hears nothing).
    const toA: any[] = [];
    a.on('cursors-batch', (msg: any) => toA.push(msg));
    got.length = 0;
    a.emit('cursor-move', { boardId: 'main', x: 7, y: 7 });
    await delay(400);
    assert.equal(toA.length, 0);
    assert.equal(got.length, 1);
  });

  it('claims, verifies, rejects invalid Teacher PINs, and supports step-down', async () => {
    const { socket: teacher } = await joinTracked({
      roomId: 'pin-room',
      userId: 't1',
      name: 'Ms. Ada',
    });
    const { socket: intruder } = await joinTracked({
      roomId: 'pin-room',
      userId: 's1',
      name: 'Bob',
    });

    const tooShort = await emitAck(teacher, 'teacher:auth', { pin: '12' });
    assert.equal(tooShort.ok, false);

    const claimed = await emitAck(teacher, 'teacher:auth', { pin: '4321' });
    assert.equal(claimed.ok, true);
    assert.equal(claimed.mode, 'claimed');

    const badVerify = await emitAck(intruder, 'teacher:auth', { pin: '9999' });
    assert.equal(badVerify.ok, false);

    const verifyRosterSync = waitForEvent<any[]>(teacher, 'roster-sync');
    const goodVerify = await emitAck(intruder, 'teacher:auth', { pin: '4321' });
    assert.equal(goodVerify.ok, true);
    assert.equal(goodVerify.mode, 'verified');
    await verifyRosterSync;

    const rosterAfterStepDown = waitForEvent<any[]>(teacher, 'roster-sync');
    teacher.emit('teacher:step-down');
    const roster = await rosterAfterStepDown;
    const tRecord = roster.find((u) => u.userId === 't1');
    assert.equal(tRecord?.isTeacher, false);
  });

  it('enforces element ownership and canvas lock on element-append-points and element-update', async () => {
    const { socket: teacher } = await joinTracked({
      roomId: 'lock-room',
      userId: 'teacher-1',
      name: 'Teacher',
    });
    await emitAck(teacher, 'teacher:auth', { pin: '1234' });

    const { socket: studentA } = await joinTracked({
      roomId: 'lock-room',
      userId: 'student-a',
      name: 'Student A',
    });
    const { socket: studentB } = await joinTracked({
      roomId: 'lock-room',
      userId: 'student-b',
      name: 'Student B',
    });

    const el = {
      id: 'stroke-a',
      tool: 'solid',
      color: '#111111',
      strokeWidth: 4,
      points: [0, 0, 10, 10],
      userId: 'student-a',
      userName: 'Student A',
      boardId: 'main',
      timestamp: Date.now(),
    };

    const seenStartByB = waitForEvent(studentB, 'element-start');
    studentA.emit('element-start', el);
    await seenStartByB;

    // Student B cannot mutate Student A's stroke via append-points or element-update
    let unauthorizedEventCount = 0;
    const countUnauthorized = () => {
      unauthorizedEventCount++;
    };
    studentA.on('element-append-points', countUnauthorized);
    studentA.on('element-update', countUnauthorized);

    studentB.emit('element-append-points', {
      id: 'stroke-a',
      boardId: 'main',
      newPoints: [99, 99],
    });
    studentB.emit('element-update', {
      id: 'stroke-a',
      boardId: 'main',
      color: '#ff0000',
    });
    await delay(100);
    assert.equal(unauthorizedEventCount, 0);

    // Owner (Student A) can append & update while unlocked
    const appendSeen = waitForEvent<any>(studentB, 'element-append-points');
    studentA.emit('element-append-points', {
      id: 'stroke-a',
      boardId: 'main',
      newPoints: [20, 20],
    });
    const appended = await appendSeen;
    assert.deepEqual(appended.newPoints, [20, 20]);

    // Teacher locks the canvas -> Student A edits are rejected
    const settingsLocked = waitForEvent<any>(studentA, 'room-settings');
    teacher.emit('teacher:set-lock', true);
    assert.equal((await settingsLocked).isCanvasLocked, true);

    let lockedLeakCount = 0;
    teacher.on('element-start', () => lockedLeakCount++);
    teacher.on('element-append-points', () => lockedLeakCount++);
    teacher.on('element-update', () => lockedLeakCount++);

    studentA.emit('element-start', { ...el, id: 'blocked-stroke' });
    studentA.emit('element-append-points', {
      id: 'stroke-a',
      boardId: 'main',
      newPoints: [30, 30],
    });
    studentA.emit('element-update', {
      id: 'stroke-a',
      boardId: 'main',
      color: '#00ff00',
    });
    await delay(100);
    assert.equal(lockedLeakCount, 0);

    // Teacher can still update even when locked
    const teacherOverrideSeen = waitForEvent<any>(studentA, 'element-update');
    teacher.emit('element-update', {
      id: 'stroke-a',
      boardId: 'main',
      color: '#1565c0',
    });
    assert.equal((await teacherOverrideSeen).color, '#1565c0');
  });

  it('broadcasts batch/remove mutations with socket.to() so sender is not echoed', async () => {
    const { socket: studentA } = await joinTracked({
      roomId: 'echo-room',
      userId: 'sa',
      name: 'Alice',
    });
    const { socket: studentB } = await joinTracked({
      roomId: 'echo-room',
      userId: 'sb',
      name: 'Bob',
    });

    let senderEchoes = 0;
    for (const ev of [
      'elements-batch-added',
      'elements-batch-updated',
      'elements-batch-removed',
      'element-removed',
    ]) {
      studentA.on(ev, () => {
        senderEchoes++;
      });
    }

    const noteA = {
      id: 'note-1',
      tool: 'text',
      text: 'Hello',
      x: 10,
      y: 20,
      width: 60,
      height: 25,
      fontSize: 20,
      color: '#111111',
      strokeWidth: 4,
      userId: 'sa',
      timestamp: Date.now(),
    };

    const bAdded = waitForEvent<any>(studentB, 'elements-batch-added');
    studentA.emit('elements-batch-add', { boardId: 'main', elements: [noteA] });
    assert.equal((await bAdded).elements.length, 1);

    const bUpdated = waitForEvent<any>(studentB, 'elements-batch-updated');
    studentA.emit('elements-batch-update', {
      boardId: 'main',
      updates: [{ id: 'note-1', x: 50, y: 60 }],
      bringToFront: true,
    });
    const updPayload = await bUpdated;
    assert.equal(updPayload.bringToFront, true);
    assert.equal(updPayload.updates[0].x, 50);

    const bRemoved = waitForEvent<any>(studentB, 'elements-batch-removed');
    studentA.emit('elements-batch-remove', { boardId: 'main', ids: ['note-1'] });
    assert.deepEqual((await bRemoved).ids, ['note-1']);

    // Add single element and remove via element-remove
    const noteB = { ...noteA, id: 'note-2' };
    const bAdded2 = waitForEvent<any>(studentB, 'elements-batch-added');
    studentA.emit('elements-batch-add', { boardId: 'main', elements: [noteB] });
    await bAdded2;

    const bSingleRemoved = waitForEvent<any>(studentB, 'element-removed');
    studentA.emit('element-remove', { id: 'note-2', boardId: 'main' });
    assert.equal((await bSingleRemoved).id, 'note-2');

    await delay(80);
    assert.equal(senderEchoes, 0);
  });

  it('supports breakout boards, ALL_SUBBOARDS broadcast, timer control, and snapshot restore', async () => {
    const { socket: teacher } = await joinTracked({
      roomId: 'breakout-room',
      userId: 't1',
      name: 'Teacher',
    });
    await emitAck(teacher, 'teacher:auth', { pin: '5678' });

    await joinTracked({
      roomId: 'breakout-room',
      userId: 'stu-1',
      name: 'Sam',
    });

    const breakoutReady = waitForEvent<any>(teacher, 'breakout-sync');
    const cfgRes = await emitAck(teacher, 'teacher:configure-breakout', {
      mode: 'individual',
      allowSelfSelect: false,
      chatScope: 'board',
      copyWorksheet: false,
    });
    assert.equal(cfgRes.ok, true);
    const syncData = await breakoutReady;
    assert.ok(syncData.subBoards['r1_ind_stu-1']);

    const sentSync = waitForEvent<any>(teacher, 'breakout-sync');
    teacher.emit('elements-batch-add', {
      boardId: 'ALL_SUBBOARDS',
      elements: [
        {
          id: 'prompt-stamp',
          tool: 'text',
          text: 'Solve #1',
          x: 20,
          y: 20,
          color: '#111111',
          strokeWidth: 4,
          userId: 't1',
          timestamp: Date.now(),
        },
      ],
    });
    const afterAllSubs = await sentSync;
    assert.equal(afterAllSubs.subBoards['r1_ind_stu-1'].elements.length, 1);
    assert.equal(afterAllSubs.subBoards['r1_ind_stu-1'].elements[0].text, 'Solve #1');

    const startRes = await emitAck(teacher, 'teacher:timer-control', {
      action: 'start',
      durationSeconds: 120,
      autoLockOnExpire: true,
    });
    assert.equal(startRes.ok, true);
    assert.equal(startRes.timer.isRunning, true);
    assert.equal(startRes.timer.autoLockOnExpire, true);

    const addMinRes = await emitAck(teacher, 'teacher:timer-control', {
      action: 'add-minute',
    });
    assert.equal(addMinRes.timer.durationMs, 180000);

    const restoredPromise = waitForEvent<any>(teacher, 'room-restored');
    const impRes = await emitAck(teacher, 'teacher:import-room', {
      mode: 'readonly',
      elements: [{ id: 'snap-1', tool: 'solid', points: [0, 0, 5, 5], userId: 't1', color: '#000', strokeWidth: 4, timestamp: 1 }],
      messages: [],
    });
    assert.equal(impRes.ok, true);
    const restored = await restoredPromise;
    assert.equal(restored.elements.length, 1);
    assert.equal(restored.roomSettings.isCanvasLocked, true);
  });

  it('persists room state asynchronously to disk and restores it on server restart', async () => {
    const { socket: teacher } = await joinTracked({
      roomId: 'persist-room',
      userId: 't1',
      name: 'Teacher',
    });
    await emitAck(teacher, 'teacher:auth', { pin: '7777' });

    const { socket: student } = await joinTracked({
      roomId: 'persist-room',
      userId: 's1',
      name: 'Maya',
    });

    const chatSeen = waitForEvent(teacher, 'chat-message');
    student.emit('chat-message', { text: 'Saved message', boardId: 'main' });
    await chatSeen;

    const strokeSeen = waitForEvent(teacher, 'element-start');
    student.emit('element-start', {
      id: 'persisted-el',
      tool: 'text',
      text: 'Remember me',
      x: 40,
      y: 50,
      color: '#111111',
      strokeWidth: 4,
      userId: 's1',
      boardId: 'main',
      timestamp: Date.now(),
    });
    await strokeSeen;

    await srv.flushRoomsToDiskAsync();
    assert.equal(fs.existsSync(path.join(tmpDir, 'allaboard.db')), true);

    // Tear down first server and restart on the same dataDir
    for (const s of openSockets.splice(0, openSockets.length)) {
      if (s.connected) s.disconnect();
    }
    await srv.close();

    srv = await startServer({
      port: 0,
      host: '127.0.0.1',
      dataDir: tmpDir,
      skipVite: true,
    });

    const { init } = await joinTracked({
      roomId: 'persist-room',
      userId: 't1',
      name: 'Teacher',
      teacherPin: '7777',
    });
    assert.equal(init.isTeacher, true);
    assert.equal(init.elements.length, 1);
    assert.equal(init.elements[0].id, 'persisted-el');
    assert.equal(init.messages.length, 1);
    assert.equal(init.messages[0].text, 'Saved message');
  });

  it('supports teacher force-rename with permanent name lock, message deletion, and kick/ban/unban', async () => {
    const { socket: teacher } = await joinTracked({
      roomId: 'mod-room',
      userId: 't-mod',
      name: 'Ms. Frizzle',
    });
    await emitAck(teacher, 'teacher:auth', { pin: '2468' });

    const { socket: student } = await joinTracked({
      roomId: 'mod-room',
      userId: 's-trouble',
      name: 'Prankster',
    });

    // Student sends a message and draws a stroke
    const msgPromise = waitForEvent<any>(teacher, 'chat-message');
    student.emit('chat-message', { text: 'First message', boardId: 'main' });
    const firstMsg = await msgPromise;
    assert.equal(firstMsg.userName, 'Prankster');

    const strokePromise = waitForEvent<any>(teacher, 'element-start');
    student.emit('element-start', {
      id: 'stu-stroke-1',
      tool: 'solid',
      points: [0, 0, 10, 10],
      color: '#111111',
      strokeWidth: 4,
      userId: 's-trouble',
      userName: 'Prankster',
      boardId: 'main',
      timestamp: Date.now(),
    });
    await strokePromise;

    // Teacher renames student -> retroactively updates messages & strokes and locks name
    const renamedEventPromise = waitForEvent<any>(student, 'user-renamed');
    const renameRes = await emitAck(teacher, 'teacher:rename-user', {
      targetUserId: 's-trouble',
      newName: 'Arnold',
    });
    assert.equal(renameRes.ok, true);
    const renamedEvent = await renamedEventPromise;
    assert.equal(renamedEvent.userId, 's-trouble');
    assert.equal(renamedEvent.newName, 'Arnold');
    assert.equal(renamedEvent.isNameLocked, true);

    // Student tries to change their name back via update-profile -> ignored by server
    const rosterAfterAttempt = waitForEvent<any[]>(teacher, 'roster-sync');
    student.emit('update-profile', {
      userId: 's-trouble',
      name: 'Prankster Again',
      color: '#dc2626',
    });
    const rosterList = await rosterAfterAttempt;
    const stuRecord = rosterList.find((u) => u.userId === 's-trouble');
    assert.equal(stuRecord?.name, 'Arnold');
    assert.equal(stuRecord?.isNameLocked, true);

    // Teacher deletes the chat message
    const delEventPromise = waitForEvent<any>(student, 'message-deleted');
    const delRes = await emitAck(teacher, 'teacher:delete-message', {
      messageId: firstMsg.id,
      boardId: 'main',
    });
    assert.equal(delRes.ok, true);
    const delEvent = await delEventPromise;
    assert.equal(delEvent.messageId, firstMsg.id);

    // Teacher bans student -> student receives room-kicked (reason: 'banned'), work is preserved
    const kickedPromise = waitForEvent<any>(student, 'room-kicked');
    const banRes = await emitAck(teacher, 'teacher:kick-user', {
      targetUserId: 's-trouble',
      mode: 'ban',
      targetName: 'Arnold',
    });
    assert.equal(banRes.ok, true);
    const kickedPayload = await kickedPromise;
    assert.equal(kickedPayload.reason, 'banned');

    // Banned student attempts to rejoin -> blocked with room-kicked
    const blockedPromise = waitForEvent<any>(student, 'room-kicked');
    student.emit('join-room', {
      roomId: 'mod-room',
      userId: 's-trouble',
      name: 'Sneaky',
    });
    const blockedPayload = await blockedPromise;
    assert.equal(blockedPayload.reason, 'banned');

    // Teacher unbans student -> student can rejoin, but locked name 'Arnold' is still enforced!
    const unbanRes = await emitAck(teacher, 'teacher:unban-user', {
      targetUserId: 's-trouble',
    });
    assert.equal(unbanRes.ok, true);

    const rejoinInitPromise = waitForEvent<any>(student, 'init');
    student.emit('join-room', {
      roomId: 'mod-room',
      userId: 's-trouble',
      name: 'TryOverrideName',
    });
    const rejoinInit = await rejoinInitPromise;
    assert.equal(rejoinInit.assignedName, 'Arnold');
    assert.equal(rejoinInit.isNameLocked, true);
    assert.equal(rejoinInit.elements.length, 1);
    assert.equal(rejoinInit.elements[0].userName, 'Arnold');
    assert.equal(rejoinInit.messages.length, 0);
  });

  describe('identity keys', () => {
    const KEY_A = 'a'.repeat(64);
    const KEY_B = 'b'.repeat(64);

    /** Connects and joins, resolving with whichever of `init` / `room-kicked` the server answers. */
    async function attemptJoin(params: Record<string, unknown>, targetSrv: ServerHandle = srv) {
      const socket = ioClient(`http://127.0.0.1:${targetSrv.port}`, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
      });
      openSockets.push(socket);
      await waitForEvent(socket, 'connect');
      const outcome = new Promise<{ event: string; data: any }>((resolve) => {
        socket.once('init', (data) => resolve({ event: 'init', data }));
        socket.once('room-kicked', (data) => resolve({ event: 'room-kicked', data }));
      });
      socket.emit('join-room', { color: '#000', ...params });
      return { socket, ...(await outcome) };
    }

    function ink(id: string) {
      return { id, boardId: 'main', tool: 'solid', color: '#000', strokeWidth: 4, points: [0, 0, 5, 5] };
    }

    it('rejects a wrong or missing key for a claimed id, and accepts the right one', async () => {
      const roomId = 'key-room';
      const first = await attemptJoin({ roomId, userId: 'sam', userKey: KEY_A, name: 'Sam' });
      assert.equal(first.event, 'init');

      const wrongKey = await attemptJoin({ roomId, userId: 'sam', userKey: KEY_B, name: 'Sam' });
      assert.equal(wrongKey.event, 'room-kicked');
      assert.equal(wrongKey.data.reason, 'identity');

      const noKey = await attemptJoin({ roomId, userId: 'sam', name: 'Sam' });
      assert.equal(noKey.event, 'room-kicked');
      assert.equal(noKey.data.reason, 'identity');

      const secondTab = await attemptJoin({ roomId, userId: 'sam', userKey: KEY_A, name: 'Sam' });
      assert.equal(secondTab.event, 'init');
    });

    it('a rejected join cannot draw as the id it tried to take', async () => {
      const roomId = 'forge-room';
      const teacher = await attemptJoin({ roomId, userId: 't', userKey: KEY_A, name: 'Teacher' });
      await attemptJoin({ roomId, userId: 'sam', userKey: KEY_B, name: 'Sam' });

      const forger = await attemptJoin({ roomId, userId: 'sam', userKey: 'c'.repeat(64), name: 'Sam' });
      assert.equal(forger.event, 'room-kicked');
      forger.socket.emit('element-start', ink('forged'));
      await delay(100);

      const check = await attemptJoin({ roomId, userId: 't', userKey: KEY_A, name: 'Teacher' });
      assert.equal(check.data.elements.length, 0);
      assert.equal(teacher.event, 'init');
    });

    it('cannot inherit teacher powers from a teacher id without key or PIN', async () => {
      const roomId = 'teacher-key-room';
      const teacher = await attemptJoin({ roomId, userId: 't', userKey: KEY_A, name: 'Teacher' });
      assert.equal((await emitAck<any>(teacher.socket, 'teacher:auth', { pin: '1234' })).ok, true);

      const noPin = await attemptJoin({ roomId, userId: 't', userKey: KEY_B, name: 'Student' });
      assert.equal(noPin.event, 'room-kicked');

      const sameBrowser = await attemptJoin({ roomId, userId: 't', userKey: KEY_A, name: 'Teacher' });
      assert.equal(sameBrowser.data.isTeacher, true);
    });

    it('rejects a forged teacher identity for the new classroom controls', async () => {
      const roomId = 'new-controls-key-room';
      const teacher = await attemptJoin({ roomId, userId: 't', userKey: KEY_A, name: 'Teacher' });
      assert.equal((await emitAck<any>(teacher.socket, 'teacher:auth', { pin: '1234' })).ok, true);
      const student = await attemptJoin({ roomId, userId: 's', userKey: KEY_B, name: 'Student' });
      await delay(50);
      const forger = await attemptJoin({ roomId, userId: 't', userKey: KEY_B, name: 'Teacher' });
      assert.equal(forger.event, 'room-kicked');
      let pulses = 0;
      student.socket.on('laser-pulse', () => pulses++);
      forger.socket.emit('laser-pulse', { boardId: 'main', x: 1, y: 2, strokeId: 'fake' });
      forger.socket.emit('teacher:set-hide-cursors', true);
      assert.equal((await emitAck<any>(forger.socket, 'teacher:spotlight-board', { sourceBoardId: 'missing' })).ok, false);
      await delay(100);
      assert.equal(pulses, 0);
      const check = await attemptJoin({ roomId, userId: 's', userKey: KEY_B, name: 'Student' });
      assert.equal(check.data.roomSettings.hideStudentCursors, false);
    });

    it('does not grant teacher status to whoever first claims a keyless teacher id', async () => {
      const roomId = 'legacy-teacher-room';
      const legacy = await attemptJoin({ roomId, userId: 't', name: 'Teacher' });
      assert.equal((await emitAck<any>(legacy.socket, 'teacher:auth', { pin: '1234' })).ok, true);

      const claimer = await attemptJoin({ roomId, userId: 't', userKey: KEY_B, name: 'Student' });
      assert.equal(claimer.event, 'init');
      assert.equal(claimer.data.isTeacher, false);
    });

    it('keeps claimed keys across a server restart and never sends them to clients', async () => {
      const roomId = 'restart-key-room';
      const first = await attemptJoin({ roomId, userId: 'sam', userKey: KEY_A, name: 'Sam' });
      assert.equal(JSON.stringify(first.data).includes('userKeyHashes'), false);
      first.socket.emit('element-start', ink('keep-room-alive'));
      await delay(100);
      first.socket.disconnect();
      await srv.close();

      srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmpDir, skipVite: true, overviewSyncMs: 100 });
      const forger = await attemptJoin({ roomId, userId: 'sam', userKey: KEY_B, name: 'Sam' });
      assert.equal(forger.event, 'room-kicked');
      const owner = await attemptJoin({ roomId, userId: 'sam', userKey: KEY_A, name: 'Sam' });
      assert.equal(owner.event, 'init');
    });

    it("ignores another user's id in update-profile, undo and cursor-move", async () => {
      const roomId = 'payload-id-room';
      const sam = await attemptJoin({ roomId, userId: 'sam', userKey: KEY_A, name: 'Sam' });
      const ada = await attemptJoin({ roomId, userId: 'ada', userKey: KEY_B, name: 'Ada' });
      sam.socket.emit('element-start', ink('sams-stroke'));
      await delay(100);

      const cursor = waitForEvent<any>(sam.socket, 'cursors-batch');
      ada.socket.emit('cursor-move', { userId: 'sam', userName: 'Sam', boardId: 'main', x: 1, y: 1 });
      const [seen] = (await cursor).cursors;
      assert.equal(seen.userId, 'ada');
      assert.equal(seen.userName, 'Ada');

      ada.socket.emit('update-profile', { userId: 'sam', name: 'Renamed' });
      ada.socket.emit('undo', { userId: 'sam', boardId: 'main' });
      await delay(100);

      const check = await attemptJoin({ roomId, userId: 'sam', userKey: KEY_A, name: 'Sam' });
      assert.deepEqual(check.data.elements.map((el: any) => el.id), ['sams-stroke']);
      assert.equal(check.data.users.find((u: any) => u.userId === 'sam').name, 'Sam');
    });
  });

  describe('multi-round breakouts', () => {
    async function setupClass(roomId: string) {
      const { socket: teacher } = await joinTracked({ roomId, userId: 't1', name: 'Teacher' });
      await emitAck(teacher, 'teacher:auth', { pin: '1234' });
      const { socket: s1 } = await joinTracked({ roomId, userId: 's1', name: 'Sam' });
      const { socket: s2 } = await joinTracked({ roomId, userId: 's2', name: 'Ada' });
      return { teacher, s1, s2 };
    }

    function stroke(id: string, boardId: string, userId: string) {
      return {
        id,
        boardId,
        userId,
        userName: userId,
        tool: 'solid',
        color: '#000',
        strokeWidth: 4,
        points: [0, 0, 10, 10],
        timestamp: Date.now(),
      };
    }

    it('T1 – resume preserves strokes', async () => {
      const { teacher, s1 } = await setupClass('mr-t1');

      const r1SyncPromise = waitForEvent<any>(teacher, 'breakout-sync');
      const r1Res = await emitAck(teacher, 'teacher:configure-breakout', {
        action: 'new-round',
        mode: 'individual',
        chatScope: 'unified',
      });
      assert.equal(r1Res.ok, true);
      assert.equal(r1Res.activeRoundId, 'r1');
      await r1SyncPromise;

      s1.emit('element-start', stroke('k1', 'r1_ind_s1', 's1'));
      await delay(50);

      const mainSyncPromise = waitForEvent<any>(teacher, 'breakout-sync');
      const mainRes = await emitAck(teacher, 'teacher:configure-breakout', { action: 'return-to-main' });
      assert.equal(mainRes.ok, true);
      const mainSync = await mainSyncPromise;
      assert.equal(mainSync.breakoutConfig.mode, 'main');
      assert.equal(mainSync.subBoards['r1_ind_s1'].elements.length, 1);

      const resumeSyncPromise = waitForEvent<any>(teacher, 'breakout-sync');
      const resumeRes = await emitAck(teacher, 'teacher:configure-breakout', { action: 'resume' });
      assert.equal(resumeRes.ok, true);
      const resumeSync = await resumeSyncPromise;
      assert.equal(resumeSync.breakoutConfig.mode, 'individual');
      assert.equal(resumeSync.breakoutConfig.activeRoundId, 'r1');
      assert.equal(resumeSync.subBoards['r1_ind_s1'].elements.length, 1);
    });

    it('T2 – new round archives the old round', async () => {
      const { teacher, s1 } = await setupClass('mr-t2');

      const r1SyncPromise = waitForEvent<any>(teacher, 'breakout-sync');
      await emitAck(teacher, 'teacher:configure-breakout', {
        action: 'new-round',
        mode: 'individual',
        chatScope: 'unified',
      });
      await r1SyncPromise;

      s1.emit('element-start', stroke('k1', 'r1_ind_s1', 's1'));
      await delay(50);

      const r2SyncPromise = waitForEvent<any>(teacher, 'breakout-sync');
      const r2Res = await emitAck(teacher, 'teacher:configure-breakout', {
        action: 'new-round',
        mode: 'groups',
        groups: [
          { id: 'grp_1', title: 'Red', assignedUserIds: ['s1'] },
          { id: 'grp_2', title: 'Blue', assignedUserIds: ['s2', 's1'] },
        ],
      });
      assert.equal(r2Res.ok, true);
      const r2Sync = await r2SyncPromise;

      assert.equal(r2Sync.breakoutConfig.activeRoundId, 'r2');
      assert.equal(r2Sync.breakoutConfig.rounds.length, 2);
      assert.equal(r2Sync.subBoards['r2_grp_1'].title, 'Red');
      assert.deepEqual(r2Sync.subBoards['r2_grp_1'].assignedUserIds, ['s1']);
      assert.deepEqual(r2Sync.subBoards['r2_grp_2'].assignedUserIds, ['s2']);
      assert.equal(r2Sync.subBoards['r2_grp_1'].elements.length, 0);
      assert.equal(r2Sync.subBoards['r1_ind_s1'].elements.length, 1);
      assert.equal(r2Sync.subBoards['r1_ind_s1'].roundId, 'r1');
    });

    it('T3 – join-board only moves within the active round', async () => {
      const { teacher } = await setupClass('mr-t3');
      const groupDrafts = [
        { id: 'grp_1', title: 'Group 1', assignedUserIds: ['s1'] },
        { id: 'grp_2', title: 'Group 2', assignedUserIds: ['s2'] },
      ];

      const r1SyncPromise = waitForEvent<any>(teacher, 'breakout-sync');
      await emitAck(teacher, 'teacher:configure-breakout', {
        action: 'new-round',
        mode: 'groups',
        groups: groupDrafts,
      });
      await r1SyncPromise;

      const r2SyncPromise = waitForEvent<any>(teacher, 'breakout-sync');
      await emitAck(teacher, 'teacher:configure-breakout', {
        action: 'new-round',
        mode: 'groups',
        groups: groupDrafts,
      });
      await r2SyncPromise;

      const moveSyncPromise = waitForEvent<any>(teacher, 'breakout-sync');
      teacher.emit('breakout:join-board', { targetBoardId: 'r2_grp_2', targetUserId: 's1' });
      const moveSync = await moveSyncPromise;
      assert.equal(moveSync.subBoards['r2_grp_2'].assignedUserIds.includes('s1'), true);
      assert.equal(moveSync.subBoards['r2_grp_1'].assignedUserIds.includes('s1'), false);
      assert.equal(moveSync.subBoards['r1_grp_1'].assignedUserIds.includes('s1'), true);

      teacher.emit('breakout:join-board', { targetBoardId: 'r1_grp_2', targetUserId: 's2' });
      await delay(100);

      const checkSyncPromise = waitForEvent<any>(teacher, 'breakout-sync');
      await emitAck(teacher, 'teacher:configure-breakout', { action: 'update-current' });
      const checkSync = await checkSyncPromise;
      assert.deepEqual(checkSync.subBoards['r1_grp_2'].assignedUserIds, ['s2']);
      assert.deepEqual(checkSync.subBoards['r1_grp_1'].assignedUserIds, ['s1']);
    });

    it('T4 – late joiner gets a board in the active round with the round worksheet', async () => {
      const { teacher } = await setupClass('mr-t4');

      const r1SyncPromise = waitForEvent<any>(teacher, 'breakout-sync');
      await emitAck(teacher, 'teacher:configure-breakout', {
        action: 'new-round',
        mode: 'individual',
        customBackground: {
          id: 'bg1',
          fileName: 'frayer.png',
          pages: [],
          x: 0,
          y: 0,
          scale: 1,
          layout: 'row',
          opacity: 1,
        },
      });
      await r1SyncPromise;

      const lateSyncPromise = waitForEvent<any>(teacher, 'breakout-sync');
      await joinTracked({ roomId: 'mr-t4', userId: 's3', name: 'Lee' });
      const lateSync = await lateSyncPromise;

      assert.ok(lateSync.subBoards['r1_ind_s3']);
      assert.equal(lateSync.subBoards['r1_ind_s3'].roundId, 'r1');
      assert.equal(lateSync.subBoards['r1_ind_s3'].background.fileName, 'frayer.png');
    });

    it('T5 – ALL_SUBBOARDS only hits the active round', async () => {
      const { teacher } = await setupClass('mr-t5');

      const r1SyncPromise = waitForEvent<any>(teacher, 'breakout-sync');
      await emitAck(teacher, 'teacher:configure-breakout', { action: 'new-round', mode: 'individual' });
      await r1SyncPromise;

      const r2SyncPromise = waitForEvent<any>(teacher, 'breakout-sync');
      await emitAck(teacher, 'teacher:configure-breakout', { action: 'new-round', mode: 'individual' });
      await r2SyncPromise;

      const batchSyncPromise = waitForEvent<any>(teacher, 'breakout-sync');
      teacher.emit('elements-batch-add', {
        boardId: 'ALL_SUBBOARDS',
        elements: [
          {
            id: 'prompt-stamp',
            tool: 'text',
            text: 'Solve #2',
            x: 20,
            y: 20,
            color: '#111111',
            strokeWidth: 4,
            userId: 't1',
            timestamp: Date.now(),
          },
        ],
      });
      const batchSync = await batchSyncPromise;

      assert.equal(batchSync.subBoards['r2_ind_s1'].elements.length, 1);
      assert.equal(batchSync.subBoards['r1_ind_s1'].elements.length, 0);
    });

    it('T6 – legacy rooms on disk are migrated', async () => {
      for (const s of openSockets.splice(0, openSockets.length)) {
        if (s.connected) s.disconnect();
      }
      await srv.close();

      fs.writeFileSync(
        path.join(tmpDir, 'rooms-store.json'),
        JSON.stringify({
          rooms: [
            {
              id: 'legacy-room',
              messages: [],
              elements: [],
              background: null,
              subBoards: {
                ind_s1: {
                  id: 'ind_s1',
                  title: "Sam's Board",
                  assignedUserIds: ['s1'],
                  elements: [stroke('old', 'ind_s1', 's1')],
                  background: null,
                  messages: [],
                },
              },
              breakoutConfig: { mode: 'individual', allowSelfSelect: false, chatScope: 'unified' },
              isCanvasLocked: false,
              teacherPin: '1234',
              lastActiveAt: Date.now(),
            },
          ],
        }),
        'utf-8'
      );

      srv = await startServer({
        port: 0,
        host: '127.0.0.1',
        dataDir: tmpDir,
        skipVite: true,
      });

      const { init } = await joinTracked({ roomId: 'legacy-room', userId: 's1', name: 'Sam' });
      assert.equal(init.subBoards['ind_s1'].roundId, 'r1');
      assert.equal(init.subBoards['ind_s1'].kind, 'individual');
      assert.equal(init.roomSettings.breakoutConfig.activeRoundId, 'r1');
      assert.equal(init.subBoards['ind_s1'].elements.length, 1);
      assert.equal(init.subBoards['r1_ind_s1'], undefined);
      assert.equal(fs.existsSync(path.join(tmpDir, 'rooms-store.json')), false);
    });

    it('T7 – non-teacher cannot configure', async () => {
      const { s1 } = await setupClass('mr-t7');
      const res = await emitAck(s1, 'teacher:configure-breakout', {
        action: 'new-round',
        mode: 'individual',
      });
      assert.equal(res.ok, false);
    });

    it('T8 – teacher can switch class back to an earlier round (Round 2 -> Round 1) with drawings intact', async () => {
      const { teacher, s1 } = await setupClass('mr-t8');

      // Start Round 1 (individual)
      const r1SyncPromise = waitForEvent<any>(teacher, 'breakout-sync');
      await emitAck(teacher, 'teacher:configure-breakout', {
        action: 'new-round',
        mode: 'individual',
      });
      await r1SyncPromise;

      // Student draws on Round 1 board
      s1.emit('element-start', stroke('r1-stroke', 'r1_ind_s1', 's1'));
      await delay(50);

      // Start Round 2 (groups)
      const r2SyncPromise = waitForEvent<any>(teacher, 'breakout-sync');
      await emitAck(teacher, 'teacher:configure-breakout', {
        action: 'new-round',
        mode: 'groups',
        groups: [
          { id: 'grp_1', title: 'Group A', assignedUserIds: ['s1'] },
          { id: 'grp_2', title: 'Group B', assignedUserIds: ['s2'] },
        ],
      });
      const r2Sync = await r2SyncPromise;
      assert.equal(r2Sync.breakoutConfig.activeRoundId, 'r2');
      assert.equal(r2Sync.breakoutConfig.mode, 'groups');

      // Student draws on Round 2 board
      s1.emit('element-start', stroke('r2-stroke', 'r2_grp_1', 's1'));
      await delay(50);

      // Teacher switches the whole class back to Round 1
      const switchBackPromise = waitForEvent<any>(teacher, 'breakout-sync');
      const switchRes = await emitAck(teacher, 'teacher:configure-breakout', {
        action: 'resume',
        targetRoundId: 'r1',
      });
      assert.equal(switchRes.ok, true);
      assert.equal(switchRes.activeRoundId, 'r1');
      assert.equal(switchRes.mode, 'individual');

      const switchSync = await switchBackPromise;
      assert.equal(switchSync.breakoutConfig.activeRoundId, 'r1');
      assert.equal(switchSync.breakoutConfig.mode, 'individual');
      assert.equal(switchSync.subBoards['r1_ind_s1'].elements.length, 1);
      assert.equal(switchSync.subBoards['r2_grp_1'].elements.length, 1);
    });

    it('T9 – autoIndividual lands joining students directly on own board with separate worksheet, cleared by return-to-main', async () => {
      const roomId = 'mr-t9-auto';
      const { socket: teacher } = await joinTracked({ roomId, userId: 't1', name: 'Teacher' });
      const { socket: nonTeacher } = await joinTracked({ roomId, userId: 'stu-0', name: 'Waiter' });

      // Non-teacher cannot configure auto-individual
      const nonTeacherRes = await emitAck(nonTeacher, 'teacher:configure-breakout', {
        action: 'set-auto-individual',
        autoIndividual: true,
      });
      assert.equal(nonTeacherRes.ok, false);
      nonTeacher.disconnect();

      // Teacher claims PIN and sets Main Board background distinct from student starting worksheet
      await emitAck(teacher, 'teacher:auth', { pin: '1234' });
      await emitAck(teacher, 'teacher:set-background', {
        boardId: 'main',
        background: {
          id: 'main-bg',
          fileName: 'teacher-main.png',
          pages: [],
          x: 0,
          y: 0,
          scale: 1,
          layout: 'row',
          opacity: 1,
        },
      });

      const settingsUpdated = waitForEvent<any>(teacher, 'room-settings');
      const armRes = await emitAck(teacher, 'teacher:configure-breakout', {
        action: 'set-auto-individual',
        autoIndividual: true,
        templateLabel: 'Frayer Model',
        customBackground: {
          id: 'student-bg',
          fileName: 'student-frayer.png',
          pages: [],
          x: 0,
          y: 0,
          scale: 1,
          layout: 'row',
          opacity: 1,
        },
      });
      assert.equal(armRes.ok, true);
      const settings = await settingsUpdated;
      assert.equal(settings.breakoutConfig.mode, 'main');
      assert.equal(settings.breakoutConfig.autoIndividual, true);
      assert.equal(settings.breakoutConfig.autoIndividualBackground.fileName, 'student-frayer.png');

      // Student 1 joins -> init immediately starts Round 1 Individual and assigns r1_ind_s1 with student worksheet
      const s1TeacherSyncPromise = waitForEvent<any>(teacher, 'breakout-sync');
      const s1Join = await joinTracked({ roomId, userId: 's1', name: 'Sam' });
      assert.equal(s1Join.init.roomSettings.breakoutConfig.mode, 'individual');
      assert.equal(s1Join.init.roomSettings.breakoutConfig.activeRoundId, 'r1');
      assert.equal(s1Join.init.roomSettings.breakoutConfig.rounds[0].title, 'Round 1 · Individual · Frayer Model');
      assert.ok(s1Join.init.subBoards['r1_ind_s1']);
      assert.equal(s1Join.init.subBoards['r1_ind_s1'].background.fileName, 'student-frayer.png');
      assert.equal(s1Join.init.background.fileName, 'teacher-main.png');
      await s1TeacherSyncPromise;

      // Late student 2 joins -> also gets their own board in r1
      const s2TeacherSyncPromise = waitForEvent<any>(teacher, 'breakout-sync');
      const s2Join = await joinTracked({ roomId, userId: 's2', name: 'Ada' });
      assert.equal(s2Join.init.roomSettings.breakoutConfig.mode, 'individual');
      assert.ok(s2Join.init.subBoards['r1_ind_s2']);
      assert.equal(s2Join.init.subBoards['r1_ind_s2'].background.fileName, 'student-frayer.png');
      await s2TeacherSyncPromise;

      // Bring All to Main returns everyone to main and turns off autoIndividual
      const mainSyncPromise = waitForEvent<any>(teacher, 'breakout-sync');
      const mainRes = await emitAck(teacher, 'teacher:configure-breakout', { action: 'return-to-main' });
      assert.equal(mainRes.ok, true);
      const mainSync = await mainSyncPromise;
      assert.equal(mainSync.breakoutConfig.mode, 'main');
      assert.equal(mainSync.breakoutConfig.autoIndividual, false);

      // Latecomer joining after Bring All to Main lands on Main with the rest of the class
      const s3Join = await joinTracked({ roomId, userId: 's3', name: 'Lee' });
      assert.equal(s3Join.init.roomSettings.breakoutConfig.mode, 'main');
      assert.equal(s3Join.init.subBoards['r1_ind_s3'], undefined);
    });
  });

  it('reports room availability accurately via check-room without creating empty rooms', async () => {
    const { socket: probe } = await joinTracked({
      roomId: 'probe-home',
      userId: 'u-probe',
      name: 'Probe',
    });

    const unknownAvail = await emitAck(probe, 'check-room', { roomId: '  Brand New Room!! ' });
    assert.deepEqual(unknownAvail, {
      roomId: 'brand-new-room',
      exists: false,
      activeUserCount: 0,
      hasTeacherPin: false,
      hasContent: false,
    });

    // Probing an unknown room should not reserve/create it as existing
    const secondProbe = await emitAck(probe, 'check-room', { roomId: 'brand-new-room' });
    assert.equal(secondProbe.exists, false);

    // Join target room, set Teacher PIN, and draw a stroke -> check-room reports activeUserCount, hasTeacherPin, hasContent
    const { socket: teacher } = await joinTracked({
      roomId: 'Busy Room',
      userId: 't-busy',
      name: 'Ms. Busy',
    });
    await emitAck(teacher, 'teacher:auth', { pin: '4321' });
    teacher.emit('element-start', {
      id: 'busy-el-1',
      tool: 'solid',
      points: [0, 0, 12, 12],
      color: '#111111',
      strokeWidth: 4,
      userId: 't-busy',
      boardId: 'main',
      timestamp: Date.now(),
    });
    await delay(50);

    const busyAvail = await emitAck(probe, 'check-room', { roomId: 'busy-room' });
    assert.deepEqual(busyAvail, {
      roomId: 'busy-room',
      exists: true,
      activeUserCount: 1,
      hasTeacherPin: true,
      hasContent: true,
    });

    // Even after everyone leaves, saved content & PIN keep the room marked as existing
    teacher.disconnect();
    await delay(50);
    const dormantAvail = await emitAck(probe, 'check-room', { roomId: 'busy-room' });
    assert.deepEqual(dormantAvail, {
      roomId: 'busy-room',
      exists: true,
      activeUserCount: 0,
      hasTeacherPin: true,
      hasContent: true,
    });
  });

  it('serves room availability via GET /api/rooms/:roomId for live, saved, and missing rooms', async () => {
    const missingRes = await fetch(`http://127.0.0.1:${srv.port}/api/rooms/${encodeURIComponent('  Missing Room! ')}`);
    assert.equal(missingRes.status, 200);
    assert.equal(missingRes.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await missingRes.json(), {
      roomId: 'missing-room',
      exists: false,
      activeUserCount: 0,
      hasTeacherPin: false,
      hasContent: false,
    });

    const { socket: teacher } = await joinTracked({
      roomId: 'History Room',
      userId: 't-hist',
      name: 'Ms. History',
    });
    await emitAck(teacher, 'teacher:auth', { pin: '4321' });

    const liveRes = await fetch(`http://127.0.0.1:${srv.port}/api/rooms/history-room`);
    assert.equal(liveRes.status, 200);
    assert.deepEqual(await liveRes.json(), {
      roomId: 'history-room',
      exists: true,
      activeUserCount: 1,
      hasTeacherPin: true,
      hasContent: false,
    });

    teacher.disconnect();
    await delay(50);

    const savedRes = await fetch(`http://127.0.0.1:${srv.port}/api/rooms/history-room`);
    assert.equal(savedRes.status, 200);
    assert.deepEqual(await savedRes.json(), {
      roomId: 'history-room',
      exists: true,
      activeUserCount: 0,
      hasTeacherPin: true,
      hasContent: false,
    });
  });

  it('purges all messages, drawings, and annotations for a target user across main and sub-boards', async () => {
    const { socket: teacher } = await joinTracked({
      roomId: 'purge-room',
      userId: 't-purge',
      name: 'Teacher',
    });
    await emitAck(teacher, 'teacher:auth', { pin: '5555' });

    const { socket: offender } = await joinTracked({
      roomId: 'purge-room',
      userId: 's-offend',
      name: 'Disruptor',
    });
    const { socket: bystander } = await joinTracked({
      roomId: 'purge-room',
      userId: 's-good',
      name: 'GoodStudent',
    });

    // Offender & bystander contribute to main board
    const msg1 = waitForEvent(teacher, 'chat-message');
    offender.emit('chat-message', { text: 'Spam chat', boardId: 'main' });
    await msg1;

    const msg2 = waitForEvent(teacher, 'chat-message');
    bystander.emit('chat-message', { text: 'Valid question', boardId: 'main' });
    await msg2;

    offender.emit('element-start', {
      id: 'off-draw',
      tool: 'solid',
      points: [0, 0, 20, 20],
      color: '#111111',
      strokeWidth: 4,
      userId: 's-offend',
      boardId: 'main',
      timestamp: Date.now(),
    });
    offender.emit('element-start', {
      id: 'off-note',
      tool: 'text',
      text: 'Bad annotation',
      x: 30,
      y: 30,
      color: '#111111',
      strokeWidth: 4,
      userId: 's-offend',
      boardId: 'main',
      timestamp: Date.now(),
    });
    bystander.emit('element-start', {
      id: 'good-draw',
      tool: 'solid',
      points: [5, 5, 15, 15],
      color: '#2563eb',
      strokeWidth: 4,
      userId: 's-good',
      boardId: 'main',
      timestamp: Date.now(),
    });
    await delay(50);

    // Launch individual breakout round with board-scoped chat and add contributions on sub-boards
    const boSync = waitForEvent(teacher, 'breakout-sync');
    await emitAck(teacher, 'teacher:configure-breakout', {
      action: 'new-round',
      mode: 'individual',
      chatScope: 'board',
    });
    await boSync;

    offender.emit('chat-message', { text: 'Spam breakout', boardId: 'r1_ind_s-offend' });
    offender.emit('element-start', {
      id: 'off-sub-draw',
      tool: 'solid',
      points: [1, 1, 9, 9],
      color: '#111111',
      strokeWidth: 4,
      userId: 's-offend',
      boardId: 'r1_ind_s-offend',
      timestamp: Date.now(),
    });
    await delay(50);

    // Non-teacher cannot purge
    const denied = await emitAck(bystander, 'teacher:purge-user-contributions', {
      targetUserId: 's-offend',
    });
    assert.equal(denied.ok, false);

    // Teacher kicks offender, then purges all contributions
    await emitAck(teacher, 'teacher:kick-user', {
      targetUserId: 's-offend',
      mode: 'ban',
      targetName: 'Disruptor',
    });

    const purgedBroadcast = waitForEvent<any>(bystander, 'user-contributions-purged');
    const purgeRes = await emitAck(teacher, 'teacher:purge-user-contributions', {
      targetUserId: 's-offend',
    });
    assert.equal(purgeRes.ok, true);
    assert.equal(purgeRes.removedElements, 3);
    assert.equal(purgeRes.removedMessages, 2);
    assert.equal((await purgedBroadcast).targetUserId, 's-offend');

    // Verify clean init state when another user joins
    const { init } = await joinTracked({
      roomId: 'purge-room',
      userId: 's-late',
      name: 'LateJoiner',
    });
    assert.deepEqual(
      init.messages.map((m: any) => m.text),
      ['Valid question']
    );
    assert.deepEqual(
      init.elements.map((e: any) => e.id),
      ['good-draw']
    );
    assert.equal(init.subBoards['r1_ind_s-offend'].elements.length, 0);
    assert.equal(init.subBoards['r1_ind_s-offend'].messages.length, 0);
  });
  describe('storage: backup bucket (BACKUP_DIR)', () => {
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    it('B1 – a cold start restores rooms and worksheets from the backup', async () => {
      const backupDir = path.join(tmpDir, 'bucket');
      await srv.close();
      srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: path.join(tmpDir, 'disk-1'), backupDir, skipVite: true });

      const { socket: teacher } = await joinTracked({ roomId: 'cold', userId: 't', name: 'Teacher' });
      await emitAck(teacher, 'teacher:auth', { pin: '1234' });
      const bgSync = waitForEvent<any>(teacher, 'background-sync');
      await emitAck(teacher, 'teacher:set-background', {
        boardId: 'main',
        background: { id: 'ws', fileName: 'w.png', pages: [{ dataUrl: PNG, width: 1, height: 1 }], x: 0, y: 0, scale: 1, layout: 'stack', opacity: 1 },
      });
      const url = (await bgSync).background.pages[0].dataUrl as string;
      await srv.flushRoomsToDiskAsync();
      await srv.backup!.flushNow();

      // Simulate Cloud Run wiping the local disk: same bucket, brand-new data dir.
      for (const s of openSockets.splice(0)) if (s.connected) s.disconnect();
      await srv.close();
      srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: path.join(tmpDir, 'disk-2'), backupDir, skipVite: true });

      const { init } = await joinTracked({ roomId: 'cold', userId: 's', name: 'Student' });
      assert.equal(init.background.pages[0].dataUrl, url);
      assert.equal(srv.store.countAssets(), 0); // not restored until requested
      const res = await fetch(`http://127.0.0.1:${srv.port}${url}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/png');
      assert.equal(srv.store.countAssets(), 1);
    });

    it('B4 – a cold start restores rooms and worksheets from a Cloud Storage bucket', async () => {
      const fake = createFakeGcs('allaboard-data');
      const gcs = () => new GcsBackend('allaboard-data', { fetchImpl: fake.fetch, apiBase: 'https://gcs.test', getToken: async () => 'test-token' });
      await srv.close();
      srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: path.join(tmpDir, 'gcs-disk-1'), backupBackend: gcs(), skipVite: true });

      const { socket: teacher } = await joinTracked({ roomId: 'cold-gcs', userId: 't', name: 'Teacher' });
      await emitAck(teacher, 'teacher:auth', { pin: '1234' });
      const bgSync = waitForEvent<any>(teacher, 'background-sync');
      await emitAck(teacher, 'teacher:set-background', {
        boardId: 'main',
        background: { id: 'ws', fileName: 'w.png', pages: [{ dataUrl: PNG, width: 1, height: 1 }], x: 0, y: 0, scale: 1, layout: 'stack', opacity: 1 },
      });
      const url = (await bgSync).background.pages[0].dataUrl as string;
      for (const s of openSockets.splice(0)) if (s.connected) s.disconnect();
      await srv.close(); // close() flushes the backup, like SIGTERM on Cloud Run
      assert.equal(fake.objects.has('rooms/cold-gcs.json.gz'), true);
      assert.equal(fake.objects.has(`assets/${url.split('/').pop()}`), true);

      srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: path.join(tmpDir, 'gcs-disk-2'), backupBackend: gcs(), skipVite: true });
      const { init } = await joinTracked({ roomId: 'cold-gcs', userId: 's', name: 'Student' });
      assert.equal(init.background.pages[0].dataUrl, url);
      const res = await fetch(`http://127.0.0.1:${srv.port}${url}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/png');
    });

    it('B5 – an unreachable bucket (403) runs without backups instead of crashing', async () => {
      const fake = createFakeGcs('allaboard-data');
      fake.failWith = 403;
      await srv.close();
      srv = await startServer({
        port: 0, host: '127.0.0.1', dataDir: tmpDir, skipVite: true,
        backupBackend: new GcsBackend('allaboard-data', { fetchImpl: fake.fetch, apiBase: 'https://gcs.test', getToken: async () => 'test-token' }),
      });
      assert.equal(srv.backup, null);
      assert.equal((await fetch(`http://127.0.0.1:${srv.port}/healthz`)).status, 200);
    });

    it('B6 – a stale BACKUP_DIR (env var kept, mount gone) falls back to the bucket API', async () => {
      const blocker = path.join(tmpDir, 'no-mount');
      fs.writeFileSync(blocker, 'x');
      const fake = createFakeGcs('allaboard-data');
      await srv.close();
      srv = await startServer({
        port: 0, host: '127.0.0.1', dataDir: tmpDir, skipVite: true,
        backupDir: path.join(blocker, 'backup'),
        backupBackend: new GcsBackend('allaboard-data', { fetchImpl: fake.fetch, apiBase: 'https://gcs.test', getToken: async () => 'test-token' }),
      });
      assert.match(srv.backup!.backend.label, /gs:\/\/allaboard-data/);
    });

    it('B2 – an unusable DATA_DIR falls back instead of crashing', async () => {
      const blocker = path.join(tmpDir, 'not-a-dir');
      fs.writeFileSync(blocker, 'x');
      await srv.close();
      srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: path.join(blocker, 'data'), skipVite: true });
      const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
      assert.equal(res.status, 200);
    });

    it('B3 – an unusable BACKUP_DIR runs without backups instead of crashing', async () => {
      const blocker = path.join(tmpDir, 'not-a-bucket');
      fs.writeFileSync(blocker, 'x');
      await srv.close();
      srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmpDir, backupDir: path.join(blocker, 'b'), skipVite: true });
      assert.equal(srv.backup, null);
      assert.equal((await fetch(`http://127.0.0.1:${srv.port}/healthz`)).status, 200);
    });
  });

  describe('storage: SQLite + worksheet assets', () => {
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const worksheet = () => ({ id: 'ws1', fileName: 'w.png', pages: [{ dataUrl: PNG, width: 1, height: 1 }], x: 0, y: 0, scale: 1, layout: 'stack', opacity: 1 });
    const restart = async () => {
      for (const s of openSockets.splice(0)) if (s.connected) s.disconnect();
      await srv.close();
      srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmpDir, skipVite: true });
    };
    const teacherIn = async (roomId: string) => {
      const { socket } = await joinTracked({ roomId, userId: 't', name: 'Teacher' });
      await emitAck(socket, 'teacher:auth', { pin: '1234' });
      return socket;
    };
    const setWorksheet = async (teacher: Socket) => {
      const sync = waitForEvent<any>(teacher, 'background-sync');
      await emitAck(teacher, 'teacher:set-background', { boardId: 'main', background: worksheet() });
      return (await sync).background.pages[0].dataUrl as string;
    };

    it('S1 – stores and serves an immutable asset', async () => {
      const url = await setWorksheet(await teacherIn('s1'));
      assert.match(url, /^\/api\/assets\/[a-f0-9]{64}$/);
      const res = await fetch(`http://127.0.0.1:${srv.port}${url}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/png');
      assert.equal(res.headers.get('content-security-policy'), 'sandbox');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.match(res.headers.get('cache-control')!, /immutable/);
    });
    it('S2 – rejects unknown and malformed asset hashes', async () => {
      for (const hash of ['0'.repeat(64), 'not-a-hash']) {
        assert.equal((await fetch(`http://127.0.0.1:${srv.port}/api/assets/${hash}`)).status, 404);
      }
    });
    it('S3 – breakout copies share one asset', async () => {
      const teacher = await teacherIn('s3');
      for (let i = 0; i < 3; i++) await joinTracked({ roomId: 's3', userId: `s${i}`, name: `Student ${i}` });
      const url = await setWorksheet(teacher);
      const sync = waitForEvent<any>(teacher, 'breakout-sync');
      await emitAck(teacher, 'teacher:configure-breakout', { action: 'new-round', mode: 'individual', copyWorksheet: true });
      const boards = Object.values((await sync).subBoards) as any[];
      assert.equal(boards.length, 3);
      for (const board of boards) assert.equal(board.background.pages[0].dataUrl, url);
      assert.equal(srv.store.countAssets(), 1);
    });
    it('S4 – writes only dirty rooms', async () => {
      const a = await joinTracked({ roomId: 'iso-a', userId: 'a', name: 'A' });
      const peer = await joinTracked({ roomId: 'iso-a', userId: 'peer', name: 'Peer' });
      const b = await joinTracked({ roomId: 'iso-b', userId: 'b', name: 'B' });
      const draw = (socket: Socket, id: string, userId: string) => socket.emit('element-start', { id, userId, boardId: 'main', tool: 'text', text: id, x: 1, y: 1, timestamp: Date.now() });
      let seen = waitForEvent(peer.socket, 'element-start'); draw(a.socket, 'a1', 'a'); await seen;
      const bPeer = await joinTracked({ roomId: 'iso-b', userId: 'bp', name: 'Peer' });
      seen = waitForEvent(bPeer.socket, 'element-start'); draw(b.socket, 'b1', 'b'); await seen;
      await srv.flushRoomsToDiskAsync();
      const saved: string[] = [];
      const orig = srv.store.saveRoom.bind(srv.store);
      srv.store.saveRoom = (id, state, t) => { saved.push(id); orig(id, state, t); };
      seen = waitForEvent(peer.socket, 'element-start'); draw(a.socket, 'a2', 'a'); await seen;
      await srv.flushRoomsToDiskAsync();
      assert.deepEqual(saved, ['iso-a']);
    });
    it('S5 – interns legacy worksheet on migration', async () => {
      await srv.close();
      fs.writeFileSync(path.join(tmpDir, 'rooms-store.json'), JSON.stringify({ rooms: [{ id: 'legacy-assets', messages: [], elements: [], background: worksheet(), teacherPin: '1234', isCanvasLocked: false, lastActiveAt: Date.now() }] }));
      srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmpDir, skipVite: true });
      const { init } = await joinTracked({ roomId: 'legacy-assets', userId: 's', name: 'Student' });
      assert.match(init.background.pages[0].dataUrl, /^\/api\/assets\//);
    });
    it('S6 – imports v2 embedded assets into a fresh store', async () => {
      const teacher = await teacherIn('s6');
      const hash = createHash('sha256').update(Buffer.from(PNG.split(',')[1], 'base64')).digest('hex');
      const url = `/api/assets/${hash}`;
      const sync = waitForEvent<any>(teacher, 'room-restored');
      const result = await emitAck(teacher, 'teacher:import-room', { mode: 'replace', elements: [], messages: [], background: { ...worksheet(), pages: [{ dataUrl: url, width: 1, height: 1 }] }, assets: { [url]: PNG } });
      assert.equal(result.ok, true);
      assert.equal((await sync).background.pages[0].dataUrl, url);
      assert.equal((await fetch(`http://127.0.0.1:${srv.port}${url}`)).status, 200);
    });
    it('S7 – lobby sees a saved unloaded room', async () => {
      const teacher = await teacherIn('lobby-room');
      await srv.flushRoomsToDiskAsync();
      teacher.disconnect();
      await restart();
      const probe = await joinTracked({ roomId: 'other', userId: 'p', name: 'Probe' });
      const result = await emitAck(probe.socket, 'check-room', { roomId: 'lobby-room' });
      assert.equal(result.exists, true);
      assert.equal(result.hasTeacherPin, true);
    });
    it('S8 – armed autoIndividualBackground asset survives GC and restart', async () => {
      const teacher = await teacherIn('s8-auto');
      const settingsPromise = waitForEvent<any>(teacher, 'room-settings');
      const armRes = await emitAck(teacher, 'teacher:configure-breakout', {
        action: 'set-auto-individual',
        autoIndividual: true,
        templateLabel: 'Frayer Model',
        customBackground: worksheet(),
      });
      assert.equal(armRes.ok, true);
      const settings = await settingsPromise;
      const url = settings.breakoutConfig.autoIndividualBackground.pages[0].dataUrl as string;
      assert.match(url, /^\/api\/assets\/[a-f0-9]{64}$/);

      await srv.flushRoomsToDiskAsync();
      assert.equal(srv.store.gcAssets(), 0);
      await restart();

      // Re-verified asset URL still serves 200 and triggers auto-individual with the interned asset on first student join
      assert.equal((await fetch(`http://127.0.0.1:${srv.port}${url}`)).status, 200);
      const { init } = await joinTracked({ roomId: 's8-auto', userId: 's1', name: 'Sam' });
      assert.equal(init.roomSettings.breakoutConfig.mode, 'individual');
      assert.equal(init.subBoards['r1_ind_s1'].background.pages[0].dataUrl, url);
    });

    describe('teacher:set-background-multi', () => {
      const named = (fileName: string) => ({ ...worksheet(), id: `bg-${fileName}`, fileName });
      /** Teacher + 3 students in an individual round; returns board ids sorted by student. */
      const individualRound = async (roomId: string) => {
        const teacher = await teacherIn(roomId);
        const students: Socket[] = [];
        for (let i = 0; i < 3; i++) students.push((await joinTracked({ roomId, userId: `s${i}`, name: `Student ${i}` })).socket);
        const sync = waitForEvent<any>(teacher, 'breakout-sync');
        await emitAck(teacher, 'teacher:configure-breakout', { action: 'new-round', mode: 'individual' });
        const state = await sync;
        const boards = Object.values(state.subBoards) as any[];
        const ids = ['s0', 's1', 's2'].map((uid) => boards.find((b) => b.assignedUserIds[0] === uid).id as string);
        const roundId = state.breakoutConfig.activeRoundId as string;
        return { teacher, students, ids, roundId };
      };
      const collectBackgroundSyncs = (socket: Socket) => {
        const got: Record<string, any> = {};
        const handler = (p: any) => { got[p.boardId] = p.background; };
        socket.on('background-sync', handler);
        return { got, stop: () => socket.off('background-sync', handler) };
      };
      const teacherBoards = async (roomId: string) => {
        const { init } = await joinTracked({ roomId, userId: 't', name: 'Teacher', teacherPin: '1234' });
        return init.subBoards as Record<string, any>;
      };

      it('M1 – sends to selected boards only, as asset URLs', async () => {
        const { teacher, ids } = await individualRound('multi-1');
        const syncs = collectBackgroundSyncs(teacher);
        const res = await emitAck(teacher, 'teacher:set-background-multi', { boardIds: [ids[0], ids[1]], background: named('X.png') });
        assert.deepEqual(res, { ok: true, updated: 2, skipped: [] });
        await delay(100);
        syncs.stop();
        assert.deepEqual(Object.keys(syncs.got).sort(), [ids[0], ids[1]].sort());
        for (const id of [ids[0], ids[1]]) assert.match(syncs.got[id].pages[0].dataUrl, /^\/api\/assets\/[a-f0-9]{64}$/);
        assert.notEqual(syncs.got[ids[0]], syncs.got[ids[1]]);
        teacher.disconnect();
        const boards = await teacherBoards('multi-1');
        assert.equal(boards[ids[0]].background.fileName, 'X.png');
        assert.equal(boards[ids[2]].background, null);
      });

      it('M2 – different variants land on different boards', async () => {
        const { teacher, ids } = await individualRound('multi-2');
        assert.equal((await emitAck(teacher, 'teacher:set-background-multi', { boardIds: [ids[0], ids[2]], background: named('A.png') })).ok, true);
        assert.equal((await emitAck(teacher, 'teacher:set-background-multi', { boardIds: [ids[1]], background: named('B.png') })).ok, true);
        teacher.disconnect();
        const boards = await teacherBoards('multi-2');
        assert.deepEqual(ids.map((id) => boards[id].background.fileName), ['A.png', 'B.png', 'A.png']);
      });

      it('M3 – students cannot use it', async () => {
        const { teacher, students, ids } = await individualRound('multi-3');
        const res = await emitAck(students[0], 'teacher:set-background-multi', { boardIds: ids, background: named('nope.png') });
        assert.equal(res.ok, false);
        teacher.disconnect();
        const boards = await teacherBoards('multi-3');
        for (const id of ids) assert.equal(boards[id].background, null);
      });

      it('M4 – unknown ids are skipped and valid ones still update', async () => {
        const { teacher, ids } = await individualRound('multi-4');
        const res = await emitAck(teacher, 'teacher:set-background-multi', {
          boardIds: [ids[0], 'r9_ind_ghost', ids[0], 42],
          background: named('X.png'),
        });
        assert.deepEqual(res, { ok: true, updated: 1, skipped: ['r9_ind_ghost'] });
        const bad = await emitAck(teacher, 'teacher:set-background-multi', { boardIds: 'nope', background: named('X.png') });
        assert.equal(bad.ok, false);
      });

      it('M5 – one worksheet to three boards stores one asset', async () => {
        const { teacher, ids } = await individualRound('multi-5');
        const before = srv.store.countAssets();
        await emitAck(teacher, 'teacher:set-background-multi', { boardIds: ids, background: named('X.png') });
        assert.equal(srv.store.countAssets(), before + 1);
      });

      it('M6 – roundTemplateFor gives late joiners the worksheet', async () => {
        const { teacher, ids, roundId } = await individualRound('multi-6');
        const res = await emitAck(teacher, 'teacher:set-background-multi', { boardIds: [ids[0]], background: named('A.png'), roundTemplateFor: roundId });
        assert.equal(res.ok, true);
        const { init } = await joinTracked({ roomId: 'multi-6', userId: 'late', name: 'Late' });
        const lateBoard = (Object.values(init.subBoards) as any[]).find((b) => b.assignedUserIds[0] === 'late');
        assert.ok(lateBoard, 'late joiner gets an individual board');
        assert.equal(lateBoard.background.fileName, 'A.png');
      });

      it('M7 – sent worksheets survive a restart', async () => {
        const { teacher, ids } = await individualRound('multi-7');
        await emitAck(teacher, 'teacher:set-background-multi', { boardIds: [ids[0]], background: named('A.png') });
        await emitAck(teacher, 'teacher:set-background-multi', { boardIds: [ids[1], ids[2]], background: named('B.png') });
        await srv.flushRoomsToDiskAsync();
        await restart();
        const boards = await teacherBoards('multi-7');
        assert.deepEqual(ids.map((id) => boards[id].background.fileName), ['A.png', 'B.png', 'B.png']);
      });
    });
  });

  describe('element authorship and teacher-only feedback stamps', () => {
    it('overwrites client-supplied userId and userName on element-start and elements-batch-add', async () => {
      const roomId = 'auth-overwrite';
      const teacher = (await joinTracked({ roomId, userId: 'teacher', name: 'Ms T' })).socket;
      await emitAck(teacher, 'teacher:auth', { pin: '1234' });
      const student = await joinTracked({ roomId, userId: 'stu-1', name: 'Real Student' });

      // Student tries to spoof userId = teacher and userName = 'Ms T' via element-start
      const startBroadcast = waitForEvent<any>(teacher, 'element-start');
      student.socket.emit('element-start', {
        id: 'spoof-1',
        boardId: 'main',
        userId: 'teacher',
        userName: 'Ms T',
        tool: 'text',
        text: 'hi',
        x: 10,
        y: 10,
      });
      const seenStart = await startBroadcast;
      assert.equal(seenStart.userId, 'stu-1');
      assert.equal(seenStart.userName, 'Real Student');

      // Same for elements-batch-add
      const batchBroadcast = waitForEvent<any>(teacher, 'elements-batch-added');
      student.socket.emit('elements-batch-add', {
        boardId: 'main',
        elements: [
          {
            id: 'spoof-2',
            userId: 'teacher',
            userName: 'Ms T',
            tool: 'rect',
            x: 20,
            y: 20,
            width: 30,
            height: 30,
            color: '#000',
            strokeWidth: 4,
          },
        ],
      });
      const seenBatch = await batchBroadcast;
      assert.equal(seenBatch.elements.length, 1);
      assert.equal(seenBatch.elements[0].userId, 'stu-1');
      assert.equal(seenBatch.elements[0].userName, 'Real Student');

      // Persisted state also has real student identity
      const late = await joinTracked({ roomId, userId: 'late-1', name: 'Latecomer' });
      const byId = new Map((late.init.elements as any[]).map((e) => [e.id, e]));
      assert.equal(byId.get('spoof-1')?.userId, 'stu-1');
      assert.equal(byId.get('spoof-2')?.userId, 'stu-1');
    });

    it('rejects teacher stamp kinds from non-teachers on add and update', async () => {
      const roomId = 'stamp-reject';
      const teacher = (await joinTracked({ roomId, userId: 'teacher', name: 'Ms T' })).socket;
      await emitAck(teacher, 'teacher:auth', { pin: '1234' });
      const student = await joinTracked({ roomId, userId: 'stu-1', name: 'Stu' });

      // Student attempts to place approved / teacher-custom via element-start and elements-batch-add
      student.socket.emit('element-start', {
        id: 'forged-1',
        boardId: 'main',
        userId: 'teacher',
        userName: 'Ms T',
        tool: 'stamp',
        stamp: 'approved',
        color: '#15803d',
        strokeWidth: 6,
        x: 50,
        y: 50,
      });
      student.socket.emit('elements-batch-add', {
        boardId: 'main',
        elements: [
          {
            id: 'forged-2',
            userId: 'teacher',
            userName: 'Ms T',
            tool: 'stamp',
            stamp: 'teacher-custom',
            text: 'EXCUSED',
            color: '#7c3aed',
            strokeWidth: 6,
            x: 70,
            y: 70,
          },
          {
            id: 'ok-student-stamp',
            userId: 'stu-1',
            userName: 'Stu',
            tool: 'stamp',
            stamp: 'check',
            color: '#2563eb',
            strokeWidth: 6,
            x: 90,
            y: 90,
          },
        ],
      });

      const batchSeen = await waitForEvent<any>(teacher, 'elements-batch-added');
      assert.deepEqual(
        batchSeen.elements.map((e: any) => e.id),
        ['ok-student-stamp']
      );

      // Student also cannot mutate their own stamp into a teacher stamp via element-update or batch-update
      const updateSeen = waitForEvent<any>(teacher, 'element-update');
      student.socket.emit('element-update', {
        id: 'ok-student-stamp',
        boardId: 'main',
        stamp: 'denied',
        x: 95,
      });
      const updated = await updateSeen;
      assert.equal(updated.x, 95);
      assert.equal(updated.stamp, undefined);

      const batchUpdateSeen = waitForEvent<any>(teacher, 'elements-batch-updated');
      student.socket.emit('elements-batch-update', {
        boardId: 'main',
        updates: [{ id: 'ok-student-stamp', stamp: 'late', y: 99 }],
      });
      const batchUpdated = await batchUpdateSeen;
      assert.equal(batchUpdated.updates[0].y, 99);
      assert.equal(batchUpdated.updates[0].stamp, undefined);

      const verify = await joinTracked({ roomId, userId: 'v', name: 'V' });
      const ids = (verify.init.elements as any[]).map((e) => e.id);
      assert.deepEqual(ids, ['ok-student-stamp']);
      assert.equal(verify.init.elements[0].stamp, 'check');
    });

    it('lets teachers place teacher stamps and blocks students from moving or deleting them', async () => {
      const roomId = 'teacher-stamp-protect';
      const teacher = (await joinTracked({ roomId, userId: 'teacher', name: 'Ms T' })).socket;
      await emitAck(teacher, 'teacher:auth', { pin: '1234' });
      const student = await joinTracked({ roomId, userId: 'stu-1', name: 'Stu' });

      const stampSeen = waitForEvent<any>(student.socket, 'element-start');
      teacher.emit('element-start', {
        id: 't-approved-1',
        boardId: 'main',
        userId: 'fake-client-id',
        userName: 'Teacher',
        tool: 'stamp',
        stamp: 'approved',
        color: '#15803d',
        strokeWidth: 6,
        x: 120,
        y: 140,
      });
      const delivered = await stampSeen;
      assert.equal(delivered.stamp, 'approved');
      assert.equal(delivered.userId, 'teacher');

      // Student tries every mutation/deletion channel against the teacher's stamp
      student.socket.emit('element-update', { id: 't-approved-1', boardId: 'main', x: 999, y: 999 });
      student.socket.emit('elements-batch-update', {
        boardId: 'main',
        updates: [{ id: 't-approved-1', x: 888 }],
      });
      student.socket.emit('element-remove', { id: 't-approved-1', boardId: 'main' });
      student.socket.emit('elements-batch-remove', { boardId: 'main', ids: ['t-approved-1'] });

      await delay(80);

      const verify = await joinTracked({ roomId, userId: 'v', name: 'V' });
      const found = (verify.init.elements as any[]).find((e) => e.id === 't-approved-1');
      assert.ok(found, 'teacher stamp must remain present');
      assert.equal(found.x, 120);
      assert.equal(found.y, 140);
      assert.equal(found.stamp, 'approved');
    });
  });

  describe('board channels (ink and cursors only reach the board that needs them)', () => {
    async function setupClass(roomId: string) {
      const { socket: teacher } = await joinTracked({ roomId, userId: 't1', name: 'Teacher' });
      await emitAck(teacher, 'teacher:auth', { pin: '1234' });
      const { socket: s1 } = await joinTracked({ roomId, userId: 's1', name: 'Sam' });
      const { socket: s2 } = await joinTracked({ roomId, userId: 's2', name: 'Ada' });
      return { teacher, s1, s2 };
    }

    function stroke(id: string, boardId: string, userId: string) {
      return { id, boardId, userId, userName: userId, tool: 'solid', color: '#000', strokeWidth: 4, points: [0, 0], timestamp: Date.now() };
    }

    /** Collects every event a socket receives, so tests can assert what it did NOT get. */
    function record(socket: Socket) {
      const got: Array<{ ev: string; data: any }> = [];
      socket.onAny((ev, data) => got.push({ ev, data }));
      return got;
    }

    async function startIndividualRound(teacher: Socket, watcher: Socket) {
      const synced = waitForEvent<any>(watcher, 'breakout-sync');
      await emitAck(teacher, 'teacher:configure-breakout', { action: 'new-round', mode: 'individual' });
      await synced;
      await delay(50);
    }

    it('shares an anonymized board to main without modifying the source and returns students', async () => {
      const { teacher, s1, s2 } = await setupClass('spotlight');
      await startIndividualRound(teacher, s2);
      const source = 'r1_ind_s1';
      const fresh = waitForEvent(teacher, 'state-sync');
      teacher.emit('teacher:view-board', { boardId: source });
      await fresh;
      const drawn = waitForEvent(teacher, 'element-start');
      s1.emit('element-start', stroke('original', source, 's1'));
      await drawn;
      const stamped = waitForEvent(teacher, 'element-start');
      s1.emit('element-start', { ...stroke('name-stamp', source, 's1'), tool: 'stamp', stamp: 'username', text: 'Sam' });
      await stamped;
      const background = { id: 'bg', fileName: 'worksheet.png', pages: [{ dataUrl: 'data:image/png;base64,aGVsbG8=', width: 10, height: 10 }], x: 0, y: 0, scale: 1, layout: 'row', opacity: 1 };
      assert.equal((await emitAck<any>(teacher, 'teacher:set-background', { boardId: source, background })).ok, true);
      assert.equal((await emitAck<any>(s1, 'teacher:spotlight-board', { sourceBoardId: source })).ok, false);
      assert.equal((await emitAck<any>(teacher, 'teacher:spotlight-board', { sourceBoardId: 'missing' })).ok, false);
      const mainSync = waitForEvent<any>(s1, 'state-sync');
      const backgroundSync = waitForEvent<any>(s1, 'background-sync');
      const breakout = waitForEvent<any>(teacher, 'breakout-sync');
      const result = await emitAck<any>(teacher, 'teacher:spotlight-board', { sourceBoardId: source, copyBackground: true, returnToMain: true });
      assert.equal(result.ok, true);
      const main = await mainSync;
      assert.equal(main.boardId, 'main');
      assert.equal(main.elements.length, 1);
      assert.notEqual(main.elements[0].id, 'original');
      assert.equal(main.elements[0].boardId, 'main');
      assert.match(main.elements[0].userId, /^anon_[0-9a-f-]{36}$/);
      assert.equal(main.elements[0].userName, 'Class Example');
      const bg = await backgroundSync;
      assert.equal(bg.boardId, 'main');
      assert.match(bg.background.pages[0].dataUrl, /^\/api\/assets\//);
      const state = await breakout;
      assert.equal(state.breakoutConfig.mode, 'main');
      assert.deepEqual(state.subBoards[source].elements.map((element: any) => element.id), ['original', 'name-stamp']);
      const late = await joinTracked({ roomId: 'spotlight', userId: 'late', name: 'Late' });
      assert.equal(late.init.elements[0].id, main.elements[0].id);
      const namedSync = waitForEvent<any>(late.socket, 'state-sync');
      const named = await emitAck<any>(teacher, 'teacher:spotlight-board', { sourceBoardId: source, anonymize: false, copyBackground: false, returnToMain: false });
      assert.equal(named.ok, true);
      const namedElements = (await namedSync).elements;
      assert.equal(namedElements.length, 2);
      assert.equal(namedElements[0].userId, 's1');
      assert.equal(namedElements[1].stamp, 'username');
      assert.equal(namedElements[1].userName, 'Sam');
    });

    it('keeps each author’s erasers separate when a group board is shared anonymously', async () => {
      const { teacher, s1, s2 } = await setupClass('spotlight-erasers');
      const configured = await emitAck<any>(teacher, 'teacher:configure-breakout', {
        action: 'new-round',
        mode: 'groups',
        groups: [{ id: 'grp_1', title: 'Red', assignedUserIds: ['s1', 's2'] }],
      });
      assert.equal(configured.ok, true);
      const source = 'r1_grp_1';
      const points = [0, 50, 50, 50, 100, 50, 150, 50, 200, 50];
      s1.emit('element-start', { ...stroke('ada-1', source, 's1'), strokeWidth: 6, points });
      s1.emit('element-start', { ...stroke('ada-2', source, 's1'), points: [0, 200, 200, 200] });
      await delay(50);
      s2.emit('element-start', {
        ...stroke('sam-eraser', source, 's2'),
        tool: 'eraser',
        strokeWidth: 40,
        points: [100, 0, 100, 25, 100, 50, 100, 75, 100, 100],
      });
      await delay(50);

      const shared = await emitAck<any>(teacher, 'teacher:spotlight-board', { sourceBoardId: source });
      assert.equal(shared.ok, true);

      const { init } = await joinTracked({ roomId: 'spotlight-erasers', userId: 'late', name: 'Late' });
      const [adaFirst, adaSecond, samEraser] = init.elements;
      assert.equal(init.elements.length, 3);
      assert.equal(adaFirst.userId, adaSecond.userId);
      assert.notEqual(adaFirst.userId, samEraser.userId);
      assert.deepEqual(getVisibleStrokeRuns(adaFirst, init.elements), [points]);
    });

    it('limits students to one name stamp per board while the teacher rule is on', async () => {
      const { teacher, s1, s2 } = await setupClass('one-stamp');
      const nameStamp = (id: string, userId: string) => ({ ...stroke(id, 'main', userId), tool: 'stamp', stamp: 'username', x: 1, y: 1 });
      const mainIds = async () => {
        const { init, socket } = await joinTracked({ roomId: 'one-stamp', userId: 'checker', name: 'Checker' });
        socket.disconnect();
        return init.elements.map((el: any) => el.id);
      };

      s1.emit('teacher:set-one-name-stamp', true);
      s1.emit('element-start', nameStamp('free-1', 's1'));
      s1.emit('element-start', nameStamp('free-2', 's1'));
      await delay(100);
      assert.deepEqual(await mainIds(), ['free-1', 'free-2']); // Off by default; students can't turn it on

      s1.emit('elements-batch-remove', { boardId: 'main', ids: ['free-1', 'free-2'] });
      const turnedOn = waitForEvent<any>(s1, 'room-settings');
      teacher.emit('teacher:set-one-name-stamp', true);
      assert.equal((await turnedOn).oneNameStamp, true);

      s1.emit('element-start', nameStamp('first', 's1'));
      await delay(50);
      const corrected = waitForEvent<any>(s1, 'state-sync');
      s1.emit('element-start', nameStamp('second', 's1'));
      assert.deepEqual((await corrected).elements.map((el: any) => el.id), ['first']);

      s2.emit('elements-batch-add', { boardId: 'main', elements: [nameStamp('batch-1', 's2'), nameStamp('batch-2', 's2')] });
      teacher.emit('element-start', nameStamp('teacher-1', 't1'));
      teacher.emit('element-start', nameStamp('teacher-2', 't1'));
      await delay(100);
      assert.deepEqual(await mainIds(), ['first', 'batch-1', 'teacher-1', 'teacher-2']);

      // Moving your stamp still works, and deleting it frees the slot
      s1.emit('element-update', { id: 'first', boardId: 'main', x: 50 });
      await delay(50);
      s1.emit('element-remove', { id: 'first', boardId: 'main' });
      s1.emit('element-start', nameStamp('replacement', 's1'));
      await delay(100);
      const ids = await mainIds();
      assert.equal(ids.includes('first'), false);
      assert.equal(ids.includes('replacement'), true);
    });

    it('refuses to let anyone join as an anonymous author', async () => {
      const { teacher, s1 } = await setupClass('spotlight-anon-id');
      await startIndividualRound(teacher, s1);
      s1.emit('element-start', stroke('original', 'r1_ind_s1', 's1'));
      await delay(50);
      await emitAck(teacher, 'teacher:spotlight-board', { sourceBoardId: 'r1_ind_s1' });
      const { init } = await joinTracked({ roomId: 'spotlight-anon-id', userId: 'late', name: 'Late' });

      const intruder = ioClient(`http://127.0.0.1:${srv.port}`, { transports: ['websocket'], forceNew: true, reconnection: false });
      openSockets.push(intruder);
      await waitForEvent(intruder, 'connect');
      const events = record(intruder);
      intruder.emit('join-room', { roomId: 'spotlight-anon-id', userId: init.elements[0].userId, name: 'Intruder' });
      await delay(100);
      assert.equal(events.some(({ ev }) => ev === 'init'), false);
    });

    it('scopes ephemeral laser pulses to the teacher’s board and rejects invalid senders and payloads', async () => {
      const { teacher, s1, s2 } = await setupClass('laser-scope');
      await startIndividualRound(teacher, s2);
      const fresh = waitForEvent(teacher, 'state-sync');
      teacher.emit('teacher:view-board', { boardId: 'r1_ind_s1' });
      await fresh;
      const otherEvents = record(s2);
      const studentEvents = record(s1);
      s1.emit('laser-pulse', { boardId: 'r1_ind_s1', x: 1, y: 2, strokeId: 'fake' });
      teacher.emit('laser-pulse', { boardId: 'r1_ind_s2', x: 1, y: 2, strokeId: 'wrong-board' });
      teacher.emit('laser-pulse', { boardId: 'r1_ind_s1', x: Infinity, y: 2, strokeId: 'invalid' });
      const seen = waitForEvent<any>(s1, 'laser-pulse');
      teacher.emit('laser-pulse', { boardId: 'r1_ind_s1', x: 3, y: 4, strokeId: 'valid', userId: 'spoof' });
      assert.deepEqual(await seen, { boardId: 'r1_ind_s1', x: 3, y: 4, strokeId: 'valid', userId: 't1' });
      await delay(150);
      assert.equal(otherEvents.filter((event) => event.ev === 'laser-pulse').length, 0);
      assert.equal(studentEvents.filter((event) => event.ev === 'laser-pulse').length, 1);
      const late = await joinTracked({ roomId: 'laser-scope', userId: 'late', name: 'Late' });
      assert.deepEqual(late.init.elements, []);
      assert.ok(Object.values(late.init.subBoards as Record<string, any>).every((board: any) => board.elements.length === 0));
    });

    it('scopes ink and cursors to the board; a teacher elsewhere gets it as a periodic digest', async () => {
      const { teacher, s1, s2 } = await setupClass('chan-scope');
      await startIndividualRound(teacher, s2);

      const t = record(teacher);
      const r2 = record(s2);
      s1.emit('element-start', stroke('ink1', 'r1_ind_s1', 's1'));
      s1.emit('element-append-points', { id: 'ink1', boardId: 'r1_ind_s1', newPoints: [20, 20] });
      s1.emit('cursor-move', { userId: 's1', boardId: 'r1_ind_s1', x: 1, y: 1 });
      await delay(300);

      assert.deepEqual(r2.map((e) => e.ev), [], 's2 is on another board and must hear nothing');
      // Teacher is viewing main: no live ink or cursors from r1_ind_s1, just digests with the whole stroke.
      assert.ok(t.every((e) => e.ev === 'boards-digest'), t.map((e) => e.ev).join());
      const upserts = t.flatMap((e) => e.data.boards).filter((d: any) => d.boardId === 'r1_ind_s1');
      assert.ok(upserts.length >= 1 && upserts.length <= 2, 'coalesced, not one per message');
      assert.deepEqual(upserts.at(-1).upserts[0].points, [0, 0, 20, 20]);
    });

    it('a teacher viewing a board gets it live (after a fresh copy) and no digest for it', async () => {
      const { teacher, s1, s2 } = await setupClass('chan-view');
      await startIndividualRound(teacher, s2);
      s1.emit('element-start', stroke('before', 'r1_ind_s1', 's1'));
      await delay(250); // let that go out as a digest first

      const fresh = waitForEvent<any>(teacher, 'state-sync');
      teacher.emit('teacher:view-board', { boardId: 'r1_ind_s1' });
      const sync = await fresh;
      assert.equal(sync.boardId, 'r1_ind_s1');
      assert.deepEqual(sync.elements.map((e: any) => e.id), ['before']);

      const t = record(teacher);
      s1.emit('element-start', stroke('live', 'r1_ind_s1', 's1'));
      s1.emit('cursor-move', { userId: 's1', boardId: 'r1_ind_s1', x: 1, y: 1 });
      s2.emit('element-start', stroke('other', 'r1_ind_s2', 's2'));
      await delay(500); // one cursor tick (CURSOR_EMIT_MS) plus slack
      const evs = t.map((e) => e.ev);
      assert.ok(evs.includes('element-start') && evs.includes('cursors-batch'));
      const digested = t.filter((e) => e.ev === 'boards-digest').flatMap((e) => e.data.boards.map((d: any) => d.boardId));
      assert.ok(digested.includes('r1_ind_s2'));
      assert.ok(!digested.includes('r1_ind_s1'), 'viewed board is live, never digested');

      // Students on that board see the teacher's ink live too.
      const seen = waitForEvent<any>(s1, 'element-start');
      teacher.emit('element-start', stroke('fromT', 'r1_ind_s1', 't1'));
      assert.equal((await seen).id, 'fromT');
    });

    it('digests carry removals, and a full board after a clear', async () => {
      const { teacher, s1, s2 } = await setupClass('chan-digest');
      await startIndividualRound(teacher, s2);
      s1.emit('element-start', stroke('a', 'r1_ind_s1', 's1'));
      s1.emit('element-start', stroke('b', 'r1_ind_s1', 's1'));
      await delay(250);

      const t = record(teacher);
      s1.emit('element-remove', { id: 'a', boardId: 'r1_ind_s1' });
      await delay(250);
      const rm = t.flatMap((e) => e.data?.boards ?? []).find((d: any) => d.boardId === 'r1_ind_s1');
      assert.deepEqual(rm.removed, ['a']);

      t.length = 0;
      teacher.emit('teacher:clear-all', { boardId: 'r1_ind_s1' });
      await delay(250);
      const full = t.flatMap((e) => e.data?.boards ?? []).find((d: any) => d.boardId === 'r1_ind_s1');
      assert.deepEqual(full.elements, []);
    });

    it('students get only their own board’s ink in breakout-sync and init; teachers get all of it', async () => {
      const { teacher, s1, s2 } = await setupClass('chan-trim');
      await startIndividualRound(teacher, s2);
      s1.emit('element-start', stroke('mine1', 'r1_ind_s1', 's1'));
      s2.emit('element-start', stroke('mine2', 'r1_ind_s2', 's2'));
      await delay(100);

      const [tSync, s1Sync] = await Promise.all([
        waitForEvent<any>(teacher, 'breakout-sync'),
        waitForEvent<any>(s1, 'breakout-sync'),
        emitAck(teacher, 'teacher:configure-breakout', { action: 'update-current', chatScope: 'board' }),
      ]);
      assert.equal(tSync.subBoards['r1_ind_s1'].elements.length, 1);
      assert.equal(tSync.subBoards['r1_ind_s2'].elements.length, 1);
      assert.equal(s1Sync.subBoards['r1_ind_s1'].elements.length, 1);
      assert.equal(s1Sync.subBoards['r1_ind_s2'].elements.length, 0, 'other board: metadata only');
      assert.deepEqual(s1Sync.subBoards['r1_ind_s2'].assignedUserIds, ['s2']);

      const { init } = await joinTracked({ roomId: 'chan-trim', userId: 's2', name: 'Ada' });
      assert.equal(init.subBoards['r1_ind_s2'].elements.length, 1);
      assert.equal(init.subBoards['r1_ind_s1'].elements.length, 0);
    });

    it('delivers ink to students sharing a group board', async () => {
      const { teacher, s1, s2 } = await setupClass('chan-group');
      const synced = waitForEvent<any>(s2, 'breakout-sync');
      await emitAck(teacher, 'teacher:configure-breakout', {
        action: 'new-round',
        mode: 'groups',
        groups: [{ id: 'g', title: 'Team', assignedUserIds: ['s1', 's2'] }],
      });
      const { subBoards } = await synced;
      const groupId = Object.keys(subBoards).find((id) => subBoards[id].kind === 'group')!;
      await delay(50);

      const got = waitForEvent<any>(s2, 'element-append-points');
      s1.emit('element-start', stroke('g1', groupId, 's1'));
      s1.emit('element-append-points', { id: 'g1', boardId: groupId, newPoints: [5, 5] });
      assert.deepEqual((await got).newPoints, [5, 5]);
    });

    it('catches a student up on the main board they missed during a breakout', async () => {
      const { teacher, s1 } = await setupClass('chan-catchup');
      await startIndividualRound(teacher, s1);

      const r1 = record(s1);
      teacher.emit('element-start', stroke('tmain', 'main', 't1')); // s1 is not listening to main now
      await delay(100);
      assert.equal(r1.filter((e) => e.ev === 'element-start').length, 0);

      const catchUp = waitForEvent<any>(s1, 'state-sync');
      await emitAck(teacher, 'teacher:configure-breakout', { action: 'return-to-main' });
      const sync = await catchUp;
      assert.equal(sync.boardId, 'main');
      assert.deepEqual(sync.elements.map((e: any) => e.id), ['tmain']);

      const live = waitForEvent<any>(s1, 'element-start'); // and it hears main again
      teacher.emit('element-start', stroke('tmain2', 'main', 't1'));
      assert.equal((await live).id, 'tmain2');
    });

    it('gives a student who becomes teacher mid-breakout a full fresh copy', async () => {
      const { teacher, s1, s2 } = await setupClass('chan-promote');
      await startIndividualRound(teacher, s2);
      s1.emit('element-start', stroke('s1ink', 'r1_ind_s1', 's1')); // s2 does not hear this
      await delay(100);

      const fresh = waitForEvent<any>(s2, 'breakout-sync');
      await emitAck(s2, 'teacher:auth', { pin: '1234' });
      const sync = await fresh;
      assert.deepEqual(sync.subBoards['r1_ind_s1'].elements.map((e: any) => e.id), ['s1ink']);
    });
  });

});
