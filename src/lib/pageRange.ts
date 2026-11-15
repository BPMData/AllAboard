export interface PageRange { first: number; last: number } // 1-based, inclusive

/** Clamp a requested range to [1, total] and to at most `max` pages, keeping `first` fixed when possible. */
export function clampPageRange(first: number, last: number, total: number, max: number): PageRange {
  const t = Math.max(1, Math.floor(total));
  const f = Math.min(Math.max(1, Math.floor(first) || 1), t);
  let l = Math.min(Math.max(f, Math.floor(last) || f), t);
  if (l - f + 1 > max) l = f + max - 1;
  return { first: f, last: l };
}
