/**
 * Author ids for ink shared to Main anonymously. Each original author gets their own id because erasers only
 * affect ink with the same userId; merging authors would let one student's eraser cut another student's work.
 */
const ANONYMOUS_AUTHOR_PREFIX = 'anon_';

export function makeAnonymousAuthorId(uniqueId: string): string {
  return ANONYMOUS_AUTHOR_PREFIX + uniqueId;
}

export function isAnonymousAuthorId(userId: string): boolean {
  return userId.startsWith(ANONYMOUS_AUTHOR_PREFIX);
}
