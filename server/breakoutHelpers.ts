import { randomUUID } from 'node:crypto';
import { MAX_BOARD_ELEMENTS } from '../socketGuards.ts';
import {
  buildRoundTitle,
  getActiveRound,
  getBoardsInRound,
  getNextRoundNumber,
  getRoundById,
  getRounds,
  isPreparedRound,
  makeGroupBoardId,
  makeIndividualBoardId,
  makeRoundId,
  uniqueStrings,
} from '../src/lib/breakoutRounds.ts';
import { filterMainInk } from '../src/lib/lessonPack.ts';
import { availableLetters, byStudentName, pickVariant, variantBackground } from '../src/lib/roundVariants.ts';
import type { BreakoutRoundMeta, ConfigureBreakoutPayload } from '../src/types.ts';
import type { createBoardChannels } from './boardChannels.ts';
import type { createRoomSerialization } from './roomSerialization.ts';
import { MAX_GROUPS_PER_ROUND, cleanRoundTitle, payloadWorksheet } from './roomSerialization.ts';
import type { RoomState, ServerUserRecord, TypedIo } from './types.ts';

export function createBreakoutHelpers({
  io,
  cloneBackground,
  cleanRoundVariants,
  noteChange,
}: {
  io: TypedIo;
  cloneBackground: ReturnType<typeof createRoomSerialization>['cloneBackground'];
  cleanRoundVariants: ReturnType<typeof createRoomSerialization>['cleanRoundVariants'];
  noteChange: ReturnType<typeof createBoardChannels>['noteChange'];
}) {
  type RoundResult = { ok: true; roundId: string } | { ok: false; error: string };

  /** Sets or clears a round's variants. Group rounds never have any. */
  function setRoundVariants(room: RoomState, roundId: string, mode: string, raw: unknown) {
    const v = mode === 'individual' ? cleanRoundVariants(raw) : null;
    if (v) room.roundVariants[roundId] = v;
    else delete room.roundVariants[roundId];
  }

  // ---------- Template ink (PLANS_LESSON_PACKS.md, phase 3) ----------

  /** Teacher-owned Main ink without name stamps: what "Also copy my ink from Main" puts on a round's boards. */
  function mainTemplateInk(room: RoomState, callerId: string): any[] {
    return filterMainInk(room.elements, 'teacher', teacherIdsOf(room, callerId))
      .slice(0, MAX_BOARD_ELEMENTS)
      .map((el) => structuredClone(el));
  }

  /** Sets or clears a round's template ink from a payload. `copyInk` counts only with `copyWorksheet` (same board). */
  function setRoundTemplateInk(room: RoomState, roundId: string, payload: ConfigureBreakoutPayload, callerId: string) {
    const ink = payload.copyInk === true && payload.copyWorksheet === true ? mainTemplateInk(room, callerId) : [];
    if (ink.length > 0) room.roundTemplateInk[roundId] = ink;
    else delete room.roundTemplateInk[roundId];
  }

  /** Fresh copies of a round's template ink for one board: new ids, that board, the teacher still the author. */
  function templateInkForBoard(room: RoomState, roundId: string, boardId: string): any[] {
    const ink = room.roundTemplateInk[roundId];
    if (!Array.isArray(ink) || ink.length === 0) return [];
    const now = Date.now();
    return ink.map((el) => ({ ...structuredClone(el), id: randomUUID(), boardId, timestamp: now }));
  }

  /** Puts a round's template ink under whatever is already on each of its group boards. */
  function stampTemplateInkOnGroupBoards(room: RoomState, roundId: string) {
    if (!room.roundTemplateInk[roundId]?.length) return;
    for (const sb of getBoardsInRound(room.subBoards, roundId)) {
      if (sb.kind !== 'group') continue;
      sb.elements = [...templateInkForBoard(room, roundId, sb.id), ...sb.elements].slice(0, MAX_BOARD_ELEMENTS);
      noteChange(room, sb.id, { full: true });
    }
  }

  // ---------- Lesson packs (PLANS_LESSON_PACKS.md, phase 2) ----------

  /** Everyone this room counts as a teacher, for "teacher ink only". */
  function teacherIdsOf(room: RoomState, callerId: string): Set<string> {
    const ids = new Set<string>([callerId]);
    for (const [uid, record] of room.usersByUserId) if (record.isTeacher) ids.add(uid);
    return ids;
  }

  /** Students who should receive breakout boards. */
  function getBreakoutStudents(room: RoomState): ServerUserRecord[] {
    return Array.from(room.usersByUserId.values()).filter((u) => !u.isTeacher);
  }

  /** Background used when the round was launched; falls back to any individual board's background in that round. */
  function getRoundTemplate(room: RoomState, roundId: string): any | null {
    if (Object.prototype.hasOwnProperty.call(room.roundTemplates, roundId)) {
      return room.roundTemplates[roundId];
    }
    const sample = getBoardsInRound(room.subBoards, roundId).find((sb) => sb.kind === 'individual');
    return sample ? sample.background : null;
  }

  /** Creates `<roundId>_ind_<userId>` if this user has no individual board in that round. Returns true if created. */
  function provisionIndividualBoard(
    room: RoomState,
    roundId: string,
    user: { userId: string; name: string },
    late = true
  ): boolean {
    const existing = getBoardsInRound(room.subBoards, roundId).find(
      (sb) => sb.kind === 'individual' && sb.assignedUserIds.includes(user.userId)
    );
    if (existing) {
      existing.title = `${user.name}'s Board`;
      return false;
    }
    const id = makeIndividualBoardId(roundId, user.userId);
    room.subBoards.set(id, {
      id,
      roundId,
      kind: 'individual',
      title: `${user.name}'s Board`,
      assignedUserIds: [user.userId],
      elements: templateInkForBoard(room, roundId, id),
      background: cloneBackground(variantWorksheetFor(room, roundId, user, late)),
      messages: [],
    });
    return true;
  }

  /** The worksheet a new individual board gets: the round's own, or the student's variant (B–D) by the round's rule. */
  function variantWorksheetFor(
    room: RoomState,
    roundId: string,
    user: { userId: string; name: string },
    late: boolean
  ) {
    const template = getRoundTemplate(room, roundId);
    const variants = room.roundVariants[roundId];
    if (!variants) return template;
    const before = variants.assigned[user.userId];
    const index =
      typeof before === 'number' && availableLetters(variants).includes(before)
        ? before
        : pickVariant(variants, {
            userId: user.userId,
            name: user.name,
            late,
            mainElements: room.elements,
            mainBackground: room.background,
          });
    variants.assigned[user.userId] = index;
    return variantBackground(variants, index, template);
  }

  /** Students in the order worksheets are dealt out: alphabetical by name. */
  function studentsInDealOrder(room: RoomState): ServerUserRecord[] {
    return getBreakoutStudents(room).sort(byStudentName);
  }

  /** Applies group titles/assignments + allowSelfSelect + chatScope to a round. NEVER touches elements/background/messages. */
  function applyRoundEdits(room: RoomState, round: BreakoutRoundMeta, payload: ConfigureBreakoutPayload) {
    const cfg = room.breakoutConfig;
    if (typeof payload.allowSelfSelect === 'boolean') cfg.allowSelfSelect = payload.allowSelfSelect;
    if (payload.chatScope === 'board' || payload.chatScope === 'unified') cfg.chatScope = payload.chatScope;

    if (round.mode === 'groups' && Array.isArray(payload.groups)) {
      const seen = new Set<string>();
      for (const g of payload.groups) {
        if (!g || typeof g.id !== 'string') continue;
        const board = room.subBoards.get(g.id);
        if (!board || board.roundId !== round.id || board.kind !== 'group') continue; // ignore unknown ids
        if (typeof g.title === 'string' && g.title.trim()) board.title = g.title.trim().slice(0, 40);
        board.assignedUserIds = uniqueStrings(g.assignedUserIds).filter((uid) => !seen.has(uid));
        board.assignedUserIds.forEach((uid) => seen.add(uid));
      }
    }
  }

  /** The worksheet a 'new-round' / 'edit-prepared' payload asks for. `undefined` means "not specified". */

  /** Creates group boards `first..last` (0-based) for a round, each with its own copy of the worksheet. */
  function createGroupBoards(
    room: RoomState,
    roundId: string,
    groups: { title?: unknown; assignedUserIds?: unknown }[],
    templateBg: any | null,
    firstIndex = 0
  ) {
    const seen = new Set<string>();
    for (const sb of getBoardsInRound(room.subBoards, roundId)) sb.assignedUserIds.forEach((uid) => seen.add(uid));
    groups.forEach((g, offset) => {
      const i = firstIndex + offset;
      const id = makeGroupBoardId(roundId, i);
      const assigned = uniqueStrings(g.assignedUserIds).filter((uid) => !seen.has(uid));
      assigned.forEach((uid) => seen.add(uid));
      room.subBoards.set(id, {
        id,
        roundId,
        kind: 'group',
        title: cleanRoundTitle(g.title) || `Group ${i + 1}`,
        assignedUserIds: assigned,
        elements: [],
        background: cloneBackground(templateBg),
        messages: [],
      });
    });
  }

  /**
   * 'new-round'. When `prepared` is false this launches the round at once (moves every student), exactly as before.
   * When true it only saves the round: no individual boards, and mode / activeRoundId / room settings are untouched.
   */
  function createRound(
    room: RoomState,
    payload: ConfigureBreakoutPayload,
    prepared: boolean,
    callerId: string
  ): RoundResult {
    const cfg = room.breakoutConfig;
    const mode: 'individual' | 'groups' = payload.mode === 'groups' ? 'groups' : 'individual';
    const groups = Array.isArray(payload.groups) ? payload.groups.filter(Boolean) : [];
    if (mode === 'groups' && groups.length === 0) {
      return { ok: false, error: 'Add at least one group before launching a group round.' };
    }
    if (groups.length > MAX_GROUPS_PER_ROUND) {
      return { ok: false, error: `A round can have at most ${MAX_GROUPS_PER_ROUND} groups.` };
    }

    const roundNumber = getNextRoundNumber(cfg);
    const roundId = makeRoundId(roundNumber);
    const templateBg = payloadWorksheet(room, payload) ?? null;
    room.roundTemplates[roundId] = cloneBackground(templateBg);
    setRoundTemplateInk(room, roundId, payload, callerId);
    setRoundVariants(room, roundId, mode, payload.variants);

    const chatScope: 'unified' | 'board' = payload.chatScope === 'board' ? 'board' : 'unified';
    const allowSelfSelect = Boolean(payload.allowSelfSelect);
    const roundMeta: BreakoutRoundMeta = {
      id: roundId,
      number: roundNumber,
      title: buildRoundTitle(roundNumber, mode, cleanRoundTitle(payload.title) ?? payload.templateLabel),
      mode,
      createdAt: Date.now(),
      ...(prepared ? { prepared: true, allowSelfSelect, chatScope } : {}),
    };

    if (mode === 'individual') {
      if (!prepared) for (const u of studentsInDealOrder(room)) provisionIndividualBoard(room, roundId, u, false);
    } else {
      createGroupBoards(room, roundId, groups, templateBg);
      // A prepared round's group boards get the template ink when it's launched (launchPreparedRound).
      if (!prepared) stampTemplateInkOnGroupBoards(room, roundId);
    }

    if (prepared) {
      cfg.rounds = [...getRounds(cfg), roundMeta];
      return { ok: true, roundId };
    }

    room.breakoutConfig = {
      mode,
      activeRoundId: roundId,
      rounds: [...getRounds(cfg), roundMeta],
      allowSelfSelect,
      ...(cfg.autoIndividual !== undefined ? { autoIndividual: cfg.autoIndividual } : {}),
      ...(cfg.autoIndividualBackground !== undefined ? { autoIndividualBackground: cfg.autoIndividualBackground } : {}),
      ...(cfg.autoIndividualTemplateLabel ? { autoIndividualTemplateLabel: cfg.autoIndividualTemplateLabel } : {}),
      chatScope,
    };
    return { ok: true, roundId };
  }

  /** Turns a prepared round into a launched one and applies its stored settings. The caller then activates it. */
  function launchPreparedRound(room: RoomState, round: BreakoutRoundMeta) {
    const cfg = room.breakoutConfig;
    const launched: BreakoutRoundMeta = { ...round, launchedAt: Date.now() };
    delete launched.prepared;
    delete launched.allowSelfSelect;
    delete launched.chatScope;
    cfg.rounds = getRounds(cfg).map((r) => (r.id === round.id ? launched : r));
    // Individual boards get the template ink as they're made; group boards already exist, so they get it now.
    if (round.mode === 'groups') stampTemplateInkOnGroupBoards(room, round.id);
    if (typeof round.allowSelfSelect === 'boolean') cfg.allowSelfSelect = round.allowSelfSelect;
    if (round.chatScope === 'board' || round.chatScope === 'unified') cfg.chatScope = round.chatScope;
  }

  /** 'edit-prepared': title, worksheet, stored settings, and (group rounds) group titles, members and count. */
  function editPreparedRound(room: RoomState, payload: ConfigureBreakoutPayload, callerId: string): RoundResult {
    const cfg = room.breakoutConfig;
    const round = getRoundById(cfg, payload.roundId);
    if (!round || !isPreparedRound(round)) {
      return { ok: false, error: 'Only a prepared round that has not been launched can be edited here.' };
    }
    if (payload.mode && payload.mode !== round.mode) {
      return { ok: false, error: "A prepared round's mode can't change. Delete it and make a new one." };
    }
    const next: BreakoutRoundMeta = { ...round };
    const title = cleanRoundTitle(payload.title);
    if (title !== undefined || typeof payload.templateLabel === 'string') {
      next.title = buildRoundTitle(round.number, round.mode, title ?? payload.templateLabel);
    }
    if (typeof payload.allowSelfSelect === 'boolean') next.allowSelfSelect = payload.allowSelfSelect;
    if (payload.chatScope === 'board' || payload.chatScope === 'unified') next.chatScope = payload.chatScope;

    const worksheet = payloadWorksheet(room, payload);
    if (worksheet !== undefined) {
      room.roundTemplates[round.id] = cloneBackground(worksheet);
      setRoundTemplateInk(room, round.id, payload, callerId);
      for (const sb of getBoardsInRound(room.subBoards, round.id)) {
        sb.background = cloneBackground(room.roundTemplates[round.id]);
        io.to(room.id).emit('background-sync', { boardId: sb.id, background: sb.background });
      }
    }
    if (payload.variants !== undefined) {
      // The form doesn't edit per-student picks: keep the ones already on the round (e.g. from a lesson pack).
      const keep = room.roundVariants[round.id]?.overrides;
      const raw: Record<string, unknown> | null =
        payload.variants && typeof payload.variants === 'object'
          ? (payload.variants as unknown as Record<string, unknown>)
          : null;
      setRoundVariants(
        room,
        round.id,
        round.mode,
        raw && !('overrides' in raw) && keep ? { ...raw, overrides: keep } : raw
      );
    }

    if (round.mode === 'groups' && Array.isArray(payload.groups)) {
      const wanted = payload.groups.filter(Boolean).slice(0, MAX_GROUPS_PER_ROUND);
      if (wanted.length === 0) return { ok: false, error: 'A group round needs at least one group.' };
      const existing = getBoardsInRound(room.subBoards, round.id).filter((sb) => sb.kind === 'group');
      // Keep boards 1..min(old,new) with their ink; delete the rest; create new ones after them.
      existing.slice(wanted.length).forEach((sb) => room.subBoards.delete(sb.id));
      const kept = existing.slice(0, wanted.length);
      const seen = new Set<string>();
      kept.forEach((board, i) => {
        const g = wanted[i];
        board.title = cleanRoundTitle(g.title) || board.title;
        board.assignedUserIds = uniqueStrings(g.assignedUserIds).filter((uid) => !seen.has(uid));
        board.assignedUserIds.forEach((uid) => seen.add(uid));
      });
      if (wanted.length > kept.length) {
        createGroupBoards(room, round.id, wanted.slice(kept.length), getRoundTemplate(room, round.id), kept.length);
      }
    }

    cfg.rounds = getRounds(cfg).map((r) => (r.id === round.id ? next : r));
    return { ok: true, roundId: round.id };
  }

  // If the room is in 'individual' mode and a student joins, make sure they have a board in the ACTIVE round.
  function ensureIndividualBoardForUser(room: RoomState, userId: string, userName: string, isTeacher: boolean) {
    if (room.breakoutConfig.mode !== 'individual' || isTeacher) return false;
    const round = getActiveRound(room.breakoutConfig);
    if (!round || round.mode !== 'individual') return false;
    return provisionIndividualBoard(room, round.id, { userId, name: userName });
  }

  /**
   * When a room is in 'main' mode with autoIndividual armed and a student joins,
   * immediately open a new Individual round using autoIndividualBackground so the
   * student enters straight onto their own board without flashing Main.
   */
  function startAutoIndividualRound(room: RoomState): boolean {
    const cfg = room.breakoutConfig;
    if (!cfg.autoIndividual || cfg.mode !== 'main') return false;
    const roundNumber = getNextRoundNumber(cfg);
    const roundId = makeRoundId(roundNumber);
    room.roundTemplates[roundId] = cloneBackground(cfg.autoIndividualBackground ?? null);
    delete room.roundTemplateInk[roundId];
    delete room.roundVariants[roundId];
    const roundMeta: BreakoutRoundMeta = {
      id: roundId,
      number: roundNumber,
      title: buildRoundTitle(roundNumber, 'individual', cfg.autoIndividualTemplateLabel),
      mode: 'individual',
      createdAt: Date.now(),
    };
    cfg.mode = 'individual';
    cfg.activeRoundId = roundId;
    cfg.rounds = [...getRounds(cfg), roundMeta];
    for (const u of getBreakoutStudents(room)) {
      provisionIndividualBoard(room, roundId, u);
    }
    return true;
  }
  return {
    setRoundVariants,
    mainTemplateInk,
    setRoundTemplateInk,
    templateInkForBoard,
    stampTemplateInkOnGroupBoards,
    teacherIdsOf,
    getBreakoutStudents,
    getRoundTemplate,
    provisionIndividualBoard,
    variantWorksheetFor,
    studentsInDealOrder,
    applyRoundEdits,
    createGroupBoards,
    createRound,
    launchPreparedRound,
    editPreparedRound,
    ensureIndividualBoardForUser,
    startAutoIndividualRound,
  };
}
