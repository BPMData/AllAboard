import { CanvasElement, HollowShapeKind } from '../types';

/**
 * OverBoard-derived ink, smoothing, highlighter/cover, and editable text-note core logic
 * adapted for AllAboard's multiplayer infinite canvas.
 */

export const NOTE_FONT = '"Plus Jakarta Sans", Arial, Helvetica, sans-serif';
export const NOTE_LH = 1.25;

export const TEXT_SIZE_PRESETS = [
  { label: 'S', size: 18, title: 'Small text (18px)' },
  { label: 'M', size: 26, title: 'Medium text (26px)' },
  { label: 'L', size: 38, title: 'Large text (38px)' },
  { label: 'XL', size: 54, title: 'Extra-large title text (54px)' },
] as const;

export interface LiveSmoothState {
  fx: number;
  fy: number;
  ex: number;
  ey: number;
  k: number;
}

/**
 * Mix a #rrggbb color toward white by `amt` (0..1).
 * Used by OverBoard's multiply highlighter so printed text stays black while highlight strength varies.
 */
export function tint(hex: string, amt: number): string {
  const clean = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#fdd835';
  const n = parseInt(clean.slice(1), 16);
  const r = n >> 16;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const m = (c: number) => Math.round(c + (255 - c) * Math.max(0, Math.min(1, amt)));
  return '#' + ((1 << 24) | (m(r) << 16) | (m(g) << 8) | m(b)).toString(16).slice(1);
}

/**
 * Compute the multiply-layer highlighter hex color for a given base color and strength (10..100%).
 */
export function hlInk(color: string, strength: number): string {
  return tint(color, 1 - strength / 100);
}

/**
 * True if an element is a see-through highlighter stroke (drawn on the multiply layer underneath pen ink).
 * Opaque "Cover" bars (`isCover: true`) go on the top pen layer so they hide answers until erased.
 */
export function isSeeThroughHighlight(el: CanvasElement): boolean {
  return el.tool === 'highlighter' && !el.isCover;
}

/**
 * Mode-aware color swatches from OverBoard:
 * - 'pen': high-contrast readable ink colors
 * - 'hl': bright see-through highlighter colors
 * - 'cover': opaque answer-hiding cover colors (black, gray, white, yellow, pink)
 */
export function getPaletteColors(mode: 'pen' | 'hl' | 'cover'): Array<{ color: string; label: string }> {
  if (mode === 'hl') {
    return [
      { color: '#fdd835', label: 'Yellow Highlight' },
      { color: '#2e7d32', label: 'Green Highlight' },
      { color: '#e0218a', label: 'Pink Highlight' },
      { color: '#1565c0', label: 'Blue Highlight' },
      { color: '#e8441a', label: 'Sunset Orange Highlight' },
    ];
  }
  if (mode === 'cover') {
    return [
      { color: '#111111', label: 'Cover: Black (hides answers)' },
      { color: '#a6a6a6', label: 'Cover: Light Gray (hides answers)' },
      { color: '#ffffff', label: 'Cover: White (hides answers)' },
      { color: '#fdd835', label: 'Cover: Yellow (hides answers)' },
      { color: '#e0218a', label: 'Cover: Pink (hides answers)' },
    ];
  }
  return [
    { color: '#111111', label: 'Black' },
    { color: '#1565c0', label: 'Blue' },
    { color: '#d32f2f', label: 'Red' },
    { color: '#e0218a', label: 'Barbie Pink' },
    { color: '#2e7d32', label: 'Green' },
    { color: '#ea580c', label: 'Orange' },
    { color: '#7c3aed', label: 'Purple' },
    { color: '#0891b2', label: 'Teal' },
  ];
}

/**
 * SMART Board / Stylus / Touch classification from OverBoard:
 * - SMART Board on macOS/Windows: pen tip = "pen"; palm/fist/side of hand = "pen" with eraser button (buttons & 32 or button === 5).
 * - Finger and mouse = "finger".
 */
export function pointerKind(e: PointerEvent | React.PointerEvent): 'palm' | 'finger' | 'pen' {
  if (e.pointerType === 'pen' && ((e.buttons & 32) !== 0 || e.button === 5)) {
    return 'palm';
  }
  if (e.pointerType === 'mouse' || e.pointerType === 'touch') {
    return 'finger';
  }
  return 'pen';
}

/**
 * Start live smoothing state at initial point (x, y).
 */
