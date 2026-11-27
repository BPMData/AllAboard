import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Socket } from 'socket.io-client';
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
import { lessonAssetUrls, type LessonPack } from '../src/lib/lessonPack.ts';

const STUDENT_IDS = ['zz-student-uid-1', 'zz-student-uid-2'];
const STUDENT_NAMES = ['Zebulon', 'Quintessa'];
const JPEG_AS_PNG = `data:image/png;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64')}`;

const stroke = (id: string, userId: string, boardId = 'main', extra: Record<string, unknown> = {}) => ({
  id,
  boardId,
  userId,
  userName: userId,
  tool: 'solid',
  color: '#000',
  strokeWidth: 3,
  points: [0, 0, 1, 1],
  ...extra,
});

describe('lesson packs (server)', () => {
  let srv: ServerHandle;
  let dir: string;
  const extra: { srv: ServerHandle; dir: string }[] = [];
  const pool = socketPool();

  beforeEach(async () => {
    ({ srv, dir } = await startTestServer());
  });
  afterEach(async () => {
    pool.closeAll();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const e of extra.splice(0)) {
      await e.srv.close();
      fs.rmSync(e.dir, { recursive: true, force: true });
    }
  });

  async function teacherIn(server: ServerHandle, roomId: string, pin = '1234', userId = 't1') {
    const { socket } = await pool.join(server, { roomId, userId, name: 'Ms Teacher' });
    assert.equal((await emitAck(socket, 'teacher:auth', { pin })).ok, true);
    return socket;
  }

  /** A room with a worksheet, teacher and student ink, chat, a launched group round and a prepared round. */
  async function busyRoom(roomId: string) {
    const teacher = await teacherIn(srv, roomId);
    const students: Socket[] = [];
    for (let i = 0; i < 2; i++) {
      const { socket } = await pool.join(srv, { roomId, userId: STUDENT_IDS[i], name: STUDENT_NAMES[i] });
      students.push(socket);
    }
    await delay(30);
    teacher.emit('teacher:set-background', { background: worksheet('main.png') });
    teacher.emit('element-start', stroke('t-ink', 't1'));
    students[0].emit('element-start', stroke('s-ink', STUDENT_IDS[0]));
    students[0].emit(
      'element-start',
      stroke('s-stamp', STUDENT_IDS[0], 'main', { tool: 'stamp', stamp: 'username', points: undefined, x: 1, y: 1 })
    );
    students[1].emit('chat-message', { text: 'secret from Quintessa', boardId: 'main' });
    await delay(50);
    let res = await emitAck<any>(teacher, 'teacher:configure-breakout', {
      action: 'new-round',
      mode: 'groups',
      groups: [
        { id: 'g1', title: 'Pros', assignedUserIds: [STUDENT_IDS[0]] },
        { id: 'g2', title: 'Cons', assignedUserIds: [STUDENT_IDS[1]] },
      ],
      customBackground: worksheet('debate.png'),
    });
    assert.equal(res.ok, true);
    students[0].emit('element-start', stroke('grp-ink', STUDENT_IDS[0], 'r1_grp_1'));
    students[0].emit('chat-message', { text: 'group chat from Zebulon', boardId: 'r1_grp_1' });
    await delay(50);
    res = await emitAck<any>(teacher, 'teacher:configure-breakout', { action: 'return-to-main' });
    assert.equal(res.ok, true);
    res = await emitAck<any>(teacher, 'teacher:configure-breakout', {
      action: 'new-round',
      prepare: true,
      mode: 'individual',
      title: 'Exit ticket',
      customBackground: worksheet('exit.png'),
    });
    assert.equal(res.ok, true);
    return { teacher, students };
  }

  async function exportLesson(teacher: Socket, opts: any = {}): Promise<LessonPack> {
    const res = await emitAck<any>(teacher, 'teacher:export-lesson', opts);
    assert.equal(res.ok, true, res.error);
    return res.lesson;
  }

  async function embed(server: ServerHandle, lesson: LessonPack): Promise<LessonPack> {
    const assets: Record<string, string> = {};
    for (const u of lessonAssetUrls(lesson)) {
      const r = await fetch(`http://127.0.0.1:${server.port}${u}`);
      assert.equal(r.ok, true);
      const type = r.headers.get('content-type') || 'image/png';
      assets[u] = `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
    }
    return { ...lesson, assets };
  }

  it('1 – export-lesson contains no student ids, names or chat', async () => {
    const { teacher } = await busyRoom('lp-1');
    const lesson = await exportLesson(teacher);
    const text = JSON.stringify(lesson);
    for (const bad of [...STUDENT_IDS, ...STUDENT_NAMES, 'secret', 'group chat']) {
      assert.equal(text.includes(bad), false, `export must not contain "${bad}"`);
    }
    assert.equal(lesson.main.background?.fileName, 'main.png');
    assert.equal(lesson.main.elements.length, 1, 'teacher ink only');
    assert.equal(lesson.rounds.length, 2);
    assert.deepEqual(lesson.rounds[0].groups, [{ title: 'Pros' }, { title: 'Cons' }]);
    assert.equal(lesson.rounds[0].worksheet?.fileName, 'debate.png');
    assert.equal(lesson.rounds[1].title, 'Exit ticket');
    const res = await emitAck<any>(teacher, 'teacher:export-lesson', { mainInk: 'all' });
    assert.equal(res.lesson.main.elements.length, 2, 'all ink except the name stamp');
    assert.deepEqual(res.inkCounts, { teacher: 1, all: 2 });
  });

  it('2 – has-assets and upload-asset accept real images and refuse the rest', async () => {
    const teacher = await teacherIn(srv, 'lp-2');
    const up = await emitAck<any>(teacher, 'teacher:upload-asset', { dataUrl: PNG });
    assert.equal(up.ok, true);
    assert.match(up.url, /^\/api\/assets\/[a-f0-9]{64}$/);
    const fake = `/api/assets/${'0'.repeat(64)}`;
    const has = await emitAck<any>(teacher, 'teacher:has-assets', {
      urls: [up.url, fake, 'https://evil.example/x.png'],
    });
    assert.deepEqual(has.missing, [fake, 'https://evil.example/x.png']);
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg></svg>').toString('base64')}`;
    const html = `data:text/html;base64,${Buffer.from('<b>x</b>').toString('base64')}`;
    for (const dataUrl of [svg, html, JPEG_AS_PNG, 'data:image/png;base64,']) {
      assert.equal((await emitAck<any>(teacher, 'teacher:upload-asset', { dataUrl })).ok, false, dataUrl.slice(0, 30));
    }
    assert.equal((await emitAck<any>(teacher, 'teacher:has-assets', { urls: Array(1001).fill(fake) })).ok, false);
  });

  it('3/4 – load into a new room: PIN, prepared rounds, loader-owned ink; students wait for launch', async () => {
    const { teacher } = await busyRoom('lp-3');
    const lesson = await exportLesson(teacher);
    const res = await emitAck<any>(teacher, 'teacher:load-lesson', {
      lesson,
      target: 'new',
      newRoomId: 'lp-3-new',
      pin: '5678',
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.roomId, 'lp-3-new');
    assert.equal(res.rounds, 2);

    const { socket: t2, init } = await pool.join(srv, {
      roomId: 'lp-3-new',
      userId: 't1',
      name: 'Ms Teacher',
      teacherPin: '5678',
    });
    assert.equal((await emitAck<any>(t2, 'teacher:auth', { pin: '5678' })).ok, true);
    const cfg = init.roomSettings?.breakoutConfig ?? init.breakoutConfig;
    assert.equal(cfg.mode, 'main');
    assert.deepEqual(
      cfg.rounds.map((r: any) => [r.id, r.prepared, r.title]),
      [
        ['r1', true, 'Round 1 · Groups'],
        ['r2', true, 'Round 2 · Individual · Exit ticket'],
      ]
    );
    assert.equal(init.background.fileName, 'main.png');
    assert.equal(init.elements.length, 1);
    assert.equal(init.elements[0].userId, 't1');
    assert.notEqual(init.elements[0].id, 't-ink');
    assert.deepEqual(Object.keys(init.subBoards).sort(), ['r1_grp_1', 'r1_grp_2']);
    assert.deepEqual(init.subBoards.r1_grp_1.assignedUserIds, []);
    assert.equal(init.subBoards.r1_grp_1.elements.length, 0, 'launched-round student ink is not carried');

    // A student who joins stays on main, then gets round 2's worksheet when it's launched.
    const { socket: kid, init: kidInit } = await pool.join(srv, { roomId: 'lp-3-new', userId: 'kid', name: 'Kid' });
    assert.equal((kidInit.roomSettings?.breakoutConfig ?? kidInit.breakoutConfig).mode, 'main');
    const kidSync = waitForEvent<any>(kid, 'breakout-sync');
    const launch = await emitAck<any>(t2, 'teacher:configure-breakout', { action: 'resume', roundId: 'r2' });
    assert.equal(launch.ok, true, launch.error);
    const sync = await kidSync;
    assert.equal(sync.breakoutConfig.mode, 'individual');
    assert.equal(sync.subBoards.r2_ind_kid.background.fileName, 'exit.png');
  });

  it('5 – a missing image, a taken room code or a short PIN fails and makes no room', async () => {
    const { teacher } = await busyRoom('lp-5');
    const lesson = await exportLesson(teacher);
    const broken = structuredClone(lesson);
    broken.rounds[1].worksheet!.pages[0].dataUrl = `/api/assets/${'1'.repeat(64)}`;
    let res = await emitAck<any>(teacher, 'teacher:load-lesson', {
      lesson: broken,
      target: 'new',
      newRoomId: 'lp-5-a',
      pin: '5678',
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /1 worksheet image is missing/);
    assert.equal((await emitAck<any>(teacher, 'check-room', { roomId: 'lp-5-a' })).exists, false);

    res = await emitAck<any>(teacher, 'teacher:load-lesson', { lesson, target: 'new', newRoomId: 'lp-5', pin: '5678' });
    assert.match(res.error, /taken/);
    res = await emitAck<any>(teacher, 'teacher:load-lesson', { lesson, target: 'new', newRoomId: 'lp-5-b', pin: '12' });
    assert.equal(res.ok, false);
    assert.equal((await emitAck<any>(teacher, 'check-room', { roomId: 'lp-5-b' })).exists, false);
  });

  it('6 – load into this room: refused while a round is live; from main keeps launched rounds', async () => {
    const { teacher, students } = await busyRoom('lp-6');
    const lesson = await exportLesson(teacher, { roundIds: ['r2'] });
    await emitAck(teacher, 'teacher:configure-breakout', { action: 'resume', roundId: 'r1' });
    let res = await emitAck<any>(teacher, 'teacher:load-lesson', { lesson, target: 'current' });
    assert.match(res.error, /Bring everyone to Main/);

    await emitAck(teacher, 'teacher:configure-breakout', { action: 'return-to-main' });
    const studentSync = waitForEvent<any>(students[0], 'state-sync');
    const teacherBreakout = waitForEvent<any>(teacher, 'breakout-sync');
    res = await emitAck<any>(teacher, 'teacher:load-lesson', { lesson, target: 'current' });
    assert.equal(res.ok, true, res.error);
    const main = await studentSync;
    assert.equal(main.boardId, 'main');
    assert.equal(main.elements.length, 1, "main ink replaced by the lesson's");
    const sync = await teacherBreakout;
    assert.equal(sync.breakoutConfig.mode, 'main');
    const rounds = sync.breakoutConfig.rounds.map((r: any) => [r.id, Boolean(r.prepared)]);
    // r1 (launched) stays with its student ink; the old prepared r2 is replaced by the lesson's copy.
    assert.deepEqual(rounds, [
      ['r1', false],
      ['r2', true],
    ]);
    assert.equal(sync.subBoards.r1_grp_1.elements.length, 1);
    assert.equal(sync.roundTemplates.r2.fileName, 'exit.png');
  });

  it('7 – students get ok:false from all four events', async () => {
    const { students } = await busyRoom('lp-7');
    const kid = students[0];
    for (const [event, payload] of [
      ['teacher:export-lesson', {}],
      ['teacher:has-assets', { urls: [] }],
      ['teacher:upload-asset', { dataUrl: PNG }],
      ['teacher:load-lesson', { lesson: {}, target: 'new', newRoomId: 'x', pin: '1234' }],
    ] as const) {
      assert.equal((await emitAck<any>(kid, event, payload)).ok, false, event);
    }
  });

  it('8 – round trip to a second server with an empty asset store', async () => {
    const { teacher } = await busyRoom('lp-8');
    const packed = await embed(srv, await exportLesson(teacher));
    const other = await startTestServer();
    extra.push(other);
    const t2 = await teacherIn(other.srv, 'lp-8-home', '9999');

    const urls = lessonAssetUrls(packed);
    const has = await emitAck<any>(t2, 'teacher:has-assets', { urls });
    assert.equal(has.missing.length, urls.length);
    for (const u of has.missing) {
      const up = await emitAck<any>(t2, 'teacher:upload-asset', { dataUrl: packed.assets[u] });
      assert.equal(up.ok, true, up.error);
      assert.equal(up.url, u, 'content-addressed: same bytes, same URL');
    }
    const { assets: _assets, ...lesson } = packed;
    const res = await emitAck<any>(t2, 'teacher:load-lesson', {
      lesson,
      target: 'new',
      newRoomId: 'lp-8-copy',
      pin: '5678',
    });
    assert.equal(res.ok, true, res.error);

    const { socket: t3 } = await pool.join(other.srv, { roomId: 'lp-8-copy', userId: 'x', name: 'Co-teacher' });
    assert.equal((await emitAck<any>(t3, 'teacher:auth', { pin: '5678' })).ok, true);
    const again = await exportLesson(t3);
    assert.deepEqual(
      again.rounds.map((r) => [r.mode, r.title, r.worksheet?.fileName, r.groups]),
      packed.rounds.map((r) => [r.mode, r.title, r.worksheet?.fileName, r.groups])
    );
    assert.equal(again.main.background?.pages[0].dataUrl, packed.main.background?.pages[0].dataUrl);
  });

  it('9 – oversized or malformed ink is refused', async () => {
    const teacher = await teacherIn(srv, 'lp-9');
    const lesson = await exportLesson(teacher);
    const cases = [
      { ...lesson, main: { background: null, elements: [{ ...stroke('a', 'x'), text: 'x'.repeat(20_001) }] } },
      { ...lesson, main: { background: null, elements: [{ ...stroke('a', 'x'), points: [0, 'NaN'] }] } },
      { ...lesson, main: { background: null, elements: 'nope' } },
      { ...lesson, rounds: [{ key: 'a', mode: 'groups', title: '', worksheet: null, groups: [] }] },
    ];
    for (const bad of cases) {
      const res = await emitAck<any>(teacher, 'teacher:load-lesson', { lesson: bad, target: 'current' });
      assert.equal(res.ok, false);
    }
    const ok = await emitAck<any>(teacher, 'teacher:load-lesson', { lesson, target: 'current' });
    assert.equal(ok.ok, true, ok.error);
  });
});
