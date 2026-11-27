import {
  MAX_PIN_LENGTH,
  MIN_PIN_LENGTH,
  hashPin,
  verifyPin
} from '../socketGuards.ts';
import { isAnonymousAuthorId } from '../src/lib/anonymousInk.ts';
import type { StudentStatus } from '../src/types.ts';
import { MAX_CHAT_CHARS, checkUserKey, getRoomSettingsPayload, getRosterPayload, normalizeRoomId } from './roomSerialization.ts';

import type { ServerContext, TypedSocket } from './types.ts';
export function registerModerationHandlers(socket: TypedSocket, ctx: ServerContext) {
  const { io, rooms, socketMeta, pinFailures, getRoomAvailability, getOrCreateRoom, scheduleSaveToDisk, teacherChannel, broadcastRoster, startAutoIndividualRound, ensureIndividualBoardForUser, placeSocket, subBoardsFor, teacherTemplatesPayload, broadcastRoomSettings, broadcastBreakoutSync, boardChannel } = ctx;
  let provenPin: string | null = null;
  const PIN_BLOCKED_ERROR = 'Too many wrong Teacher PINs for this room. Wait a few minutes and try again.';
  socket.on('check-room', (payload: { roomId?: string } | undefined, callback) => {
    callback?.(getRoomAvailability(payload?.roomId));
  });

  socket.on('join-room', async ({ roomId: rawRoomId, userId, userKey, name, color, teacherPin }) => {
    if (!userId || typeof userId !== 'string' || isAnonymousAuthorId(userId)) return;

    const room = getOrCreateRoom(rawRoomId);
    const offeredPin = typeof teacherPin === 'string' ? teacherPin.trim().slice(0, MAX_PIN_LENGTH) : '';
    let pinMatches = false;
    if (offeredPin && room.teacherPinHash && !pinFailures.isBlocked(room.id)) {
      pinMatches = await verifyPin(offeredPin, room.teacherPinHash);
      if (pinMatches) provenPin = `${room.id}\u0000${offeredPin}`;
      else pinFailures.fail(room.id);
    }
    const keyCheck = checkUserKey(room.userKeyHashes, userId, userKey);
    if (keyCheck === 'rejected') {
      socket.emit('room-kicked', { reason: 'identity', roomId: room.id });
      return;
    }
    if (keyCheck === 'claimed') scheduleSaveToDisk(room);

    const prevMeta = socketMeta.get(socket.id);
    if (prevMeta && prevMeta.roomId !== normalizeRoomId(rawRoomId)) {
      const prevRoom = rooms.get(prevMeta.roomId);
      socket.leave(prevMeta.roomId);
      if (prevMeta.channel) socket.leave(prevMeta.channel);
      if (prevMeta.inTeachers) socket.leave(teacherChannel(prevMeta.roomId));
      if (prevRoom) {
        const prevUser = prevRoom.usersByUserId.get(prevMeta.userId);
        if (prevUser) {
          prevUser.sockets.delete(socket.id);
          if (prevUser.sockets.size === 0) {
            io.to(prevRoom.id).emit('cursor-leave', { userId: prevMeta.userId });
          }
          broadcastRoster(prevRoom);
        }
      }
    }

    // Block banned students from joining the room
    const existing = room.usersByUserId.get(userId);
    let isVerifiedTeacher = false;
    if (pinMatches) {
      isVerifiedTeacher = true;
    } else if (existing?.isTeacher && room.teacherPinHash && keyCheck === 'matched') {
      // Teacher status carries over only with proof this is the same browser; otherwise the PIN is required.
      isVerifiedTeacher = true;
    }

    if (room.bannedUsers[userId] && !isVerifiedTeacher) {
      socket.emit('room-kicked', { reason: 'banned', roomId: room.id });
      return;
    }

    room.lastActiveAt = Date.now();
    socket.join(room.id);
    // Same room again: keep the channel so placeSocket can move it if needed. New room: left above.
    const same = prevMeta && prevMeta.roomId === room.id ? prevMeta : undefined;
    socketMeta.set(socket.id, {
      roomId: room.id,
      userId,
      channel: same?.channel,
      viewBoardId: same?.viewBoardId,
      inTeachers: same?.inTeachers,
    });

    const lockedName = room.lockedNames[userId];
    const isNameLocked = Boolean(lockedName);
    const effectiveName = lockedName || (name && String(name).trim() ? String(name).trim() : '');

    let createdSubBoard = false;
    let autoStartedRound = false;
    if (effectiveName) {
      if (existing) {
        existing.name = effectiveName;
        existing.color = color || existing.color;
        existing.isTeacher = isVerifiedTeacher;
        existing.isNameLocked = isNameLocked;
        existing.sockets.add(socket.id);
      } else {
        room.usersByUserId.set(userId, {
          userId,
          name: effectiveName,
          color: color || '#2563eb',
          isTeacher: isVerifiedTeacher,
          isNameLocked,
          sockets: new Set([socket.id]),
        });
      }
      if (!isVerifiedTeacher && room.breakoutConfig.autoIndividual && room.breakoutConfig.mode === 'main') {
        autoStartedRound = startAutoIndividualRound(room);
      }
      createdSubBoard = ensureIndividualBoardForUser(room, userId, effectiveName, isVerifiedTeacher);
      if (autoStartedRound || createdSubBoard) {
        scheduleSaveToDisk(room, autoStartedRound);
      }
    }

    placeSocket(socket.id, room, false); // `init` below is the full, fresh state
    socket.emit('init', {
      messages: room.messages,
      elements: room.elements,
      background: room.background,
      subBoards: subBoardsFor(room, userId),
      users: getRosterPayload(room),
      roomSettings: getRoomSettingsPayload(room),
      isTeacher: isVerifiedTeacher,
      ...(isVerifiedTeacher ? teacherTemplatesPayload(room) : {}),
      assignedName: effectiveName || undefined,
      isNameLocked,
    });

    broadcastRoster(room);
    if (autoStartedRound) {
      broadcastRoomSettings(room);
      broadcastBreakoutSync(room);
    } else if (createdSubBoard) {
      broadcastBreakoutSync(room);
    }
  });

  socket.on('teacher:auth', async ({ pin }, callback) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) {
      callback?.({ ok: false, error: 'Join the room first.' });
      return;
    }
    const room = rooms.get(meta.roomId);
    if (!room) {
      callback?.({ ok: false, error: 'Room not found.' });
      return;
    }

    const cleanPin = String(pin || '').trim();
    if (!cleanPin || cleanPin.length > MAX_PIN_LENGTH) {
      callback?.({ ok: false, error: `PIN must be ${MIN_PIN_LENGTH} to ${MAX_PIN_LENGTH} characters.` });
      return;
    }

    const userRecord = room.usersByUserId.get(meta.userId);
    if (!userRecord) {
      callback?.({ ok: false, error: 'User profile not registered in room.' });
      return;
    }

    if (room.teacherPinHash === null) {
      // Only new PINs need the minimum length; rooms claimed earlier with 3 characters still verify below.
      if (cleanPin.length < MIN_PIN_LENGTH) {
        callback?.({ ok: false, error: `PIN must be at least ${MIN_PIN_LENGTH} characters.` });
        return;
      }
      const hash = await hashPin(cleanPin);
      if (room.teacherPinHash !== null) {
        callback?.({ ok: false, error: 'Someone just set a Teacher PIN for this room. Enter that PIN instead.' });
        return;
      }
      room.teacherPinHash = hash;
      provenPin = `${room.id}\u0000${cleanPin}`;
      room.lastActiveAt = Date.now();
      userRecord.isTeacher = true;
      scheduleSaveToDisk(room, true);
      broadcastRoomSettings(room);
      broadcastRoster(room);
      callback?.({ ok: true, mode: 'claimed', pin: cleanPin });
      return;
    }

    if (provenPin !== `${room.id}\u0000${cleanPin}`) {
      if (pinFailures.isBlocked(room.id)) {
        callback?.({ ok: false, error: PIN_BLOCKED_ERROR });
        return;
      }
      if (!(await verifyPin(cleanPin, room.teacherPinHash))) {
        pinFailures.fail(room.id);
        callback?.({
          ok: false,
          error: 'Incorrect Teacher PIN for this room. Need a fresh board? Click "New Room" to create a new room where you can set the PIN first.',
        });
        return;
      }
      provenPin = `${room.id}\u0000${cleanPin}`;
    }
    userRecord.isTeacher = true;
    broadcastRoster(room);
    callback?.({ ok: true, mode: 'verified', pin: cleanPin });
  });

  socket.on('user:set-status', (payload: { status?: unknown } | undefined) => {
    const meta = socketMeta.get(socket.id);
    const room = meta && rooms.get(meta.roomId);
    const record = meta && room?.usersByUserId.get(meta.userId);
    const status = payload?.status;
    if (!room || !record || record.isTeacher || !['none', 'need-help', 'got-it', 'done'].includes(status as string)) return;
    record.status = status as StudentStatus;
    record.statusUpdatedAt = Date.now();
    broadcastRoster(room);
  });

  socket.on('teacher:clear-status', (payload: { targetUserId?: unknown } | undefined) => {
    const meta = socketMeta.get(socket.id);
    const room = meta && rooms.get(meta.roomId);
    if (!meta || !room?.usersByUserId.get(meta.userId)?.isTeacher) return;
    if (payload?.targetUserId !== undefined && typeof payload.targetUserId !== 'string') return;
    for (const record of room.usersByUserId.values()) {
      if (!record.isTeacher && (payload?.targetUserId === undefined || record.userId === payload.targetUserId)) {
        record.status = 'none';
        record.statusUpdatedAt = Date.now();
      }
    }
    broadcastRoster(room);
  });

  socket.on('teacher:step-down', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = rooms.get(meta.roomId);
    if (!room) return;
    const userRecord = room.usersByUserId.get(meta.userId);
    if (userRecord) {
      userRecord.isTeacher = false;
      broadcastRoster(room);
    }
  });

  socket.on('update-profile', ({ name, color }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = rooms.get(meta.roomId);
    if (!room) return;
    const userId = meta.userId; // Only ever your own profile, whatever the payload says
    const existing = room.usersByUserId.get(userId);
    if (existing) {
      const isLockedByTeacher = Boolean(room.lockedNames[userId] || existing.isNameLocked);
      if (name && (!isLockedByTeacher || existing.isTeacher)) {
        existing.name = String(name).trim();
        let renamedBoard = false;
        for (const sb of room.subBoards.values()) {
          if (sb.kind === 'individual' && sb.assignedUserIds[0] === userId) {
            sb.title = `${existing.name}'s Board`;
            renamedBoard = true;
          }
        }
        if (renamedBoard) broadcastBreakoutSync(room);
      }
      if (color) existing.color = color;
      broadcastRoster(room);
    }
  });

  socket.on('teacher:rename-user', ({ targetUserId, newName }, callback) => {
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
      callback?.({ ok: false, error: 'Only a verified Teacher can rename users.' });
      return;
    }

    const cleanName = String(newName || '').trim().slice(0, 28);
    if (!targetUserId || !cleanName) {
      callback?.({ ok: false, error: 'A valid target user and name are required.' });
      return;
    }

    room.lockedNames[targetUserId] = cleanName;
    const targetRecord = room.usersByUserId.get(targetUserId);
    if (targetRecord) {
      targetRecord.name = cleanName;
      targetRecord.isNameLocked = true;
    }
    if (room.bannedUsers[targetUserId]) {
      room.bannedUsers[targetUserId].name = cleanName;
    }

    // Retroactively scrub userName on all messages and canvas elements in main + sub-boards
    for (const msg of room.messages) {
      if (msg && msg.userId === targetUserId) {
        msg.userName = cleanName;
      }
    }
    for (const el of room.elements) {
      if (el && el.userId === targetUserId) {
        el.userName = cleanName;
      }
    }
    for (const sb of room.subBoards.values()) {
      if (sb.kind === 'individual' && sb.assignedUserIds[0] === targetUserId) {
        sb.title = `${cleanName}'s Board`;
      }
      for (const msg of sb.messages) {
        if (msg && msg.userId === targetUserId) {
          msg.userName = cleanName;
        }
      }
      for (const el of sb.elements) {
        if (el && el.userId === targetUserId) {
          el.userName = cleanName;
        }
      }
    }

    room.lastActiveAt = Date.now();
    scheduleSaveToDisk(room, true);

    io.to(room.id).emit('user-renamed', {
      userId: targetUserId,
      newName: cleanName,
      isNameLocked: true,
    });
    broadcastRoster(room);
    broadcastBreakoutSync(room);
    callback?.({ ok: true, newName: cleanName });
  });

  socket.on('teacher:delete-message', ({ messageId, boardId = 'main' }, callback) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || !messageId) {
      callback?.({ ok: false, error: 'Invalid request.' });
      return;
    }
    const room = rooms.get(meta.roomId);
    if (!room) {
      callback?.({ ok: false, error: 'Room not found.' });
      return;
    }
    const callerRecord = room.usersByUserId.get(meta.userId);
    if (!callerRecord?.isTeacher) {
      callback?.({ ok: false, error: 'Only a verified Teacher can delete chat messages.' });
      return;
    }

    room.messages = room.messages.filter((m) => m.id !== messageId);
    for (const sb of room.subBoards.values()) {
      sb.messages = sb.messages.filter((m) => m.id !== messageId);
    }

    room.lastActiveAt = Date.now();
    scheduleSaveToDisk(room);
    io.to(room.id).emit('message-deleted', { messageId, boardId });
    callback?.({ ok: true });
  });

  socket.on(
    'teacher:kick-user',
    (
      {
        targetUserId,
        mode = 'kick',
        targetName,
      }: { targetUserId: string; mode?: 'kick' | 'ban'; targetName?: string },
      callback
    ) => {
      const meta = socketMeta.get(socket.id);
      if (!meta || !targetUserId) {
        callback?.({ ok: false, error: 'Invalid request.' });
        return;
      }
      const room = rooms.get(meta.roomId);
      if (!room) {
        callback?.({ ok: false, error: 'Room not found.' });
        return;
      }
      const callerRecord = room.usersByUserId.get(meta.userId);
      if (!callerRecord?.isTeacher) {
        callback?.({ ok: false, error: 'Only a verified Teacher can remove users.' });
        return;
      }
      if (targetUserId === meta.userId) {
        callback?.({ ok: false, error: 'Cannot kick yourself.' });
        return;
      }

      const targetRecord = room.usersByUserId.get(targetUserId);
      const resolvedName =
        targetRecord?.name || room.lockedNames[targetUserId] || targetName || 'Student';

      if (mode === 'ban') {
        room.bannedUsers[targetUserId] = {
          userId: targetUserId,
          name: resolvedName,
          bannedAt: Date.now(),
        };
      }

      // Collect all sockets belonging to targetUserId in this room
      const targetSocketIds = new Set<string>(targetRecord ? Array.from(targetRecord.sockets) : []);
      for (const [sockId, sMeta] of socketMeta.entries()) {
        if (sMeta.roomId === room.id && sMeta.userId === targetUserId) {
          targetSocketIds.add(sockId);
        }
      }

      for (const sockId of targetSocketIds) {
        const targetSock = io.sockets.sockets.get(sockId);
        if (targetSock) {
          targetSock.emit('room-kicked', {
            reason: mode === 'ban' ? 'banned' : 'kicked',
            roomId: room.id,
          });
          targetSock.leave(room.id);
        }
        socketMeta.delete(sockId);
      }

      if (targetRecord) {
        targetRecord.sockets.clear();
        room.usersByUserId.delete(targetUserId);
      }

      io.to(room.id).emit('cursor-leave', { userId: targetUserId });
      room.lastActiveAt = Date.now();
      scheduleSaveToDisk(room, true);
      broadcastRoster(room);
      broadcastRoomSettings(room);
      callback?.({ ok: true });
    }
  );

  socket.on('teacher:unban-user', ({ targetUserId }, callback) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || !targetUserId) {
      callback?.({ ok: false, error: 'Invalid request.' });
      return;
    }
    const room = rooms.get(meta.roomId);
    if (!room) {
      callback?.({ ok: false, error: 'Room not found.' });
      return;
    }
    const callerRecord = room.usersByUserId.get(meta.userId);
    if (!callerRecord?.isTeacher) {
      callback?.({ ok: false, error: 'Only a verified Teacher can unban users.' });
      return;
    }

    delete room.bannedUsers[targetUserId];
    room.lastActiveAt = Date.now();
    scheduleSaveToDisk(room, true);
    broadcastRoomSettings(room);
    callback?.({ ok: true });
  });

  socket.on('teacher:purge-user-contributions', ({ targetUserId }: { targetUserId?: string }, callback) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || !targetUserId) {
      callback?.({ ok: false, error: 'Invalid request.' });
      return;
    }
    const room = rooms.get(meta.roomId);
    if (!room) {
      callback?.({ ok: false, error: 'Room not found.' });
      return;
    }
    const callerRecord = room.usersByUserId.get(meta.userId);
    if (!callerRecord?.isTeacher) {
      callback?.({ ok: false, error: 'Only a verified Teacher can delete user contributions.' });
      return;
    }

    const prevMainEls = room.elements.length;
    const prevMainMsgs = room.messages.length;
    room.elements = room.elements.filter((el) => el?.userId !== targetUserId);
    room.messages = room.messages.filter((m) => m?.userId !== targetUserId);

    let removedElements = prevMainEls - room.elements.length;
    let removedMessages = prevMainMsgs - room.messages.length;

    for (const sb of room.subBoards.values()) {
      const beforeSbEls = sb.elements.length;
      const beforeSbMsgs = sb.messages.length;
      sb.elements = sb.elements.filter((el) => el?.userId !== targetUserId);
      sb.messages = sb.messages.filter((m) => m?.userId !== targetUserId);
      removedElements += beforeSbEls - sb.elements.length;
      removedMessages += beforeSbMsgs - sb.messages.length;
    }

    room.lastActiveAt = Date.now();
    scheduleSaveToDisk(room, true);
    io.to(room.id).emit('user-contributions-purged', { targetUserId });
    callback?.({ ok: true, removedElements, removedMessages });
  });

  socket.on('chat-message', (msg) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || !msg || !msg.text || !String(msg.text).trim()) return;
    const room = rooms.get(meta.roomId);
    if (!room) return;

    const senderRecord = room.usersByUserId.get(meta.userId);
    const boardId = typeof msg.boardId === 'string' && msg.boardId ? msg.boardId : 'main';
    const boardScoped = room.breakoutConfig.chatScope === 'board' && boardId !== 'main';
    // Students post only to the main chat or the board they're on; teachers to any board.
    if (boardScoped && !senderRecord?.isTeacher && meta.channel !== boardChannel(room.id, boardId)) return;
    const message = {
      id: Math.random().toString(36).substring(2, 11),
      boardId,
      userId: meta.userId,
      userName: senderRecord?.name || msg.userName || 'Student',
      userColor: senderRecord?.color || msg.userColor,
      isTeacher: Boolean(senderRecord?.isTeacher),
      text: String(msg.text).trim().slice(0, MAX_CHAT_CHARS),
      timestamp: Date.now(),
    };

    if (boardScoped) {
      const sb = room.subBoards.get(boardId);
      if (sb) {
        sb.messages.push(message);
        if (sb.messages.length > 300) sb.messages.shift();
      }
    } else {
      room.messages.push(message);
      if (room.messages.length > 500) room.messages.shift();
    }

    room.lastActiveAt = Date.now();
    scheduleSaveToDisk(room);
    // Board chat goes only to that board and to teachers; everything else is room-wide.
    if (boardScoped) io.to([boardChannel(room.id, boardId), teacherChannel(room.id)]).emit('chat-message', message);
    else io.to(room.id).emit('chat-message', message);
  });

  socket.on('teacher:set-hide-cursors', (hide: boolean) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = rooms.get(meta.roomId);
    if (!room || !room.usersByUserId.get(meta.userId)?.isTeacher) return;

    room.hideStudentCursors = Boolean(hide);
    room.lastActiveAt = Date.now();
    scheduleSaveToDisk(room, true);
    broadcastRoomSettings(room);
  });

  socket.on('teacher:set-one-name-stamp', (enabled: boolean) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = rooms.get(meta.roomId);
    if (!room || !room.usersByUserId.get(meta.userId)?.isTeacher) return;

    room.oneNameStamp = Boolean(enabled);
    room.lastActiveAt = Date.now();
    scheduleSaveToDisk(room, true);
    broadcastRoomSettings(room);
  });

  socket.on('teacher:set-lock', (isLocked: boolean) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = rooms.get(meta.roomId);
    if (!room) return;

    const callerRecord = room.usersByUserId.get(meta.userId);
    if (!callerRecord?.isTeacher) return;

    room.isCanvasLocked = Boolean(isLocked);
    room.lastActiveAt = Date.now();
    scheduleSaveToDisk(room, true);
    broadcastRoomSettings(room);
  });

  socket.on(
    'teacher:timer-control',
    (
      payload: {
        action: 'start' | 'pause' | 'resume' | 'stop' | 'add-minute' | 'set-autolock';
        durationSeconds?: number;
        autoLockOnExpire?: boolean;
      },
      callback
    ) => {
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
        callback?.({ ok: false, error: 'Only a verified Teacher can control the classroom timer.' });
        return;
      }

      const now = Date.now();
      const action = payload?.action;

      if (typeof payload?.autoLockOnExpire === 'boolean') {
        room.timer.autoLockOnExpire = payload.autoLockOnExpire;
      }

      if (action === 'start') {
        const secs = Math.max(5, Math.min(7200, Math.round(Number(payload.durationSeconds) || 300)));
        const durationMs = secs * 1000;
        room.timer = {
          isRunning: true,
          durationMs,
          remainingMs: durationMs,
          endsAt: now + durationMs,
          autoLockOnExpire:
            typeof payload.autoLockOnExpire === 'boolean'
              ? payload.autoLockOnExpire
              : room.timer.autoLockOnExpire,
        };
      } else if (action === 'pause') {
        if (room.timer.isRunning && room.timer.endsAt !== null) {
          room.timer.remainingMs = Math.max(0, room.timer.endsAt - now);
        }
        room.timer.isRunning = false;
        room.timer.endsAt = null;
      } else if (action === 'resume') {
        const rem = room.timer.remainingMs > 0 ? room.timer.remainingMs : room.timer.durationMs || 300000;
        room.timer.remainingMs = rem;
        room.timer.isRunning = true;
        room.timer.endsAt = now + rem;
      } else if (action === 'add-minute') {
        const addMs = 60 * 1000;
        room.timer.durationMs += addMs;
        if (room.timer.isRunning && room.timer.endsAt !== null) {
          room.timer.endsAt += addMs;
          room.timer.remainingMs = Math.max(0, room.timer.endsAt - now);
        } else {
          room.timer.remainingMs += addMs;
        }
      } else if (action === 'stop') {
        room.timer.isRunning = false;
        room.timer.remainingMs = 0;
        room.timer.endsAt = null;
      }

      room.lastActiveAt = now;
      scheduleSaveToDisk(room);
      broadcastRoomSettings(room);
      callback?.({ ok: true, timer: room.timer });
    }
  );

  socket.on('disconnect', () => {
    const meta = socketMeta.get(socket.id);
    socketMeta.delete(socket.id);

    if (meta) {
      const room = rooms.get(meta.roomId);
      if (room) {
        const record = room.usersByUserId.get(meta.userId);
        if (record) {
          record.sockets.delete(socket.id);
          if (record.sockets.size === 0) {
            io.to(room.id).emit('cursor-leave', { userId: meta.userId });
          }
          broadcastRoster(room);
        }
      }
    }
  });
}
