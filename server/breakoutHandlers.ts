import { randomUUID } from 'node:crypto';
import { internBackground } from '../roomStore.ts';
import { makeAnonymousAuthorId } from '../src/lib/anonymousInk.ts';
import {
  getActiveRound,
  getBoardsInRound,
  getRoundById,
  getRounds,
  isPreparedRound,
  resolveBreakoutAction,
  uniqueStrings,
} from '../src/lib/breakoutRounds.ts';
import type { ConfigureBreakoutPayload } from '../src/types.ts';

import type { ServerContext, TypedSocket } from './types.ts';
export function registerBreakoutHandlers(socket: TypedSocket, ctx: ServerContext) {
  const {
    io,
    rooms,
    socketMeta,
    store,
    cloneBackground,
    launchPreparedRound,
    applyRoundEdits,
    studentsInDealOrder,
    provisionIndividualBoard,
    editPreparedRound,
    createRound,
    scheduleSaveToDisk,
    broadcastRoomSettings,
    broadcastBreakoutSync,
    noteChange,
    boardAudience,
    placeSocket,
    teacherChannel,
    teacherTemplatesPayload,
    setRoundVariants,
  } = ctx;
  socket.on('teacher:configure-breakout', (payload: ConfigureBreakoutPayload, callback) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) {
      callback?.({ ok: false, error: 'Not in a room.' });
      return;
    }
    const room = rooms.get(meta.roomId);
    if (!room) {
      callback?.({ ok: false, error: 'Room not found.' });
      return;
    }
    const callerRecord = room.usersByUserId.get(meta.userId);
    if (!callerRecord?.isTeacher) {
      callback?.({ ok: false, error: 'Only a verified Teacher can configure breakout boards.' });
      return;
    }

    const safePayload: ConfigureBreakoutPayload = payload && typeof payload === 'object' ? payload : {};
    const cfg = room.breakoutConfig;
    const action = resolveBreakoutAction(safePayload, cfg);
    let createdRoundId: string | undefined;

    if (action === 'set-auto-individual') {
      if (room.teacherPinHash === null) {
        callback?.({
          ok: false,
          error: 'Set a Room Teacher PIN before enabling automatic student boards.',
        });
        return;
      }
      cfg.autoIndividual = Boolean(safePayload.autoIndividual);
      if (safePayload.customBackground !== undefined) {
        cfg.autoIndividualBackground = cloneBackground(safePayload.customBackground);
      } else if (safePayload.autoIndividualBackground !== undefined) {
        cfg.autoIndividualBackground = cloneBackground(safePayload.autoIndividualBackground);
      } else if (safePayload.copyWorksheet) {
        cfg.autoIndividualBackground = cloneBackground(room.background);
      }
      if (typeof safePayload.templateLabel === 'string' && safePayload.templateLabel.trim()) {
        cfg.autoIndividualTemplateLabel = safePayload.templateLabel.trim().slice(0, 40);
      } else if (safePayload.customBackground === null && !safePayload.copyWorksheet) {
        cfg.autoIndividualTemplateLabel = 'Blank';
      }
      if (safePayload.chatScope === 'board' || safePayload.chatScope === 'unified') {
        cfg.chatScope = safePayload.chatScope;
      }
    } else if (action === 'return-to-main') {
      cfg.mode = 'main';
      cfg.autoIndividual = false;
      delete cfg.userBoardOverrides;
    } else if (action === 'resume' || action === 'update-current') {
      const targetId = safePayload.roundId || safePayload.targetRoundId;
      const round = getRoundById(cfg, targetId || cfg.activeRoundId);
      if (!round) {
        callback?.({ ok: false, error: 'There is no breakout round to resume or edit yet.' });
        return;
      }
      const launchingNow = isPreparedRound(round);
      if (launchingNow) {
        if (action !== 'resume') {
          callback?.({ ok: false, error: 'Launch this prepared round first, or edit it with Edit.' });
          return;
        }
        launchPreparedRound(room, round);
      }
      applyRoundEdits(room, round, safePayload);
      if (action === 'resume' || targetId) {
        cfg.activeRoundId = round.id;
        cfg.mode = round.mode;
        delete cfg.userBoardOverrides;
      }
      if (round.mode === 'individual' && cfg.mode === 'individual' && cfg.activeRoundId === round.id) {
        for (const u of studentsInDealOrder(room)) provisionIndividualBoard(room, round.id, u, !launchingNow);
      }
    } else if (action === 'edit-prepared') {
      const result = editPreparedRound(room, safePayload, meta.userId);
      if (!result.ok) {
        callback?.(result);
        return;
      }
      createdRoundId = result.roundId;
    } else if (action === 'delete-prepared') {
      const round = getRoundById(cfg, safePayload.roundId);
      if (!round || !isPreparedRound(round)) {
        callback?.({ ok: false, error: 'Only a prepared round that has not been launched can be deleted.' });
        return;
      }
      cfg.rounds = getRounds(cfg).filter((r) => r.id !== round.id);
      for (const sb of getBoardsInRound(room.subBoards, round.id)) room.subBoards.delete(sb.id);
      delete room.roundTemplates[round.id];
      delete room.roundTemplateInk[round.id];
      delete room.roundVariants[round.id];
    } else {
      // 'new-round' (prepare: true creates it without moving anyone)
      const result = createRound(room, safePayload, safePayload.prepare === true, meta.userId);
      if (!result.ok) {
        callback?.(result);
        return;
      }
      createdRoundId = result.roundId;
    }

    room.lastActiveAt = Date.now();
    scheduleSaveToDisk(room, true);
    broadcastRoomSettings(room);
    broadcastBreakoutSync(room);
    callback?.({
      ok: true,
      action,
      activeRoundId: room.breakoutConfig.activeRoundId,
      mode: room.breakoutConfig.mode,
      ...(createdRoundId ? { roundId: createdRoundId } : {}),
    });
  });

  socket.on('teacher:spotlight-board', (payload, callback) => {
    const meta = socketMeta.get(socket.id);
    const room = meta && rooms.get(meta.roomId);
    if (!meta || !room || !room.usersByUserId.get(meta.userId)?.isTeacher) {
      callback?.({ ok: false, error: 'Only a verified Teacher can share a board.' });
      return;
    }
    const source = typeof payload?.sourceBoardId === 'string' ? room.subBoards.get(payload.sourceBoardId) : undefined;
    if (!source) {
      callback?.({ ok: false, error: 'Board not found.' });
      return;
    }
    const anonymize = payload.anonymize !== false;
    const anonymousAuthorIds = new Map<string, string>();
    const anonymousAuthorFor = (authorId: string) => {
      let anonymousId = anonymousAuthorIds.get(authorId);
      if (!anonymousId) {
        anonymousId = makeAnonymousAuthorId(randomUUID());
        anonymousAuthorIds.set(authorId, anonymousId);
      }
      return anonymousId;
    };
    room.elements = source.elements
      .filter((element) => !anonymize || element.stamp !== 'username')
      .map((element) => ({
        ...structuredClone(element),
        id: randomUUID(),
        boardId: 'main',
        ...(anonymize ? { userId: anonymousAuthorFor(element.userId), userName: 'Class Example' } : {}),
      }));
    if (payload.copyBackground === true) {
      room.background = cloneBackground(source.background);
      io.to(room.id).emit('background-sync', { boardId: 'main', background: room.background });
    }
    // Invalidate old Main undo histories before distributing the replacement.
    io.to(room.id).emit('board-replaced', { boardId: 'main' });
    noteChange(room, 'main', { full: true });
    io.to(boardAudience(room.id, 'main')).emit('state-sync', { boardId: 'main', elements: room.elements });
    if (payload.returnToMain === true) {
      room.breakoutConfig.mode = 'main';
      room.breakoutConfig.autoIndividual = false;
      delete room.breakoutConfig.userBoardOverrides;
      broadcastRoomSettings(room);
      broadcastBreakoutSync(room);
    }
    room.lastActiveAt = Date.now();
    scheduleSaveToDisk(room, true);
    callback?.({ ok: true });
  });

  socket.on('teacher:view-board', (payload: { boardId?: string } | undefined) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    meta.viewBoardId = typeof payload?.boardId === 'string' ? payload.boardId : 'main';
    const room = rooms.get(meta.roomId);
    if (room) placeSocket(socket.id, room, true);
  });

  socket.on('breakout:join-board', ({ targetBoardId, targetUserId }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || !targetBoardId) return;
    const room = rooms.get(meta.roomId);
    if (!room) return;

    const callerRecord = room.usersByUserId.get(meta.userId);
    const userToMove = targetUserId || meta.userId;

    // Only allow moving another user if caller is teacher; only allow self-move if allowSelfSelect is true or caller is teacher
    if (userToMove !== meta.userId && !callerRecord?.isTeacher) return;
    if (userToMove === meta.userId && !callerRecord?.isTeacher && !room.breakoutConfig.allowSelfSelect) {
      return;
    }

    const activeRound = getActiveRound(room.breakoutConfig);
    const targetBoard = room.subBoards.get(targetBoardId);
    // Only group boards in the ACTIVE round can be joined. Archived rounds are never edited here.
    if (!activeRound || !targetBoard || targetBoard.roundId !== activeRound.id || targetBoard.kind !== 'group') {
      return;
    }

    for (const sb of getBoardsInRound(room.subBoards, activeRound.id)) {
      if (sb.kind === 'group') {
        sb.assignedUserIds = sb.assignedUserIds.filter((id) => id !== userToMove);
      }
    }
    targetBoard.assignedUserIds.push(userToMove);

    room.lastActiveAt = Date.now();
    scheduleSaveToDisk(room);
    broadcastBreakoutSync(room);
  });

  socket.on('teacher:set-background', (payload, callback) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) {
      callback?.({ ok: false, error: 'Not in a room.' });
      return;
    }
    const room = rooms.get(meta.roomId);
    if (!room) {
      callback?.({ ok: false, error: 'Room not found.' });
      return;
    }

    const callerRecord = room.usersByUserId.get(meta.userId);
    if (!callerRecord?.isTeacher) {
      callback?.({ ok: false, error: 'Only a verified Teacher can change the background worksheet.' });
      return;
    }

    const boardId = payload?.boardId || 'main';
    const bgData = internBackground(store, payload && 'background' in payload ? payload.background : payload);

    if (boardId === 'main') {
      room.background = bgData || null;
      io.to(room.id).emit('background-sync', { boardId: 'main', background: room.background });
    } else {
      const sb = room.subBoards.get(boardId);
      if (sb) {
        sb.background = bgData || null;
        io.to(room.id).emit('background-sync', { boardId, background: sb.background });
      }
    }

    room.lastActiveAt = Date.now();
    scheduleSaveToDisk(room, true);
    callback?.({ ok: true });
  });

  socket.on('teacher:set-background-multi', (payload, callback) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) {
      callback?.({ ok: false, error: 'Not in a room.' });
      return;
    }
    const room = rooms.get(meta.roomId);
    if (!room) {
      callback?.({ ok: false, error: 'Room not found.' });
      return;
    }

    const callerRecord = room.usersByUserId.get(meta.userId);
    if (!callerRecord?.isTeacher) {
      callback?.({ ok: false, error: 'Only a verified Teacher can change the background worksheet.' });
      return;
    }

    if (!payload || !Array.isArray(payload.boardIds)) {
      callback?.({ ok: false, error: 'boardIds must be an array.' });
      return;
    }

    const ids = uniqueStrings(payload.boardIds).slice(0, 500);
    const interned = internBackground(store, payload.background ?? null) || null;
    const copyOf = () => (interned ? JSON.parse(JSON.stringify(interned)) : null);
    const skipped: string[] = [];
    let updated = 0;

    for (const boardId of ids) {
      if (boardId === 'main') {
        room.background = copyOf();
        io.to(room.id).emit('background-sync', { boardId: 'main', background: room.background });
        updated++;
        continue;
      }
      const sb = room.subBoards.get(boardId);
      if (!sb) {
        skipped.push(boardId);
        continue;
      }
      sb.background = copyOf();
      io.to(room.id).emit('background-sync', { boardId, background: sb.background });
      updated++;
    }

    const templateRound = payload.roundTemplateFor;
    if (typeof templateRound === 'string' && getRounds(room.breakoutConfig).some((r) => r.id === templateRound)) {
      room.roundTemplates[templateRound] = cloneBackground(interned);
      io.to(teacherChannel(room.id)).emit('round-templates-sync', teacherTemplatesPayload(room));
    }

    room.lastActiveAt = Date.now();
    scheduleSaveToDisk(room, true);
    callback?.({ ok: true, updated, skipped });
  });

  socket.on('teacher:set-round-variants', (payload, callback) => {
    const meta = socketMeta.get(socket.id);
    const room = meta && rooms.get(meta.roomId);
    if (!meta || !room || !room.usersByUserId.get(meta.userId)?.isTeacher) {
      callback?.({ ok: false, error: 'Only a verified Teacher can change worksheet variants.' });
      return;
    }
    const round = getRoundById(room.breakoutConfig, payload?.roundId);
    if (!round || round.mode !== 'individual') {
      callback?.({ ok: false, error: 'Worksheet variants are for individual rounds only.' });
      return;
    }
    setRoundVariants(room, round.id, round.mode, payload?.variants ?? null);
    room.lastActiveAt = Date.now();
    scheduleSaveToDisk(room, true);
    io.to(teacherChannel(room.id)).emit('round-templates-sync', teacherTemplatesPayload(room));
    callback?.({ ok: true });
  });

  socket.on('teacher:update-background', ({ boardId = 'main', patch }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || !patch) return;
    const room = rooms.get(meta.roomId);
    if (!room) return;

    const callerRecord = room.usersByUserId.get(meta.userId);
    if (!callerRecord?.isTeacher) return;

    if (boardId === 'main') {
      if (!room.background) return;
      room.background = internBackground(store, { ...room.background, ...patch });
      io.to(room.id).emit('background-sync', { boardId: 'main', background: room.background });
    } else {
      const sb = room.subBoards.get(boardId);
      if (!sb || !sb.background) return;
      sb.background = internBackground(store, { ...sb.background, ...patch });
      io.to(room.id).emit('background-sync', { boardId, background: sb.background });
    }

    room.lastActiveAt = Date.now();
    scheduleSaveToDisk(room);
  });
}
