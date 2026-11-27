import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { internBackground, type RoomStore } from '../roomStore.ts';
import { elementFieldsOk, hashPinSync, isHashedPin, MAX_BOARD_ELEMENTS } from '../socketGuards.ts';
import { getRounds, type BreakoutConfigLike } from '../src/lib/breakoutRounds.ts';
import { hasVariantContent, normalizeRoundVariants, type RoundVariants } from '../src/lib/roundVariants.ts';
import type { ConfigureBreakoutPayload, StudentStatus } from '../src/types.ts';
import type { RoomState, SerializedRoom, SubBoardState, UserKeyCheck } from './types.ts';

export function serializeSubBoards(subBoards: Map<string, SubBoardState>): Record<string, SubBoardState> {
  const obj: Record<string, SubBoardState> = {};
  for (const [k, v] of subBoards.entries()) {
    obj[k] = v;
  }
  return obj;
}

export function deserializeSubBoards(raw?: Record<string, SubBoardState>): Map<string, SubBoardState> {
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

/** The room's PIN hash. A legacy plain-text PIN is hashed here, once, when its room loads. */
export function storedPinHash(item: SerializedRoom): string | null {
  if (typeof item.teacherPinHash === 'string' && isHashedPin(item.teacherPinHash)) return item.teacherPinHash;
  if (typeof item.teacherPin === 'string' && item.teacherPin) {
    return isHashedPin(item.teacherPin) ? item.teacherPin : hashPinSync(item.teacherPin.trim());
  }
  return null;
}

export function isRoomEmpty(room: RoomState): boolean {
  return (
    room.elements.length === 0 &&
    room.messages.length === 0 &&
    room.background === null &&
    room.subBoards.size === 0 &&
    Object.keys(room.roundTemplateInk).length === 0 &&
    room.teacherPinHash === null &&
    Object.keys(room.lockedNames).length === 0 &&
    Object.keys(room.bannedUsers).length === 0
  );
}

export function normalizeRoomId(raw?: string): string {
  const cleaned = String(raw || 'main')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || 'main';
}

export function getRosterPayload(room: RoomState) {
  const list: Array<{
    userId: string;
    name: string;
    color: string;
    isTeacher: boolean;
    isNameLocked?: boolean;
    status: StudentStatus;
    statusUpdatedAt?: number;
  }> = [];
  for (const record of room.usersByUserId.values()) {
    if (record.sockets.size > 0) {
      list.push({
        userId: record.userId,
        name: record.name,
        color: record.color,
        isTeacher: record.isTeacher,
        isNameLocked: Boolean(record.isNameLocked || room.lockedNames[record.userId]),
        status: record.status || 'none',
        statusUpdatedAt: record.statusUpdatedAt,
      });
    }
  }
  return list;
}

export function getRoomSettingsPayload(room: RoomState) {
  return {
    roomId: room.id,
    isCanvasLocked: room.isCanvasLocked,
    hideStudentCursors: room.hideStudentCursors,
    oneNameStamp: room.oneNameStamp,
    hasTeacherPin: room.teacherPinHash !== null,
    lastSavedAt: room.lastActiveAt,
    breakoutConfig: room.breakoutConfig,
    timer: room.timer,
    bannedUsers: Object.values(room.bannedUsers),
  };
}

/** A stored `roundTemplateInk` (SQLite row): only array values. */
export function storedTemplateInk(raw: unknown): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, list] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(list) && list.length > 0) out[key] = list;
  }
  return out;
}

/** A stored `roundVariants` (SQLite row): only valid records. Backgrounds are interned by internRoomAssets. */
export function storedRoundVariants(raw: unknown): Record<string, RoundVariants> {
  const out: Record<string, RoundVariants> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = normalizeRoundVariants(value);
    if (v) out[key] = v;
  }
  return out;
}

/**
 * Imported `roundTemplateInk`: only keys naming a round in `cfg`, each a list of sound elements (no name stamps) at
 * most `MAX_BOARD_ELEMENTS` long, with fresh server ids.
 */
