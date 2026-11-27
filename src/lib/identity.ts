import { normalizeRoomCode } from './roomCode';

export const STORAGE_KEYS = {
  USER_ID: 'drawchat_user_id',
  USER_KEY: 'drawchat_user_key',
  USER_NAME: 'drawchat_user_name',
  IS_JOINED: 'drawchat_is_joined',
  JOINED_ROOM_SESSION: 'drawchat_joined_room_session',
  TEACHER_PIN_PREFIX: 'drawchat_teacher_pin_',
};

export function getOrCreatePersistentUserId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEYS.USER_ID);
    if (existing) return existing;
    const created = 'usr_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now().toString(36);
    localStorage.setItem(STORAGE_KEYS.USER_ID, created);
    return created;
  } catch {
    return 'usr_' + Math.random().toString(36).substring(2, 11);
  }
}

/** Private proof that this browser owns its userId. Unlike the userId, it is never shown to other users. */
export function getOrCreatePersistentUserKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const created = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    const existing = localStorage.getItem(STORAGE_KEYS.USER_KEY);
    if (existing) return existing;
    localStorage.setItem(STORAGE_KEYS.USER_KEY, created);
  } catch {
    // Storage blocked: the userId is per-page-load too, so a per-page-load key still matches it
  }
  return created;
}

function normalizeClientRoomId(raw?: string): string {
  return normalizeRoomCode(raw);
}

export function hasInitialUrlRoomParam(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return Boolean(params.get('room')?.trim());
  } catch {
    return false;
  }
}

export function getInitialRoomId(): string {
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('room');
    if (fromUrl && fromUrl.trim()) {
      return normalizeClientRoomId(fromUrl);
    }
  } catch {
    // Ignore
  }
  return 'main';
}

export function generateFreshRoomCode(): string {
  const num = Math.floor(100 + Math.random() * 900);
  const suffix = Math.random().toString(36).substring(2, 4);
  return `class-${num}${suffix}`;
}

