import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Socket } from 'socket.io-client';
import { lessonAssetUrls, type LessonPack } from '../src/lib/lessonPack.ts';
import {
  PNG,
  type ServerHandle,
  delay,
  emitAck,
  socketPool,
  startTestServer,
  waitForEvent,
  worksheet,
} from './socketHelpers.ts';

/** A 100×100 worksheet page at (0, 0), so stamp corners are easy to place. */
const board100 = (fileName: string) => ({ ...worksheet(fileName), pages: [{ dataUrl: PNG, width: 100, height: 100 }] });

const nameStamp = (id: string, userId: string, x: number, y: number) => ({
  id,
  boardId: 'main',
  userId,
  userName: userId,
  tool: 'stamp',
  stamp: 'username',
  color: '#000',
  strokeWidth: 3,
  x,
  y,
});

const variants = (extra: Partial<Record<'B' | 'C' | 'D', string>>, more: Record<string, unknown> = {}) => ({
  extra: [
    extra.B ? worksheet(extra.B) : null,
    extra.C ? worksheet(extra.C) : null,
    extra.D ? worksheet(extra.D) : null,
  ],
  rule: 'same',
  ...more,
});

describe('worksheet variants A–D on rounds', () => {
  let srv: ServerHandle;
  let dir: string;
  const extraServers: { srv: ServerHandle; dir: string }[] = [];
  const pool = socketPool();

  beforeEach(async () => {
    ({ srv, dir } = await startTestServer());
  });
  afterEach(async () => {
    pool.closeAll();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const e of extraServers.splice(0)) {
      await e.srv.close();
      fs.rmSync(e.dir, { recursive: true, force: true });
    }
  });

  async function setupClass(roomId: string, server = srv) {
    const { socket: teacher } = await pool.join(server, { roomId, userId: 't1', name: 'Teacher' });
    assert.equal((await emitAck(teacher, 'teacher:auth', { pin: '1234' })).ok, true);
    const { socket: sam } = await pool.join(server, { roomId, userId: 's1', name: 'Sam' });
    const { socket: ada } = await pool.join(server, { roomId, userId: 's2', name: 'Ada' });
    await delay(30);
    return { teacher, sam, ada };
  }

  async function configure(teacher: Socket, payload: any) {
    const sync = waitForEvent<any>(teacher, 'breakout-sync');
    const res = await emitAck<any>(teacher, 'teacher:configure-breakout', payload);
    assert.equal(res.ok, true, res.error);
    return { res, sync: await sync };
  }

  const fileOf = (sync: any, userId: string, round = 'r1') =>
    sync.subBoards[`${round}_ind_${userId}`]?.background?.fileName;

  it('V1 – deal out in turn: launch deals alphabetically, late joiners keep dealing', async () => {
    const { teacher } = await setupClass('v-1');
    const { sync: prepared } = await configure(teacher, {
      action: 'new-round',
      prepare: true,
      mode: 'individual',
      customBackground: worksheet('a.png'),
      variants: variants({ B: 'b.png' }, { rule: 'rotate' }),
    });
    assert.equal(prepared.roundVariants.r1.rule, 'rotate');
    assert.equal(prepared.roundVariants.r1.extra[0].fileName, 'b.png');
    assert.match(prepared.roundVariants.r1.extra[0].pages[0].dataUrl, /^\/api\/assets\//);
    assert.deepEqual(Object.keys(prepared.subBoards), [], 'nobody moved');

    const { sync } = await configure(teacher, { action: 'resume', roundId: 'r1' });
    assert.equal(fileOf(sync, 's2'), 'a.png', 'Ada is first alphabetically');
    assert.equal(fileOf(sync, 's1'), 'b.png');
    assert.deepEqual(sync.roundVariants.r1.assigned, { s2: 0, s1: 1 });

    const late = waitForEvent<any>(teacher, 'breakout-sync');
    await pool.join(srv, { roomId: 'v-1', userId: 's3', name: 'Zed' });
    assert.equal(fileOf(await late, 's3'), 'a.png', 'third student: back to A');
  });

  it('V2 – by name-stamp corner, read at launch; late joiners by the same rule or always A', async () => {
    const { teacher, sam, ada } = await setupClass('v-2');
    teacher.emit('teacher:set-background', { background: board100('corners.png') });
    await delay(30);
    sam.emit('element-start', nameStamp('st1', 's1', 10, 10)); // top-left
    ada.emit('element-start', nameStamp('st2', 's2', 90, 90)); // bottom-right
    await delay(50);
    await configure(teacher, {
      action: 'new-round',
      prepare: true,
      mode: 'individual',
      customBackground: worksheet('a.png'),
      variants: variants(
        { B: 'b.png', D: 'd.png' },
        { rule: 'corner', cornerMap: { tl: 0, tr: 1, bl: 2, br: 3, none: 1 } }
      ),
    });
    const { sync } = await configure(teacher, { action: 'resume', roundId: 'r1' });
    assert.equal(fileOf(sync, 's1'), 'a.png');
    assert.equal(fileOf(sync, 's2'), 'd.png');

    // A late joiner with no stamp gets the "no stamp" letter (B).
    let late = waitForEvent<any>(teacher, 'breakout-sync');
    await pool.join(srv, { roomId: 'v-2', userId: 's3', name: 'Zed' });
    assert.equal(fileOf(await late, 's3'), 'b.png');

    // "Late joiners always get A" overrides the rule for anyone after launch.
    const res = await emitAck<any>(teacher, 'teacher:set-round-variants', {
      roundId: 'r1',
      variants: { ...sync.roundVariants.r1, lateJoiners: 'a' },
    });
    assert.equal(res.ok, true, res.error);
    late = waitForEvent<any>(teacher, 'breakout-sync');
    await pool.join(srv, { roomId: 'v-2', userId: 's4', name: 'Yan' });
    assert.equal(fileOf(await late, 's4'), 'a.png');
  });

  it('V3 – a per-student pick by name wins over the rule, and edit-prepared keeps picks', async () => {
    const { teacher } = await setupClass('v-3');
    await configure(teacher, {
      action: 'new-round',
      prepare: true,
      mode: 'individual',
      customBackground: worksheet('a.png'),
      variants: variants({ C: 'c.png' }, { overrides: { ' SAM ': 2 } }),
    });
    // The prepared-round form sends no overrides: the round keeps the pick.
    const { sync: edited } = await configure(teacher, {
      action: 'edit-prepared',
      roundId: 'r1',
      variants: variants({ C: 'c.png' }),
    });
    assert.deepEqual(edited.roundVariants.r1.overrides, { sam: 2 });
    const { sync } = await configure(teacher, { action: 'resume', roundId: 'r1' });
    assert.equal(fileOf(sync, 's1'), 'c.png');
    assert.equal(fileOf(sync, 's2'), 'a.png');
  });

  it('V4 – clearing variants, group rounds and students', async () => {
    const { teacher, sam } = await setupClass('v-4');
    await configure(teacher, {
      action: 'new-round',
      prepare: true,
      mode: 'individual',
      variants: variants({ B: 'b.png' }, { rule: 'rotate' }),
    });
    const { sync } = await configure(teacher, { action: 'edit-prepared', roundId: 'r1', variants: null });
    assert.equal(sync.roundVariants.r1, undefined);

    const { sync: grp } = await configure(teacher, {
      action: 'new-round',
      prepare: true,
      mode: 'groups',
      groups: [{ id: 'g', title: 'G', assignedUserIds: [] }],
      variants: variants({ B: 'b.png' }),
    });
    assert.equal(grp.roundVariants.r2, undefined, 'group rounds take no variants');
    assert.equal(
      (await emitAck<any>(teacher, 'teacher:set-round-variants', { roundId: 'r2', variants: variants({ B: 'b.png' }) }))
        .ok,
      false
    );
    assert.equal(
      (await emitAck<any>(sam, 'teacher:set-round-variants', { roundId: 'r1', variants: variants({ B: 'b.png' }) })).ok,
      false
    );
    const studentSync = waitForEvent<any>(sam, 'breakout-sync');
    await configure(teacher, { action: 'resume', roundId: 'r1' });
    assert.equal((await studentSync).roundVariants, undefined, 'students never see variants');
  });

  it('V5 – variants survive a restart and a room save round trip', async () => {
    const { teacher } = await setupClass('v-5');
    await configure(teacher, {
      action: 'new-round',
      prepare: true,
      mode: 'individual',
      customBackground: worksheet('a.png'),
      variants: variants({ B: 'b.png' }, { rule: 'rotate' }),
    });
    await srv.flushRoomsToDiskAsync();
    pool.closeAll();
    await srv.close();
    ({ srv } = await startTestServer(dir));
    const { socket: t2, init } = await pool.join(srv, {
      roomId: 'v-5',
      userId: 't1',
      name: 'Teacher',
      teacherPin: '1234',
    });
    assert.equal(init.roundVariants.r1.extra[0].fileName, 'b.png');
    assert.equal(init.roundVariants.r1.rule, 'rotate');

    // Room save (Save class work → Open class work) into another room keeps them.
    const { socket: t3 } = await pool.join(srv, { roomId: 'v-5-copy', userId: 't1', name: 'Teacher' });
    assert.equal((await emitAck(t3, 'teacher:auth', { pin: '1234' })).ok, true);
    const templates = waitForEvent<any>(t3, 'round-templates-sync');
    const res = await emitAck<any>(t3, 'teacher:import-room', {
      elements: [],
      messages: [],
      subBoards: init.subBoards,
      breakoutConfig: init.roomSettings.breakoutConfig,
      roundTemplates: init.roundTemplates,
      roundVariants: init.roundVariants,
      mode: 'replace',
    });
    assert.equal(res.ok, true, res.error);
    assert.equal((await templates).roundVariants.r1.extra[0].fileName, 'b.png');
    void t2;
  });

  it('V6 – lesson packs carry variants; per-student picks only when asked; never who got which', async () => {
    const { teacher } = await setupClass('v-6');
    await configure(teacher, {
      action: 'new-round',
      prepare: true,
      mode: 'individual',
      customBackground: worksheet('a.png'),
      variants: variants(
        { B: 'b.png', C: 'c.png' },
        { rule: 'corner', cornerMap: { tl: 2, tr: 1, bl: 0, br: 0, none: 2 }, lateJoiners: 'a', overrides: { sam: 1 } }
      ),
    });
    let res = await emitAck<any>(teacher, 'teacher:export-lesson', {});
    let lesson: LessonPack = res.lesson;
    assert.equal(JSON.stringify(lesson).includes('sam'), false, 'no student names by default');
    assert.deepEqual(lesson.rounds[0].variants?.overrides, {});
    res = await emitAck<any>(teacher, 'teacher:export-lesson', { includeStudentPicks: true });
    lesson = res.lesson;
    assert.deepEqual(lesson.rounds[0].variants?.overrides, { sam: 1 });
    assert.equal('assigned' in (lesson.rounds[0].variants as object), false);

    // Load on a second server, as another teacher's computer would.
    const assets: Record<string, string> = {};
    for (const u of lessonAssetUrls(lesson)) {
      const r = await fetch(`http://127.0.0.1:${srv.port}${u}`);
      assets[u] = `data:image/png;base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
    }
    const other = await startTestServer();
    extraServers.push(other);
    const { teacher: t2 } = await setupClass('v-6-src', other.srv);
    const has = await emitAck<any>(t2, 'teacher:has-assets', { urls: Object.keys(assets) });
    for (const u of has.missing)
      assert.equal((await emitAck<any>(t2, 'teacher:upload-asset', { dataUrl: assets[u] })).ok, true);
    res = await emitAck<any>(t2, 'teacher:load-lesson', { lesson, target: 'new', newRoomId: 'v-6-new', pin: '5678' });
    assert.equal(res.ok, true, res.error);
    const { init } = await pool.join(other.srv, {
      roomId: 'v-6-new',
      userId: 't1',
      name: 'Teacher',
      teacherPin: '5678',
    });
    const v = init.roundVariants.r1;
    assert.deepEqual(
      v.extra.map((bg: any) => bg?.fileName ?? null),
      ['b.png', 'c.png', null]
    );
    assert.equal(v.rule, 'corner');
    assert.deepEqual(v.cornerMap, { tl: 2, tr: 1, bl: 0, br: 0, none: 2 });
    assert.equal(v.lateJoiners, 'a');
    assert.deepEqual(v.overrides, { sam: 1 });
    assert.deepEqual(v.assigned, {});
    assert.equal(init.roundTemplates.r1.fileName, 'a.png');

    // A pack with a missing variant image is refused.
    const broken = structuredClone(lesson);
    broken.rounds[0].variants!.extra[1]!.pages[0].dataUrl = `/api/assets/${'2'.repeat(64)}`;
    res = await emitAck<any>(t2, 'teacher:load-lesson', {
      lesson: broken,
      target: 'new',
      newRoomId: 'v-6-bad',
      pin: '5678',
    });
    assert.match(res.error, /missing/);
  });
});