export function liveStart(x: number, y: number): LiveSmoothState {
  return { fx: x, fy: y, ex: x, ey: y, k: 1 };
}

/**
 * Filter a raw sample through OverBoard's exponential smoothing filter (level 0..8).
 * Returns the smoothed [px, py] point if it moved at least `minDist`, or null if skipped.
 */
export function liveAddPoint(
  points: number[],
  live: LiveSmoothState,
  x: number,
  y: number,
  level: number,
  minDist = 0.5
): [number, number] | null {
  const k = Math.max(0, Math.min(8, level)) / 10;
  const n = points.length;
  live.fx = live.fx * k + x * (1 - k);
  live.fy = live.fy * k + y * (1 - k);
  const px = Math.round(live.fx * 10) / 10;
  const py = Math.round(live.fy * 10) / 10;
  if (n >= 2 && Math.abs(px - points[n - 2]) + Math.abs(py - points[n - 1]) < minDist) {
    return null;
  }
  points.push(px, py);
  return [px, py];
}

/**
 * Catch up to the exact pen-lift point at the end of a smoothed stroke.
 */
export function liveLiftPoint(
  points: number[],
  x: number,
  y: number,
  minDist = 0.5
): [number, number] | null {
  const n = points.length;
  const px = Math.round(x * 10) / 10;
  const py = Math.round(y * 10) / 10;
  if (n >= 4 && Math.abs(px - points[n - 2]) + Math.abs(py - points[n - 1]) >= minDist) {
    points.push(px, py);
    return [px, py];
  }
  return null;
}

/**
 * Trace OverBoard's midpoint quadratic curve path onto a 2D canvas context (or Konva Context).
 * Single taps (p.length < 4) draw a round filled dot; longer strokes connect sample midpoints
 * with quadratic Bézier curves so corners come out round instead of jagged.
 */
export function traceSmoothStrokePath(ctx: CanvasRenderingContext2D | any, points: number[], strokeWidth: number): 'dot' | 'stroke' | 'none' {
  if (!points || points.length < 2) return 'none';
  ctx.beginPath();
  if (points.length < 4) {
    ctx.arc(points[0], points[1], strokeWidth / 2, 0, Math.PI * 2);
    return 'dot';
  }
  ctx.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length - 2; i += 2) {
    const mx = (points[i] + points[i + 2]) / 2;
    const my = (points[i + 1] + points[i + 3]) / 2;
    ctx.quadraticCurveTo(points[i], points[i + 1], mx, my);
  }
  ctx.lineTo(points[points.length - 2], points[points.length - 1]);
  return 'stroke';
}

/**
 * Trace a geometric tip shape (circle, square, triangle, diamond, or 5-point star) centered at (cx, cy) with radius `r`.
 */
