import type { CanvasElement, RoomBackground } from '../types';
import { layoutPages } from './worksheetLayout.ts';

/** Which quarter of a worksheet page a point falls in. */
export type Quadrant = 'tl' | 'tr' | 'bl' | 'br';

export const QUADRANTS: Quadrant[] = ['tl', 'tr', 'bl', 'br'];

/**
 * Finds the worksheet page containing (x, y) and splits that page at its center.
 * Returns null when there is no background or the point is on no page.
 */
export function quadrantForPoint(x: number, y: number, bg: RoomBackground | null): Quadrant | null {
  if (!bg || !Array.isArray(bg.pages) || bg.pages.length === 0) return null;
  for (const r of layoutPages(bg)) {
    if (x < r.x || x > r.x + r.width || y < r.y || y > r.y + r.height) continue;
    const left = x < r.x + r.width / 2;
    const top = y < r.y + r.height / 2;
    return top ? (left ? 'tl' : 'tr') : left ? 'bl' : 'br';
  }
  return null;
}

/** The user's latest name stamp (highest timestamp; ties/missing timestamps → last in the array). */
export function latestNameStamp(elements: CanvasElement[], userId: string): CanvasElement | null {
  let best: CanvasElement | null = null;
  let bestTs = -Infinity;
  for (const el of elements) {
    if (el.tool !== 'stamp' || el.stamp !== 'username' || el.userId !== userId) continue;
    const ts = typeof el.timestamp === 'number' ? el.timestamp : -Infinity;
    if (ts >= bestTs) {
      best = el;
      bestTs = ts;
    }
  }
  return best;
}

/** Quadrant of each user's latest name stamp on the given board (null = no stamp or off the worksheet). */
export function quadrantsByUser(
  elements: CanvasElement[],
  bg: RoomBackground | null,
  userIds: string[]
): Record<string, Quadrant | null> {
  const out: Record<string, Quadrant | null> = {};
  for (const uid of userIds) {
    const stamp = latestNameStamp(elements, uid);
    out[uid] =
      stamp && typeof stamp.x === 'number' && typeof stamp.y === 'number'
        ? quadrantForPoint(stamp.x, stamp.y, bg)
        : null;
  }
  return out;
}
