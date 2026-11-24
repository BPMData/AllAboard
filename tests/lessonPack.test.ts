import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LESSON_KIND,
  LESSON_MAX_ELEMENTS,
  LESSON_VERSION,
  buildLessonPack,
  filterMainInk,
  lessonAssetUrls,
  lessonFileName,
  parseLessonText,
  rewriteAssetUrls,
  roundNameFromTitle,
  validateLesson,
  type LessonBuildInput,
} from '../src/lib/lessonPack.ts';
import { MAX_BOARD_ELEMENTS } from '../socketGuards.ts';
import type { BreakoutRoundMeta, CanvasElement, RoomBackground } from '../src/types.ts';

const H = (c: string) => c.repeat(64);
const url = (c: string) => `/api/assets/${H(c)}`;
const bg = (fileName: string, ...urls: string[]): RoomBackground => ({
  id: `bg-${fileName}`,
  fileName,
  pages: urls.map((u) => ({ dataUrl: u, width: 10, height: 10 })),
  x: 0,
  y: 0,
  scale: 1,
  layout: 'stack',
  opacity: 1,
});
const el = (id: string, userId: string, extra: Partial<CanvasElement> = {}): CanvasElement => ({
  id,
  boardId: 'main',
  userId,
  userName: `${userId}-name`,
  tool: 'solid',
  color: '#000',
  strokeWidth: 2,
  points: [0, 0, 1, 1],
  ...extra,
});
const nameStamp = (id: string, userId: string) => el(id, userId, { tool: 'stamp', stamp: 'username', points: undefined });

function input(over: Partial<LessonBuildInput> = {}): LessonBuildInput {
  const rounds: BreakoutRoundMeta[] = [
    { id: 'r1', number: 1, title: 'Round 1 · Groups · Debate', mode: 'groups', createdAt: 1, launchedAt: 2 },
    {
      id: 'r2',
      number: 2,
      title: 'Round 2 · Individual · Exit ticket',
      mode: 'individual',
      createdAt: 3,
      prepared: true,
      allowSelfSelect: true,
      chatScope: 'board',
    },
    { id: 'r3', number: 3, title: 'Round 3 · Groups', mode: 'groups', createdAt: 4, prepared: true },
  ];
  return {
    title: 'Photosynthesis',
    exportedBy: 'Ms T',
    exportedAt: 100,
    mainBackground: bg('main.pdf', url('a'), url('b')),
    mainElements: [el('t-ink', 'teacher'), el('s-ink', 'student-1'), nameStamp('s-stamp', 'student-1'), nameStamp('t-stamp', 'teacher')],
    teacherUserIds: new Set(['teacher']),
    mainInk: 'teacher',
    rounds,
    roundTemplates: { r1: bg('debate.png', url('c')), r2: bg('exit.png', url('d')), r3: null },
    boards: [
      { id: 'r1_grp_2', roundId: 'r1', kind: 'group', title: 'Cons', elements: [el('kid', 'student-2')] },
      { id: 'r1_grp_1', roundId: 'r1', kind: 'group', title: 'Pros', elements: [] },
      { id: 'r1_ind_student-1', roundId: 'r1', kind: 'individual', title: "Sam's Board", elements: [] },
      { id: 'r3_grp_1', roundId: 'r3', kind: 'group', title: 'Team A', elements: [el('prep', 'teacher')] },
    ],
    settings: {
      oneNameStamp: true,
      hideStudentCursors: false,
      allowSelfSelect: false,
      chatScope: 'unified',
      autoIndividual: true,
      autoIndividualBackground: bg('frayer.png', url('e'), url('a')),
      autoIndividualTemplateLabel: 'Frayer',
      timerDurationMs: 120_000,
      timerAutoLock: true,
    },
    ...over,
  };
}

