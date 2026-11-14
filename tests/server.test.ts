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
  });

});