export function cleanImportedTemplateInk(raw: unknown, cfg: BreakoutConfigLike): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  if (!raw || typeof raw !== 'object') return out;
  const ids = new Set(getRounds(cfg).map((r) => r.id));
  for (const [key, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!ids.has(key) || !Array.isArray(list) || list.length > MAX_BOARD_ELEMENTS) continue;
    const ink = list
      .filter((el) => el && typeof el === 'object' && typeof el.userId === 'string' && elementFieldsOk(el))
      .filter((el) => !(el.tool === 'stamp' && el.stamp === 'username'))
      .map((el) => ({ ...structuredClone(el), id: randomUUID() }));
    if (ink.length > 0) out[key] = ink;
  }
  return out;
}

export function payloadWorksheet(room: RoomState, payload: ConfigureBreakoutPayload): any | null | undefined {
  if (payload.customBackground !== undefined) return payload.customBackground;
  if (payload.copyWorksheet) return room.background;
  return undefined;
}

export function cleanRoundTitle(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 40) : undefined;
}

export function createRoomSerialization(store: RoomStore) {
  function cloneBackground(bg: any | null | undefined): any | null {
    return bg ? internBackground(store, bg) : null;
  }

  /** Imported `roundTemplates`: only keys naming a round in `cfg`, each value a background (interned) or null. */
  function cleanImportedRoundTemplates(raw: unknown, cfg: BreakoutConfigLike): Record<string, any | null> {
    const out: Record<string, any | null> = {};
    if (!raw || typeof raw !== 'object') return out;
    const ids = new Set(getRounds(cfg).map((r) => r.id));
    for (const [key, bg] of Object.entries(raw as Record<string, unknown>)) {
      if (!ids.has(key)) continue;
      if (bg === null) out[key] = null;
      else if (bg && typeof bg === 'object' && Array.isArray((bg as any).pages)) out[key] = cloneBackground(bg);
    }
    return out;
  }

  /** A variants record from a client or a file: checked, worksheets interned. null when it carries nothing. */
  function cleanRoundVariants(raw: unknown): RoundVariants | null {
    const v = normalizeRoundVariants(raw);
    if (!v) return null;
    v.extra = v.extra.map((bg) => (bg ? cloneBackground(bg) : null));
    return hasVariantContent(v) ? v : null;
  }

  /** Imported `roundVariants`: only keys naming an individual round in `cfg`. */
  function cleanImportedRoundVariants(raw: unknown, cfg: BreakoutConfigLike): Record<string, RoundVariants> {
    const out: Record<string, RoundVariants> = {};
    if (!raw || typeof raw !== 'object') return out;
    const ids = new Set(
      getRounds(cfg)
        .filter((r) => r.mode === 'individual')
        .map((r) => r.id)
    );
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!ids.has(key)) continue;
      const v = cleanRoundVariants(value);
      if (v) out[key] = v;
    }
    return out;
  }
  return { cloneBackground, cleanImportedRoundTemplates, cleanRoundVariants, cleanImportedRoundVariants };
}

export const ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days inactivity cleanup
/** Wrong Teacher PINs allowed per room per window, from all sockets together (a 4-digit PIN then takes days). */
export const PIN_FAILURES_PER_WINDOW = 10;
export const MAX_CHAT_CHARS = 2_000;
export const PIN_FAILURE_WINDOW_MS = 5 * 60 * 1000;
export const IDLE_UNLOAD_MS = 15 * 60 * 1000;
export const HOUSEKEEPING_INTERVAL_MS = 5 * 60 * 1000;
export const USER_KEY_PATTERN = /^[0-9a-f]{64}$/;
/** Group boards per breakout round (the UI offers up to 8; lesson packs allow up to 30). */
export const MAX_GROUPS_PER_ROUND = 30;

/**
 * Proves a join comes from the browser that first used this userId in this room. userIds are public (they're in the
 * roster), so the private key is what stops someone taking over a classmate's or teacher's identity.
 * 'keyless' covers tabs still running a pre-key bundle: allowed only while nobody has claimed the id.
 */
export function checkUserKey(keyHashes: Map<string, string>, userId: string, rawKey: unknown): UserKeyCheck {
  const stored = keyHashes.get(userId);
  if (typeof rawKey !== 'string' || !USER_KEY_PATTERN.test(rawKey)) return stored ? 'rejected' : 'keyless';
  const hash = createHash('sha256').update(rawKey).digest('hex');
  if (!stored) {
    keyHashes.set(userId, hash);
    return 'claimed';
  }
  return timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(hash, 'hex')) ? 'matched' : 'rejected';
}
