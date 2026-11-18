/**
 * Coalesces streaming ink (`element-append-points`) so we send, and re-render, far less often.
 * Used twice by App.tsx: outgoing (flush every POINT_FLUSH_MS) and incoming (flush once per animation frame).
 * Order is preserved: per element, points stay in arrival order; across elements, first-seen order.
 */

export interface PointBatch {
  boardId: string;
  id: string;
  points: number[];
}

export interface PointQueue {
  add(boardId: string, id: string, points: number[]): void;
  /** Deliver everything queued right now. Call before any other event that touches the same elements. */
  flush(): void;
  /** Drop everything queued without delivering it. */
  clear(): void;
  readonly size: number;
}

/** `schedule(run)` arranges for `run` to be called later and returns a cancel function. */
export type Scheduler = (run: () => void) => () => void;

export function createPointQueue(deliver: (batches: PointBatch[]) => void, schedule: Scheduler): PointQueue {
  let queued = new Map<string, PointBatch>();
  let cancel: (() => void) | null = null;

  const flush = () => {
    if (cancel) {
      cancel();
      cancel = null;
    }
    if (queued.size === 0) return;
    const batches = Array.from(queued.values());
    queued = new Map();
    deliver(batches);
  };

  return {
    add(boardId, id, points) {
      if (!id || !Array.isArray(points) || points.length === 0) return;
      const key = `${boardId}\u0000${id}`;
      const existing = queued.get(key);
      if (existing) existing.points.push(...points);
      else queued.set(key, { boardId, id, points: [...points] });
      if (!cancel) cancel = schedule(flush);
    },
    flush,
    clear() {
      if (cancel) cancel();
      cancel = null;
      queued = new Map();
    },
    get size() {
      return queued.size;
    },
  };
}

export function timeoutScheduler(ms: number): Scheduler {
  return (run) => {
    const t = setTimeout(run, ms);
    return () => clearTimeout(t);
  };
}

/**
 * Next animation frame, with a timer fallback because hidden tabs don't run rAF
 * (a backgrounded Chromebook tab would otherwise pile up points until it's shown again).
 */
export function frameScheduler(fallbackMs = 250): Scheduler {
  return (run) => {
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      run();
    };
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(once) : null;
    const t = setTimeout(once, fallbackMs);
    return () => {
      done = true;
      if (raf !== null) cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  };
}

/** Applies batches for one board to its element list in a single pass. Returns `list` unchanged if nothing matched. */
export function appendPointBatches<T extends { id: string; points?: number[] }>(list: T[], batches: PointBatch[]): T[] {
  if (batches.length === 0) return list;
  const byId = new Map<string, number[]>();
  for (const b of batches) {
    const prev = byId.get(b.id);
    if (prev) prev.push(...b.points);
    else byId.set(b.id, [...b.points]);
  }
  let changed = false;
  const next = list.map((el) => {
    const pts = byId.get(el.id);
    if (!pts || !Array.isArray(el.points)) return el;
    changed = true;
    return { ...el, points: [...el.points, ...pts] };
  });
  return changed ? next : list;
}
