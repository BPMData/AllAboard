/**
 * The real eraser: when the pen lifts, an eraser stroke turns into edits (remove, trim, split) instead of being
 * stored as an "eraser" element that hides ink at render time.
 *
 * - Ink drawn along points (pen, highlighter, spray, shape brush, straight line) is split into the pieces the
 *   eraser left; fully covered ink is removed. A cut shape-brush stroke ends in its tip shape, like any stroke end.
 * - Rectangles and circles have no points to split: removed only when fully covered, otherwise a piece of the
 *   eraser stroke is kept over just them (the old behaviour, but only where it's needed).
 * - Text notes and stamps the eraser touches are removed.
 * - Only the eraser's own author's ink, drawn before the eraser, is touched (same rule as before).
 *
 * Edits are "groups": remove `ids`, put `elements` where the first of them was, so stacking order never changes.
 * Pure: shared by the browser and the server (`elements-replace`).
 */
import type { CanvasElement } from '../types.ts';
import { boxesMeet, distToPath, getElementBounds, inkBox, noteTouched, stampsHitByEraser } from './inkCore.ts';
import type { ElementGroup } from './elementGroups.ts';

export { applyElementGroups, type ElementGroup } from './elementGroups.ts';

/** One erased element: what it was, and what replaces it (empty = removed). */
export interface EraseEdit {
  before: CanvasElement[];
  after: CanvasElement[];
  /** The element just before it on the board (null = it was first), so an undo can put a removed element back. */
  prevId: string | null;
}

export interface EraseResult {
  edits: EraseEdit[];
  /** What becomes of the eraser stroke itself: nothing, or the parts still needed over shapes it only partly covers. */
  keptEraser: CanvasElement[];
}

/** Ink drawn along points: split into what's left. Each piece of a shape-brush stroke gets its own cached picture. */
const SPLITTABLE = new Set(['solid', 'highlighter', 'spray', 'hollow', 'line']);
/** Outlines with no points to split: removed when fully covered, else covered by a trimmed piece of the eraser. */
const WHOLE_ONLY = new Set(['rect', 'circle']);
/** Server limits (socketGuards.ts): numbers per stroke, and elements per edit. Past them, fall back to the old eraser. */
const MAX_POINT_NUMBERS = 50_000;
const MAX_EDIT_ELEMENTS = 2_000;

export function eraserRadius(eraser: Pick<CanvasElement, 'strokeWidth'>): number {
  return Math.max(8, (eraser.strokeWidth || 6) * 1.5) / 2;
}

/** The groups that apply an erase (forward) and that undo it (backward). */
export function eraseGroups(
  result: EraseResult,
  eraserId: string
): { forward: ElementGroup[]; backward: ElementGroup[] } {
  const forward: ElementGroup[] = result.edits.map((e) => ({ ids: e.before.map((el) => el.id), elements: e.after }));
  forward.push({ ids: [eraserId], elements: result.keptEraser });
  // In board order, so each element's `prevId` is already back when it's restored.
  const backward: ElementGroup[] = result.edits.map((e) => ({
    ids: e.after.map((el) => el.id),
    elements: e.before,
    after: e.prevId,
  }));
  backward.unshift({ ids: result.keptEraser.map((el) => el.id), elements: [] });
  return { forward, backward };
}

/** Points along a polyline no further apart than `step` (only where `near` says the segment matters). */
function densify(
  pts: number[],
  step: number,
  near: (ax: number, ay: number, bx: number, by: number) => boolean
): number[] {
  if (pts.length < 4) return pts.slice();
  const out: number[] = [pts[0], pts[1]];
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i];
    const ay = pts[i + 1];
    const bx = pts[i + 2];
    const by = pts[i + 3];
    const len = Math.hypot(bx - ax, by - ay);
    if (len > step && near(ax, ay, bx, by)) {
      const n = Math.min(500, Math.ceil(len / step));
      for (let k = 1; k < n; k++) out.push(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n);
    }
    out.push(bx, by);
  }
  return out;
}

/** The centre line of a whole-only element, as points to test for full coverage. */
function outlineOf(el: CanvasElement): number[] {
  if (el.tool === 'rect') {
    const x = el.x || 0;
    const y = el.y || 0;
    const w = el.width || 0;
    const h = el.height || 0;
    return [x, y, x + w, y, x + w, y + h, x, y + h, x, y];
  }
  if (el.tool === 'circle') {
    const rx = Math.abs(el.width || 0) / 2;
    const ry = Math.abs(el.height || 0) / 2;
    const cx = (el.x || 0) + (el.width || 0) / 2;
    const cy = (el.y || 0) + (el.height || 0) / 2;
    const out: number[] = [];
    for (let k = 0; k <= 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      out.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
    }
    return out;
  }
  return el.points || [];
}

/**
 * Splits a freehand stroke along an eraser path. Returns null when the eraser doesn't touch it, [] when it's
 * fully erased, else the remaining runs of points.
 */
