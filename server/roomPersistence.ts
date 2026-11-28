import fs from 'fs';
import { BackupMirror, DirBackend, GcsBackend, type BackupBackend } from '../backupMirror.ts';
import { RoomStore, internBackground } from '../roomStore.ts';
import { isHashedPin } from '../socketGuards.ts';
import { migrateLegacyBreakout, normalizeBreakoutConfig } from '../src/lib/breakoutRounds.ts';
import {
  IDLE_UNLOAD_MS,
  ROOM_TTL_MS,
  deserializeSubBoards,
  getRosterPayload,
  isRoomEmpty,
  normalizeRoomId,
  serializeSubBoards,
  storedPinHash,
  storedRoundVariants,
  storedTemplateInk,
} from './roomSerialization.ts';
import type { RoomState, SerializedRoom, StartServerOptions } from './types.ts';

/**
 * Production backup bucket. It lives in code, not in an env var or volume mount, because AI Studio's
 * Deploy button replaces the Cloud Run service config (env vars, volumes) on every publish.
 */
const DEFAULT_BACKUP_BUCKET = 'allaboard-data';

export function isProductionRuntime(): boolean {
  return (
    process.env.NODE_ENV === 'production' || (process.env.NODE_ENV !== 'development' && Boolean(process.env.K_SERVICE))
  );
}

/** Cloud Run always uses the bucket. Local runs may explicitly select a directory. */
export async function openBackupMirror(store: RoomStore, options: StartServerOptions): Promise<BackupMirror | null> {
  const dir = options.backupDir ?? process.env.BACKUP_DIR ?? '';
  const isProd = isProductionRuntime();
  const onCloudRun = Boolean(process.env.K_SERVICE) && isProd;
  const bucket = process.env.BACKUP_BUCKET ?? (onCloudRun ? DEFAULT_BACKUP_BUCKET : '');

  const candidates: BackupBackend[] = [];
  if (dir && !onCloudRun) candidates.push(new DirBackend(dir));
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
  if (candidates.length > 0 || isProd) {
    console.warn('Backups are OFF: rooms will NOT survive a cold start or redeploy.');
  }
  return null;
}

export function createRoomPersistence({
  store,
  backup,
  rooms,
  legacyStoreFile,
}: {
  store: RoomStore;
  backup: BackupMirror | null;
  rooms: Map<string, RoomState>;
  legacyStoreFile: string;
}) {
  const dirtyRooms = new Set<string>();
  let saveTimeout: NodeJS.Timeout | null = null;
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
      roundTemplateInk: storedTemplateInk(item.roundTemplateInk),
      roundVariants: storedRoundVariants(item.roundVariants),
      timer: item.timer || {
        isRunning: false,
        durationMs: 5 * 60 * 1000,
        remainingMs: 0,
        endsAt: null,
        autoLockOnExpire: false,
      },
      usersByUserId: new Map(),
      userKeyHashes: new Map(
        Object.entries(item.userKeyHashes && typeof item.userKeyHashes === 'object' ? item.userKeyHashes : {}).filter(
          ([, hash]) => typeof hash === 'string'
        )
      ),
      lockedNames: item.lockedNames && typeof item.lockedNames === 'object' ? item.lockedNames : {},
      bannedUsers: item.bannedUsers && typeof item.bannedUsers === 'object' ? item.bannedUsers : {},
      isCanvasLocked: Boolean(item.isCanvasLocked),
      hideStudentCursors: Boolean(item.hideStudentCursors),
      oneNameStamp: Boolean(item.oneNameStamp),
      teacherPinHash: storedPinHash(item),
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
      roundTemplateInk: room.roundTemplateInk,
      roundVariants: room.roundVariants,
      timer: room.timer,
      userKeyHashes: Object.fromEntries(room.userKeyHashes),
      lockedNames: room.lockedNames,
      bannedUsers: room.bannedUsers,
      isCanvasLocked: room.isCanvasLocked,
      hideStudentCursors: room.hideStudentCursors,
      oneNameStamp: room.oneNameStamp,
      teacherPinHash: room.teacherPinHash,
      lastActiveAt: room.lastActiveAt,
    };
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
    for (const v of Object.values(room.roundVariants)) {
      v.extra = v.extra.map((bg) => (bg ? internBackground(store, bg) : null));
    }
    if (room.breakoutConfig.autoIndividualBackground !== undefined) {
      room.breakoutConfig.autoIndividualBackground = internBackground(
        store,
        room.breakoutConfig.autoIndividualBackground
      );
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
      for await (const { roomId, state, lastActiveAt } of backup.rooms()) {
        const room = hydrateRoom({ ...state, id: roomId, lastActiveAt });
        if (!room) {
          backup.deleteRoom(roomId); // expired
          continue;
        }
        // A plain-text PIN in the bucket copy: rewrite it there too (hydrateRoom already hashed it).
        const legacyPin =
          typeof state?.teacherPin === 'string' && Boolean(state.teacherPin) && !isHashedPin(state.teacherPin);
        const local = store.loadRoom<SerializedRoom>(roomId);
        if (local && local.lastActiveAt >= room.lastActiveAt) {
          if (legacyPin) backupRoom(roomId);
          continue;
        }
        store.saveRoom(roomId, serializeRoom(room), room.lastActiveAt);
        if (legacyPin) backupRoom(roomId);
        restored++;
      }
      console.log(`Restored ${restored} room(s) from backup.`);
    } catch (err) {
      backup.restoreErrors++;
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
    if (stored.state.teacherPin && restored.teacherPinHash) scheduleSaveToDisk(restored, true); // rewrite without plain text
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
        breakoutConfig: {
          mode: 'main',
          activeRoundId: undefined,
          rounds: [],
          allowSelfSelect: false,
          chatScope: 'unified',
        },
        roundTemplates: {},
        roundTemplateInk: {},
        roundVariants: {},
        timer: {
          isRunning: false,
          durationMs: 5 * 60 * 1000,
          remainingMs: 0,
          endsAt: null,
          autoLockOnExpire: false,
        },
        usersByUserId: new Map(),
        userKeyHashes: new Map(),
        lockedNames: {},
        bannedUsers: {},
        isCanvasLocked: false,
        hideStudentCursors: false,
        oneNameStamp: false,
        teacherPinHash: null,
        lastActiveAt: Date.now(),
      };
      rooms.set(roomId, room);
    }
    return room;
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
      room.elements.length > 0 || room.messages.length > 0 || room.background !== null || room.subBoards.size > 0;
    const hasTeacherPin = room.teacherPinHash !== null;
    return {
      roomId: normalizedId,
      exists: activeUserCount > 0 || hasContent || hasTeacherPin,
      activeUserCount,
      hasTeacherPin,
      hasContent,
    };
  }
  function cancelPendingSave() {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
  }
  return {
    internRoomAssets,
    migrateLegacyJsonStore,
    restoreFromBackup,
    runHousekeeping,
    findRoom,
    getOrCreateRoom,
    getRoomAvailability,
    scheduleSaveToDisk,
    flushRoomsToDisk,
    flushRoomsToDiskAsync,
    cancelPendingSave,
  };
}
