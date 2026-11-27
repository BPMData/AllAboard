import { buildDigest, emptyChanges, type BoardChanges, type BoardDigest } from '../src/lib/boardDigest.ts';
import { findStudentBoardId } from '../src/lib/breakoutRounds.ts';
import type { ClientToServerEvents, ServerToClientEvents } from '../src/lib/socketContract.ts';
import { getRoomSettingsPayload, getRosterPayload, serializeSubBoards } from './roomSerialization.ts';
import type { RoomState, SocketMeta, SubBoardState, TypedIo, TypedSocket } from './types.ts';

type DrawingChange = { upsert?: string[]; removed?: string[]; full?: boolean };
export function createBoardChannels({
  io,
  rooms,
  socketMeta,
  scheduleSaveToDisk,
}: {
  io: TypedIo;
  rooms: Map<string, RoomState>;
  socketMeta: Map<string, SocketMeta>;
  scheduleSaveToDisk: (room: RoomState, immediate?: boolean) => void;
}) {
  /** roomId → boardId → changes since the last digest. */
  const pendingDigests = new Map<string, Map<string, BoardChanges>>();
  /** board channel → userId → latest cursor (and the socket that sent it). */
  const pendingCursors = new Map<
    string,
    Map<string, { socketId: string; cursor: Parameters<ClientToServerEvents['cursor-move']>[0] }>
  >();
  function boardChannel(roomId: string, boardId: string): string {
    return `${roomId}\u0000board:${boardId}`;
  }

  function teacherChannel(roomId: string): string {
    return `${roomId}\u0000teachers`;
  }

  /** Viewers of this board. Ephemeral events also use this channel. */
  function boardAudience(roomId: string, boardId: string | undefined): string {
    return boardChannel(roomId, boardId || 'main');
  }

  function boardElementsOf(room: RoomState, boardId: string): any[] | null {
    if (boardId === 'main') return room.elements;
    return room.subBoards.get(boardId)?.elements ?? null;
  }

  function noteChange(room: RoomState, boardId: string | undefined, change: DrawingChange) {
    const bId = boardId || 'main';
    let boards = pendingDigests.get(room.id);
    if (!boards) pendingDigests.set(room.id, (boards = new Map()));
    let c = boards.get(bId);
    if (!c) boards.set(bId, (c = emptyChanges()));
    if (change.full) c.full = true;
    for (const id of change.upsert ?? []) {
      c.removed.delete(id);
      c.upserts.add(id);
    }
    for (const id of change.removed ?? []) {
      c.upserts.delete(id);
      c.removed.add(id);
    }
  }

  function flushDigests() {
    for (const [roomId, boards] of pendingDigests) {
      pendingDigests.delete(roomId);
      const room = rooms.get(roomId);
      const teacherIds = io.sockets.adapter.rooms.get(teacherChannel(roomId));
      if (!room || !teacherIds || teacherIds.size === 0) continue;
      const digests: BoardDigest[] = [];
      for (const [boardId, changes] of boards) {
        const elements = boardElementsOf(room, boardId);
        if (elements) digests.push(buildDigest(boardId, changes, elements));
      }
      if (digests.length === 0) continue;
      for (const id of teacherIds) {
        const viewing = socketMeta.get(id)?.viewBoardId ?? 'main';
        const forSocket = digests.filter((d) => d.boardId !== viewing); // that one is already live
        if (forSocket.length) io.to(id).emit('boards-digest', { boards: forSocket });
      }
    }
  }

  function flushCursors() {
    for (const [channel, byUser] of pendingCursors) {
      pendingCursors.delete(channel);
      // Drop positions from sockets that left the board (or disconnected) since they moved: cursor-leave already went out.
      const moved = Array.from(byUser.values()).filter((p) => socketMeta.get(p.socketId)?.channel === channel);
      if (moved.length === 0) continue;
      const batch = { cursors: moved.map((p) => p.cursor) };
      // One mover (e.g. a student alone on an individual board): don't echo it back to that socket.
      if (moved.length === 1) io.to(channel).except(moved[0].socketId).emit('cursors-batch', batch);
      else io.to(channel).emit('cursors-batch', batch);
    }
  }

  /**
   * Puts the socket in the right board channel (students: their assigned board; teachers: the board they view) and,
   * for teachers, the digest channel. With `catchUp`, a socket that moved is sent the state it missed.
   */
  function placeSocket(socketId: string, room: RoomState, catchUp: boolean) {
    const meta = socketMeta.get(socketId);
    const socket = io.sockets.sockets.get(socketId);
    if (!meta || !socket || meta.roomId !== room.id) return;
    const isTeacher = Boolean(room.usersByUserId.get(meta.userId)?.isTeacher);
    let boardId: string;
    if (isTeacher) {
      const wanted = meta.viewBoardId || 'main';
      boardId = wanted === 'main' || room.subBoards.has(wanted) ? wanted : 'main';
    } else {
      boardId = findStudentBoardId(room.subBoards, room.breakoutConfig, meta.userId);
    }

    const becameTeacher = isTeacher && !meta.inTeachers;
    if (isTeacher !== Boolean(meta.inTeachers)) {
      if (isTeacher) socket.join(teacherChannel(room.id));
      else socket.leave(teacherChannel(room.id));
      meta.inTeachers = isTeacher;
    }

    const next = boardChannel(room.id, boardId);
    const prev = meta.channel;
    if (prev !== next) {
      if (prev) {
        socket.leave(prev);
        socket.to(prev).emit('cursor-leave', { userId: meta.userId });
      }
      socket.join(next);
      meta.channel = next;
    }
    if (!catchUp || !prev) return;
    if (becameTeacher) {
      // As a student it only heard its own board; now it needs everything.
      socket.emit('state-sync', { boardId: 'main', elements: room.elements });
      socket.emit('breakout-sync', {
        breakoutConfig: room.breakoutConfig,
        subBoards: serializeSubBoards(room.subBoards),
        ...teacherTemplatesPayload(room),
      });
    } else if (prev !== next) {
      const elements = boardElementsOf(room, boardId);
      // A sub-board's chat came stripped like its ink (subBoardsFor), so it rides along.
      const messages = boardId === 'main' ? undefined : room.subBoards.get(boardId)?.messages;
      if (elements) socket.emit('state-sync', messages ? { boardId, elements, messages } : { boardId, elements });
    }
  }

  /** Re-places every socket in the room. Call whenever roles, breakout mode or board assignments may have changed. */
  function syncBoardChannels(room: RoomState, catchUp = true) {
    const ids = io.sockets.adapter.rooms.get(room.id);
    if (!ids) return;
    for (const id of Array.from(ids)) placeSocket(id, room, catchUp);
  }

  function broadcastRoster(room: RoomState) {
    syncBoardChannels(room);
    io.to(room.id).emit('roster-sync', getRosterPayload(room));
  }

  function broadcastRoomSettings(room: RoomState) {
    syncBoardChannels(room);
    io.to(room.id).emit('room-settings', getRoomSettingsPayload(room));
  }

  /**
   * Sub-boards as one user should receive them. Teachers get everything. Students get every board's metadata and
   * background but only their *own* board's ink and chat, since they never see the rest (and placeSocket sends a
   * fresh copy when they move). In a 20-board breakout this makes each student's copy ~20x smaller.
   */
  function subBoardsFor(room: RoomState, userId: string): Record<string, SubBoardState> {
    const all = serializeSubBoards(room.subBoards);
    if (room.usersByUserId.get(userId)?.isTeacher) return all;
    const mine = findStudentBoardId(room.subBoards, room.breakoutConfig, userId);
    const out: Record<string, SubBoardState> = {};
    for (const [id, sb] of Object.entries(all)) out[id] = id === mine ? sb : { ...sb, elements: [], messages: [] };
    return out;
  }

  function broadcastBreakoutSync(room: RoomState) {
    syncBoardChannels(room);
    const ids = io.sockets.adapter.rooms.get(room.id);
    if (!ids) return;
    const full = serializeSubBoards(room.subBoards);
    for (const id of ids) {
      const meta = socketMeta.get(id);
      if (!meta || meta.inTeachers) {
        io.to(id).emit('breakout-sync', {
          breakoutConfig: room.breakoutConfig,
          subBoards: full,
          ...teacherTemplatesPayload(room),
        });
      } else {
        io.to(id).emit('breakout-sync', {
          breakoutConfig: room.breakoutConfig,
          subBoards: subBoardsFor(room, meta.userId),
        });
      }
    }
  }

  /** Teacher-only: the round templates and their ink, as sent with `init`, `breakout-sync` and `round-templates-sync`. */
  function teacherTemplatesPayload(room: RoomState) {
    return {
      roundTemplates: room.roundTemplates,
      roundTemplateInk: room.roundTemplateInk,
      roundVariants: room.roundVariants,
    };
  }
  /** Publish an accepted edit to its viewers, the teacher overview, and the room store. */
  function publishDrawingEdit(socket: TypedSocket) {
    return function publishDrawingEdit<
      K extends
        | 'element-start'
        | 'element-append-points'
        | 'element-update'
        | 'elements-batch-updated'
        | 'elements-batch-added'
        | 'elements-batch-removed'
        | 'elements-replaced'
        | 'element-removed'
        | 'state-sync',
    >(
      room: RoomState,
      change: DrawingChange,
      event: K,
      payload: Parameters<ServerToClientEvents[K]>[0] & { boardId: string },
      options: { includeSender?: boolean; immediateSave?: boolean } = {}
    ) {
      room.lastActiveAt = Date.now();
      scheduleSaveToDisk(room, options.immediateSave);
      noteChange(room, payload.boardId, change);
      const audience = options.includeSender ? io : socket;
      const channel = audience.to(boardAudience(room.id, payload.boardId));
      // Socket.IO decorates broadcast acknowledgments; drawing events have no acknowledgments.
      const emit = channel.emit as (event: K, payload: Parameters<ServerToClientEvents[K]>[0]) => boolean;
      emit.call(channel, event, payload);
    };
  }
  return {
    publishDrawingEdit,
    boardChannel,
    teacherChannel,
    boardAudience,
    boardElementsOf,
    noteChange,
    flushDigests,
    flushCursors,
    placeSocket,
    syncBoardChannels,
    broadcastRoster,
    broadcastRoomSettings,
    subBoardsFor,
    broadcastBreakoutSync,
    teacherTemplatesPayload,
    pendingCursors,
  };
}