export function traceHollowTipShape(
  ctx: CanvasRenderingContext2D | any,
  cx: number,
  cy: number,
  r: number,
  shapeKind: HollowShapeKind = 'circle'
): void {
  const rad = Math.max(0.5, r);
  if (shapeKind === 'square') {
    ctx.rect(cx - rad, cy - rad, rad * 2, rad * 2);
    return;
  }
  if (shapeKind === 'triangle') {
    ctx.moveTo(cx, cy - rad);
    ctx.lineTo(cx + rad, cy + rad * 0.85);
    ctx.lineTo(cx - rad, cy + rad * 0.85);
    ctx.closePath();
    return;
  }
  if (shapeKind === 'diamond') {
    ctx.moveTo(cx, cy - rad);
    ctx.lineTo(cx + rad, cy);
    ctx.lineTo(cx, cy + rad);
    ctx.lineTo(cx - rad, cy);
    ctx.closePath();
    return;
  }
  if (shapeKind === 'star') {
    const inner = rad * 0.44;
    for (let i = 0; i < 10; i++) {
      const angle = -Math.PI / 2 + (i * Math.PI) / 5;
      const d = i % 2 === 0 ? rad : inner;
      const sx = cx + Math.cos(angle) * d;
      const sy = cy + Math.sin(angle) * d;
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.closePath();
    return;
  }
  ctx.moveTo(cx + rad, cy);
  ctx.arc(cx, cy, rad, 0, Math.PI * 2);
}

/**
 * Sample evenly spaced points along a polyline so dragged non-circular hollow shapes sweep smoothly.
 */
function samplePolylinePoints(points: number[], stepDist: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (!points || points.length < 2) return out;
  out.push([points[0], points[1]]);
  const step = Math.max(1.5, stepDist);
  for (let i = 2; i < points.length; i += 2) {
    const x0 = points[i - 2];
    const y0 = points[i - 1];
    const x1 = points[i];
    const y1 = points[i + 1];
    const segLen = Math.hypot(x1 - x0, y1 - y0);
    if (segLen <= 0.01) continue;
    const count = Math.max(1, Math.ceil(segLen / step));
    for (let s = 1; s <= count; s++) {
      const t = s / count;
      out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
    }
  }
  return out;
}

/**
 * Render a hollow shape stamp (when points.length < 4) or hollow dragged stroke (when points.length >= 4)
 * with outer diameter `outerSize`, wall thickness `lineWeight`, and tip shape `shapeKind`.
 */
export function drawHollowElementOnCtx(
  ctx: CanvasRenderingContext2D | any,
  points: number[],
  outerSize: number,
  lineWeight: number,
  color: string,
  shapeKind: HollowShapeKind = 'circle'
): void {
  if (!points || points.length < 2) return;
  const outerD = Math.max(4, outerSize || 24);
  const rOuter = outerD / 2;
  const weight = Math.max(1, Math.min(rOuter - 0.5, lineWeight || 2));
  const innerD = Math.max(1, outerD - weight * 2);
  const rInner = innerD / 2;

  // Single-click stamp: draw crisp hollow geometric shape with exact outer diameter & border line weight
  if (points.length < 4) {
    const cx = points[0];
    const cy = points[1];
    const rMid = Math.max(1.5, rOuter - weight / 2);
    ctx.save();
    ctx.beginPath();
    traceHollowTipShape(ctx, cx, cy, rMid, shapeKind);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = weight;
    ctx.lineJoin = shapeKind === 'circle' ? 'round' : 'miter';
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();
    return;
  }

  // Dragged hollow stroke: Circle uses fast dual smooth curves; polygons/stars sweep the outer & inner shapes along the path
  if (shapeKind === 'circle') {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.lineWidth = outerD;
    traceSmoothStrokePath(ctx, points, outerD);
    ctx.stroke();

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = innerD;
    traceSmoothStrokePath(ctx, points, innerD);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const samples = samplePolylinePoints(points, Math.max(2, rOuter * 0.28));
  ctx.save();
  // Pass 1: Outer colored silhouette along the path
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < samples.length; i++) {
    traceHollowTipShape(ctx, samples[i][0], samples[i][1], rOuter, shapeKind);
  }
  ctx.fill();

  // Pass 2: Inner white cutout along the path
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  for (let i = 0; i < samples.length; i++) {
    traceHollowTipShape(ctx, samples[i][0], samples[i][1], rInner, shapeKind);
  }
  ctx.fill();
  ctx.restore();
}

/* ---- Editable Multiline Text Notes (OverBoard v45) ---- */

let measureCtx: CanvasRenderingContext2D | null = null;

/**
 * Compute the font size (in world px) for a text note from its `fontSize` or `strokeWidth`.
 */
export function getNoteFontSize(el: Pick<CanvasElement, 'fontSize' | 'strokeWidth'>): number {
  if (typeof el.fontSize === 'number' && el.fontSize > 0) return el.fontSize;
  return Math.max(14, (el.strokeWidth || 6) * 3 + 8);
}

/**
 * Measure [width, height] of multiline note text at font size `f`.
 */
export function noteSize(text: string, f: number): [number, number] {
  if (typeof document !== 'undefined' && !measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d');
  }
  const lines = (text || '').split('\n');
  let maxW = 0;
  if (measureCtx) {
    measureCtx.font = `600 ${f}px ${NOTE_FONT}`;
    for (let i = 0; i < lines.length; i++) {
      maxW = Math.max(maxW, measureCtx.measureText(lines[i]).width);
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      maxW = Math.max(maxW, lines[i].length * f * 0.6);
    }
  }
  const w = Math.max(f * 0.8, Math.ceil(maxW * 10) / 10);
  const h = Math.round(Math.max(1, lines.length) * f * NOTE_LH * 10) / 10;
  return [w, h];
}

/**
 * Return the bounding box [x0, y0, x1, y1] of a text note in world coordinates.
 */
export function getNoteBox(el: CanvasElement): [number, number, number, number] {
  const x0 = el.x || 0;
  const y0 = el.y || 0;
  const f = getNoteFontSize(el);
  if (typeof el.width === 'number' && el.width > 0 && typeof el.height === 'number' && el.height > 0) {
    return [x0, y0, x0 + el.width, y0 + el.height];
  }
  const [w, h] = noteSize(el.text || '', f);
  return [x0, y0, x0 + w, y0 + h];
}

/**
 * OverBoard's `noteTouched`: checks whether an eraser path `ep` with radius `r` touches note `noteEl`.
 * Checks both raw samples and interpolated steps along fast swipes so a quick swipe across a small note catches it.
 */
export function noteTouched(noteEl: CanvasElement, ep: number[], r: number): boolean {
  if (!ep || ep.length < 2) return false;
  const b = getNoteBox(noteEl);
  for (let i = 0; i < ep.length; i += 2) {
    const dx = Math.max(b[0] - ep[i], 0, ep[i] - b[2]);
    const dy = Math.max(b[1] - ep[i + 1], 0, ep[i + 1] - b[3]);
    if (dx * dx + dy * dy <= r * r) return true;
  }
  if (ep.length >= 4) {
    for (let j = 0; j + 3 < ep.length; j += 2) {
      const dist = Math.hypot(ep[j + 2] - ep[j], ep[j + 3] - ep[j + 1]);
      const steps = Math.ceil(dist / Math.max(r, 1));
      for (let k = 1; k < steps; k++) {
        const x = ep[j] + ((ep[j + 2] - ep[j]) * k) / steps;
        const y = ep[j + 1] + ((ep[j + 3] - ep[j + 1]) * k) / steps;
        const ddx = Math.max(b[0] - x, 0, x - b[2]);
        const ddy = Math.max(b[1] - y, 0, y - b[3]);
        if (ddx * ddx + ddy * ddy <= r * r) return true;
      }
    }
  }
  return false;
}

/**
 * OverBoard's `notesGone`: given a user's elements in drawing order, returns the Set of note IDs
 * that were touched by a subsequent eraser stroke from that user.
 * Because this is computed from the element list in order, undoing the eraser stroke automatically restores the note!
 */
export function computeNotesGone(userElements: CanvasElement[]): Set<string> {
  const gone = new Set<string>();
  let activeNotes: CanvasElement[] = [];
  for (let i = 0; i < userElements.length; i++) {
    const el = userElements[i];
    if (el.tool === 'text') {
      activeNotes.push(el);
    } else if (el.tool === 'eraser' && activeNotes.length > 0 && el.points && el.points.length >= 2) {
      const r = Math.max(8, el.strokeWidth * 1.5) / 2;
      activeNotes = activeNotes.filter((n) => {
        if (noteTouched(n, el.points!, r)) {
          gone.add(n.id);
          return false;
        }
        return true;
      });
    }
  }
  return gone;
}

/**
 * Find the topmost non-erased text note at world coordinates `(x, y)` within `tol` world units
 * that the current user is allowed to edit (their own notes, or any note if `isTeacher`).
 */
export function hitEditableNote(
  elements: CanvasElement[],
  goneNoteIds: Set<string>,
  x: number,
  y: number,
  tol: number,
  currentUserId: string,
  isTeacher: boolean
): CanvasElement | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (el.tool !== 'text' || goneNoteIds.has(el.id)) continue;
    if (!isTeacher && el.userId !== currentUserId) continue;
    const b = getNoteBox(el);
    if (x >= b[0] - tol && x <= b[2] + tol && y >= b[1] - tol && y <= b[3] + tol) {
      return el;
    }
  }
  return null;
}

