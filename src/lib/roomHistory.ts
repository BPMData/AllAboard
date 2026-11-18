import { normalizeRoomCode } from './roomCode';

export const ROOM_HISTORY_STORAGE_KEY = 'allaboard.roomHistory';
export const MAX_ROOM_HISTORY = 20;

export interface RoomHistoryEntry {
  code: string;
  createdAt: number;
  lastUsedAt: number;
}

export type RoomLiveStatus = 'checking' | 'live' | 'saved' | 'expired' | 'unknown';

export interface RoomStatusInfo {
  status: Exclude<RoomLiveStatus, 'checking'>;
  activeUserCount: number;
  hasTeacherPin: boolean;
}

export const STATUS_RANK: Record<RoomLiveStatus, number> = {
  live: 0,
  saved: 1,
  checking: 2,
  unknown: 3,
  expired: 4,
};

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'getItem' | 'setItem'>;
type StorageRemover = Pick<Storage, 'removeItem'>;

function getDefaultStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Validate, normalize, deduplicate, and sort raw room history entries.
 */
export function sanitizeRoomHistoryEntries(raw: unknown, fallbackNow = Date.now()): RoomHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const byCode = new Map<string, RoomHistoryEntry>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rawCode = (item as { code?: unknown }).code;
    if (typeof rawCode !== 'string' || !rawCode.trim()) continue;
    const code = normalizeRoomCode(rawCode);
    const createdAtRaw = (item as { createdAt?: unknown }).createdAt;
    const lastUsedAtRaw = (item as { lastUsedAt?: unknown }).lastUsedAt;
    const lastUsedAt =
      typeof lastUsedAtRaw === 'number' && Number.isFinite(lastUsedAtRaw) ? lastUsedAtRaw : fallbackNow;
    const createdAt =
      typeof createdAtRaw === 'number' && Number.isFinite(createdAtRaw) ? createdAtRaw : lastUsedAt;
    const prev = byCode.get(code);
    if (!prev) {
      byCode.set(code, { code, createdAt, lastUsedAt });
    } else {
      byCode.set(code, {
        code,
        createdAt: Math.min(prev.createdAt, createdAt),
        lastUsedAt: Math.max(prev.lastUsedAt, lastUsedAt),
      });
    }
  }
  return [...byCode.values()]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, MAX_ROOM_HISTORY);
}

