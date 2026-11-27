export const DEFAULT_CHAT_WIDTH = 320;
export const MIN_CHAT_WIDTH = 260;
export const MAX_CHAT_WIDTH = 600;
export const MIN_CANVAS_WIDTH = 280;

export const CHAT_STORAGE_KEYS = {
  WIDTH: 'drawchat_chat_width',
  /** Legacy: written on every load, so only its 'true' (always a deliberate hide; the default was open) is trusted. */
  HIDDEN: 'drawchat_chat_hidden',
  /** The person's own hide/show choice. Written only when they click hide or show. */
  HIDDEN_CHOICE: 'allaboard_chat_hidden_choice',
} as const;

/**
 * Below this viewport width (phones, and tablets held upright: iPad portrait is 768–834 px) the chat sidebar starts
 * hidden unless the person has chosen otherwise, so the board gets the screen. Tablets held sideways and laptops keep
 * it open.
 */
export const COMPACT_LAYOUT_MAX_WIDTH = 900;

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

export function readStoredChatWidth(storage?: Pick<Storage, 'getItem'> | null, viewportWidth?: number): number {
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

/** Whether the chat sidebar starts hidden: the person's own choice if they made one, else hidden on narrow screens. */
export function readStoredChatHidden(storage?: Pick<Storage, 'getItem'> | null, viewportWidth?: number): boolean {
  const narrow =
    typeof viewportWidth === 'number' &&
    Number.isFinite(viewportWidth) &&
    viewportWidth > 0 &&
    viewportWidth < COMPACT_LAYOUT_MAX_WIDTH;
  try {
    const choice = storage?.getItem(CHAT_STORAGE_KEYS.HIDDEN_CHOICE);
    if (choice === 'true' || choice === 'false') return choice === 'true';
    if (storage?.getItem(CHAT_STORAGE_KEYS.HIDDEN) === 'true') return true;
  } catch {
    // Storage blocked: fall through to the screen-size default.
  }
  return narrow;
}

/** Remember the person's own hide/show choice (call only from their click, never on load). */
export function storeChatHiddenChoice(storage: Pick<Storage, 'setItem'> | null | undefined, hidden: boolean): void {
  try {
    storage?.setItem(CHAT_STORAGE_KEYS.HIDDEN_CHOICE, hidden ? 'true' : 'false');
  } catch {
    // Ignore: the choice just won't survive a reload.
  }
}
