export const DEFAULT_CHAT_WIDTH = 320;
export const MIN_CHAT_WIDTH = 260;
export const MAX_CHAT_WIDTH = 600;
export const MIN_CANVAS_WIDTH = 280;

export const CHAT_STORAGE_KEYS = {
  WIDTH: 'drawchat_chat_width',
  HIDDEN: 'drawchat_chat_hidden',
} as const;

export function getMaxChatWidth(viewportWidth?: number): number {
  if (typeof viewportWidth !== 'number' || !Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return MAX_CHAT_WIDTH;
  }
  return Math.max(MIN_CHAT_WIDTH, Math.min(MAX_CHAT_WIDTH, viewportWidth - MIN_CANVAS_WIDTH));
}

export function clampChatWidth(width: number, viewportWidth?: number): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return DEFAULT_CHAT_WIDTH;
  }
  const maxWidth = getMaxChatWidth(viewportWidth);
  return Math.round(Math.min(maxWidth, Math.max(MIN_CHAT_WIDTH, width)));
}

export function readStoredChatWidth(
  storage?: Pick<Storage, 'getItem'> | null,
  viewportWidth?: number
): number {
  try {
    const raw = storage?.getItem(CHAT_STORAGE_KEYS.WIDTH);
    if (!raw) return clampChatWidth(DEFAULT_CHAT_WIDTH, viewportWidth);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return clampChatWidth(DEFAULT_CHAT_WIDTH, viewportWidth);
    return clampChatWidth(parsed, viewportWidth);
  } catch {
    return clampChatWidth(DEFAULT_CHAT_WIDTH, viewportWidth);
  }
}

export function readStoredChatHidden(storage?: Pick<Storage, 'getItem'> | null): boolean {
  try {
    return storage?.getItem(CHAT_STORAGE_KEYS.HIDDEN) === 'true';
  } catch {
    return false;
  }
}