function saveRoomHistory(entries: RoomHistoryEntry[], storage?: Pick<Storage, 'setItem'> | null): void {
  const target = storage === undefined ? getDefaultStorage() : storage;
  if (!target) return;
  try {
    target.setItem(ROOM_HISTORY_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Ignore storage quota / private-mode errors
  }
}

/** Load sanitized recent rooms from storage, newest first. */
export function loadRoomHistory(storage?: StorageReader | null): RoomHistoryEntry[] {
  const target = storage === undefined ? getDefaultStorage() : storage;
  if (!target) return [];
  try {
    const raw = target.getItem(ROOM_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    return sanitizeRoomHistoryEntries(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** Record or bump a visited room code in local history. */
export function recordRoomHistory(
  rawCode: string,
  now = Date.now(),
  storage?: StorageWriter | null
): RoomHistoryEntry[] {
  const target = storage === undefined ? getDefaultStorage() : storage;
  const current = loadRoomHistory(target);
  if (typeof rawCode !== 'string' || !rawCode.trim()) {
    return current;
  }
  const code = normalizeRoomCode(rawCode);
  const existing = current.find((entry) => entry.code === code);
  const nextEntry: RoomHistoryEntry = {
    code,
    createdAt: existing ? Math.min(existing.createdAt, now) : now,
    lastUsedAt: now,
  };
  const updated = [nextEntry, ...current.filter((entry) => entry.code !== code)]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, MAX_ROOM_HISTORY);
  saveRoomHistory(updated, target);
  return updated;
}

/** Remove a single room code from local history. */
export function removeRoomHistoryEntry(
  rawCode: string,
  storage?: StorageWriter | null
): RoomHistoryEntry[] {
  const target = storage === undefined ? getDefaultStorage() : storage;
  const current = loadRoomHistory(target);
  if (typeof rawCode !== 'string' || !rawCode.trim()) {
    return current;
  }
  const code = normalizeRoomCode(rawCode);
  const updated = current.filter((entry) => entry.code !== code);
  saveRoomHistory(updated, target);
  return updated;
}

/** Clear all saved room history entries. */
export function clearRoomHistory(storage?: StorageRemover | null): void {
  const target = storage === undefined ? getDefaultStorage() : storage;
  if (!target) return;
  try {
    target.removeItem(ROOM_HISTORY_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

/** Query the server's room availability endpoint for a history entry. */
export async function checkRoomHistoryStatus(
  rawCode: string,
  fetchImpl: typeof fetch = fetch
): Promise<RoomStatusInfo> {
  if (typeof rawCode !== 'string' || !rawCode.trim()) {
    return { status: 'expired', activeUserCount: 0, hasTeacherPin: false };
  }
  const code = normalizeRoomCode(rawCode);
  try {
    const signal =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(8_000)
        : undefined;
    const response = await fetchImpl(`/api/rooms/${encodeURIComponent(code)}`, {
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (response.status === 404) {
      return { status: 'expired', activeUserCount: 0, hasTeacherPin: false };
    }
    if (!response.ok) {
      return { status: 'unknown', activeUserCount: 0, hasTeacherPin: false };
    }
    const data = (await response.json()) as {
      exists?: unknown;
      activeUserCount?: unknown;
      hasTeacherPin?: unknown;
    };
    if (!data || typeof data !== 'object' || typeof data.exists !== 'boolean') {
      return { status: 'unknown', activeUserCount: 0, hasTeacherPin: false };
    }
    if (!data.exists) {
      return { status: 'expired', activeUserCount: 0, hasTeacherPin: false };
    }
    const activeUserCount =
      typeof data.activeUserCount === 'number' && Number.isFinite(data.activeUserCount) && data.activeUserCount > 0
        ? Math.floor(data.activeUserCount)
        : 0;
    const hasTeacherPin = Boolean(data.hasTeacherPin);
    return {
      status: activeUserCount > 0 ? 'live' : 'saved',
      activeUserCount,
      hasTeacherPin,
    };
  } catch {
    return { status: 'unknown', activeUserCount: 0, hasTeacherPin: false };
  }
}

/** Sort rooms by live status rank then recency, optionally filtering to live/checking rooms. */
export function sortAndFilterRoomHistory(
  entries: RoomHistoryEntry[],
  statuses: Record<string, RoomStatusInfo | undefined>,
  liveOnly: boolean
): RoomHistoryEntry[] {
  const sorted = [...entries].sort((a, b) => {
    const statusA: RoomLiveStatus = statuses[a.code]?.status ?? 'checking';
    const statusB: RoomLiveStatus = statuses[b.code]?.status ?? 'checking';
    const rankA = STATUS_RANK[statusA];
    const rankB = STATUS_RANK[statusB];
    if (rankA !== rankB) return rankA - rankB;
    return b.lastUsedAt - a.lastUsedAt;
  });
  if (!liveOnly) return sorted;
  return sorted.filter((entry) => {
    const st = statuses[entry.code]?.status ?? 'checking';
    return st === 'live' || st === 'checking';
  });
}

/** Human-friendly relative age label for a history entry. */
export function formatRoomAge(timestamp: number, now = Date.now()): string {
  const diffMs = Math.max(0, now - timestamp);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/** Human-readable status badge text for a room status lookup. */
export function formatRoomStatusLabel(info: RoomStatusInfo | undefined): string {
  if (!info) return 'Checking…';
  switch (info.status) {
    case 'live':
      return info.activeUserCount > 0 ? `Live · ${info.activeUserCount} online` : 'Live';
    case 'saved':
      return 'Saved · rejoinable';
    case 'expired':
      return 'Expired';
    case 'unknown':
      return 'Status unknown';
  }
}
