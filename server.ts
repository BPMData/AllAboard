import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import type { BreakoutRoundMeta, ConfigureBreakoutPayload, SubBoardKind } from './src/types.ts';
import {
  type BreakoutConfigLike,
  buildRoundTitle,
  getActiveRound,
  getBoardsInRound,
  getNextRoundNumber,
  getRoundById,
  getRounds,
  makeGroupBoardId,
  makeIndividualBoardId,
  makeRoundId,
  migrateLegacyBreakout,
  normalizeBreakoutConfig,
  resolveBreakoutAction,
  uniqueStrings,
} from './src/lib/breakoutRounds.ts';
import { RoomStore, internBackground, isValidAssetHash } from './roomStore.ts';
import { BackupMirror, DirBackend, GcsBackend, sniffMime, type BackupBackend } from './backupMirror.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days inactivity cleanup
const IDLE_UNLOAD_MS = 15 * 60 * 1000;
const HOUSEKEEPING_INTERVAL_MS = 5 * 60 * 1000;

export interface StartServerOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  backupDir?: string;
  /** Tests only: use this backup backend instead of picking one from the environment. */
  backupBackend?: BackupBackend;
  skipVite?: boolean;
}

interface ServerUserRecord {
  userId: string;
  name: string;
  color: string;
  isTeacher: boolean;
  isNameLocked?: boolean;
  sockets: Set<string>;
}

interface BannedUserRecord {
  userId: string;
  name: string;
  bannedAt: number;
}

interface SubBoardState {
  id: string;
  roundId?: string;
  kind?: SubBoardKind;
  title: string;
  assignedUserIds: string[];
  elements: any[];
  background: any | null;
  messages: any[];
}

type BreakoutConfigState = BreakoutConfigLike;

interface TimerState {
  isRunning: boolean;
  durationMs: number;
  remainingMs: number;
  endsAt: number | null;
  autoLockOnExpire: boolean;
}

interface RoomState {
  id: string;
  messages: any[];
  elements: any[];
  background: any | null;
  subBoards: Map<string, SubBoardState>;
  breakoutConfig: BreakoutConfigState;
  /** Worksheet background each round was launched with, used to provision late-joining students. Server-only; not broadcast. */
  roundTemplates: Record<string, any | null>;
  timer: TimerState;
  usersByUserId: Map<string, ServerUserRecord>;
  lockedNames: Record<string, string>;
  bannedUsers: Record<string, BannedUserRecord>;
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
  roundTemplates?: Record<string, any | null>;
  timer?: TimerState;
  lockedNames?: Record<string, string>;
  bannedUsers?: Record<string, BannedUserRecord>;
  isCanvasLocked: boolean;
  teacherPin: string | null;
  lastActiveAt: number;
}

/**
 * Production backup bucket. It lives in code, not in an env var or volume mount, because AI Studio's
 * Deploy button replaces the Cloud Run service config (env vars, volumes) on every publish.
 */
const DEFAULT_BACKUP_BUCKET = 'allaboard-data';

/**
 * Picks where rooms are backed up. Candidates, tried in this order; the first one whose probe
 * succeeds wins:
 *   1. BACKUP_DIR (or options.backupDir) → plain files in that folder (local dev, or a mounted bucket)
 *   2. The bucket: options.backupBackend (tests only), else BACKUP_BUCKET (set "off" to disable),
 *      else DEFAULT_BACKUP_BUCKET when running on Cloud Run in production (K_SERVICE + NODE_ENV=production)
 * A candidate that fails its probe is skipped (and logged), so a stale BACKUP_DIR left behind by an
 * AI Studio redeploy (env var kept, volume mount dropped) falls through to the bucket API instead of
 * disabling backups. Returns null if nothing works. Never throws.
 */
