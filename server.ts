import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');
const STORE_FILE = path.join(DATA_DIR, 'rooms-store.json');
const ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days inactivity cleanup

interface ServerUserRecord {
  userId: string;
  name: string;
  color: string;
  isTeacher: boolean;
  sockets: Set<string>;
}

interface SubBoardState {
  id: string;
  title: string;
  assignedUserIds: string[];
  elements: any[];
  background: any | null;
  messages: any[];
}

interface BreakoutConfigState {
  mode: 'main' | 'individual' | 'groups';
  allowSelfSelect: boolean;
  chatScope: 'unified' | 'board';
}

interface RoomState {
  id: string;
  messages: any[];
  elements: any[];
  background: any | null;
  subBoards: Map<string, SubBoardState>;
  breakoutConfig: BreakoutConfigState;
  usersByUserId: Map<string, ServerUserRecord>;
  isCanvasLocked: boolean;
  teacherPin: string | null;
  lastActiveAt: number;
}

interface SerializedRoom {
  id: string;
  messages: any[];
  elements: any[];
  background?: any | null;
  subBoards?: Record<string, SubBoardState>;
  breakoutConfig?: BreakoutConfigState;
  isCanvasLocked: boolean;
  teacherPin: string | null;
  lastActiveAt: number;
}

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: '*',
    },
    maxHttpBufferSize: 3e7, // 30 MB for PDF worksheets, subBoards, and JSON snapshots
  });

  const PORT = Number(process.env.PORT) || 3000;

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  const rooms: Map<string, RoomState> = new Map();
  const socketMeta: Map<string, { roomId: string; userId: string }> = new Map();
  let saveTimeout: NodeJS.Timeout | null = null;

  function serializeSubBoards(subBoards: Map<string, SubBoardState>): Record<string, SubBoardState> {
    const obj: Record<string, SubBoardState> = {};
    for (const [k, v] of subBoards.entries()) {
      obj[k] = v;
    }
    return obj;
  }

  function deserializeSubBoards(raw?: Record<string, SubBoardState>): Map<string, SubBoardState> {
    const map = new Map<string, SubBoardState>();
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        if (v && v.id) {
          map.set(k, {
            id: v.id,
            title: v.title || k,
            assignedUserIds: Array.isArray(v.assignedUserIds) ? v.assignedUserIds : [],
            elements: Array.isArray(v.elements) ? v.elements : [],
            background: v.background || null,
            messages: Array.isArray(v.messages) ? v.messages : [],
          });
        }
      }
    }
    return map;
  }

  function loadRoomsFromDisk() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      if (!fs.existsSync(STORE_FILE)) return;
      const raw = fs.readFileSync(STORE_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.rooms)) return;

      const now = Date.now();
      let restoredCount = 0;
      for (const item of parsed.rooms as SerializedRoom[]) {
        if (!item || !item.id) continue;
        const lastActive = item.lastActiveAt || now;
        if (now - lastActive > ROOM_TTL_MS) {
          continue;
        }
        rooms.set(item.id, {
          id: item.id,
          messages: Array.isArray(item.messages) ? item.messages : [],
          elements: Array.isArray(item.elements) ? item.elements : [],
          background: item.background || null,
          subBoards: deserializeSubBoards(item.subBoards),
          breakoutConfig: item.breakoutConfig || {
            mode: 'main',
            allowSelfSelect: false,
            chatScope: 'unified',
          },
          usersByUserId: new Map(),
          isCanvasLocked: Boolean(item.isCanvasLocked),
          teacherPin: item.teacherPin || null,
          lastActiveAt: lastActive,
        });
        restoredCount++;
      }
      if (restoredCount > 0) {
        console.log(`Restored ${restoredCount} active room(s) from disk.`);
      }
    } catch (err) {
      console.error('Failed to load rooms from disk:', err);
    }
  }

  function flushRoomsToDisk() {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const now = Date.now();
      const serialized: SerializedRoom[] = [];
      for (const [roomId, room] of rooms.entries()) {
        let hasActiveSockets = false;
        for (const u of room.usersByUserId.values()) {
          if (u.sockets.size > 0) {
            hasActiveSockets = true;
            break;
          }
        }
        if (!hasActiveSockets && now - room.lastActiveAt > ROOM_TTL_MS) {
          rooms.delete(roomId);
          continue;
        }
        if (
          room.elements.length > 0 ||
          room.messages.length > 0 ||
          room.background !== null ||
          room.subBoards.size > 0 ||
          room.teacherPin !== null
        ) {
          serialized.push({
            id: room.id,
            messages: room.messages,
            elements: room.elements,
            background: room.background,
            subBoards: serializeSubBoards(room.subBoards),
            breakoutConfig: room.breakoutConfig,
            isCanvasLocked: room.isCanvasLocked,
            teacherPin: room.teacherPin,
            lastActiveAt: room.lastActiveAt,
          });
        }
      }
      const tmpFile = `${STORE_FILE}.tmp`;
      fs.writeFileSync(
        tmpFile,
        JSON.stringify({ updatedAt: now, rooms: serialized }),
        'utf-8'
      );
      fs.renameSync(tmpFile, STORE_FILE);
    } catch (err) {
      console.error('Failed to save rooms to disk:', err);
    }
  }

  function scheduleSaveToDisk(immediate = false) {
    if (immediate) {
      flushRoomsToDisk();
      return;
    }
    if (saveTimeout) return;
    saveTimeout = setTimeout(() => {
      flushRoomsToDisk();
    }, 2000);
  }

  loadRoomsFromDisk();
  setInterval(() => {
    flushRoomsToDisk();
  }, 60 * 60 * 1000);

  function normalizeRoomId(raw?: string): string {
    const cleaned = String(raw || 'main')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    return cleaned || 'main';
  }

  function getOrCreateRoom(rawRoomId?: string): RoomState {
    const roomId = normalizeRoomId(rawRoomId);
    let room = rooms.get(roomId);
    if (!room) {
      room = {
        id: roomId,
        messages: [],
        elements: [],
        background: null,
        subBoards: new Map(),
        breakoutConfig: {
          mode: 'main',
          allowSelfSelect: false,
          chatScope: 'unified',
        },
        usersByUserId: new Map(),
        isCanvasLocked: false,
        teacherPin: null,
        lastActiveAt: Date.now(),
      };
      rooms.set(roomId, room);
    }
    return room;
  }

  function getRosterPayload(room: RoomState) {
    const list: Array<{ userId: string; name: string; color: string; isTeacher: boolean }> = [];
    for (const record of room.usersByUserId.values()) {
      if (record.sockets.size > 0) {
        list.push({
          userId: record.userId,
          name: record.name,
          color: record.color,
          isTeacher: record.isTeacher,
        });
      }
    }
    return list;
  }

  function getRoomSettingsPayload(room: RoomState) {
    return {
      roomId: room.id,
      isCanvasLocked: room.isCanvasLocked,
      hasTeacherPin: room.teacherPin !== null,
      lastSavedAt: room.lastActiveAt,
      breakoutConfig: room.breakoutConfig,
    };
  }

  function broadcastRoster(room: RoomState) {
    io.to(room.id).emit('roster-sync', getRosterPayload(room));
  }

  function broadcastRoomSettings(room: RoomState) {
    io.to(room.id).emit('room-settings', getRoomSettingsPayload(room));
  }

  function broadcastBreakoutSync(room: RoomState) {
    io.to(room.id).emit('breakout-sync', {
      breakoutConfig: room.breakoutConfig,
      subBoards: serializeSubBoards(room.subBoards),
    });
  }

  // Ensure that if a room is in 'individual' mode and a new student joins, they automatically get their individual board
  function ensureIndividualBoardForUser(room: RoomState, userId: string, userName: string, isTeacher: boolean) {
    if (room.breakoutConfig.mode !== 'individual' || isTeacher) return false;
    const boardId = `ind_${userId}`;
    if (!room.subBoards.has(boardId)) {
      room.subBoards.set(boardId, {
        id: boardId,
        title: `${userName}'s Board`,
        assignedUserIds: [userId],
        elements: [],
        background: room.background ? JSON.parse(JSON.stringify(room.background)) : null,
        messages: [],
      });
      return true;
    } else {
      const existing = room.subBoards.get(boardId)!;
      existing.title = `${userName}'s Board`;
      if (!existing.assignedUserIds.includes(userId)) {
        existing.assignedUserIds.push(userId);
      }
    }
    return false;
  }

  io.on('connection', (socket) => {
    socket.on('join-room', ({ roomId: rawRoomId, userId, name, color, teacherPin }) => {
      if (!userId) return;

      const prevMeta = socketMeta.get(socket.id);
      if (prevMeta && prevMeta.roomId !== normalizeRoomId(rawRoomId)) {
        const prevRoom = rooms.get(prevMeta.roomId);
        socket.leave(prevMeta.roomId);
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

      const room = getOrCreateRoom(rawRoomId);
      room.lastActiveAt = Date.now();
      socket.join(room.id);
      socketMeta.set(socket.id, { roomId: room.id, userId });

      const existing = room.usersByUserId.get(userId);
      let isVerifiedTeacher = false;
      if (room.teacherPin && teacherPin && String(teacherPin).trim() === room.teacherPin) {
        isVerifiedTeacher = true;
      } else if (existing?.isTeacher && room.teacherPin) {
        isVerifiedTeacher = true;
      }

      let createdSubBoard = false;
      if (name && String(name).trim()) {
        const trimmedName = String(name).trim();
        if (existing) {
          existing.name = trimmedName;
          existing.color = color || existing.color;
          existing.isTeacher = isVerifiedTeacher;
          existing.sockets.add(socket.id);
        } else {
          room.usersByUserId.set(userId, {
            userId,
            name: trimmedName,
            color: color || '#2563eb',
            isTeacher: isVerifiedTeacher,
            sockets: new Set([socket.id]),
          });
        }
        createdSubBoard = ensureIndividualBoardForUser(room, userId, trimmedName, isVerifiedTeacher);
      }

      socket.emit('init', {
        messages: room.messages,
        elements: room.elements,
        background: room.background,
        subBoards: serializeSubBoards(room.subBoards),
        users: getRosterPayload(room),
        roomSettings: getRoomSettingsPayload(room),
        isTeacher: isVerifiedTeacher,
      });

      broadcastRoster(room);
      if (createdSubBoard) {
        broadcastBreakoutSync(room);
      }
    });

    socket.on('teacher:auth', ({ pin }, callback) => {
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
      if (cleanPin.length < 3) {
        callback?.({ ok: false, error: 'PIN must be at least 3 characters.' });
        return;
      }

      const userRecord = room.usersByUserId.get(meta.userId);
      if (!userRecord) {
        callback?.({ ok: false, error: 'User profile not registered in room.' });
        return;
      }

      if (room.teacherPin === null) {
        room.teacherPin = cleanPin;
        room.lastActiveAt = Date.now();
        userRecord.isTeacher = true;
        scheduleSaveToDisk(true);
        broadcastRoomSettings(room);
        broadcastRoster(room);
        callback?.({ ok: true, mode: 'claimed', pin: cleanPin });
      } else if (room.teacherPin === cleanPin) {
        userRecord.isTeacher = true;
        broadcastRoster(room);
        callback?.({ ok: true, mode: 'verified', pin: cleanPin });
      } else {
        callback?.({
          ok: false,
          error: 'Incorrect Teacher PIN for this room. Need a fresh board? Click "New Room" to create a new room where you can set the PIN first.',
        });
      }
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

    // Teacher Breakout & Individual Assignment Launcher
    socket.on(
      'teacher:configure-breakout',
      (
        {
          mode,
          allowSelfSelect,
          chatScope,
          copyWorksheet,
          customBackground,
          groups,
        }: {
          mode: 'main' | 'individual' | 'groups';
          allowSelfSelect: boolean;
          chatScope: 'unified' | 'board';
          copyWorksheet: boolean;
          customBackground?: any | null;
          groups?: Array<{ id: string; title: string; assignedUserIds: string[] }>;
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
          callback?.({ ok: false, error: 'Only a verified Teacher can configure breakout boards.' });
          return;
        }

        room.breakoutConfig = {
          mode,
          allowSelfSelect: Boolean(allowSelfSelect),
          chatScope: chatScope === 'board' ? 'board' : 'unified',
        };

        const templateBg =
          customBackground !== undefined
            ? customBackground
            : copyWorksheet
            ? room.background
            : null;

        if (mode === 'individual') {
          for (const u of room.usersByUserId.values()) {
            if (u.isTeacher && u.sockets.size > 0) continue;
            const bId = `ind_${u.userId}`;
            const existing = room.subBoards.get(bId);
            if (!existing) {
              room.subBoards.set(bId, {
                id: bId,
                title: `${u.name}'s Board`,
                assignedUserIds: [u.userId],
                elements: [],
                background: templateBg ? JSON.parse(JSON.stringify(templateBg)) : null,
                messages: [],
              });
            } else {
              existing.title = `${u.name}'s Board`;
              existing.assignedUserIds = [u.userId];
              if (copyWorksheet && templateBg) {
                existing.background = JSON.parse(JSON.stringify(templateBg));
              }
            }
          }
        } else if (mode === 'groups' && Array.isArray(groups)) {
          for (const g of groups) {
            if (!g || !g.id) continue;
            const existing = room.subBoards.get(g.id);
            if (!existing) {
              room.subBoards.set(g.id, {
                id: g.id,
                title: g.title || g.id,
                assignedUserIds: Array.isArray(g.assignedUserIds) ? g.assignedUserIds : [],
                elements: [],
                background: templateBg ? JSON.parse(JSON.stringify(templateBg)) : null,
                messages: [],
              });
            } else {
              existing.title = g.title || existing.title;
              existing.assignedUserIds = Array.isArray(g.assignedUserIds)
                ? g.assignedUserIds
                : existing.assignedUserIds;
              if (copyWorksheet && templateBg) {
                existing.background = JSON.parse(JSON.stringify(templateBg));
              }
            }
          }
        }

        room.lastActiveAt = Date.now();
        scheduleSaveToDisk(true);
        broadcastRoomSettings(room);
        broadcastBreakoutSync(room);
        callback?.({ ok: true });
      }
    );

    // Student self-select or Teacher manual student reassignment to a sub-board
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

      const targetBoard = room.subBoards.get(targetBoardId);
      if (!targetBoard) return;

      // Remove userToMove from other group boards if in groups mode
      for (const [bId, sb] of room.subBoards.entries()) {
        if (bId.startsWith('grp_')) {
          sb.assignedUserIds = sb.assignedUserIds.filter((id) => id !== userToMove);
        }
      }
      if (!targetBoard.assignedUserIds.includes(userToMove)) {
        targetBoard.assignedUserIds.push(userToMove);
      }

      room.lastActiveAt = Date.now();
      scheduleSaveToDisk();
      broadcastBreakoutSync(room);
    });

    // Teacher-only Background Worksheet upload/remove (scoped to target boardId or 'main')
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
      const bgData = payload && 'background' in payload ? payload.background : payload;

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
      scheduleSaveToDisk(true);
      callback?.({ ok: true });
    });

    // Teacher-only Background Worksheet transform update (position, scale, layout)
    socket.on('teacher:update-background', ({ boardId = 'main', patch }) => {
      const meta = socketMeta.get(socket.id);
      if (!meta || !patch) return;
      const room = rooms.get(meta.roomId);
      if (!room) return;

      const callerRecord = room.usersByUserId.get(meta.userId);
      if (!callerRecord?.isTeacher) return;

      if (boardId === 'main') {
        if (!room.background) return;
        room.background = { ...room.background, ...patch };
        io.to(room.id).emit('background-sync', { boardId: 'main', background: room.background });
      } else {
        const sb = room.subBoards.get(boardId);
        if (!sb || !sb.background) return;
        sb.background = { ...sb.background, ...patch };
        io.to(room.id).emit('background-sync', { boardId, background: sb.background });
      }

      room.lastActiveAt = Date.now();
      scheduleSaveToDisk();
    });

    // Teacher-only JSON Snapshot Import & Restore
    socket.on(
      'teacher:import-room',
      (
        {
          elements: importedElements,
          messages: importedMessages,
          background: importedBg,
          subBoards: importedSubBoards,
          breakoutConfig: importedBreakoutConfig,
          mode,
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
          callback?.({ ok: false, error: 'Only a verified Teacher can import room snapshots.' });
          return;
        }

        const validElements = Array.isArray(importedElements) ? importedElements : [];
        const validMessages = Array.isArray(importedMessages) ? importedMessages : [];

        if (mode === 'merge') {
          const existingElIds = new Set(room.elements.map((e) => e.id));
          for (const el of validElements) {
            if (el && el.id && !existingElIds.has(el.id)) {
              room.elements.push(el);
              existingElIds.add(el.id);
            }
          }
          const existingMsgIds = new Set(room.messages.map((m) => m.id));
          for (const msg of validMessages) {
            if (msg && msg.id && !existingMsgIds.has(msg.id)) {
              room.messages.push(msg);
              existingMsgIds.add(msg.id);
            }
          }
          room.messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
          if (room.messages.length > 500) {
            room.messages = room.messages.slice(-500);
          }
          if (!room.background && importedBg) {
            room.background = importedBg;
          }
          if (importedSubBoards) {
            const parsedSubs = deserializeSubBoards(importedSubBoards);
            for (const [k, v] of parsedSubs.entries()) {
              if (!room.subBoards.has(k)) {
                room.subBoards.set(k, v);
              }
            }
          }
        } else if (mode === 'readonly') {
          room.elements = validElements;
          room.messages = validMessages.slice(-500);
          if (importedBg !== undefined) room.background = importedBg || null;
          if (importedSubBoards !== undefined) {
            room.subBoards = deserializeSubBoards(importedSubBoards);
          }
          if (importedBreakoutConfig) {
            room.breakoutConfig = importedBreakoutConfig;
          }
          room.isCanvasLocked = true;
        } else {
          room.elements = validElements;
          room.messages = validMessages.slice(-500);
          if (importedBg !== undefined) room.background = importedBg || null;
          if (importedSubBoards !== undefined) {
            room.subBoards = deserializeSubBoards(importedSubBoards);
          }
          if (importedBreakoutConfig) {
            room.breakoutConfig = importedBreakoutConfig;
          }
          room.isCanvasLocked = false;
        }

        room.lastActiveAt = Date.now();
        scheduleSaveToDisk(true);

        io.to(room.id).emit('room-restored', {
          elements: room.elements,
          messages: room.messages,
          background: room.background,
          subBoards: serializeSubBoards(room.subBoards),
          roomSettings: getRoomSettingsPayload(room),
        });

        callback?.({
          ok: true,
          elementsCount: room.elements.length,
          messagesCount: room.messages.length,
        });
      }
    );

    socket.on('update-profile', ({ userId, name, color }) => {
      const meta = socketMeta.get(socket.id);
      if (!meta || !userId) return;
      const room = rooms.get(meta.roomId);
      if (!room) return;
      const existing = room.usersByUserId.get(userId);
      if (existing) {
        if (name) {
          existing.name = String(name).trim();
          const indBoard = room.subBoards.get(`ind_${userId}`);
          if (indBoard) {
            indBoard.title = `${existing.name}'s Board`;
            broadcastBreakoutSync(room);
          }
        }
        if (color) existing.color = color;
        broadcastRoster(room);
      }
    });

    socket.on('chat-message', (msg) => {
      const meta = socketMeta.get(socket.id);
      if (!meta || !msg || !msg.text || !String(msg.text).trim()) return;
      const room = rooms.get(meta.roomId);
      if (!room) return;

      const senderRecord = room.usersByUserId.get(meta.userId);
      const boardId = msg.boardId || 'main';
      const message = {
        id: Math.random().toString(36).substring(2, 11),
        boardId,
        userId: meta.userId,
        userName: senderRecord?.name || msg.userName || 'Student',
        userColor: senderRecord?.color || msg.userColor,
        isTeacher: Boolean(senderRecord?.isTeacher),
        text: String(msg.text).trim(),
        timestamp: Date.now(),
      };

      if (room.breakoutConfig.chatScope === 'board' && boardId !== 'main') {
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
      scheduleSaveToDisk();
      io.to(room.id).emit('chat-message', message);
    });

    // Helper to get elements array for either 'main' or a subBoard
    function getBoardElements(room: RoomState, boardId?: string): any[] | null {
      if (!boardId || boardId === 'main') return room.elements;
      const sb = room.subBoards.get(boardId);
      return sb ? sb.elements : null;
    }

    socket.on('element-start', (element) => {
      const meta = socketMeta.get(socket.id);
      if (!meta || !element || !element.id) return;
      const room = rooms.get(meta.roomId);
      if (!room) return;

      const senderRecord = room.usersByUserId.get(meta.userId);
      if (room.isCanvasLocked && !senderRecord?.isTeacher) {
        return;
      }

      const boardId = element.boardId || 'main';
      const targetElements = getBoardElements(room, boardId);
      if (!targetElements) return;

      const exists = targetElements.some((el) => el.id === element.id);
      if (!exists) {
        targetElements.push(element);
      }
      room.lastActiveAt = Date.now();
      scheduleSaveToDisk();
      socket.to(room.id).emit('element-start', { ...element, boardId });
    });

    socket.on('element-append-points', ({ id, boardId = 'main', newPoints }) => {
      const meta = socketMeta.get(socket.id);
      if (!meta || !id || !Array.isArray(newPoints)) return;
      const room = rooms.get(meta.roomId);
      if (!room) return;

      const targetElements = getBoardElements(room, boardId);
      if (!targetElements) return;

      const el = targetElements.find((item) => item.id === id);
      if (el && Array.isArray(el.points)) {
        el.points.push(...newPoints);
        room.lastActiveAt = Date.now();
        scheduleSaveToDisk();
        socket.to(room.id).emit('element-append-points', { id, boardId, newPoints });
      }
    });

    socket.on('element-update', (patch) => {
      const meta = socketMeta.get(socket.id);
      if (!meta || !patch || !patch.id) return;
      const room = rooms.get(meta.roomId);
      if (!room) return;

      const boardId = patch.boardId || 'main';
      const targetElements = getBoardElements(room, boardId);
      if (!targetElements) return;

      const idx = targetElements.findIndex((item) => item.id === patch.id);
      if (idx !== -1) {
        targetElements[idx] = { ...targetElements[idx], ...patch };
        room.lastActiveAt = Date.now();
        scheduleSaveToDisk();
        socket.to(room.id).emit('element-update', { ...patch, boardId });
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
          room.lastActiveAt = Date.now();
          scheduleSaveToDisk();
          io.to(room.id).emit('element-removed', { id, boardId });
        }
      }
    });

    socket.on('cursor-move', (cursorData) => {
      const meta = socketMeta.get(socket.id);
      if (!meta) return;
      socket.to(meta.roomId).emit('cursor-move', cursorData);
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
      if (room.isCanvasLocked && !senderRecord?.isTeacher) return;

      const targetElements = getBoardElements(room, boardId);
      if (!targetElements) return;

      for (let i = targetElements.length - 1; i >= 0; i--) {
        if (targetElements[i].userId === userId) {
          const removed = targetElements.splice(i, 1)[0];
          room.lastActiveAt = Date.now();
          scheduleSaveToDisk();
          io.to(room.id).emit('element-removed', { id: removed.id, boardId });
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

      if (boardId === 'main') {
        room.elements = room.elements.filter((el) => el.userId !== targetUserId);
        io.to(room.id).emit('state-sync', { boardId: 'main', elements: room.elements });
      } else {
        const sb = room.subBoards.get(boardId);
        if (sb) {
          sb.elements = sb.elements.filter((el) => el.userId !== targetUserId);
          io.to(room.id).emit('state-sync', { boardId, elements: sb.elements });
        }
      }

      room.lastActiveAt = Date.now();
      scheduleSaveToDisk(true);
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
      scheduleSaveToDisk(true);
      broadcastRoomSettings(room);
    });

    socket.on('teacher:clear-all', (payload) => {
      const meta = socketMeta.get(socket.id);
      if (!meta) return;
      const room = rooms.get(meta.roomId);
      if (!room) return;

      const callerRecord = room.usersByUserId.get(meta.userId);
      if (!callerRecord?.isTeacher) return;

      const boardId = payload?.boardId || 'main';
      if (boardId === 'main') {
        room.elements = [];
        io.to(room.id).emit('state-sync', { boardId: 'main', elements: room.elements });
      } else {
        const sb = room.subBoards.get(boardId);
        if (sb) {
          sb.elements = [];
          io.to(room.id).emit('state-sync', { boardId, elements: sb.elements });
        }
      }

      room.lastActiveAt = Date.now();
      scheduleSaveToDisk(true);
    });

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
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  let isShuttingDown = false;
  function handleShutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`Received ${signal}, flushing rooms to disk and shutting down...`);
    flushRoomsToDisk();

    const forceExitTimeout = setTimeout(() => {
      process.exit(0);
    }, 8000);
    forceExitTimeout.unref();

    io.close(() => {
      httpServer.close(() => {
        process.exit(0);
      });
    });
  }

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));
}

startServer();
