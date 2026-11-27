import type { CanvasElement } from '../types';
import { isAnonymousAuthorId } from './anonymousInk';

export interface SelectionAuthor {
  key: string;
  name: string;
  itemCount: number;
}

const ANONYMOUS_KEY = 'anonymous';

/** Groups all anonymously shared ink under one author; everyone else is keyed by their userId. */
export function authorKeyOf(userId: string): string {
  return isAnonymousAuthorId(userId) ? ANONYMOUS_KEY : userId;
}

/**
 * Who made the selected items, most items first. Authors are grouped by userId, so two students with the same
 * display name stay separate. Anonymously shared ink is one entry and never resolves to a real student.
 */
export function summarizeSelectionAuthors(
  elements: CanvasElement[],
  rosterNames: ReadonlyMap<string, string>,
  currentUserId: string
): SelectionAuthor[] {
  const authors = new Map<string, SelectionAuthor>();
  for (const el of elements) {
    if (el.tool === 'eraser') continue;
    const anonymous = isAnonymousAuthorId(el.userId);
    const key = authorKeyOf(el.userId);
    const existing = authors.get(key);
    if (existing) {
      existing.itemCount += 1;
      continue;
    }
    const name = anonymous
      ? el.userName || 'Class Example'
      : el.userId === currentUserId
        ? 'You'
        : rosterNames.get(el.userId) || el.userName || 'Student';
    authors.set(key, { key, name, itemCount: 1 });
  }
  return Array.from(authors.values()).sort((a, b) => b.itemCount - a.itemCount || a.name.localeCompare(b.name));
}

/** Short toolbar label: "By Sam", "By Sam, Ada" or "By Sam, Ada +3". */
export function formatSelectionAuthors(authors: SelectionAuthor[], maxShown = 2): string {
  if (authors.length === 0) return '';
  const shown = authors
    .slice(0, maxShown)
    .map((author) => author.name)
    .join(', ');
  const hidden = authors.length - maxShown;
  return `By ${shown}${hidden > 0 ? ` +${hidden}` : ''}`;
}

/** Full list for the tooltip: "Sam (2 items), Ada (1 item)". */
export function describeSelectionAuthors(authors: SelectionAuthor[]): string {
  return authors
    .map((author) => `${author.name} (${author.itemCount} ${author.itemCount === 1 ? 'item' : 'items'})`)
    .join(', ');
}