async function openBackupMirror(store: RoomStore, options: StartServerOptions): Promise<BackupMirror | null> {
  const dir = options.backupDir ?? process.env.BACKUP_DIR ?? '';
  const onCloudRun = Boolean(process.env.K_SERVICE) && process.env.NODE_ENV === 'production';
  const bucket = process.env.BACKUP_BUCKET ?? (onCloudRun ? DEFAULT_BACKUP_BUCKET : '');

  const candidates: BackupBackend[] = [];
  if (dir) candidates.push(new DirBackend(dir));
  if (options.backupBackend) candidates.push(options.backupBackend);
  else if (bucket && bucket !== 'off') candidates.push(new GcsBackend(bucket));

  for (const backend of candidates) {
    try {
      await backend.probe();
      console.log(`Backing up rooms to ${backend.label}.`);
      return new BackupMirror(backend, (hash) => store.getAsset(hash)?.bytes ?? null);
    } catch (err) {
      console.error(`Backup target ${backend.label} is unusable, skipping:`, err);
    }
  }
  if (candidates.length > 0 || process.env.NODE_ENV === 'production') {
    console.warn('Backups are OFF: rooms will NOT survive a cold start or redeploy.');
  }
  return null;
}

export async function startServer(options: StartServerOptions = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(process.cwd(), '.data');
  const legacyStoreFile = path.join(dataDir, 'rooms-store.json');
  const store = new RoomStore(path.join(dataDir, 'allaboard.db'));
  const backup = await openBackupMirror(store, options);
  const portToBind = options.port !== undefined ? options.port : Number(process.env.PORT) || 3000;
  const hostToBind = options.host || '0.0.0.0';

  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: '*',
    },
    maxHttpBufferSize: 3e7, // 30 MB for PDF worksheets, subBoards, and JSON snapshots
  });

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/api/assets/:hash', async (req, res) => {
    const hash = req.params.hash;
    if (!isValidAssetHash(hash)) {
      res.status(404).end();
      return;
    }
    try {
      let asset = store.getAsset(hash);
      if (!asset && backup) {
        // Cold start: the local store is empty but the backup bucket has the image.
        const bytes = await backup.readAsset(hash);
        if (bytes && store.putAsset(bytes, sniffMime(bytes)) === hash) asset = store.getAsset(hash);
      }
      if (!asset) {
        res.status(404).end();
        return;
      }
      res.setHeader('Content-Security-Policy', 'sandbox');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', asset.mime);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.end(Buffer.from(asset.bytes));
    } catch (err) {
      console.error(`Failed to serve asset ${hash}:`, err);
      res.status(500).end();
    }
  });

  const rooms: Map<string, RoomState> = new Map();
  const socketMeta: Map<string, { roomId: string; userId: string }> = new Map();

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
            roundId: typeof v.roundId === 'string' ? v.roundId : undefined,
            kind: v.kind === 'group' || v.kind === 'individual' ? v.kind : undefined,
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

  /** SerializedRoom → in-memory RoomState. Returns null if missing/expired. */
  function hydrateRoom(item: SerializedRoom, now = Date.now()): RoomState | null {
    if (!item || !item.id) return null;
    const lastActive = item.lastActiveAt || now;
    if (now - lastActive > ROOM_TTL_MS) return null;

    const subBoards = deserializeSubBoards(item.subBoards);
    const breakoutConfig = normalizeBreakoutConfig(item.breakoutConfig);
    migrateLegacyBreakout(subBoards, breakoutConfig);
    return {
      id: item.id,
      messages: Array.isArray(item.messages) ? item.messages : [],
      elements: Array.isArray(item.elements) ? item.elements : [],
      background: item.background || null,
      subBoards,
      breakoutConfig,
      roundTemplates: item.roundTemplates && typeof item.roundTemplates === 'object' ? item.roundTemplates : {},
      timer: item.timer || {
        isRunning: false,
        durationMs: 5 * 60 * 1000,
        remainingMs: 0,
        endsAt: null,
        autoLockOnExpire: false,
      },
      usersByUserId: new Map(),
      lockedNames: item.lockedNames && typeof item.lockedNames === 'object' ? item.lockedNames : {},
      bannedUsers: item.bannedUsers && typeof item.bannedUsers === 'object' ? item.bannedUsers : {},
      isCanvasLocked: Boolean(item.isCanvasLocked),
      teacherPin: item.teacherPin || null,
      lastActiveAt: lastActive,
    };
  }

  function serializeRoom(room: RoomState): SerializedRoom {
    return {
      id: room.id,
      messages: room.messages,
      elements: room.elements,
      background: room.background,
      subBoards: serializeSubBoards(room.subBoards),
      breakoutConfig: room.breakoutConfig,
      roundTemplates: room.roundTemplates,
      timer: room.timer,
      lockedNames: room.lockedNames,
      bannedUsers: room.bannedUsers,
      isCanvasLocked: room.isCanvasLocked,
      teacherPin: room.teacherPin,
      lastActiveAt: room.lastActiveAt,
    };
  }

  function isRoomEmpty(room: RoomState): boolean {
    return (
      room.elements.length === 0 &&
      room.messages.length === 0 &&
      room.background === null &&
      room.subBoards.size === 0 &&
      room.teacherPin === null &&
      Object.keys(room.lockedNames).length === 0 &&
      Object.keys(room.bannedUsers).length === 0
    );
  }

  function roomHasActiveSockets(room: RoomState): boolean {
    for (const u of room.usersByUserId.values()) {
      if (u.sockets.size > 0) return true;
    }
    return false;
  }

  /** Safety net: converts any remaining base64 worksheet pages in a room to asset URLs. */
  function internRoomAssets(room: RoomState) {
    room.background = internBackground(store, room.background);
    for (const sb of room.subBoards.values()) {
      sb.background = internBackground(store, sb.background);
    }
    for (const key of Object.keys(room.roundTemplates)) {
      room.roundTemplates[key] = internBackground(store, room.roundTemplates[key]);
    }
  }

  /** Imports an old rooms-store.json (if present) into SQLite, then renames it. */
  function migrateLegacyJsonStore() {
    if (!fs.existsSync(legacyStoreFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(legacyStoreFile, 'utf-8'));
      let migrated = 0;
      if (parsed && Array.isArray(parsed.rooms)) {
        for (const item of parsed.rooms as SerializedRoom[]) {
          const room = hydrateRoom(item);
          if (!room) continue;
          internRoomAssets(room);
          store.saveRoom(room.id, serializeRoom(room), room.lastActiveAt);
          migrated++;
        }
      }
      fs.renameSync(legacyStoreFile, `${legacyStoreFile}.migrated-${Date.now()}`);
      console.log(`Migrated ${migrated} room(s) from rooms-store.json into SQLite.`);
    } catch (err) {
      console.error('Failed to migrate rooms-store.json (left in place):', err);
    }
  }

  /** Cold start: copy rooms from the backup into the local SQLite store. */
  async function restoreFromBackup() {
    if (!backup) return;
    try {
      let restored = 0;
      for (const { roomId, state, lastActiveAt } of await backup.loadAllRooms()) {
        const room = hydrateRoom({ ...state, id: roomId, lastActiveAt });
        if (!room) {
          backup.deleteRoom(roomId); // expired
          continue;
        }
        const local = store.loadRoom<SerializedRoom>(roomId);
        if (local && local.lastActiveAt >= room.lastActiveAt) continue;
        store.saveRoom(roomId, serializeRoom(room), room.lastActiveAt);
        restored++;
      }
      console.log(`Restored ${restored} room(s) from backup.`);
    } catch (err) {
      console.error('Restoring from backup failed; starting with local state only:', err);
    }
  }

  /** Queue a room for the backup. Reads the latest state when the write happens; null deletes it. */
  function backupRoom(roomId: string) {
    backup?.scheduleRoom(roomId, () => {
      const live = rooms.get(roomId);
      if (live) return isRoomEmpty(live) ? null : serializeRoom(live);
      return store.loadRoom<SerializedRoom>(roomId)?.state ?? null;
    });
  }

  const dirtyRooms = new Set<string>();
  let saveTimeout: NodeJS.Timeout | null = null;

  /** Writes ONLY rooms that changed since the last flush. Synchronous (node:sqlite is sync). */
  function flushRoomsToDisk() {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
    for (const roomId of [...dirtyRooms]) {
      dirtyRooms.delete(roomId);
      const room = rooms.get(roomId);
      if (!room) continue;
      try {
        if (isRoomEmpty(room)) {
          store.deleteRoom(roomId);
          backupRoom(roomId);
          continue;
        }
        internRoomAssets(room);
        store.saveRoom(roomId, serializeRoom(room), room.lastActiveAt);
        backupRoom(roomId);
      } catch (err) {
        dirtyRooms.add(roomId); // retry on next flush
        console.error(`Failed to save room "${roomId}":`, err);
      }
    }
  }

  /** Kept for the test suite / callers that await it. */
  async function flushRoomsToDiskAsync(): Promise<void> {
    flushRoomsToDisk();
  }

  function scheduleSaveToDisk(room: RoomState, immediate = false) {
    dirtyRooms.add(room.id);
    if (immediate) {
      flushRoomsToDisk();
      return;
    }
    if (saveTimeout) return;
    saveTimeout = setTimeout(flushRoomsToDisk, 2000);
  }

  /** Every 5 min: flush, unload idle rooms from RAM, expire old rooms, GC unreferenced assets. */
  function runHousekeeping() {
    flushRoomsToDisk();
    const now = Date.now();
    for (const [roomId, room] of rooms) {
      if (dirtyRooms.has(roomId) || roomHasActiveSockets(room)) continue;
      if (now - room.lastActiveAt > IDLE_UNLOAD_MS) rooms.delete(roomId);
    }
    try {
      for (const roomId of store.deleteRoomsInactiveBefore(now - ROOM_TTL_MS)) backupRoom(roomId);
      store.gcAssets();
    } catch (err) {
      console.error('Housekeeping failed:', err);
    }
  }

  migrateLegacyJsonStore();
  await restoreFromBackup();
  const housekeepingInterval = setInterval(runHousekeeping, HOUSEKEEPING_INTERVAL_MS);
  housekeepingInterval.unref();

  function normalizeRoomId(raw?: string): string {
    const cleaned = String(raw || 'main')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    return cleaned || 'main';
  }

  /** In-memory room, else hydrate it from SQLite (and cache it). Never creates a new room. */
  function findRoom(roomId: string): RoomState | null {
    const inMemory = rooms.get(roomId);
    if (inMemory) return inMemory;
    const stored = store.loadRoom<SerializedRoom>(roomId);
    if (!stored) return null;
    const restored = hydrateRoom({ ...stored.state, id: roomId, lastActiveAt: stored.lastActiveAt });
    if (!restored) {
      store.deleteRoom(roomId); // expired
      return null;
    }
    rooms.set(roomId, restored);
    return restored;
  }

  function getOrCreateRoom(rawRoomId?: string): RoomState {
    const roomId = normalizeRoomId(rawRoomId);
    let room = findRoom(roomId);
    if (!room) {
      room = {
        id: roomId,
        messages: [],
        elements: [],
        background: null,
        subBoards: new Map(),
        breakoutConfig: { mode: 'main', activeRoundId: undefined, rounds: [], allowSelfSelect: false, chatScope: 'unified' },
        roundTemplates: {},
        timer: {
          isRunning: false,
          durationMs: 5 * 60 * 1000,
          remainingMs: 0,
          endsAt: null,
          autoLockOnExpire: false,
        },
        usersByUserId: new Map(),
        lockedNames: {},
        bannedUsers: {},
        isCanvasLocked: false,
        teacherPin: null,
        lastActiveAt: Date.now(),
      };
      rooms.set(roomId, room);
    }
    return room;
  }

  function getRosterPayload(room: RoomState) {
    const list: Array<{
      userId: string;
      name: string;
      color: string;
      isTeacher: boolean;
      isNameLocked?: boolean;
    }> = [];
    for (const record of room.usersByUserId.values()) {
      if (record.sockets.size > 0) {
        list.push({
          userId: record.userId,
          name: record.name,
          color: record.color,
          isTeacher: record.isTeacher,
          isNameLocked: Boolean(record.isNameLocked || room.lockedNames[record.userId]),
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
      timer: room.timer,
      bannedUsers: Object.values(room.bannedUsers),
    };
  }

  function broadcastRoster(room: RoomState) {
    io.to(room.id).emit('roster-sync', getRosterPayload(room));
  }

  function broadcastRoomSettings(room: RoomState) {
    io.to(room.id).emit('room-settings', getRoomSettingsPayload(room));
  }

  // 1-second check for running classroom countdown timers
  const timerTickInterval = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (room.timer?.isRunning && room.timer.endsAt !== null && now >= room.timer.endsAt) {
        room.timer.isRunning = false;
        room.timer.remainingMs = 0;
        room.timer.endsAt = null;
        if (room.timer.autoLockOnExpire) {
          room.isCanvasLocked = true;
        }
        room.lastActiveAt = now;
        broadcastRoomSettings(room);
        scheduleSaveToDisk(room);
      }
    }
  }, 1000);
  timerTickInterval.unref();

  function broadcastBreakoutSync(room: RoomState) {
    io.to(room.id).emit('breakout-sync', {
      breakoutConfig: room.breakoutConfig,
      subBoards: serializeSubBoards(room.subBoards),
    });
  }

  function cloneBackground(bg: any | null | undefined): any | null {
    return bg ? internBackground(store, bg) : null;
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
    user: { userId: string; name: string }
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
      elements: [],
      background: cloneBackground(getRoundTemplate(room, roundId)),
      messages: [],
    });
    return true;
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

  // If the room is in 'individual' mode and a student joins, make sure they have a board in the ACTIVE round.
  function ensureIndividualBoardForUser(room: RoomState, userId: string, userName: string, isTeacher: boolean) {
    if (room.breakoutConfig.mode !== 'individual' || isTeacher) return false;
    const round = getActiveRound(room.breakoutConfig);
    if (!round || round.mode !== 'individual') return false;
    return provisionIndividualBoard(room, round.id, { userId, name: userName });
  }

  function getRoomAvailability(rawRoomId?: string) {
    const normalizedId = normalizeRoomId(rawRoomId);
    const room = findRoom(normalizedId);
    if (!room) {
      return {
        roomId: normalizedId,
        exists: false,
        activeUserCount: 0,
        hasTeacherPin: false,
        hasContent: false,
      };
    }
    const activeUserCount = getRosterPayload(room).length;
    const hasContent =
      room.elements.length > 0 ||
      room.messages.length > 0 ||
      room.background !== null ||
      room.subBoards.size > 0;
    const hasTeacherPin = room.teacherPin !== null;
    return {
      roomId: normalizedId,
      exists: activeUserCount > 0 || hasContent || hasTeacherPin,
      activeUserCount,
      hasTeacherPin,
      hasContent,
    };
  }

  io.on('connection', (socket) => {
    socket.on('check-room', (payload: { roomId?: string } | undefined, callback) => {
      callback?.(getRoomAvailability(payload?.roomId));
    });

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

      // Block banned students from joining the room
      const existing = room.usersByUserId.get(userId);
      let isVerifiedTeacher = false;
      if (room.teacherPin && teacherPin && String(teacherPin).trim() === room.teacherPin) {
        isVerifiedTeacher = true;
      } else if (existing?.isTeacher && room.teacherPin) {
        isVerifiedTeacher = true;
      }

      if (room.bannedUsers[userId] && !isVerifiedTeacher) {
        socket.emit('room-kicked', { reason: 'banned', roomId: room.id });
        return;
      }

      room.lastActiveAt = Date.now();
      socket.join(room.id);
      socketMeta.set(socket.id, { roomId: room.id, userId });

      const lockedName = room.lockedNames[userId];
      const isNameLocked = Boolean(lockedName);
      const effectiveName = lockedName || (name && String(name).trim() ? String(name).trim() : '');

      let createdSubBoard = false;
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
        createdSubBoard = ensureIndividualBoardForUser(room, userId, effectiveName, isVerifiedTeacher);
      }

      socket.emit('init', {
        messages: room.messages,
        elements: room.elements,
        background: room.background,
        subBoards: serializeSubBoards(room.subBoards),
        users: getRosterPayload(room),
        roomSettings: getRoomSettingsPayload(room),
        isTeacher: isVerifiedTeacher,
        assignedName: effectiveName || undefined,
        isNameLocked,
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
        scheduleSaveToDisk(room, true);
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

    // Teacher Breakout & Individual Assignment Launcher (multi-round)
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

      if (action === 'return-to-main') {
        cfg.mode = 'main';
        delete cfg.userBoardOverrides;
      } else if (action === 'resume' || action === 'update-current') {
        const targetId = safePayload.roundId || safePayload.targetRoundId;
        const round = getRoundById(cfg, targetId || cfg.activeRoundId);
        if (!round) {
          callback?.({ ok: false, error: 'There is no breakout round to resume or edit yet.' });
          return;
        }
        applyRoundEdits(room, round, safePayload);
        if (action === 'resume' || targetId) {
          cfg.activeRoundId = round.id;
          cfg.mode = round.mode;
          delete cfg.userBoardOverrides;
        }
        if (round.mode === 'individual' && cfg.mode === 'individual' && cfg.activeRoundId === round.id) {
          for (const u of getBreakoutStudents(room)) provisionIndividualBoard(room, round.id, u);
        }
      } else {
        // 'new-round'
        const mode: 'individual' | 'groups' = safePayload.mode === 'groups' ? 'groups' : 'individual';
        const groups = Array.isArray(safePayload.groups) ? safePayload.groups.filter(Boolean) : [];
        if (mode === 'groups' && groups.length === 0) {
          callback?.({ ok: false, error: 'Add at least one group before launching a group round.' });
          return;
        }

        const roundNumber = getNextRoundNumber(cfg);
        const roundId = makeRoundId(roundNumber);
        const templateBg =
          safePayload.customBackground !== undefined
            ? safePayload.customBackground
            : safePayload.copyWorksheet
            ? room.background
            : null;
        room.roundTemplates[roundId] = cloneBackground(templateBg);

        const roundMeta: BreakoutRoundMeta = {
          id: roundId,
          number: roundNumber,
          title: buildRoundTitle(roundNumber, mode, safePayload.templateLabel),
          mode,
          createdAt: Date.now(),
        };

        if (mode === 'individual') {
          for (const u of getBreakoutStudents(room)) provisionIndividualBoard(room, roundId, u);
        } else {
          const seen = new Set<string>();
          groups.forEach((g, i) => {
            const id = makeGroupBoardId(roundId, i);
            const assigned = uniqueStrings(g.assignedUserIds).filter((uid) => !seen.has(uid));
            assigned.forEach((uid) => seen.add(uid));
            room.subBoards.set(id, {
              id,
              roundId,
              kind: 'group',
              title: (typeof g.title === 'string' && g.title.trim()) ? g.title.trim().slice(0, 40) : `Group ${i + 1}`,
              assignedUserIds: assigned,
              elements: [],
              background: cloneBackground(templateBg),
              messages: [],
            });
          });
        }

        room.breakoutConfig = {
          mode,
          activeRoundId: roundId,
          rounds: [...getRounds(cfg), roundMeta],
          allowSelfSelect: Boolean(safePayload.allowSelfSelect),
          chatScope: safePayload.chatScope === 'board' ? 'board' : 'unified',
        };
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
      });
    });

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
          assets: importedAssets,
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

        if (importedAssets && typeof importedAssets === 'object') {
          for (const dataUrl of Object.values(importedAssets)) {
            if (typeof dataUrl === 'string') store.internDataUrl(dataUrl);
          }
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
            const importedCfg = normalizeBreakoutConfig(importedBreakoutConfig);
            migrateLegacyBreakout(parsedSubs, importedCfg);
            for (const [k, v] of parsedSubs.entries()) {
              if (!room.subBoards.has(k)) room.subBoards.set(k, v);
            }
            const knownRoundIds = new Set(getRounds(room.breakoutConfig).map((r) => r.id));
            const mergedRounds = getRounds(room.breakoutConfig);
            for (const r of getRounds(importedCfg)) {
              if (!knownRoundIds.has(r.id)) mergedRounds.push(r);
            }
            room.breakoutConfig.rounds = mergedRounds;
          }
        } else if (mode === 'readonly') {
          room.elements = validElements;
          room.messages = validMessages.slice(-500);
          if (importedBg !== undefined) room.background = importedBg || null;
          if (importedSubBoards !== undefined) {
            room.subBoards = deserializeSubBoards(importedSubBoards);
            room.roundTemplates = {};
          }
          if (importedBreakoutConfig) {
            room.breakoutConfig = normalizeBreakoutConfig(importedBreakoutConfig);
          }
          room.isCanvasLocked = true;
        } else {
          room.elements = validElements;
          room.messages = validMessages.slice(-500);
          if (importedBg !== undefined) room.background = importedBg || null;
          if (importedSubBoards !== undefined) {
            room.subBoards = deserializeSubBoards(importedSubBoards);
            room.roundTemplates = {};
          }
          if (importedBreakoutConfig) {
            room.breakoutConfig = normalizeBreakoutConfig(importedBreakoutConfig);
          }
          room.isCanvasLocked = false;
        }

        migrateLegacyBreakout(room.subBoards, room.breakoutConfig);
        internRoomAssets(room);

        room.lastActiveAt = Date.now();
        scheduleSaveToDisk(room, true);

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

    // Teacher-only Force Rename User + Permanent Name Lock + Retroactive Scrubbing
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

    // Teacher-only Delete Individual Chat Message
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

    // Teacher-only Kick or Ban Student (preserves student's drawings and messages unless cleared separately)
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

    // Teacher-only Unban Student
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

    // Teacher-only Purge All User Contributions (chat messages, drawings, annotations across main + sub-boards)
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
      scheduleSaveToDisk(room);
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
      scheduleSaveToDisk(room);
      socket.to(room.id).emit('element-start', { ...element, boardId });
    });

    socket.on('element-append-points', ({ id, boardId = 'main', newPoints }) => {
      const meta = socketMeta.get(socket.id);
      if (!meta || !id || !Array.isArray(newPoints)) return;
      const room = rooms.get(meta.roomId);
      if (!room) return;

      const senderRecord = room.usersByUserId.get(meta.userId);
      if (room.isCanvasLocked && !senderRecord?.isTeacher) return;

      const targetElements = getBoardElements(room, boardId);
      if (!targetElements) return;

      const el = targetElements.find((item) => item.id === id);
      if (el && (el.userId === meta.userId || senderRecord?.isTeacher) && Array.isArray(el.points)) {
        el.points.push(...newPoints);
        room.lastActiveAt = Date.now();
        scheduleSaveToDisk(room);
        socket.to(room.id).emit('element-append-points', { id, boardId, newPoints });
      }
    });

    socket.on('element-update', (patch) => {
      const meta = socketMeta.get(socket.id);
      if (!meta || !patch || !patch.id) return;
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
        const { bringToFront, userId: _ignoreUserId, ...cleanPatch } = patch;
        const updated = { ...existing, ...cleanPatch };
        if (bringToFront) {
          targetElements.splice(idx, 1);
          targetElements.push(updated);
        } else {
          targetElements[idx] = updated;
        }
        room.lastActiveAt = Date.now();
        scheduleSaveToDisk(room);
        socket.to(room.id).emit('element-update', {
          ...cleanPatch,
          boardId,
          bringToFront: Boolean(bringToFront),
        });
      }
    });

    socket.on('elements-batch-update', ({ boardId = 'main', updates, bringToFront = false }) => {
      const meta = socketMeta.get(socket.id);
      if (!meta || !Array.isArray(updates) || updates.length === 0) return;
      const room = rooms.get(meta.roomId);
      if (!room) return;

      const senderRecord = room.usersByUserId.get(meta.userId);
      if (room.isCanvasLocked && !senderRecord?.isTeacher) return;

      const targetElements = getBoardElements(room, boardId);
      if (!targetElements) return;

      const updateMap = new Map<string, any>();
      for (const u of updates) {
        if (u && typeof u.id === 'string') {
          updateMap.set(u.id, u);
        }
      }

      const appliedUpdates: any[] = [];
      const movedToFront: any[] = [];

      for (let i = 0; i < targetElements.length; ) {
        const el = targetElements[i];
        const patch = updateMap.get(el.id);
        if (patch && (el.userId === meta.userId || senderRecord?.isTeacher)) {
          const { bringToFront: _ignored, ...cleanPatch } = patch;
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
        room.lastActiveAt = Date.now();
        scheduleSaveToDisk(room);
        socket.to(room.id).emit('elements-batch-updated', {
          boardId,
          updates: appliedUpdates,
          bringToFront: Boolean(bringToFront),
        });
      }
    });

    socket.on('elements-batch-add', ({ boardId = 'main', elements: newElements }) => {
      const meta = socketMeta.get(socket.id);
      if (!meta || !Array.isArray(newElements) || newElements.length === 0) return;
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
            const cloned = {
              ...el,
              id: Math.random().toString(36).substring(2, 11) + '_' + Math.random().toString(36).substring(2, 5),
              boardId: sb.id,
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
      for (const el of newElements) {
        if (el && el.id && !existingIds.has(el.id)) {
          const normalized = { ...el, boardId };
          targetElements.push(normalized);
          existingIds.add(el.id);
          added.push(normalized);
        }
      }

      if (added.length > 0) {
        room.lastActiveAt = Date.now();
        scheduleSaveToDisk(room);
        socket.to(room.id).emit('elements-batch-added', { boardId, elements: added });
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
        room.lastActiveAt = Date.now();
        scheduleSaveToDisk(room);
        socket.to(room.id).emit('elements-batch-removed', { boardId, ids: removedIds });
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
          scheduleSaveToDisk(room);
          socket.to(room.id).emit('element-removed', { id, boardId });
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
          scheduleSaveToDisk(room);
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
      scheduleSaveToDisk(room, true);
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
      scheduleSaveToDisk(room, true);
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

  if (!options.skipVite && process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (!options.skipVite) {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  await new Promise<void>((resolve) => {
    httpServer.listen(portToBind, hostToBind, () => {
      const addr = httpServer.address();
      const listeningPort = typeof addr === 'object' && addr ? addr.port : portToBind;
      if (!options.skipVite) {
        console.log(`Server running on http://localhost:${listeningPort}`);
      }
      resolve();
    });
  });

  const addr = httpServer.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : portToBind;

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

    // Cloud Run allows ~10 s after SIGTERM: push pending room backups before exiting.
    void (backup ? backup.stop() : Promise.resolve()).finally(() => {
      io.close(() => {
        httpServer.close(() => {
          process.exit(0);
        });
      });
    });
  }

  if (!options.skipVite) {
    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
    process.on('SIGINT', () => handleShutdown('SIGINT'));
  }

  async function close() {
    clearInterval(housekeepingInterval);
    clearInterval(timerTickInterval);
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
    await new Promise<void>((resolve) => {
      io.close(() => {
        resolve();
      });
    });
    if (httpServer.listening) {
      await new Promise<void>((resolve) => {
        httpServer.close(() => {
          resolve();
        });
      });
    }
    flushRoomsToDisk();
    await backup?.stop();
    store.close();
  }

  return {
    app,
    store,
    backup,
    httpServer,
    io,
    port: actualPort,
    flushRoomsToDisk,
    flushRoomsToDiskAsync,
    close,
  };
}

const isMainModule =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMainModule) {
  void startServer();
}
