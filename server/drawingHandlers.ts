import {
  MAX_APPEND_NUMBERS,
  MAX_BATCH_ELEMENTS,
  MAX_BOARD_ELEMENTS,
  MAX_STROKE_NUMBERS,
  appendAll,
  elementFieldsOk,
  isPointArray,
} from '../socketGuards.ts';
import { getBoardsInRound } from '../src/lib/breakoutRounds.ts';
import { applyElementGroups } from '../src/lib/elementGroups.ts';
import { hasNameStamp, isTeacherStampKind } from '../src/lib/stamps.ts';
import type { RoomState } from './types.ts';

import type { ServerContext, TypedSocket } from './types.ts';
export function registerDrawingHandlers(
  socket: TypedSocket,
  ctx: ServerContext,
  boardFull: (boardId: string, elements: any[]) => void
) {
  const { rooms, socketMeta, scheduleSaveToDisk, broadcastBreakoutSync, boardChannel, boardAudience, pendingCursors } =
    ctx;
  function getBoardElements(room: RoomState, boardId?: string): any[] | null {
    if (!boardId || boardId === 'main') return room.elements;
    const sb = room.subBoards.get(boardId);
    return sb ? sb.elements : null;
  }
  const publishDrawingEdit = ctx.publishDrawingEdit(socket);
  function clearBoardInk(room: RoomState, boardId: string, userId?: string) {
    const board = boardId === 'main' ? room : room.subBoards.get(boardId);
    if (board) {
      board.elements = userId ? board.elements.filter((el) => el.userId !== userId) : [];
      publishDrawingEdit(
        room,
        { full: true },
        'state-sync',
        { boardId, elements: board.elements },
        { includeSender: true, immediateSave: true }
      );
    } else {
      // A stale board selection still counts as room activity, as it did before.
      room.lastActiveAt = Date.now();
      scheduleSaveToDisk(room, true);
    }
  }
  socket.on('element-start', (element) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || !element || !element.id || !elementFieldsOk(element)) return;
    const room = rooms.get(meta.roomId);
    if (!room) return;

    const senderRecord = room.usersByUserId.get(meta.userId);
    if (room.isCanvasLocked && !senderRecord?.isTeacher) {
      return;
    }
    if (element.tool === 'stamp' && isTeacherStampKind(element.stamp) && !senderRecord?.isTeacher) {
      return;
    }

    const boardId = element.boardId || 'main';
    const targetElements = getBoardElements(room, boardId);
    if (!targetElements) return;

    if (
      room.oneNameStamp &&
      !senderRecord?.isTeacher &&
      element.tool === 'stamp' &&
      element.stamp === 'username' &&
      hasNameStamp(targetElements, meta.userId)
    ) {
      socket.emit('state-sync', { boardId, elements: targetElements }); // Drops the sender's optimistic copy
      return;
    }

    const authoredElement = {
      ...element,
      boardId,
      userId: meta.userId,
      userName: senderRecord?.name || element.userName,
    };

    const exists = targetElements.some((el) => el.id === authoredElement.id);
    if (!exists) {
      if (targetElements.length >= MAX_BOARD_ELEMENTS) return boardFull(boardId, targetElements);
      targetElements.push(authoredElement);
    }
    publishDrawingEdit(room, { upsert: [authoredElement.id] }, 'element-start', authoredElement);
  });

  socket.on('element-append-points', ({ id, boardId = 'main', newPoints }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || !id || !isPointArray(newPoints, MAX_APPEND_NUMBERS)) return;
    const room = rooms.get(meta.roomId);
    if (!room) return;

    const senderRecord = room.usersByUserId.get(meta.userId);
    if (room.isCanvasLocked && !senderRecord?.isTeacher) return;

    const targetElements = getBoardElements(room, boardId);
    if (!targetElements) return;

    const el = targetElements.find((item) => item.id === id);
    if (el && (el.userId === meta.userId || senderRecord?.isTeacher) && Array.isArray(el.points)) {
      if (el.points.length + newPoints.length > MAX_STROKE_NUMBERS) return; // stroke is long enough; drop the rest
      appendAll(el.points, newPoints);
      publishDrawingEdit(room, { upsert: [id] }, 'element-append-points', { id, boardId, newPoints });
    }
  });

  socket.on('element-update', (patch) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || !patch || !patch.id || !elementFieldsOk(patch)) return;
    const room = rooms.get(meta.roomId);
    if (!room) return;

    const senderRecord = room.usersByUserId.get(meta.userId);
    if (room.isCanvasLocked && !senderRecord?.isTeacher) return;

    const boardId = patch.boardId || 'main';
    const targetElements = getBoardElements(room, boardId);
    if (!targetElements) return;

    const idx = targetElements.findIndex((item) => item.id === patch.id);
    if (idx !== -1) {
      const existing = targetElements[idx];
      if (existing.userId !== meta.userId && !senderRecord?.isTeacher) return;
      const { bringToFront, userId: _ignoreUserId, userName: _ignoreUserName, ...cleanPatch } = patch;
      if (!senderRecord?.isTeacher && cleanPatch.stamp !== undefined && isTeacherStampKind(cleanPatch.stamp)) {
        delete cleanPatch.stamp;
      }
      if (!senderRecord?.isTeacher && room.oneNameStamp && cleanPatch.stamp === 'username') {
        delete cleanPatch.stamp;
      }
      const updated = { ...existing, ...cleanPatch };
      if (bringToFront) {
        targetElements.splice(idx, 1);
        targetElements.push(updated);
      } else {
        targetElements[idx] = updated;
      }
      publishDrawingEdit(room, bringToFront ? { full: true } : { upsert: [patch.id] }, 'element-update', {
        ...cleanPatch,
        boardId,
        bringToFront: Boolean(bringToFront),
      });
    }
  });

  socket.on('elements-batch-update', ({ boardId = 'main', updates, bringToFront = false }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || !Array.isArray(updates) || updates.length === 0 || updates.length > MAX_BATCH_ELEMENTS) return;
    const room = rooms.get(meta.roomId);
    if (!room) return;

    const senderRecord = room.usersByUserId.get(meta.userId);
    if (room.isCanvasLocked && !senderRecord?.isTeacher) return;

    const targetElements = getBoardElements(room, boardId);
    if (!targetElements) return;

    const updateMap = new Map<string, any>();
    for (const u of updates) {
      if (u && typeof u.id === 'string' && elementFieldsOk(u)) {
        updateMap.set(u.id, u);
      }
    }

    const appliedUpdates: any[] = [];
    const movedToFront: any[] = [];

    for (let i = 0; i < targetElements.length; ) {
      const el = targetElements[i];
      const patch = updateMap.get(el.id);
      if (patch && (el.userId === meta.userId || senderRecord?.isTeacher)) {
        const { bringToFront: _ignored, userId: _ignoreUserId, userName: _ignoreUserName, ...cleanPatch } = patch;
        if (!senderRecord?.isTeacher && cleanPatch.stamp !== undefined && isTeacherStampKind(cleanPatch.stamp)) {
          delete cleanPatch.stamp;
        }
        if (!senderRecord?.isTeacher && room.oneNameStamp && cleanPatch.stamp === 'username') {
          delete cleanPatch.stamp;
        }
        const merged = { ...el, ...cleanPatch };
        appliedUpdates.push(cleanPatch);
        if (bringToFront) {
          targetElements.splice(i, 1);
          movedToFront.push(merged);
          continue;
        } else {
          targetElements[i] = merged;
        }
      }
      i++;
    }

    if (bringToFront && movedToFront.length > 0) {
      targetElements.push(...movedToFront);
    }

    if (appliedUpdates.length > 0) {
      publishDrawingEdit(
        room,
        bringToFront ? { full: true } : { upsert: appliedUpdates.map((u) => u.id) },
        'elements-batch-updated',
        {
          boardId,
          updates: appliedUpdates,
          bringToFront: Boolean(bringToFront),
        }
      );
    }
  });

  socket.on('elements-batch-add', ({ boardId = 'main', elements: newElements }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || !Array.isArray(newElements) || newElements.length === 0) return;
    if (newElements.length > MAX_BATCH_ELEMENTS || !newElements.every((el) => elementFieldsOk(el))) return;
    const room = rooms.get(meta.roomId);
    if (!room) return;

    const senderRecord = room.usersByUserId.get(meta.userId);
    if (room.isCanvasLocked && !senderRecord?.isTeacher) return;

    if (boardId === 'ALL_SUBBOARDS') {
      if (!senderRecord?.isTeacher) return;
      let changed = false;
      for (const sb of getBoardsInRound(room.subBoards, room.breakoutConfig.activeRoundId)) {
        for (const el of newElements) {
          if (!el || typeof el.tool !== 'string') continue;
          if (sb.elements.length >= MAX_BOARD_ELEMENTS) break;
          const cloned = {
            ...el,
            id: Math.random().toString(36).substring(2, 11) + '_' + Math.random().toString(36).substring(2, 5),
            boardId: sb.id,
            userId: meta.userId,
            userName: senderRecord.name || el.userName,
            timestamp: Date.now(),
          };
          sb.elements.push(cloned);
          changed = true;
        }
      }
      if (changed) {
        room.lastActiveAt = Date.now();
        scheduleSaveToDisk(room);
        broadcastBreakoutSync(room);
      }
      return;
    }

    const targetElements = getBoardElements(room, boardId);
    if (!targetElements) return;

    const existingIds = new Set(targetElements.map((e) => e.id));
    const added: any[] = [];
    let rejectedNameStamp = false;
    let rejectedFull = false;
    for (const el of newElements) {
      if (!el || !el.id || existingIds.has(el.id)) continue;
      if (targetElements.length >= MAX_BOARD_ELEMENTS) {
        rejectedFull = true;
        break;
      }
      if (el.tool === 'stamp' && isTeacherStampKind(el.stamp) && !senderRecord?.isTeacher) {
        continue;
      }
      if (
        room.oneNameStamp &&
        !senderRecord?.isTeacher &&
        el.tool === 'stamp' &&
        el.stamp === 'username' &&
        hasNameStamp(targetElements, meta.userId)
      ) {
        rejectedNameStamp = true;
        continue;
      }
      const normalized = {
        ...el,
        boardId,
        userId: meta.userId,
        userName: senderRecord?.name || el.userName,
      };
      targetElements.push(normalized);
      existingIds.add(el.id);
      added.push(normalized);
    }

    if (added.length > 0) {
      publishDrawingEdit(room, { upsert: added.map((e) => e.id) }, 'elements-batch-added', {
        boardId,
        elements: added,
      });
    }
    if (rejectedFull) {
      boardFull(boardId, targetElements);
    } else if (rejectedNameStamp) {
      socket.emit('state-sync', { boardId, elements: targetElements }); // Drops the sender's optimistic copies
    }
  });

  socket.on('elements-batch-remove', ({ boardId = 'main', ids }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || !Array.isArray(ids) || ids.length === 0) return;
    const room = rooms.get(meta.roomId);
    if (!room) return;

    const senderRecord = room.usersByUserId.get(meta.userId);
    if (room.isCanvasLocked && !senderRecord?.isTeacher) return;

    const targetElements = getBoardElements(room, boardId);
    if (!targetElements) return;

    const idSet = new Set(ids);
    const removedIds: string[] = [];
    for (let i = targetElements.length - 1; i >= 0; i--) {
      const el = targetElements[i];
      if (idSet.has(el.id) && (el.userId === meta.userId || senderRecord?.isTeacher)) {
        removedIds.push(el.id);
        targetElements.splice(i, 1);
      }
    }

    if (removedIds.length > 0) {
      publishDrawingEdit(room, { removed: removedIds }, 'elements-batch-removed', { boardId, ids: removedIds });
    }
  });

  socket.on('elements-replace', (payload) => {
    const boardId = payload?.boardId === undefined ? 'main' : payload.boardId;
    const groups = payload?.groups;
    const meta = socketMeta.get(socket.id);
    if (!meta || !Array.isArray(groups) || groups.length === 0 || groups.length > MAX_BATCH_ELEMENTS) return;
    const room = rooms.get(meta.roomId);
    if (!room) return;
    const senderRecord = room.usersByUserId.get(meta.userId);
    const isTeacher = Boolean(senderRecord?.isTeacher);
    if (room.isCanvasLocked && !isTeacher) return;
    const targetElements = getBoardElements(room, boardId);
    if (!targetElements) return;

    let idCount = 0;
    let elCount = 0;
    for (const g of groups) {
      if (!g || !Array.isArray(g.ids) || !Array.isArray(g.elements)) return;
      if (g.after !== undefined && g.after !== null && typeof g.after !== 'string') return;
      if (!g.ids.every((id: unknown) => typeof id === 'string')) return;
      if (
        !g.elements.every(
          (el: any) => el && typeof el.id === 'string' && typeof el.tool === 'string' && elementFieldsOk(el)
        )
      )
        return;
      idCount += g.ids.length;
      elCount += g.elements.length;
    }
    if (idCount > MAX_BATCH_ELEMENTS || elCount > MAX_BATCH_ELEMENTS) return;

    const byId = new Map(targetElements.map((el) => [el.id, el]));
    const author = { userId: meta.userId, userName: senderRecord?.name };
    const clean = groups.map((g: any) => ({
      // Only the sender's own ink can be removed (teachers: anyone's), as with batch remove.
      ids: (g.ids as string[]).filter((id) => {
        const el = byId.get(id);
        return el && (el.userId === meta.userId || isTeacher);
      }),
      elements: (g.elements as any[])
        .filter((el) => !(el.tool === 'stamp' && isTeacherStampKind(el.stamp) && !isTeacher))
        .map((el) => ({ ...el, boardId, userId: author.userId, userName: author.userName || el.userName })),
      ...(g.after !== undefined ? { after: g.after } : {}),
    }));

    let next = applyElementGroups(targetElements, clean);
    if (next.length > MAX_BOARD_ELEMENTS && next.length > targetElements.length)
      return boardFull(boardId, targetElements);
    let droppedNameStamp = false;
    if (room.oneNameStamp && !isTeacher) {
      const isMine = (el: any) => el.tool === 'stamp' && el.stamp === 'username' && el.userId === meta.userId;
      if (next.filter(isMine).length > 1) {
        // Never a second name stamp: keep the one already down, drop the sender's optimistic copy below.
        next = next.filter((el) => !(isMine(el) && !byId.has(el.id)));
        droppedNameStamp = true;
      }
    }
    targetElements.splice(0, targetElements.length, ...next);

    if (droppedNameStamp) {
      publishDrawingEdit(
        room,
        { full: true },
        'state-sync',
        { boardId, elements: targetElements },
        { includeSender: true }
      );
    } else {
      publishDrawingEdit(room, { full: true }, 'elements-replaced', { boardId, groups: clean });
    }
  });

  socket.on('element-remove', ({ id, boardId = 'main' }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || !id) return;
    const room = rooms.get(meta.roomId);
    if (!room) return;

    const senderRecord = room.usersByUserId.get(meta.userId);
    if (room.isCanvasLocked && !senderRecord?.isTeacher) return;

    const targetElements = getBoardElements(room, boardId);
    if (!targetElements) return;

    const idx = targetElements.findIndex((item) => item.id === id);
    if (idx !== -1) {
      const el = targetElements[idx];
      if (el.userId === meta.userId || senderRecord?.isTeacher) {
        targetElements.splice(idx, 1);
        publishDrawingEdit(room, { removed: [id] }, 'element-removed', { id, boardId });
      }
    }
  });

  socket.on('laser-pulse', (payload: unknown) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || !payload || typeof payload !== 'object') return;
    const room = rooms.get(meta.roomId);
    if (!room?.usersByUserId.get(meta.userId)?.isTeacher) return;
    const pulse = payload as { boardId?: unknown; x?: unknown; y?: unknown; strokeId?: unknown };
    if (
      typeof pulse.boardId !== 'string' ||
      meta.channel !== boardChannel(room.id, pulse.boardId) ||
      typeof pulse.x !== 'number' ||
      !Number.isFinite(pulse.x) ||
      typeof pulse.y !== 'number' ||
      !Number.isFinite(pulse.y) ||
      typeof pulse.strokeId !== 'string' ||
      pulse.strokeId.length > 64
    )
      return;
    socket.to(boardAudience(room.id, pulse.boardId)).emit('laser-pulse', {
      boardId: pulse.boardId,
      x: pulse.x,
      y: pulse.y,
      strokeId: pulse.strokeId,
      userId: meta.userId,
    });
  });

  socket.on('cursor-move', (cursorData) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    if (!cursorData || typeof cursorData !== 'object') return;
    const boardId = typeof cursorData.boardId === 'string' ? cursorData.boardId : 'main';
    const channel = boardAudience(meta.roomId, boardId);
    if (meta.channel !== channel) return; // only the board this socket is actually on
    const sender = rooms.get(meta.roomId)?.usersByUserId.get(meta.userId);
    let byUser = pendingCursors.get(channel);
    if (!byUser) pendingCursors.set(channel, (byUser = new Map()));
    byUser.set(meta.userId, {
      socketId: socket.id,
      cursor: { ...cursorData, boardId, userId: meta.userId, userName: sender?.name || cursorData.userName },
    });
  });

  socket.on('undo', (payload) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = rooms.get(meta.roomId);
    if (!room) return;

    const userId = typeof payload === 'string' ? payload : payload?.userId;
    const boardId = (typeof payload === 'object' && payload?.boardId) || 'main';
    if (!userId) return;

    const senderRecord = room.usersByUserId.get(meta.userId);
    if (userId !== meta.userId && !senderRecord?.isTeacher) return;
    if (room.isCanvasLocked && !senderRecord?.isTeacher) return;

    const targetElements = getBoardElements(room, boardId);
    if (!targetElements) return;

    for (let i = targetElements.length - 1; i >= 0; i--) {
      if (targetElements[i].userId === userId) {
        const removed = targetElements.splice(i, 1)[0];
        publishDrawingEdit(
          room,
          { removed: [removed.id] },
          'element-removed',
          { id: removed.id, boardId },
          { includeSender: true }
        );
        break;
      }
    }
  });

  socket.on('clear-user-drawings', (payload) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = rooms.get(meta.roomId);
    if (!room) return;

    const targetUserId = typeof payload === 'string' ? payload : payload?.targetUserId;
    const boardId = (typeof payload === 'object' && payload?.boardId) || 'main';
    if (!targetUserId) return;

    const callerRecord = room.usersByUserId.get(meta.userId);
    if (meta.userId !== targetUserId && !callerRecord?.isTeacher) {
      return;
    }
    if (room.isCanvasLocked && !callerRecord?.isTeacher) {
      return;
    }

    clearBoardInk(room, boardId, targetUserId);
  });

  socket.on('teacher:clear-all', (payload) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = rooms.get(meta.roomId);
    if (!room) return;

    const callerRecord = room.usersByUserId.get(meta.userId);
    if (!callerRecord?.isTeacher) return;

    const boardId = payload?.boardId || 'main';
    clearBoardInk(room, boardId);
  });
}
