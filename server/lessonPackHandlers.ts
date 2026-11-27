import { randomUUID } from 'node:crypto';
import type { RoomStore } from '../roomStore.ts';
import { MAX_BOARD_ELEMENTS, elementFieldsOk } from '../socketGuards.ts';
import { buildRoundTitle, getBoardsInRound, getNextRoundNumber, getRounds, isPreparedRound, makeGroupBoardId, makeRoundId, uniqueStrings } from '../src/lib/breakoutRounds.ts';
import { buildLessonPack, validateLesson, type LessonPack, type MainInkChoice } from '../src/lib/lessonPack.ts';
import type { BreakoutRoundMeta } from '../src/types.ts';
import type { createRoomSerialization } from './roomSerialization.ts';
import { MAX_GROUPS_PER_ROUND } from './roomSerialization.ts';
import type { RoomState } from './types.ts';

import type { createBreakoutHelpers } from './breakoutHandlers.ts';
export function createLessonPackHelpers({ store, cloneBackground, setRoundVariants, createGroupBoards, teacherIdsOf, getRoundTemplate }: { store: RoomStore; cloneBackground: ReturnType<typeof createRoomSerialization>['cloneBackground']; setRoundVariants: ReturnType<typeof createBreakoutHelpers>['setRoundVariants']; createGroupBoards: ReturnType<typeof createBreakoutHelpers>['createGroupBoards']; teacherIdsOf: ReturnType<typeof createBreakoutHelpers>['teacherIdsOf']; getRoundTemplate: ReturnType<typeof createBreakoutHelpers>['getRoundTemplate'] }) {


  type LessonCheck = { ok: boolean; lesson: LessonPack | null; error?: string };

  function buildLessonForRoom(
    room: RoomState,
    caller: { userId: string; name: string },
    opts: {
      title?: unknown;
      exportedBy?: unknown;
      mainInk?: unknown;
      includeLaunchedRounds?: unknown;
      roundIds?: unknown;
      includeStudentPicks?: unknown;
    }
  ): LessonPack {
    const cfg = room.breakoutConfig;
    const rounds = getRounds(cfg);
    const roundTemplates: Record<string, any | null> = {};
    for (const r of rounds) roundTemplates[r.id] = getRoundTemplate(room, r.id);
    const mainInk: MainInkChoice = opts.mainInk === 'all' || opts.mainInk === 'none' ? opts.mainInk : 'teacher';
    return buildLessonPack({
      title: typeof opts.title === 'string' && opts.title.trim() ? opts.title : room.id,
      exportedBy: typeof opts.exportedBy === 'string' ? opts.exportedBy : undefined,
      mainBackground: room.background,
      mainElements: room.elements,
      teacherUserIds: teacherIdsOf(room, caller.userId),
      mainInk,
      rounds,
      roundTemplates,
      roundTemplateInk: room.roundTemplateInk,
      roundVariants: room.roundVariants,
      includeStudentPicks: opts.includeStudentPicks === true,
      boards: Array.from(room.subBoards.values()).map((sb) => ({
        id: sb.id,
        roundId: sb.roundId,
        kind: sb.kind === 'group' ? 'group' : 'individual',
        title: sb.title,
        elements: sb.elements,
      })),
      roundIds: Array.isArray(opts.roundIds) ? uniqueStrings(opts.roundIds) : undefined,
      includeLaunchedRounds: opts.includeLaunchedRounds !== false,
      settings: {
        oneNameStamp: room.oneNameStamp,
        hideStudentCursors: room.hideStudentCursors,
        allowSelfSelect: cfg.allowSelfSelect,
        chatScope: cfg.chatScope,
        autoIndividual: Boolean(cfg.autoIndividual),
        autoIndividualBackground: cfg.autoIndividualBackground ?? null,
        autoIndividualTemplateLabel: cfg.autoIndividualTemplateLabel,
        timerDurationMs: room.timer.durationMs,
        timerAutoLock: room.timer.autoLockOnExpire,
      },
    });
  }


  /**
   * Server-side check of a lesson sent by a client, whatever the client already checked: shape, element sizes, and
   * every worksheet page interned and present in the asset store.
   */
  function checkIncomingLesson(raw: unknown): LessonCheck {
    const { lesson, error } = validateLesson(raw);
    if (!lesson) return { ok: false, lesson: null, error: error || 'This lesson file is damaged.' };
    const lists: any[][] = [lesson.main.elements];
    for (const r of lesson.rounds) {
      if (r.groupInk) lists.push(...r.groupInk);
      if (r.ink) lists.push(r.ink);
    }
    for (const list of lists) {
      if (list.length > MAX_BOARD_ELEMENTS || !list.every((el) => elementFieldsOk(el))) {
        return { ok: false, lesson: null, error: 'This lesson has ink AllAboard can’t load (too large or damaged).' };
      }
    }
    // Intern any stray data: URL (a hand-edited file), then require every page to be a stored asset.
    lesson.main.background = cloneBackground(lesson.main.background);
    for (const r of lesson.rounds) {
      r.worksheet = cloneBackground(r.worksheet);
      if (r.variants) r.variants.extra = r.variants.extra.map((bg) => cloneBackground(bg));
    }
    if (lesson.settings.autoIndividualBackground) {
      lesson.settings.autoIndividualBackground = cloneBackground(lesson.settings.autoIndividualBackground);
    }
    const backgrounds = [
      lesson.main.background,
      ...lesson.rounds.map((r) => r.worksheet),
      ...lesson.rounds.flatMap((r) => r.variants?.extra ?? []),
      lesson.settings.autoIndividualBackground,
    ];
    let missing = 0;
    for (const bg of backgrounds) {
      for (const page of bg?.pages ?? []) {
        const m = /^\/api\/assets\/([a-f0-9]{64})$/.exec(String(page.dataUrl));
        if (!m || !store.getAsset(m[1])) missing++;
      }
    }
    if (missing > 0) {
      return {
        ok: false,
        lesson: null,
        error: `${missing} worksheet image${missing === 1 ? ' is' : 's are'} missing. Try loading again.`,
      };
    }
    lesson.assets = {};
    return { ok: true, lesson };
  }


  /** The lesson's ink as the loading teacher's own: fresh ids, this board, no name stamps. */
  function lessonInk(elements: any[], boardId: string, author: { userId: string; name: string }): any[] {
    const now = Date.now();
    return elements
      .filter((el) => !(el.tool === 'stamp' && el.stamp === 'username'))
      .map((el) => ({
        ...structuredClone(el),
        id: randomUUID(),
        boardId,
        userId: author.userId,
        userName: author.name,
        timestamp: now,
      }));
  }


  /** Removes a round, its boards and its worksheet template. */
  function removeRound(room: RoomState, roundId: string) {
    const cfg = room.breakoutConfig;
    cfg.rounds = getRounds(cfg).filter((r) => r.id !== roundId);
    for (const sb of getBoardsInRound(room.subBoards, roundId)) room.subBoards.delete(sb.id);
    delete room.roundTemplates[roundId];
    delete room.roundTemplateInk[roundId];
    delete room.roundVariants[roundId];
  }


  /**
   * Sets a checked lesson up in a room: main worksheet and ink, every round as a prepared round with server-made ids,
   * and the settings. Existing prepared rounds are replaced; launched rounds stay. Never moves anyone.
   */
  function applyLessonToRoom(room: RoomState, lesson: LessonPack, author: { userId: string; name: string }): string[] {
    const cfg = room.breakoutConfig;
    room.background = cloneBackground(lesson.main.background);
    room.elements = lessonInk(lesson.main.elements, 'main', author);

    for (const r of getRounds(cfg)) if (isPreparedRound(r)) removeRound(room, r.id);

    const s = lesson.settings;
    const createdIds: string[] = [];
    for (const lr of lesson.rounds) {
      const number = getNextRoundNumber(cfg);
      const roundId = makeRoundId(number);
      // A stale board from a deleted round could share this id: clear it so the new round starts clean.
      for (const sb of getBoardsInRound(room.subBoards, roundId)) room.subBoards.delete(sb.id);
      const worksheet = cloneBackground(lr.worksheet);
      room.roundTemplates[roundId] = worksheet;
      const templateInk = lessonInk(lr.ink ?? [], roundId, author);
      if (templateInk.length > 0) room.roundTemplateInk[roundId] = templateInk;
      else delete room.roundTemplateInk[roundId];
      setRoundVariants(room, roundId, lr.mode, lr.variants ? { ...lr.variants, assigned: {} } : null);
      const meta: BreakoutRoundMeta = {
        id: roundId,
        number,
        title: buildRoundTitle(number, lr.mode, lr.title),
        mode: lr.mode,
        createdAt: Date.now(),
        prepared: true,
        allowSelfSelect: lr.allowSelfSelect ?? Boolean(s.allowSelfSelect),
        chatScope: lr.chatScope ?? (s.chatScope === 'board' ? 'board' : 'unified'),
      };
      if (lr.mode === 'groups') {
        const groups = (lr.groups ?? [{ title: 'Group 1' }]).slice(0, MAX_GROUPS_PER_ROUND);
        createGroupBoards(room, roundId, groups.map((g) => ({ title: g.title })), worksheet);
        groups.forEach((_g, i) => {
          const board = room.subBoards.get(makeGroupBoardId(roundId, i));
          const ink = lr.groupInk?.[i];
          if (board && ink) board.elements = lessonInk(ink, board.id, author);
        });
      }
      cfg.rounds = [...getRounds(cfg), meta];
      createdIds.push(roundId);
    }

    if (typeof s.oneNameStamp === 'boolean') room.oneNameStamp = s.oneNameStamp;
    if (typeof s.hideStudentCursors === 'boolean') room.hideStudentCursors = s.hideStudentCursors;
    if (typeof s.allowSelfSelect === 'boolean') cfg.allowSelfSelect = s.allowSelfSelect;
    if (s.chatScope === 'board' || s.chatScope === 'unified') cfg.chatScope = s.chatScope;
    if (!room.timer.isRunning) {
      if (typeof s.timerDurationMs === 'number') room.timer.durationMs = s.timerDurationMs;
      if (typeof s.timerAutoLock === 'boolean') room.timer.autoLockOnExpire = s.timerAutoLock;
    }
    // Same rule as set-auto-individual: automatic student boards need a Teacher PIN.
    if (room.teacherPinHash !== null && typeof s.autoIndividual === 'boolean') {
      cfg.autoIndividual = s.autoIndividual;
      if (s.autoIndividual) {
        cfg.autoIndividualBackground = cloneBackground(s.autoIndividualBackground ?? null);
        if (s.autoIndividualTemplateLabel) cfg.autoIndividualTemplateLabel = s.autoIndividualTemplateLabel;
      }
    }
    return createdIds;
  }
  return { buildLessonForRoom, checkIncomingLesson, lessonInk, removeRound, applyLessonToRoom };
}