describe('lesson packs (pure)', () => {
  it('element cap matches the server', () => {
    assert.equal(LESSON_MAX_ELEMENTS, MAX_BOARD_ELEMENTS);
  });

  it('1 – keeps the lesson and drops every kind of student data', () => {
    const pack = buildLessonPack(input());
    assert.equal(pack.kind, LESSON_KIND);
    assert.equal(pack.version, LESSON_VERSION);
    assert.equal(pack.title, 'Photosynthesis');
    assert.equal(pack.main.background?.fileName, 'main.pdf');
    assert.deepEqual(pack.assets, {});
    const text = JSON.stringify(pack);
    for (const bad of ['student-1', 'student-2', 'student-1-name', "Sam's Board", 'activeRoundId', 'assignedUserIds', 'mode":"main']) {
      assert.equal(text.includes(bad), false, `pack must not contain ${bad}`);
    }
    // Element authorship is a placeholder; the loader becomes the author.
    assert.ok(pack.main.elements.every((e) => e.userId === 'lesson' && e.userName === '' && e.boardId === undefined));
    assert.deepEqual(pack.rounds.map((r) => r.title), ['Debate', 'Exit ticket', '']);
    assert.deepEqual(pack.rounds.map((r) => r.key), ['a', 'b', 'c']);
    // Prepared rounds keep their own settings.
    assert.equal(pack.rounds[1].allowSelfSelect, true);
    assert.equal(pack.rounds[1].chatScope, 'board');
    assert.equal(pack.settings.autoIndividualBackground?.fileName, 'frayer.png');
    assert.equal(pack.settings.timerDurationMs, 120_000);
  });

  it('2 – main ink: teacher only, all but name stamps, none', () => {
    const teacherIds = new Set(['teacher']);
    const els = input().mainElements;
    assert.deepEqual(filterMainInk(els, 'teacher', teacherIds).map((e) => e.id), ['t-ink']);
    assert.deepEqual(filterMainInk(els, 'all', teacherIds).map((e) => e.id), ['t-ink', 's-ink']);
    assert.deepEqual(filterMainInk(els, 'none', teacherIds), []);
    assert.equal(buildLessonPack(input({ mainInk: 'none' })).main.elements.length, 0);
  });

  it('3 – a launched group round keeps group titles in order, no members or student ink', () => {
    const pack = buildLessonPack(input());
    const debate = pack.rounds[0];
    assert.equal(debate.mode, 'groups');
    assert.deepEqual(debate.groups, [{ title: 'Pros' }, { title: 'Cons' }]);
    assert.equal(debate.groupInk, undefined);
    assert.equal(debate.worksheet?.fileName, 'debate.png');
    // A prepared group round keeps the teacher's board ink.
    assert.equal(pack.rounds[2].groupInk?.[0].length, 1);
  });

  it('round choice: roundIds, or prepared only without launched rounds', () => {
    assert.deepEqual(buildLessonPack(input({ roundIds: ['r2'] })).rounds.map((r) => r.title), ['Exit ticket']);
    assert.deepEqual(
      buildLessonPack(input({ includeLaunchedRounds: false })).rounds.map((r) => r.title),
      ['Exit ticket', '']
    );
  });

  it('4 – lessonAssetUrls finds main, round and auto-individual pages once each', () => {
    const urls = lessonAssetUrls(buildLessonPack(input()));
    assert.deepEqual(urls.sort(), [url('a'), url('b'), url('c'), url('d'), url('e')].sort());
  });

  it('5 – parseLessonText refuses bad files and accepts a good one', () => {
    assert.match(parseLessonText('x.allaboard', '{oops').error ?? '', /isn't a lesson file/);
    assert.match(parseLessonText('x', JSON.stringify({ kind: 'other' })).error ?? '', /isn't an AllAboard lesson/);
    assert.match(
      parseLessonText('x', JSON.stringify({ ...buildLessonPack(input()), version: LESSON_VERSION + 1 })).error ?? '',
      /newer AllAboard/
    );
    assert.match(parseLessonText('x', JSON.stringify({ version: 2, elements: [] })).error ?? '', /room save/);
    const tooMany = { ...buildLessonPack(input()), rounds: Array.from({ length: 51 }, () => ({ mode: 'individual' })) };
    assert.match(parseLessonText('x', JSON.stringify(tooMany)).error ?? '', /at most 50 rounds/);
    const tooManyGroups = {
      ...buildLessonPack(input()),
      rounds: [{ mode: 'groups', groups: Array.from({ length: 31 }, () => ({ title: 'g' })) }],
    };
    assert.match(parseLessonText('x', JSON.stringify(tooManyGroups)).error ?? '', /more than 30 groups/);
    const noPages = { ...buildLessonPack(input()), main: { background: { fileName: 'x' }, elements: [] } };
    assert.match(parseLessonText('x', JSON.stringify(noPages)).error ?? '', /damaged/);
    const bigInk = { ...buildLessonPack(input()), main: { background: null, elements: Array(10_001).fill({ tool: 'solid' }) } };
    assert.match(parseLessonText('x', JSON.stringify(bigInk)).error ?? '', /too much ink/);

    const good = parseLessonText('x', JSON.stringify(buildLessonPack(input())));
    assert.equal(good.error, null);
    assert.equal(good.lesson?.rounds.length, 3);
    assert.equal(good.lesson?.settings.autoIndividual, true);
    // Never throws, whatever it gets.
    for (const junk of [null, 42, 'x', [], { kind: LESSON_KIND, version: 1, rounds: 'no' }]) {
      assert.ok(validateLesson(junk).error);
    }
  });

  it('6 – rewriteAssetUrls rewrites every reference and the assets map', () => {
    const pack = buildLessonPack(input());
    pack.assets = { [url('a')]: 'data:image/png;base64,AA==' };
    const out = rewriteAssetUrls(pack, { [url('a')]: url('f') });
    const text = JSON.stringify(out);
    assert.equal(text.includes(url('a')), false);
    assert.equal(out.main.background?.pages[0].dataUrl, url('f'));
    assert.equal(out.settings.autoIndividualBackground?.pages[1].dataUrl, url('f'));
    assert.deepEqual(Object.keys(out.assets), [url('f')]);
    assert.equal(pack.main.background?.pages[0].dataUrl, url('a'), 'the original is untouched');
  });

  it('file names and round names', () => {
    assert.equal(lessonFileName('Photosynthesis: Part 2!', new Date(2026, 10, 24)), 'photosynthesis-part-2-2026-11-24.allaboard');
    assert.equal(lessonFileName('   ', new Date(2026, 0, 5)), 'lesson-2026-01-05.allaboard');
    assert.equal(roundNameFromTitle('Round 3 · Groups · A · B'), 'A · B');
    assert.equal(roundNameFromTitle('Round 3 · Groups'), '');
  });
});