export function splitStroke(pts: number[], strokeWidth: number, eraserPts: number[], r: number): number[][] | null {
  if (pts.length < 2) return null;
  const pad = (strokeWidth || 4) / 2;
  const limit = r + pad * 0.5;
  const eBox = inkBox(eraserPts, r);
  if (!boxesMeet(eBox, inkBox(pts, pad))) return null;
  const step = Math.max(1, r / 3);
  const dense = densify(pts, step, (ax, ay, bx, by) =>
    boxesMeet(eBox, [Math.min(ax, bx) - pad, Math.min(ay, by) - pad, Math.max(ax, bx) + pad, Math.max(ay, by) + pad])
  );
  const runs: number[][] = [];
  let cur: number[] = [];
  let erased = false;
  for (let i = 0; i < dense.length; i += 2) {
    if (distToPath(dense[i], dense[i + 1], eraserPts) <= limit) {
      erased = true;
      if (cur.length) runs.push(cur);
      cur = [];
    } else cur.push(dense[i], dense[i + 1]);
  }
  if (cur.length) runs.push(cur);
  if (!erased) return null;
  // A lone leftover point of a longer stroke is a speck, not ink worth keeping.
  return pts.length === 2 ? runs : runs.filter((run) => run.length >= 4);
}

/** How much of a whole-only element the eraser covers. */
function coverage(el: CanvasElement, eraserPts: number[], r: number): 'none' | 'part' | 'all' {
  const pad = (el.strokeWidth || 4) / 2;
  const limit = r + pad * 0.5;
  if (!boxesMeet(inkBox(eraserPts, r), getElementBounds(el))) return 'none';
  const dense = densify(outlineOf(el), Math.max(1, r / 3), () => true);
  let inside = 0;
  for (let i = 0; i < dense.length; i += 2) if (distToPath(dense[i], dense[i + 1], eraserPts) <= limit) inside++;
  if (inside === 0) {
    // The eraser may only touch the stroke's width, not its centre line: leave that to the kept eraser.
    for (let i = 0; i < eraserPts.length; i += 2) {
      if (distToPath(eraserPts[i], eraserPts[i + 1], dense) <= r + pad) return 'part';
    }
    return 'none';
  }
  return inside * 2 === dense.length ? 'all' : 'part';
}

/** The eraser's points near the given boxes, as one eraser element per unbroken run. */
function trimEraser(
  eraser: CanvasElement,
  boxes: [number, number, number, number][],
  r: number,
  makeId: () => string
): CanvasElement[] {
  const pts = eraser.points || [];
  const near = (x: number, y: number) =>
    boxes.some((b) => x >= b[0] - r && x <= b[2] + r && y >= b[1] - r && y <= b[3] + r);
  const runs: number[][] = [];
  let cur: number[] = [];
  const dense = densify(pts, Math.max(1, r / 2), () => true);
  for (let i = 0; i < dense.length; i += 2) {
    if (near(dense[i], dense[i + 1])) cur.push(dense[i], dense[i + 1]);
    else if (cur.length) {
      runs.push(cur);
      cur = [];
    }
  }
  if (cur.length) runs.push(cur);
  return runs.map((run) => ({ ...eraser, id: makeId(), points: run }));
}

/**
 * Works out what an eraser stroke does to the board. `elements` is the board in drawing order; the eraser
 * should be in it (only ink before it is touched) or will be treated as last.
 */
export function eraseWithStroke(elements: CanvasElement[], eraser: CanvasElement, makeId: () => string): EraseResult {
  const pts = eraser.points || [];
  if (eraser.tool !== 'eraser' || pts.length < 2) return { edits: [], keptEraser: [] };
  const r = eraserRadius(eraser);
  const idx = elements.findIndex((el) => el.id === eraser.id);
  const earlier = (idx === -1 ? elements : elements.slice(0, idx)).filter((el) => el.userId === eraser.userId);

  const prevOf = new Map<string, string | null>();
  elements.forEach((el, i) => prevOf.set(el.id, i === 0 ? null : elements[i - 1].id));
  const edit = (el: CanvasElement, after: CanvasElement[]): EraseEdit => ({
    before: [el],
    after,
    prevId: prevOf.get(el.id) ?? null,
  });
  const edits: EraseEdit[] = [];
  const partial: [number, number, number, number][] = [];
  const stampIds = new Set(stampsHitByEraser(earlier, eraser).map((el) => el.id));

  for (const el of earlier) {
    if (el.tool === 'eraser') continue;
    if (el.tool === 'stamp') {
      if (stampIds.has(el.id)) edits.push(edit(el, []));
      continue;
    }
    if (el.tool === 'text') {
      if (noteTouched(el, pts, r)) edits.push(edit(el, []));
      continue;
    }
    if (SPLITTABLE.has(el.tool)) {
      const runs = splitStroke(el.points || [], el.strokeWidth, pts, r);
      if (!runs) continue;
      if (runs.some((run) => run.length > MAX_POINT_NUMBERS)) {
        partial.push(getElementBounds(el));
        continue;
      }
      edits.push(
        edit(
          el,
          runs.map((run) => ({ ...el, id: makeId(), points: run }))
        )
      );
      continue;
    }
    if (WHOLE_ONLY.has(el.tool)) {
      const c = coverage(el, pts, r);
      if (c === 'all') edits.push(edit(el, []));
      else if (c === 'part') partial.push(getElementBounds(el));
    }
  }

  const total = edits.reduce((n, e) => n + e.after.length, 0);
  if (total > MAX_EDIT_ELEMENTS) return { edits: [], keptEraser: [{ ...eraser, id: makeId() }] };
  const keptEraser = partial.length > 0 ? trimEraser(eraser, partial, r, makeId) : [];
  return { edits, keptEraser };
}
