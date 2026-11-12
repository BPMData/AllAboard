import { CanvasElement } from '../types';

/**
 * OverBoard-derived ink, smoothing, highlighter/cover, and editable text-note core logic
 * adapted for AllAboard's multiplayer infinite canvas.
 */

export const NOTE_FONT = '"Plus Jakarta Sans", Arial, Helvetica, sans-serif';
export const NOTE_LH = 1.25;

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
