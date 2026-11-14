import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as ioClient, Socket } from 'socket.io-client';
import { startServer } from '../server';

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
    assert.equal(fs.existsSync(path.join(tmpDir, 'rooms-store.json')), true);

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
});

