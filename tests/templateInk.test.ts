// Template ink (PLANS_LESSON_PACKS.md, phase 3): a round copies the teacher's Main ink onto every one of its boards.
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

describe('template ink on round worksheets', () => {
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

  const stroke = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    boardId: 'main',
    tool: 'solid',
    color: '#000',
    strokeWidth: 4,
    points: [0, 0, 5, 5],
    timestamp: Date.now(),
    ...extra,
  });

  /** A teacher with a Main worksheet, two teacher strokes and a name stamp; a student with a stroke of their own. */
  async function setupClass(roomId: string) {
    const { socket: teacher } = await pool.join(srv, { roomId, userId: 't1', name: 'Ms T' });
    assert.equal((await emitAck(teacher, 'teacher:auth', { pin: '1234' })).ok, true);
    const { socket: s1 } = await pool.join(srv, { roomId, userId: 's1', name: 'Sam' });
    await delay(30);
    teacher.emit('teacher:set-background', { background: worksheet('main.png') });
    teacher.emit('element-start', stroke('t-a'));
    teacher.emit('element-start', stroke('t-b', { points: [10, 10, 20, 20] }));
    teacher.emit('element-start', {
      ...stroke('t-stamp'),
      tool: 'stamp',
      stamp: 'username',
      points: undefined,
      x: 1,
      y: 1,
    });
    s1.emit('element-start', stroke('kid'));
    await delay(80);
    return { teacher, s1 };
  }

  async function configure(teacher: Socket, payload: any) {
    const sync = waitForEvent<any>(teacher, 'breakout-sync');
    const res = await emitAck<any>(teacher, 'teacher:configure-breakout', payload);
    return { res, sync: res.ok ? await sync : null };
  }

  const groups = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `d-${i}`, title: `Team ${i + 1}` }));
  const ids = (els: any[]) => els.map((e) => e.id);

  it('T1 – an individual round copies the teacher ink (no stamps, no student ink) onto every board, late joiners too', async () => {
    const { teacher } = await setupClass('ti-1');
    const { sync: prepared } = await configure(teacher, {
      action: 'new-round',
      prepare: true,
      mode: 'individual',
      copyWorksheet: true,
      copyInk: true,
    });
    assert.equal(prepared.roundTemplateInk.r1.length, 2, 'teachers see the template ink');
    const { sync } = await configure(teacher, { action: 'resume', roundId: 'r1' });
    const board = sync.subBoards.r1_ind_s1;
    assert.equal(board.background.fileName, 'main.png');
    assert.equal(board.elements.length, 2);
    for (const el of board.elements) {
      assert.equal(el.userId, 't1', 'the teacher stays the author');
      assert.equal(el.boardId, 'r1_ind_s1');
      assert.ok(!['t-a', 't-b'].includes(el.id), 'every copy gets a new id');
    }

    const late = waitForEvent<any>(teacher, 'breakout-sync');
    await pool.join(srv, { roomId: 'ti-1', userId: 's2', name: 'Ada' });
    const lateBoard = (await late).subBoards.r1_ind_s2;
    assert.equal(lateBoard.elements.length, 2);
    assert.equal(new Set([...ids(board.elements), ...ids(lateBoard.elements)]).size, 4, 'ids differ across boards');
  });

  it("T2 – a student can't erase the template ink on their board", async () => {
    const { teacher, s1 } = await setupClass('ti-2');
    const { sync } = await configure(teacher, {
      action: 'new-round',
      mode: 'individual',
      copyWorksheet: true,
      copyInk: true,
    });
    const [first, second] = sync.subBoards.r1_ind_s1.elements;
    await delay(50);
    s1.emit('element-remove', { id: first.id, boardId: 'r1_ind_s1' });
    s1.emit('elements-batch-remove', { boardId: 'r1_ind_s1', ids: [second.id] });
    s1.emit('element-update', { id: first.id, boardId: 'r1_ind_s1', points: [0, 0, 99, 99] });
    await delay(80);
    const { sync: after } = await configure(teacher, { action: 'update-current', roundId: 'r1' });
    const els = after.subBoards.r1_ind_s1.elements;
    assert.deepEqual(ids(els), [first.id, second.id]);
    assert.deepEqual(els[0].points, first.points);
  });

  it('T3 – a prepared group round gets the ink at launch; a launched one at once; copyInk needs copyWorksheet', async () => {
    const { teacher } = await setupClass('ti-3');
    const { sync: prepared } = await configure(teacher, {
      action: 'new-round',
      prepare: true,
      mode: 'groups',
      groups: groups(2),
      copyWorksheet: true,
      copyInk: true,
    });
    assert.equal(prepared.subBoards.r1_grp_1.elements.length, 0, 'not on the boards before launch');
    const { sync: launched } = await configure(teacher, { action: 'resume', roundId: 'r1', groups: groups(2) });
    assert.equal(launched.subBoards.r1_grp_1.elements.length, 2);
    assert.equal(launched.subBoards.r1_grp_2.elements.length, 2);

    await configure(teacher, { action: 'return-to-main' });
    const { sync: direct } = await configure(teacher, {
      action: 'new-round',
      mode: 'groups',
      groups: groups(1),
      copyWorksheet: true,
      copyInk: true,
    });
    assert.equal(direct.subBoards.r2_grp_1.elements.length, 2);

    await configure(teacher, { action: 'return-to-main' });
    const { sync: noWorksheet } = await configure(teacher, {
      action: 'new-round',
      mode: 'individual',
      customBackground: worksheet('other.png'),
      copyInk: true,
    });
    assert.equal(noWorksheet.subBoards.r3_ind_s1.elements.length, 0);
    assert.equal(noWorksheet.roundTemplateInk.r3, undefined);
  });

  it('T4 – edit-prepared replaces or clears the ink with the worksheet; delete-prepared removes it', async () => {
    const { teacher } = await setupClass('ti-4');
    await configure(teacher, {
      action: 'new-round',
      prepare: true,
      mode: 'individual',
      copyWorksheet: true,
      copyInk: true,
    });
    const { sync: untouched } = await configure(teacher, { action: 'edit-prepared', roundId: 'r1', title: 'Exit' });
    assert.equal(untouched.roundTemplateInk.r1.length, 2, 'a title change keeps the ink');
    const { sync: cleared } = await configure(teacher, {
      action: 'edit-prepared',
      roundId: 'r1',
      customBackground: worksheet('new.png'),
    });
    assert.equal(cleared.roundTemplateInk.r1, undefined);
    await configure(teacher, { action: 'edit-prepared', roundId: 'r1', copyWorksheet: true, copyInk: true });
    const { sync: deleted } = await configure(teacher, { action: 'delete-prepared', roundId: 'r1' });
    assert.equal(deleted.roundTemplateInk.r1, undefined);
  });

  it('T5 – a lesson pack keeps the ink, and the loader becomes its author', async () => {
    const { teacher } = await setupClass('ti-5');
    await configure(teacher, {
      action: 'new-round',
      prepare: true,
      mode: 'individual',
      copyWorksheet: true,
      copyInk: true,
    });
    const exported = await emitAck<any>(teacher, 'teacher:export-lesson', { title: 'Ink' });
    assert.equal(exported.ok, true);
    const lesson = exported.lesson;
    assert.equal(lesson.rounds[0].ink.length, 2);
    assert.ok(lesson.rounds[0].ink.every((el: any) => el.userId === 'lesson' && el.boardId === undefined));
    assert.equal(JSON.stringify(lesson).includes('s1'), false);

    const { socket: other } = await pool.join(srv, { roomId: 'ti-5-src', userId: 't9', name: 'Mr K' });
    await emitAck(other, 'teacher:auth', { pin: '5678' });
    const loaded = await emitAck<any>(other, 'teacher:load-lesson', {
      lesson,
      target: 'new',
      newRoomId: 'ti-5-copy',
      pin: '5678',
    });
    assert.equal(loaded.ok, true);
    const { socket: t2, init } = await pool.join(srv, {
      roomId: 'ti-5-copy',
      userId: 't9',
      name: 'Mr K',
      teacherPin: '5678',
    });
    assert.equal(init.roundTemplateInk.r1.length, 2);
    assert.ok(init.roundTemplateInk.r1.every((el: any) => el.userId === 't9'));
    await pool.join(srv, { roomId: 'ti-5-copy', userId: 'kid', name: 'Kid' });
    await delay(30);
    const { sync } = await configure(t2, { action: 'resume', roundId: 'r1' });
    assert.equal(sync.subBoards.r1_ind_kid.elements.length, 2);
  });

  it('T6 – a room save keeps the ink, and it survives a restart', async () => {
    const { teacher } = await setupClass('ti-6');
    const { sync } = await configure(teacher, {
      action: 'new-round',
      prepare: true,
      mode: 'individual',
      copyWorksheet: true,
      copyInk: true,
    });
    const { socket: t2 } = await pool.join(srv, { roomId: 'ti-6-copy', userId: 't1', name: 'Ms T' });
    await emitAck(t2, 'teacher:auth', { pin: '1234' });
    const templates = waitForEvent<any>(t2, 'round-templates-sync');
    const res = await emitAck<any>(t2, 'teacher:import-room', {
      mode: 'replace',
      elements: [],
      messages: [],
      background: null,
      subBoards: sync.subBoards,
      breakoutConfig: sync.breakoutConfig,
      roundTemplates: sync.roundTemplates,
      roundTemplateInk: { ...sync.roundTemplateInk, r99: sync.roundTemplateInk.r1 },
    });
    assert.equal(res.ok, true);
    const imported = (await templates).roundTemplateInk;
    assert.deepEqual(Object.keys(imported), ['r1'], 'only rounds the save has');
    assert.equal(imported.r1.length, 2);

    await srv.flushRoomsToDiskAsync();
    pool.closeAll();
    await srv.close();
    ({ srv } = await startTestServer(dir));
    const { init } = await pool.join(srv, { roomId: 'ti-6', userId: 't1', name: 'Ms T', teacherPin: '1234' });
    assert.equal(init.roundTemplateInk.r1.length, 2);
  });
});
