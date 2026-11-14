/**
 * Room-code cleanup matching `server.ts` `normalizeRoomId` exactly:
 *   trim -> lowercase -> replace anything not [a-z0-9-_] with "-"
 *   -> collapse repeated "-" -> trim leading/trailing "-" -> empty means "main".
 */
export function normalizeRoomCode(raw?: string): string {
  const cleaned = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || 'main';
}

/**
 * Live input sanitizer while typing a room code:
 * lowercases, replaces disallowed characters with "-" (never strips them),
 * and collapses repeated "-". Leading/trailing "-" are trimmed on commit/blur
 * via `normalizeRoomCode` so users can naturally type hyphenated words.
 */
export function sanitizeRoomCodeDraft(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-');
}
