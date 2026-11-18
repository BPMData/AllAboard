/**
 * Teacher overview digests: instead of live ink for every board, a teacher gets live traffic only for the board they
 * are viewing, and every OVERVIEW_SYNC_MS a `boards-digest` with what changed on the other boards.
 * Shared by the server (builds digests) and the client (applies them).
 */

/** How often teachers get changes from boards they aren't viewing (overview grid, roster counts, switcher). */
export const OVERVIEW_SYNC_MS = 1500;

export interface BoardDigest<E = any> {
  boardId: string;
  /** Present when the board must be replaced wholesale (clear, reorder). Otherwise apply `removed` then `upserts`. */
  elements?: E[];
  upserts?: E[];
  removed?: string[];
}

/** What changed on one board since the last digest. */
export interface BoardChanges {
  full: boolean;
  upserts: Set<string>;
  removed: Set<string>;
}

export function emptyChanges(): BoardChanges {
  return { full: false, upserts: new Set(), removed: new Set() };
}

export function buildDigest<E extends { id: string }>(boardId: string, changes: BoardChanges, elements: E[]): BoardDigest<E> {
  if (changes.full) return { boardId, elements };
  const byId = new Map(elements.map((e) => [e.id, e]));
  const upserts: E[] = [];
  const removed = new Set(changes.removed);
  for (const id of changes.upserts) {
    const el = byId.get(id);
    if (el) upserts.push(el);
    else removed.add(id);
  }
  const digest: BoardDigest<E> = { boardId };
  if (upserts.length) digest.upserts = upserts;
  if (removed.size) digest.removed = Array.from(removed);
  return digest;
}

/** Applies a digest to a board's element list. New elements are appended; existing ones are replaced in place. */
export function applyDigest<E extends { id: string }>(list: E[], digest: BoardDigest<E>): E[] {
  if (Array.isArray(digest.elements)) return digest.elements;
  const removed = new Set(digest.removed ?? []);
  const upserts = new Map((digest.upserts ?? []).map((e) => [e.id, e]));
  if (removed.size === 0 && upserts.size === 0) return list;
  const next: E[] = [];
  for (const el of list) {
    if (removed.has(el.id)) continue;
    const up = upserts.get(el.id);
    if (up) {
      next.push(up);
      upserts.delete(el.id);
    } else next.push(el);
  }
  for (const up of upserts.values()) next.push(up);
  return next;
}