/* ---- OverBoard Geometry, Hit-Testing, Lasso Selection & Element Transform Helpers ---- */

/**
 * Compute bounding box [minX - pad, minY - pad, maxX + pad, maxY + pad] for a 2D point list.
 */
export function inkBox(pts: number[], pad: number): [number, number, number, number] {
  if (!pts || pts.length < 2) return [0, 0, 0, 0];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i];
    const y = pts[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

/**
 * True if two axis-aligned bounding boxes [x0, y0, x1, y1] overlap.
 */
export function boxesMeet(
  a: [number, number, number, number],
  b: [number, number, number, number]
): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/**
 * Minimum Euclidean distance from (x, y) to a polyline [x0, y0, x1, y1, ...].
 */
export function distToPath(x: number, y: number, pts: number[]): number {
  if (!pts || pts.length < 2) return Infinity;
  if (pts.length < 4) return Math.hypot(x - pts[0], y - pts[1]);
  let best = Infinity;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i];
    const ay = pts[i + 1];
    const dx = pts[i + 2] - ax;
    const dy = pts[i + 3] - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lenSq)) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

/**
 * Ray-casting point-in-polygon test for a closed lasso loop [x0, y0, x1, y1, ...].
 */
export function pointInLoop(x: number, y: number, loop: number[]): boolean {
  if (!loop || loop.length < 6) return false;
  let inside = false;
  for (let i = 0, j = loop.length - 2; i < loop.length; j = i, i += 2) {
    if (
      (loop[i + 1] > y) !== (loop[j + 1] > y) &&
      x < ((loop[j] - loop[i]) * (y - loop[i + 1])) / (loop[j + 1] - loop[i + 1]) + loop[i]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Return the world-space bounding box [x0, y0, x1, y1] of any CanvasElement.
 */
export function getElementBounds(el: CanvasElement): [number, number, number, number] {
  if (el.tool === 'text') {
    return getNoteBox(el);
  }
  const pad = (el.strokeWidth || 4) / 2;
  if (el.tool === 'rect') {
    const x0 = Math.min(el.x || 0, (el.x || 0) + (el.width || 0));
    const y0 = Math.min(el.y || 0, (el.y || 0) + (el.height || 0));
    const x1 = Math.max(el.x || 0, (el.x || 0) + (el.width || 0));
    const y1 = Math.max(el.y || 0, (el.y || 0) + (el.height || 0));
    return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  }
  if (el.tool === 'circle') {
    const radius = Math.max(Math.abs(el.width || 0) / 2, Math.abs(el.height || 0) / 2);
    const cx = (el.x || 0) + (el.width || 0) / 2;
    const cy = (el.y || 0) + (el.height || 0) / 2;
    return [cx - radius - pad, cy - radius - pad, cx + radius + pad, cy + radius + pad];
  }
  if (el.tool === 'stamp') {
    const cx = el.x || 0;
    const cy = el.y || 0;
    if (el.stamp === 'username') {
      const label = el.userName || 'Student';
      const fontSize = Math.max(13, Math.round((el.strokeWidth || 6) * 1.1 + 10));
      const padX = Math.round(fontSize * 0.85);
      const badgeW = Math.max(64, Math.round(label.length * (fontSize * 0.62) + padX * 2));
      const badgeH = Math.round(fontSize * 1.85);
      return [cx - badgeW / 2, cy - badgeH / 2, cx + badgeW / 2, cy + badgeH / 2];
    }
    const radius = Math.max(16, (el.strokeWidth || 6) * 1.8 + 10);
    return [cx - radius, cy - radius, cx + radius, cy + radius];
  }
  return inkBox(el.points || [], pad);
}

/**
 * Compute the union bounding box [x0, y0, x1, y1] of a set of elements, or null if empty.
 */
export function getSelectionBounds(
  elements: CanvasElement[]
): [number, number, number, number] | null {
  if (!elements || elements.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const el of elements) {
    const b = getElementBounds(el);
    if (b[0] < x0) x0 = b[0];
    if (b[1] < y0) y0 = b[1];
    if (b[2] > x1) x1 = b[2];
    if (b[3] > y1) y1 = b[3];
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
}

/**
 * True if the user owns the element or is a verified teacher.
 */
export function canUserModifyElement(
  el: CanvasElement,
  currentUserId: string,
  isTeacher: boolean
): boolean {
  return isTeacher || el.userId === currentUserId;
}

/**
 * True if `el` is a freehand stroke whose `points` can be split/trimmed by subsequent eraser strokes.
 */
export function isFreehandStroke(el: CanvasElement): boolean {
  return (
    el.tool === 'solid' ||
    el.tool === 'hollow' ||
    el.tool === 'spray' ||
    el.tool === 'highlighter'
  );
}

/**
 * Compute the remaining visible polyline runs of `el` after applying subsequent eraser strokes
 * from the same user (mirrors OverBoard's `seenNow` / `applyErasers`).
 */
export function getVisibleStrokeRuns(
  el: CanvasElement,
  allElements: CanvasElement[]
): number[][] {
  if (!isFreehandStroke(el)) {
    return el.points && el.points.length >= 2 ? [el.points] : [];
  }
  const pts = el.points || [];
  if (pts.length < 2) return [];
  const idx = allElements.findIndex((item) => item.id === el.id);
  if (idx === -1) return [pts];

  let runs: number[][] = [pts];
  const pad = (el.strokeWidth || 4) / 2;

  const flushRun = (out: number[][], origLen: number, run: number[]) => {
    if (run.length >= 4 || (run.length === 2 && origLen === 2)) {
      out.push(run);
    }
  };

  for (let j = idx + 1; j < allElements.length; j++) {
    const er = allElements[j];
    if (
      er.tool !== 'eraser' ||
      er.userId !== el.userId ||
      !er.points ||
      er.points.length < 2
    ) {
      continue;
    }
    const r = Math.max(8, (er.strokeWidth || 6) * 1.5) / 2;
    const eBox = inkBox(er.points, r);
    const nextRuns: number[][] = [];

    for (const run of runs) {
      if (!boxesMeet(eBox, inkBox(run, pad))) {
        nextRuns.push(run);
        continue;
      }
      let cur: number[] = [];
      for (let n = 0; n < run.length; n += 2) {
        if (distToPath(run[n], run[n + 1], er.points) <= r + pad * 0.5) {
          flushRun(nextRuns, run.length, cur);
          cur = [];
        } else {
          cur.push(run[n], run[n + 1]);
        }
      }
      flushRun(nextRuns, run.length, cur);
    }

    runs = nextRuns;
    if (runs.length === 0) break;
  }

  return runs;
}

/**
 * Expand `el` into its remaining visible pieces after subsequent erasers from the same user.
 * Returns `[el]` unchanged when no points were erased, `[]` if fully erased, or split copies otherwise.
 */
export function expandElementVisiblePieces(
  el: CanvasElement,
  allElements: CanvasElement[]
): CanvasElement[] {
  if (!isFreehandStroke(el)) return [el];
  const runs = getVisibleStrokeRuns(el, allElements);
  if (runs.length === 0) return [];
  if (runs.length === 1 && runs[0].length === (el.points?.length || 0)) {
    return [el];
  }
  return runs.map((pts, idx) => ({
    ...el,
    id:
      idx === 0
        ? el.id
        : `${el.id}_p${idx}_${Math.random().toString(36).substring(2, 6)}`,
    points: [...pts],
  }));
}

/**
 * True if a subsequent eraser stroke from the same user overlaps `el`'s bounding box.
 */
export function hasSubsequentOverlappingEraser(
  el: CanvasElement,
  allElements: CanvasElement[]
): boolean {
  if (el.tool === 'text' || el.tool === 'eraser') return false;
  const idx = allElements.findIndex((item) => item.id === el.id);
  if (idx === -1) return false;
  const elBounds = getElementBounds(el);
  for (let j = idx + 1; j < allElements.length; j++) {
    const er = allElements[j];
    if (
      er.tool === 'eraser' &&
      er.userId === el.userId &&
      er.points &&
      er.points.length >= 2
    ) {
      const r = Math.max(8, (er.strokeWidth || 6) * 1.5) / 2;
      if (boxesMeet(elBounds, inkBox(er.points, r))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Find the topmost modifiable, non-erased element at world coordinates (x, y) within `tol`.
 */
export function hitElementAtPoint(
  elements: CanvasElement[],
  goneNoteIds: Set<string>,
  x: number,
  y: number,
  tol: number,
  currentUserId: string,
  isTeacher: boolean
): CanvasElement | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (el.tool === 'eraser' || goneNoteIds.has(el.id)) continue;
    if (!canUserModifyElement(el, currentUserId, isTeacher)) continue;

    const pad = (el.strokeWidth || 4) / 2;
    if (el.tool === 'text' || el.tool === 'stamp') {
      const b = getElementBounds(el);
      if (x >= b[0] - tol && x <= b[2] + tol && y >= b[1] - tol && y <= b[3] + tol) {
        return el;
      }
      continue;
    }

    if (el.tool === 'rect') {
      const rx0 = Math.min(el.x || 0, (el.x || 0) + (el.width || 0));
      const ry0 = Math.min(el.y || 0, (el.y || 0) + (el.height || 0));
      const rx1 = Math.max(el.x || 0, (el.x || 0) + (el.width || 0));
      const ry1 = Math.max(el.y || 0, (el.y || 0) + (el.height || 0));
      const reach = pad + tol;
      if (
        x >= rx0 - reach &&
        x <= rx1 + reach &&
        y >= ry0 - reach &&
        y <= ry1 + reach
      ) {
        if (rx1 - rx0 < 24 || ry1 - ry0 < 24) return el;
        const inHollowInterior =
          x > rx0 + reach && x < rx1 - reach && y > ry0 + reach && y < ry1 - reach;
        if (!inHollowInterior) return el;
      }
      continue;
    }

    if (el.tool === 'circle') {
      const radius = Math.max(Math.abs(el.width || 0) / 2, Math.abs(el.height || 0) / 2);
      const cx = (el.x || 0) + (el.width || 0) / 2;
      const cy = (el.y || 0) + (el.height || 0) / 2;
      const dist = Math.hypot(x - cx, y - cy);
      const reach = pad + tol;
      if (radius < 16 ? dist <= radius + reach : Math.abs(dist - radius) <= reach) {
        return el;
      }
      continue;
    }

    if (isFreehandStroke(el)) {
      const runs = getVisibleStrokeRuns(el, elements);
      if (runs.length === 0) continue;
      if (runs.some((run) => distToPath(x, y, run) <= pad + tol)) {
        return el;
      }
      continue;
    }

    const pts = el.points || [];
    if (pts.length >= 2 && distToPath(x, y, pts) <= pad + tol) {
      return el;
    }
  }
  return null;
}

/**
 * Select all modifiable, non-erased elements enclosed by a lasso loop [x0, y0, x1, y1, ...].
 * Returned in drawing order (bottom to top).
 */
export function lassoSelectElements(
  elements: CanvasElement[],
  goneNoteIds: Set<string>,
  loop: number[],
  currentUserId: string,
  isTeacher: boolean
): CanvasElement[] {
  if (!loop || loop.length < 6) return [];
  const lb = inkBox(loop, 0);
  const out: CanvasElement[] = [];

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (el.tool === 'eraser' || goneNoteIds.has(el.id)) continue;
    if (!canUserModifyElement(el, currentUserId, isTeacher)) continue;

    const b = getElementBounds(el);
    if (!boxesMeet(lb, b)) continue;

    if (
      el.tool === 'text' ||
      el.tool === 'stamp' ||
      el.tool === 'rect' ||
      el.tool === 'circle'
    ) {
      const cx = (b[0] + b[2]) / 2;
      const cy = (b[1] + b[3]) / 2;
      if (pointInLoop(cx, cy, loop)) {
        out.push(el);
        continue;
      }
      let cornersInside = 0;
      if (pointInLoop(b[0], b[1], loop)) cornersInside++;
      if (pointInLoop(b[2], b[1], loop)) cornersInside++;
      if (pointInLoop(b[0], b[3], loop)) cornersInside++;
      if (pointInLoop(b[2], b[3], loop)) cornersInside++;
      if (cornersInside >= 2) {
        out.push(el);
      }
      continue;
    }

    if (isFreehandStroke(el)) {
      const runs = getVisibleStrokeRuns(el, elements);
      if (runs.length === 0) continue;
      let total = 0;
      let inside = 0;
      for (const run of runs) {
        total += run.length / 2;
        for (let k = 0; k < run.length; k += 2) {
          if (pointInLoop(run[k], run[k + 1], loop)) inside++;
        }
      }
      if (total > 0 && inside * 2 >= total) {
        out.push(el);
      }
      continue;
    }

    const pts = el.points || [];
    if (pts.length < 2) continue;
    const total = pts.length / 2;
    let inside = 0;
    for (let k = 0; k < pts.length; k += 2) {
      if (pointInLoop(pts[k], pts[k + 1], loop)) inside++;
    }
    if (inside * 2 >= total) {
      out.push(el);
    }
  }

  return out;
}

/**
 * Return a copy of `el` translated by `(dx, dy)` in world coordinates (rounded to 0.1).
 */
export function translateElement(el: CanvasElement, dx: number, dy: number): CanvasElement {
  const r = (v: number) => Math.round(v * 10) / 10;
  const copy: CanvasElement = { ...el };
  if (typeof el.x === 'number') copy.x = r(el.x + dx);
  if (typeof el.y === 'number') copy.y = r(el.y + dy);
  if (Array.isArray(el.points)) {
    const nextPts: number[] = new Array(el.points.length);
    for (let i = 0; i < el.points.length; i += 2) {
      nextPts[i] = r(el.points[i] + dx);
      nextPts[i + 1] = r(el.points[i + 1] + dy);
    }
    copy.points = nextPts;
  }
  return copy;
}
