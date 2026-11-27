import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Socket } from 'socket.io-client';
import {
  type ServerHandle,
  delay,
  emitAck,
  socketPool,
  startTestServer,
  waitForEvent,
  worksheet,
} from './socketHelpers.ts';

describe('prepared breakout rounds', () => {
  let srv: ServerHandle;
  let dir: string;
  const pool = socketPool();

  beforeEach(async () => {
    ({ srv, dir } = await startTestServer());
  });
  afterEach(async () => {
    pool.closeAll();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function setupClass(roomId: string) {
    const { socket: teacher } = await pool.join(srv, { roomId, userId: 't1', name: 'Teacher' });
    assert.equal((await emitAck(teacher, 'teacher:auth', { pin: '1234' })).ok, true);
    const { socket: s1 } = await pool.join(srv, { roomId, userId: 's1', name: 'Sam' });
    const { socket: s2 } = await pool.join(srv, { roomId, userId: 's2', name: 'Ada' });
    await delay(30);
    return { teacher, s1, s2 };
  }

  /** Sends a configure-breakout and returns the ack and the teacher's next breakout-sync. */
  async function configure(teacher: Socket, payload: any) {
    const sync = waitForEvent<any>(teacher, 'breakout-sync');
    const res = await emitAck<any>(teacher, 'teacher:configure-breakout', payload);
    return { res, sync: res.ok ? await sync : null };
  }

  const groups = (n: number, assigned: string[][] = []) =>
    Array.from({ length: n }, (_, i) => ({
      id: `draft-${i}`,
      title: `Team ${i + 1}`,
      assignedUserIds: assigned[i] ?? [],
    }));

  it('P1 – a prepared individual round moves nobody and makes no boards', async () => {
    const { teacher, s1 } = await setupClass('pr-1');
    const studentSync = waitForEvent<any>(s1, 'breakout-sync');
    const { res, sync } = await configure(teacher, {
      action: 'new-round',
      prepare: true,
      mode: 'individual',
      title: 'Warm-up',
      customBackground: worksheet('frayer.png'),
    });
    assert.equal(res.ok, true);
    assert.equal(res.roundId, 'r1');
    assert.equal(res.mode, 'main');
    assert.equal(res.activeRoundId, undefined);
    assert.equal(sync.breakoutConfig.mode, 'main');
    assert.deepEqual(Object.keys(sync.subBoards), []);
    const round = sync.breakoutConfig.rounds[0];
    assert.equal(round.prepared, true);
    assert.equal(round.title, 'Round 1 · Individual · Warm-up');
    // Teachers get the round's worksheet; students don't.
    assert.equal(sync.roundTemplates.r1.fileName, 'frayer.png');
    assert.match(sync.roundTemplates.r1.pages[0].dataUrl, /^\/api\/assets\//);
    const forStudent = await studentSync;
    assert.equal(forStudent.breakoutConfig.mode, 'main');
    assert.equal(forStudent.roundTemplates, undefined);
  });

  it('P2 – a prepared group round makes its boards with the worksheet, and nobody moves', async () => {
    const { teacher } = await setupClass('pr-2');
    const { res, sync } = await configure(teacher, {
      action: 'new-round',
      prepare: true,
      mode: 'groups',
      groups: groups(3),
      customBackground: worksheet('debate.png'),
      chatScope: 'board',
      allowSelfSelect: true,
    });
    assert.equal(res.ok, true);
    assert.equal(sync.breakoutConfig.mode, 'main');
    assert.equal(sync.breakoutConfig.chatScope, 'unified', 'room settings untouched until launch');
    assert.equal(sync.breakoutConfig.allowSelfSelect, false);
    for (const id of ['r1_grp_1', 'r1_grp_2', 'r1_grp_3']) {
      assert.equal(sync.subBoards[id].background.fileName, 'debate.png');
      assert.deepEqual(sync.subBoards[id].assignedUserIds, []);
    }
    assert.equal(sync.subBoards.r1_grp_2.title, 'Team 2');
  });

  it('P3/P4 – launching applies the stored settings, gives students the worksheet, and serves late joiners', async () => {
    const { teacher, s1 } = await setupClass('pr-3');
    await configure(teacher, {
      action: 'new-round',
      prepare: true,
      mode: 'individual',
      customBackground: worksheet('exit.png'),
      chatScope: 'board',
    });
    await delay(50); // let the students' copy of that sync arrive first
    const studentSync = waitForEvent<any>(s1, 'breakout-sync');
    const { res, sync } = await configure(teacher, { action: 'resume', roundId: 'r1' });
    assert.equal(res.ok, true);
    assert.equal(sync.breakoutConfig.mode, 'individual');
    assert.equal(sync.breakoutConfig.activeRoundId, 'r1');
    assert.equal(sync.breakoutConfig.chatScope, 'board');
    const round = sync.breakoutConfig.rounds[0];
    assert.equal(round.prepared, undefined);
    assert.equal(typeof round.launchedAt, 'number');
    assert.equal(sync.subBoards.r1_ind_s1.background.fileName, 'exit.png');
    const mine = await studentSync;
    assert.equal(mine.subBoards.r1_ind_s1.background.fileName, 'exit.png');

    const late = waitForEvent<any>(teacher, 'breakout-sync');
    await pool.join(srv, { roomId: 'pr-3', userId: 's3', name: 'Lee' });
    const lateSync = await late;
    assert.equal(lateSync.subBoards.r1_ind_s3.background.fileName, 'exit.png');

    // Payload values override the stored ones.
    await configure(teacher, { action: 'return-to-main' });
    await configure(teacher, { action: 'new-round', prepare: true, mode: 'individual', chatScope: 'board' });
    const { sync: second } = await configure(teacher, { action: 'resume', roundId: 'r2', chatScope: 'unified' });
    assert.equal(second.breakoutConfig.chatScope, 'unified');
  });

  it('P5 – edit-prepared changes title and worksheet; it refuses launched rounds', async () => {
    const { teacher } = await setupClass('pr-5');
    await configure(teacher, { action: 'new-round', prepare: true, mode: 'groups', groups: groups(2) });
    const { res, sync } = await configure(teacher, {
      action: 'edit-prepared',
      roundId: 'r1',
      title: 'Jigsaw',
      customBackground: worksheet('jigsaw.png'),
    });
    assert.equal(res.ok, true);
    assert.equal(sync.breakoutConfig.rounds[0].title, 'Round 1 · Groups · Jigsaw');
    assert.equal(sync.roundTemplates.r1.fileName, 'jigsaw.png');
    assert.equal(sync.subBoards.r1_grp_1.background.fileName, 'jigsaw.png');
    assert.notEqual(sync.subBoards.r1_grp_1.background, sync.subBoards.r1_grp_2.background);

    await configure(teacher, { action: 'resume', roundId: 'r1', groups: groups(2, [['s1'], ['s2']]) });
    const refused = await emitAck<any>(teacher, 'teacher:configure-breakout', {
      action: 'edit-prepared',
      roundId: 'r1',
      title: 'x',
    });
    assert.equal(refused.ok, false);
    const updateOnPrepared = await emitAck<any>(teacher, 'teacher:configure-breakout', {
      action: 'edit-prepared',
      roundId: 'r1',
      mode: 'individual',
    });
    assert.equal(updateOnPrepared.ok, false);
  });

  it('P6 – edit-prepared group count keeps the first boards and their ink', async () => {
    const { teacher } = await setupClass('pr-6');
    await configure(teacher, { action: 'new-round', prepare: true, mode: 'groups', groups: groups(3) });
    teacher.emit('teacher:view-board', { boardId: 'r1_grp_1' });
    teacher.emit('element-start', {
      id: 'note-1',
      boardId: 'r1_grp_1',
      tool: 'solid',
      color: '#000',
      strokeWidth: 4,
      points: [0, 0, 5, 5],
      timestamp: Date.now(),
    });
    await delay(50);
    const { sync: fewer } = await configure(teacher, { action: 'edit-prepared', roundId: 'r1', groups: groups(2) });
    assert.deepEqual(Object.keys(fewer.subBoards).sort(), ['r1_grp_1', 'r1_grp_2']);
    assert.equal(fewer.subBoards.r1_grp_1.elements.length, 1);
    const { sync: more } = await configure(teacher, { action: 'edit-prepared', roundId: 'r1', groups: groups(4) });
    assert.deepEqual(Object.keys(more.subBoards).sort(), ['r1_grp_1', 'r1_grp_2', 'r1_grp_3', 'r1_grp_4']);
    assert.equal(more.subBoards.r1_grp_1.elements.length, 1);
    assert.equal(more.subBoards.r1_grp_4.title, 'Team 4');
  });

  it('P7 – delete-prepared removes the round, its boards and worksheet; never a launched round', async () => {
    const { teacher } = await setupClass('pr-7');
    await configure(teacher, { action: 'new-round', mode: 'individual' }); // r1, launched
    await configure(teacher, { action: 'return-to-main' });
    await configure(teacher, {
      action: 'new-round',
      prepare: true,
      mode: 'groups',
      groups: groups(2),
      customBackground: worksheet(),
    });
    const { res, sync } = await configure(teacher, { action: 'delete-prepared', roundId: 'r2' });
    assert.equal(res.ok, true);
    assert.deepEqual(
      sync.breakoutConfig.rounds.map((r: any) => r.id),
      ['r1']
    );
    assert.equal(
      Object.keys(sync.subBoards).some((id) => id.startsWith('r2')),
      false
    );
    assert.equal(sync.roundTemplates.r2, undefined);
    const refused = await emitAck<any>(teacher, 'teacher:configure-breakout', {
      action: 'delete-prepared',
      roundId: 'r1',
    });
    assert.equal(refused.ok, false);
    const updateRefused = await emitAck<any>(teacher, 'teacher:configure-breakout', {
      action: 'update-current',
      roundId: 'r1',
    });
    assert.equal(updateRefused.ok, true, 'launched rounds still edit as before');
  });

  it('P8 – students cannot prepare, edit, delete or launch', async () => {
    const { teacher, s1 } = await setupClass('pr-8');
    await configure(teacher, { action: 'new-round', prepare: true, mode: 'individual' });
    for (const payload of [
      { action: 'new-round', prepare: true, mode: 'individual' },
      { action: 'edit-prepared', roundId: 'r1', title: 'x' },
      { action: 'delete-prepared', roundId: 'r1' },
      { action: 'resume', roundId: 'r1' },
    ]) {
      const res = await emitAck<any>(s1, 'teacher:configure-breakout', payload);
      assert.equal(res.ok, false);
    }
  });

  it('P9 – a teacher joining gets roundTemplates in init; a student does not', async () => {
    const { teacher } = await setupClass('pr-9');
    await configure(teacher, {
      action: 'new-round',
      prepare: true,
      mode: 'individual',
      customBackground: worksheet('a.png'),
    });
    const { init: t } = await pool.join(srv, { roomId: 'pr-9', userId: 't2', name: 'Co', teacherPin: '1234' });
    assert.equal(t.isTeacher, true);
    assert.equal(t.roundTemplates.r1.fileName, 'a.png');
    const { init: s } = await pool.join(srv, { roomId: 'pr-9', userId: 's9', name: 'Kid' });
    assert.equal(s.roundTemplates, undefined);
  });

  it('P10 – a room save round trip keeps a prepared round worksheet', async () => {
    const { teacher, s1 } = await setupClass('pr-10');
    await configure(teacher, {
      action: 'new-round',
      prepare: true,
      mode: 'individual',
      customBackground: worksheet('keep.png'),
    });
    const state = await configure(teacher, { action: 'return-to-main' });
    const snapshot = {
      mode: 'replace',
      elements: [],
      messages: [],
      background: null,
      subBoards: state.sync.subBoards,
      breakoutConfig: state.sync.breakoutConfig,
      roundTemplates: state.sync.roundTemplates,
    };
    // Load the save into a fresh room.
    const { socket: t2 } = await pool.join(srv, { roomId: 'pr-10-copy', userId: 't1', name: 'Teacher' });
    await emitAck(t2, 'teacher:auth', { pin: '1234' });
    const templates = waitForEvent<any>(t2, 'round-templates-sync');
    const res = await emitAck<any>(t2, 'teacher:import-room', snapshot);
    assert.equal(res.ok, true);
    assert.equal((await templates).roundTemplates.r1.fileName, 'keep.png');
    const { socket: kid } = await pool.join(srv, { roomId: 'pr-10-copy', userId: 's1', name: 'Sam' });
    const kidSync = waitForEvent<any>(kid, 'breakout-sync');
    await configure(t2, { action: 'resume', roundId: 'r1' });
    assert.equal((await kidSync).subBoards.r1_ind_s1.background.fileName, 'keep.png');
    void s1;
  });

  it('P11 – prepared rounds survive a flush and a restart', async () => {
    const { teacher } = await setupClass('pr-11');
    await configure(teacher, {
      action: 'new-round',
      prepare: true,
      mode: 'groups',
      groups: groups(2),
      customBackground: worksheet('g.png'),
    });
    await srv.flushRoomsToDiskAsync();
    pool.closeAll();
    await srv.close();
    ({ srv } = await startTestServer(dir));
    const { init } = await pool.join(srv, { roomId: 'pr-11', userId: 't1', name: 'Teacher', teacherPin: '1234' });
    assert.equal(init.isTeacher, true);
    assert.equal(init.roomSettings.breakoutConfig.rounds[0].prepared, true);
    assert.equal(init.roomSettings.breakoutConfig.mode, 'main');
    assert.equal(init.roundTemplates.r1.fileName, 'g.png');
    assert.equal(init.subBoards.r1_grp_2.background.fileName, 'g.png');
  });
});
