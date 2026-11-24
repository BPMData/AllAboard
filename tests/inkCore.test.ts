import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CanvasElement } from '../src/types';
import { cn } from '../src/lib/utils';
import {
  NOTE_LH,
  tint,
  hlInk,
  isSeeThroughHighlight,
  getPaletteColors,
  pointerKind,
  liveStart,
  liveAddPoint,
  liveLiftPoint,
  traceSmoothStrokePath,
  traceHollowTipShape,
  drawHollowElementOnCtx,
  simplifyPathForSweep,
  hollowTipConvexPieces,
  buildHollowSweepPolygons,
  getHollowSweepGeometry,
  drawHollowElementCached,
  hollowBitmapPixelsInUse,
  HOLLOW_BITMAP_BUDGET_PX,
  HOLLOW_SWEEP_TOLERANCE,
  HOLLOW_SWEEP_POLYS_PER_FILL,
  getNoteFontSize,
  noteSize,
  getNoteBox,
  noteTouched,
  computeNotesGone,
  hitEditableNote,
  inkBox,
  boxesMeet,
  distToPath,
  pointInLoop,
  getElementBounds,
  getSelectionBounds,
  canUserModifyElement,
  isFreehandStroke,
  getVisibleStrokeRuns,
  expandElementVisiblePieces,
  hasSubsequentOverlappingEraser,
  hitElementAtPoint,
  lassoSelectElements,
  translateElement,
  stampsHitByEraser,
} from '../src/lib/inkCore';

function makeEl(overrides: Partial<CanvasElement> & Pick<CanvasElement, 'id' | 'tool'>): CanvasElement {
  return {
    color: '#111111',
    strokeWidth: 4,
    userId: 'user-1',
    userName: 'Tester',
    timestamp: 1000,
    ...overrides,
  };
}

describe('inkCore palette and pointer helpers', () => {
  it('tints colors toward white and handles invalid hex gracefully', () => {
    assert.equal(tint('#ff0000', 0), '#ff0000');
    assert.equal(tint('#ff0000', 1), '#ffffff');
    assert.equal(tint('#ff0000', 0.5), '#ff8080');
    assert.equal(tint('not-a-hex', 0), '#fdd835');
    assert.equal(hlInk('#000000', 100), '#000000');
    assert.equal(hlInk('#000000', 0), '#ffffff');
  });

  it('distinguishes see-through highlighter from opaque cover bars', () => {
    assert.equal(isSeeThroughHighlight(makeEl({ id: 'h1', tool: 'highlighter' })), true);
    assert.equal(isSeeThroughHighlight(makeEl({ id: 'c1', tool: 'highlighter', isCover: true })), false);
    assert.equal(isSeeThroughHighlight(makeEl({ id: 's1', tool: 'solid' })), false);
  });

  it('returns distinct swatches for pen, hl, and cover modes', () => {
    assert.equal(getPaletteColors('pen').length, 8);
    assert.equal(getPaletteColors('hl').length, 5);
    const cover = getPaletteColors('cover');
    assert.equal(cover.length, 5);
    assert.ok(cover.some((s) => s.color === '#ffffff'));
    assert.ok(cover.some((s) => s.color === '#111111'));
  });

  it('classifies SMART Board palm, stylus pen, mouse, and touch pointers', () => {
    assert.equal(pointerKind({ pointerType: 'pen', buttons: 32, button: 0 } as PointerEvent), 'palm');
    assert.equal(pointerKind({ pointerType: 'pen', buttons: 0, button: 5 } as PointerEvent), 'palm');
    assert.equal(pointerKind({ pointerType: 'pen', buttons: 1, button: 0 } as PointerEvent), 'pen');
    assert.equal(pointerKind({ pointerType: 'mouse', buttons: 1, button: 0 } as PointerEvent), 'finger');
    assert.equal(pointerKind({ pointerType: 'touch', buttons: 1, button: 0 } as PointerEvent), 'finger');
  });
});

describe('live smoothing and stroke path tracing', () => {
  it('filters tiny jitter movements and catches up on pen lift', () => {
    const pts = [10, 10];
    const live = liveStart(10, 10);

    assert.equal(liveAddPoint(pts, live, 10.1, 10.1, 4, 0.5), null);
    assert.equal(pts.length, 2);

    const next = liveAddPoint(pts, live, 20, 10, 0, 0.5);
    assert.deepEqual(next, [20, 10]);
    assert.deepEqual(pts, [10, 10, 20, 10]);

    const lifted = liveLiftPoint(pts, 25, 10, 0.5);
    assert.deepEqual(lifted, [25, 10]);
    assert.deepEqual(pts, [10, 10, 20, 10, 25, 10]);
    assert.equal(liveLiftPoint(pts, 25.1, 10.1, 0.5), null);
  });

  it('traces none, dot, or quadratic stroke commands depending on point count', () => {
    const createMockCtx = () => {
      const calls: string[] = [];
      return {
        calls,
        beginPath() {
          calls.push('beginPath');
        },
        arc() {
          calls.push('arc');
        },
        moveTo() {
          calls.push('moveTo');
        },
        quadraticCurveTo() {
          calls.push('quadraticCurveTo');
        },
        lineTo() {
          calls.push('lineTo');
        },
      };
    };

    const ctx0 = createMockCtx();
    assert.equal(traceSmoothStrokePath(ctx0, [], 4), 'none');
    assert.deepEqual(ctx0.calls, []);

    const ctxDot = createMockCtx();
    assert.equal(traceSmoothStrokePath(ctxDot, [5, 6], 4), 'dot');
    assert.deepEqual(ctxDot.calls, ['beginPath', 'arc']);

    const ctxStroke = createMockCtx();
    assert.equal(traceSmoothStrokePath(ctxStroke, [0, 0, 10, 5, 20, 0], 4), 'stroke');
    assert.deepEqual(ctxStroke.calls, ['beginPath', 'moveTo', 'quadraticCurveTo', 'lineTo']);
  });
});

describe('text notes sizing, erasing, and hit-testing', () => {
  it('resolves explicit fontSize and legacy strokeWidth fallback', () => {
    assert.equal(getNoteFontSize({ fontSize: 38, strokeWidth: 4 }), 38);
    assert.equal(getNoteFontSize({ strokeWidth: 4 }), 20);
    assert.equal(getNoteFontSize({ strokeWidth: 1 }), 14);
  });

  it('computes multiline note dimensions and explicit bounds', () => {
    const [w1, h1] = noteSize('hello', 20);
    const [w2, h2] = noteSize('hello\nworld!', 20);
    assert.ok(w2 > w1);
    assert.equal(h1, Math.round(1 * 20 * NOTE_LH * 10) / 10);
    assert.equal(h2, Math.round(2 * 20 * NOTE_LH * 10) / 10);

    const explicit = makeEl({ id: 'n1', tool: 'text', x: 100, y: 200, width: 150, height: 60, text: 'hi' });
    assert.deepEqual(getNoteBox(explicit), [100, 200, 250, 260]);
  });

  it('marks only notes touched by subsequent erasers in order as gone', () => {
    const n1 = makeEl({ id: 'n1', tool: 'text', x: 100, y: 100, width: 80, height: 30, text: 'Keep' });
    const n2 = makeEl({ id: 'n2', tool: 'text', x: 300, y: 100, width: 80, height: 30, text: 'Erase' });
    const earlyMiss = makeEl({ id: 'e0', tool: 'eraser', strokeWidth: 10, points: [310, 110, 340, 110] });
    const lateHit = makeEl({ id: 'e1', tool: 'eraser', strokeWidth: 10, points: [290, 115, 390, 115] });

    assert.equal(noteTouched(n2, [290, 115, 390, 115], 8), true);
    assert.equal(noteTouched(n1, [290, 115, 390, 115], 8), false);

    // Eraser drawn BEFORE n2 does not erase n2
    const gone = computeNotesGone([n1, earlyMiss, n2, lateHit]);
    assert.equal(gone.has('n1'), false);
    assert.equal(gone.has('n2'), true);

    // Removing the later eraser restores n2
    const restored = computeNotesGone([n1, earlyMiss, n2]);
    assert.equal(restored.has('n2'), false);
  });

  it('respects note ownership, erased status, and topmost z-order in hitEditableNote', () => {
    const otherNote = makeEl({
      id: 'other',
      tool: 'text',
      userId: 'student-2',
      x: 50,
      y: 50,
      width: 100,
      height: 40,
      text: 'Other',
    });
    const ownNote = makeEl({
      id: 'own',
      tool: 'text',
      userId: 'student-1',
      x: 50,
      y: 50,
      width: 100,
      height: 40,
      text: 'Mine',
    });

    assert.equal(hitEditableNote([otherNote], new Set(), 70, 70, 8, 'student-1', false), null);
    assert.equal(hitEditableNote([otherNote], new Set(), 70, 70, 8, 'teacher-1', true)?.id, 'other');
    assert.equal(hitEditableNote([otherNote, ownNote], new Set(), 70, 70, 8, 'student-1', false)?.id, 'own');
    assert.equal(hitEditableNote([otherNote, ownNote], new Set(['own']), 70, 70, 8, 'student-1', false), null);
  });
});

describe('geometry, element bounds, ownership, and translation', () => {
  it('computes boxes, intersection, distance-to-path, and point-in-loop', () => {
    assert.deepEqual(inkBox([0, 10, 30, 40], 5), [-5, 5, 35, 45]);
    assert.equal(boxesMeet([0, 0, 10, 10], [10, 10, 20, 20]), true);
    assert.equal(boxesMeet([0, 0, 10, 10], [11, 11, 20, 20]), false);
    assert.equal(distToPath(5, 3, [0, 0, 10, 0]), 3);

    const squareLoop = [0, 0, 100, 0, 100, 100, 0, 100];
    assert.equal(pointInLoop(50, 50, squareLoop), true);
    assert.equal(pointInLoop(150, 50, squareLoop), false);
  });

  it('computes element and selection bounds across shapes, stamps, text, and strokes', () => {
    const rectNeg = makeEl({ id: 'r1', tool: 'rect', x: 100, y: 100, width: -40, height: -20, strokeWidth: 4 });
    assert.deepEqual(getElementBounds(rectNeg), [58, 78, 102, 102]);

    const circle = makeEl({ id: 'c1', tool: 'circle', x: 0, y: 0, width: 40, height: 20, strokeWidth: 4 });
    assert.deepEqual(getElementBounds(circle), [-2, -12, 42, 32]);

    const stamp = makeEl({ id: 'st1', tool: 'stamp', stamp: 'star', x: 50, y: 50, strokeWidth: 6 });
    const sb = getElementBounds(stamp);
    assert.deepEqual(sb, [29.2, 29.2, 70.8, 70.8]);

    assert.equal(getSelectionBounds([]), null);
    assert.deepEqual(getSelectionBounds([rectNeg, circle]), [-2, -12, 102, 102]);
  });

  it('translates elements without mutating originals and enforces ownership', () => {
    const stroke = makeEl({ id: 'p1', tool: 'solid', userId: 's1', points: [10, 20, 30, 40] });
    const moved = translateElement(stroke, 5.5, -10);
    assert.deepEqual(moved.points, [15.5, 10, 35.5, 30]);
    assert.deepEqual(stroke.points, [10, 20, 30, 40]);

    const box = makeEl({ id: 'b1', tool: 'rect', userId: 's1', x: 12, y: 18, width: 40, height: 40 });
    const movedBox = translateElement(box, 10, 2);
    assert.equal(movedBox.x, 22);
    assert.equal(movedBox.y, 20);
    assert.equal(box.x, 12);

    assert.equal(canUserModifyElement(stroke, 's1', false), true);
    assert.equal(canUserModifyElement(stroke, 's2', false), false);
    assert.equal(canUserModifyElement(stroke, 's2', true), true);
  });
});

describe('partially-erased freehand strokes and lasso/hit-testing', () => {
  it('splits a partially erased stroke into visible segments and rejects hits in erased gap', () => {
    const stroke = makeEl({
      id: 'pen1',
      tool: 'solid',
      userId: 'u1',
      strokeWidth: 4,
      points: [0, 0, 20, 0, 40, 0, 60, 0, 80, 0, 100, 0],
    });
    // Eraser cuts vertically through x = 50 (covers vertices around 40 and 60 depending on radius)
    const middleEraser = makeEl({
      id: 'er1',
      tool: 'eraser',
      userId: 'u1',
      strokeWidth: 16, // r = max(8, 24)/2 = 12 => hits vertices at x=40 and x=60
      points: [50, -30, 50, 30],
    });

    assert.equal(isFreehandStroke(stroke), true);
    assert.equal(hasSubsequentOverlappingEraser(stroke, [middleEraser, stroke]), false);
    assert.equal(hasSubsequentOverlappingEraser(stroke, [stroke, middleEraser]), true);

    const elements = [stroke, middleEraser];
    const runs = getVisibleStrokeRuns(stroke, elements);
    assert.equal(runs.length, 2);
    assert.deepEqual(runs[0], [0, 0, 20, 0]);
    assert.deepEqual(runs[1], [80, 0, 100, 0]);

    const pieces = expandElementVisiblePieces(stroke, elements);
    assert.equal(pieces.length, 2);
    assert.equal(pieces[0].id, 'pen1');
    assert.notEqual(pieces[1].id, 'pen1');

    // Erased center gap is un-hittable, surviving ends remain hittable
    assert.equal(hitElementAtPoint(elements, new Set(), 50, 0, 6, 'u1', false), null);
    assert.equal(hitElementAtPoint(elements, new Set(), 10, 0, 6, 'u1', false)?.id, 'pen1');
    assert.equal(hitElementAtPoint(elements, new Set(), 90, 0, 6, 'u1', false)?.id, 'pen1');

    // Lasso around only the erased middle (x: 35..65) must NOT phantom-select the stroke
    const gapLoop = [35, -20, 65, -20, 65, 20, 35, 20];
    assert.deepEqual(lassoSelectElements(elements, new Set(), gapLoop, 'u1', false), []);

    // Lasso enclosing the surviving runs selects it
    const fullLoop = [-10, -20, 110, -20, 110, 20, -10, 20];
    const picked = lassoSelectElements(elements, new Set(), fullLoop, 'u1', false);
    assert.equal(picked.length, 1);
    assert.equal(picked[0].id, 'pen1');
  });

  it('drops completely erased strokes and ignores erasers from other users', () => {
    const stroke = makeEl({
      id: 'pen2',
      tool: 'highlighter',
      userId: 'u1',
      strokeWidth: 4,
      points: [0, 0, 10, 0, 20, 0],
    });
    const otherUserEraser = makeEl({
      id: 'er-other',
      tool: 'eraser',
      userId: 'u2',
      strokeWidth: 30,
      points: [-10, 0, 30, 0],
    });
    const ownFullEraser = makeEl({
      id: 'er-own',
      tool: 'eraser',
      userId: 'u1',
      strokeWidth: 30,
      points: [-10, 0, 30, 0],
    });

    // Different user's eraser does not split u1's stroke
    assert.deepEqual(expandElementVisiblePieces(stroke, [stroke, otherUserEraser]), [stroke]);

    // Same user's covering eraser completely removes it
    const goneElements = [stroke, ownFullEraser];
    assert.deepEqual(getVisibleStrokeRuns(stroke, goneElements), []);
    assert.deepEqual(expandElementVisiblePieces(stroke, goneElements), []);
    assert.equal(hitElementAtPoint(goneElements, new Set(), 10, 0, 8, 'u1', false), null);
    assert.deepEqual(
      lassoSelectElements(goneElements, new Set(), [-20, -20, 40, -20, 40, 20, -20, 20], 'u1', false),
      []
    );
  });
});

describe('cn tailwind class merge utility', () => {
  it('merges conditional classes and resolves conflicting utilities', () => {
    assert.equal(cn('px-2 py-1', false && 'hidden', 'px-4'), 'py-1 px-4');
  });
});

describe('hollow shape brush geometry and rendering', () => {
  it('renders single-click stamps and dragged strokes for circle, square, triangle, diamond, and star', () => {
    const calls: string[] = [];
    const mockCtx = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      lineCap: 'round',
      lineJoin: 'round',
      save: () => calls.push('save'),
      restore: () => calls.push('restore'),
      beginPath: () => calls.push('beginPath'),
      closePath: () => calls.push('closePath'),
      moveTo: () => calls.push('moveTo'),
      lineTo: () => calls.push('lineTo'),
      quadraticCurveTo: () => calls.push('quad'),
      arc: () => calls.push('arc'),
      rect: () => calls.push('rect'),
      fill: () => calls.push(`fill:${mockCtx.fillStyle}`),
      stroke: () => calls.push(`stroke:${mockCtx.strokeStyle}:${mockCtx.lineWidth}`),
    };

    for (const shape of ['circle', 'square', 'triangle', 'diamond', 'star'] as const) {
      calls.length = 0;
      drawHollowElementOnCtx(mockCtx, [20, 30], 40, 5, '#e53935', shape);
      assert.ok(calls.includes('fill:#ffffff'), `stamp fills hollow white center for ${shape}`);
      assert.ok(calls.includes('stroke:#e53935:5'), `stamp strokes border weight 5 for ${shape}`);

      calls.length = 0;
      drawHollowElementOnCtx(mockCtx, [0, 0, 20, 10, 40, 20], 36, 4, '#1e88e5', shape);
      assert.ok(
        calls.some((c) => c.includes('#1e88e5')) && calls.some((c) => c.includes('#ffffff')),
        `dragged stroke renders both outer color and inner white cutout for ${shape}`
      );
    }

    calls.length = 0;
    traceHollowTipShape(mockCtx, 10, 10, 15, 'star');
    assert.ok(calls.filter((c) => c === 'lineTo').length === 9);
  });
});


describe('hollow shape brush: swept strokes stay cheap to paint (shape-tool FPS bug)', () => {
  // A long, dense, curvy pen path like a big scribble across the board (point every ~1.5px).
  function scribble(totalLen: number): number[] {
    const pts: number[] = [100, 100];
    let t = 0;
    let x = 100;
    let y = 100;
    let len = 0;
    while (len < totalLen) {
      t += 0.004;
      const nx = 700 + 600 * Math.sin(t * 3.1);
      const ny = 420 + 330 * Math.sin(t * 7.3 + 1);
      const d = Math.hypot(nx - x, ny - y);
      const n = Math.max(1, Math.floor(d / 1.5));
      for (let k = 1; k <= n; k++) {
        pts.push(Math.round((x + ((nx - x) * k) / n) * 10) / 10, Math.round((y + ((ny - y) * k) / n) * 10) / 10);
      }
      len += d;
      x = nx;
      y = ny;
    }
    return pts;
  }

  function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    return Math.hypot(ax + dx * t - px, ay + dy * t - py);
  }

  function isConvex(poly: number[]): boolean {
    const n = poly.length / 2;
    let sign = 0;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = [poly[i * 2], poly[i * 2 + 1]];
      const [bx, by] = [poly[((i + 1) % n) * 2], poly[((i + 1) % n) * 2 + 1]];
      const [cx, cy] = [poly[((i + 2) % n) * 2], poly[((i + 2) % n) * 2 + 1]];
      const c = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
      if (Math.abs(c) < 1e-9) continue;
      if (sign === 0) sign = Math.sign(c);
      else if (Math.sign(c) !== sign) return false;
    }
    return true;
  }

  /** Distance from (px, py) to a convex polygon (0 when inside). */
  function distToConvex(poly: number[], px: number, py: number): number {
    const n = poly.length / 2;
    let inside = true;
    let sign = 0;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const ax = poly[i * 2];
      const ay = poly[i * 2 + 1];
      const bx = poly[((i + 1) % n) * 2];
      const by = poly[((i + 1) % n) * 2 + 1];
      best = Math.min(best, distToSeg(px, py, ax, ay, bx, by));
      const c = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      if (Math.abs(c) > 1e-9) {
        if (sign === 0) sign = Math.sign(c);
        else if (Math.sign(c) !== sign) inside = false;
      }
    }
    return inside ? 0 : best;
  }

  const bigStroke = scribble(6000);

  it('simplifies a dense pen path a lot without straying more than the tolerance', () => {
    const simple = simplifyPathForSweep(bigStroke);
    assert.deepEqual(simple.slice(0, 2), bigStroke.slice(0, 2), 'keeps the first point');
    assert.deepEqual(simple.slice(-2), bigStroke.slice(-2), 'keeps the last point');
    assert.ok(simple.length * 5 < bigStroke.length, `${bigStroke.length / 2} points became ${simple.length / 2}`);
    for (let i = 0; i < bigStroke.length; i += 2) {
      let best = Infinity;
      for (let j = 0; j + 3 < simple.length; j += 2) {
        best = Math.min(best, distToSeg(bigStroke[i], bigStroke[i + 1], simple[j], simple[j + 1], simple[j + 2], simple[j + 3]));
        if (best <= HOLLOW_SWEEP_TOLERANCE) break;
      }
      assert.ok(best <= HOLLOW_SWEEP_TOLERANCE + 1e-9, `raw point ${i / 2} is ${best.toFixed(3)}px from the simplified path`);
    }
    assert.deepEqual(simplifyPathForSweep([5, 6]), [5, 6]);
    assert.deepEqual(simplifyPathForSweep([0, 0, 10, 0]), [0, 0, 10, 0]);
  });

  it('splits every tip shape into convex pieces that use the same corners as the drawn stamp', () => {
    for (const shape of ['square', 'triangle', 'diamond', 'star'] as const) {
      const pieces = hollowTipConvexPieces(20, shape);
      for (const piece of pieces) assert.ok(isConvex(piece), `${shape} piece is convex`);
      const traced: number[] = [];
      const rec = {
        moveTo: (x: number, y: number) => traced.push(x, y),
        lineTo: (x: number, y: number) => traced.push(x, y),
        rect: (x: number, y: number, w: number, h: number) => traced.push(x, y, x + w, y, x + w, y + h, x, y + h),
        closePath: () => {},
      };
      traceHollowTipShape(rec, 0, 0, 20, shape);
      for (let i = 0; i < traced.length; i += 2) {
        const covered = pieces.some((piece) => distToConvex(piece, traced[i], traced[i + 1]) < 1e-6);
        assert.ok(covered, `${shape} corner (${traced[i]}, ${traced[i + 1]}) is inside a piece`);
      }
    }
    assert.equal(hollowTipConvexPieces(20, 'star').length, 5);
  });

  it('covers the tip shape at every raw pen point (no gaps in the swept stroke)', () => {
    const path = bigStroke.slice(0, 1200);
    for (const shape of ['square', 'triangle', 'diamond', 'star'] as const) {
      const polys = buildHollowSweepPolygons(simplifyPathForSweep(path), 18, shape);
      const corners = hollowTipConvexPieces(18, shape).flat();
      for (let i = 0; i < path.length; i += 6) {
        for (let c = 0; c < corners.length; c += 2) {
          const px = path[i] + corners[c];
          const py = path[i + 1] + corners[c + 1];
          let best = Infinity;
          for (const poly of polys) {
            best = Math.min(best, distToConvex(poly, px, py));
            if (best === 0) break;
          }
          assert.ok(best <= HOLLOW_SWEEP_TOLERANCE + 1e-6, `${shape}: corner at pen point ${i / 2} is ${best.toFixed(3)}px outside`);
        }
      }
    }
  });

  it('paints a big dragged shape stroke with a bounded number of small fills, not one giant path', () => {
    for (const shape of ['square', 'triangle', 'diamond', 'star'] as const) {
      let contoursInPath = 0;
      const contoursPerFill: number[] = [];
      const ctx = {
        fillStyle: '',
        save: () => {},
        restore: () => {},
        beginPath: () => {
          contoursInPath = 0;
        },
        moveTo: () => {
          contoursInPath += 1;
        },
        lineTo: () => {},
        closePath: () => {},
        fill: () => {
          contoursPerFill.push(contoursInPath);
        },
      };
      drawHollowElementOnCtx(ctx, bigStroke, 36, 3, '#222222', shape);
      const totalContours = contoursPerFill.reduce((a, b) => a + b, 0);
      assert.ok(
        Math.max(...contoursPerFill) <= HOLLOW_SWEEP_POLYS_PER_FILL,
        `${shape}: largest fill had ${Math.max(...contoursPerFill)} contours`
      );
      // The old renderer stamped the shape every ~5px here: ~1,200 copies per pass for this stroke
      // (6,000 star contours per pass), all in one path. The sweep needs far fewer.
      const pieces = shape === 'star' ? 5 : 1;
      assert.ok(totalContours < 2 * pieces * 300, `${shape}: ${totalContours} contours for both passes`);
    }
  });

  it('builds a finished stroke once and reuses it on every repaint', () => {
    const pts = bigStroke.slice(0, 400);
    const a = getHollowSweepGeometry(pts, 18, 15, 'star');
    const b = getHollowSweepGeometry(pts, 18, 15, 'star');
    assert.equal(a, b, 'same stroke, same settings: cached');
    const c = getHollowSweepGeometry(pts, 18, 15, 'square');
    assert.notEqual(c, a, 'different shape rebuilds');
    const d = getHollowSweepGeometry(pts.slice(), 18, 15, 'square');
    assert.notEqual(d, c, 'a new points array (stroke still growing) rebuilds');
  });
});

describe('hollow shape brush: a finished stroke becomes one picture', () => {
  function makeLog() {
    const log = { fills: 0, images: 0, canvases: 0 };
    const pathCtx = () => ({
      fillStyle: '',
      save() {},
      restore() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      closePath() {},
      quadraticCurveTo() {},
      arc() {},
      stroke() {},
      setTransform() {},
      fill() {
        log.fills += 1;
      },
    });
    let m = { a: 2, b: 0, c: 0, d: 2, e: 10, f: 20 };
    const ctx = {
      ...pathCtx(),
      getTransform: () => m,
      drawImage() {
        log.images += 1;
      },
    };
    const makeCanvas = (w: number, h: number) => {
      log.canvases += 1;
      return { width: w, height: h, getContext: () => pathCtx() };
    };
    return { log, ctx, makeCanvas, setTransform: (next: typeof m) => (m = next) };
  }

  const stroke = () => {
    const pts: number[] = [];
    for (let i = 0; i <= 600; i++) pts.push(100 + i * 1.5, 200 + 60 * Math.sin(i / 8));
    return pts;
  };

  it('paints shapes once, then repaints as a single image', () => {
    const { log, ctx, makeCanvas } = makeLog();
    const pts = stroke();
    drawHollowElementCached(ctx, pts, 36, 3, '#cc0000', 'star', makeCanvas);
    assert.ok(log.fills > 0, 'first paint draws the shapes');
    assert.equal(log.images, 0);

    log.fills = 0;
    drawHollowElementCached(ctx, pts, 36, 3, '#cc0000', 'star', makeCanvas);
    assert.equal(log.canvases, 1, 'second paint at the same zoom makes the picture');
    assert.equal(log.images, 1);

    log.fills = 0;
    log.images = 0;
    for (let i = 0; i < 20; i++) drawHollowElementCached(ctx, pts, 36, 3, '#cc0000', 'star', makeCanvas);
    assert.equal(log.fills, 0, 'later repaints fill nothing');
    assert.equal(log.images, 20, 'one image per repaint');
    assert.equal(log.canvases, 1, 'picture reused');
  });

  it('goes back to shapes while zooming and remakes the picture once the zoom settles', () => {
    const { log, ctx, makeCanvas, setTransform } = makeLog();
    const pts = stroke();
    drawHollowElementCached(ctx, pts, 36, 3, '#0000cc', 'square', makeCanvas);
    drawHollowElementCached(ctx, pts, 36, 3, '#0000cc', 'square', makeCanvas);
    assert.equal(log.canvases, 1);

    setTransform({ a: 3, b: 0, c: 0, d: 3, e: 0, f: 0 });
    log.fills = 0;
    log.images = 0;
    drawHollowElementCached(ctx, pts, 36, 3, '#0000cc', 'square', makeCanvas);
    assert.ok(log.fills > 0, 'new zoom: crisp shapes, not a stretched picture');
    assert.equal(log.images, 0);
    drawHollowElementCached(ctx, pts, 36, 3, '#0000cc', 'square', makeCanvas);
    assert.equal(log.canvases, 2, 'picture remade at the settled zoom');
    assert.equal(log.images, 1);

    // Panning (translation only) keeps the picture.
    setTransform({ a: 3, b: 0, c: 0, d: 3, e: 250, f: -40 });
    drawHollowElementCached(ctx, pts, 36, 3, '#0000cc', 'square', makeCanvas);
    assert.equal(log.canvases, 2);
    assert.equal(log.images, 2);
  });

  it('stays vector for a stroke still being drawn, round strokes, and rotated contexts', () => {
    const { log, ctx, makeCanvas, setTransform } = makeLog();
    let pts = stroke();
    for (let i = 0; i < 5; i++) {
      pts = [...pts, pts[pts.length - 2] + 1.5, pts[pts.length - 1]]; // each move is a new points array
      drawHollowElementCached(ctx, pts, 36, 3, '#00aa00', 'triangle', makeCanvas);
    }
    assert.equal(log.canvases, 0, 'no picture while the pen is down');

    const done = stroke();
    drawHollowElementCached(ctx, done, 36, 3, '#00aa00', 'circle', makeCanvas);
    drawHollowElementCached(ctx, done, 36, 3, '#00aa00', 'circle', makeCanvas);
    assert.equal(log.canvases, 0, 'round brush strokes are already cheap and stay as they were');

    const short = [0, 0, 40, 10, 80, 0];
    drawHollowElementCached(ctx, short, 36, 3, '#00aa00', 'star', makeCanvas);
    drawHollowElementCached(ctx, short, 36, 3, '#00aa00', 'star', makeCanvas);
    assert.equal(log.canvases, 0, 'small strokes are cheap already and use no picture memory');

    setTransform({ a: 1, b: 0.5, c: -0.5, d: 1, e: 0, f: 0 });
    drawHollowElementCached(ctx, done, 36, 3, '#00aa00', 'diamond', makeCanvas);
    drawHollowElementCached(ctx, done, 36, 3, '#00aa00', 'diamond', makeCanvas);
    assert.equal(log.canvases, 0);
  });

  it('keeps total picture memory under the budget by dropping the oldest', () => {
    const { ctx, makeCanvas } = makeLog();
    // ~1,300 x 600 world px at 2x: about 3M screen px per stroke picture.
    const strokes: number[][] = [];
    for (let k = 0; k < 30; k++) {
      const pts: number[] = [];
      for (let i = 0; i <= 300; i++) pts.push(i * 4.3 + k * 0.01, 300 * Math.sin(i / 20));
      strokes.push(pts);
    }
    for (const pts of strokes) {
      drawHollowElementCached(ctx, pts, 36, 3, '#333333', 'star', makeCanvas);
      drawHollowElementCached(ctx, pts, 36, 3, '#333333', 'star', makeCanvas);
      assert.ok(hollowBitmapPixelsInUse() <= HOLLOW_BITMAP_BUDGET_PX, `${hollowBitmapPixelsInUse()} px in use`);
    }
    assert.ok(hollowBitmapPixelsInUse() > 0);
  });
});

describe('stampsHitByEraser', () => {
  const stamp = (id: string, x: number, y: number, userId = 'u1'): CanvasElement =>
    ({ id, tool: 'stamp', stamp: 'username', userId, userName: 'Ava', color: '#000', strokeWidth: 6, x, y }) as CanvasElement;
  const eraser = (points: number[], strokeWidth = 20, userId = 'u1'): CanvasElement =>
    ({ id: 'e', tool: 'eraser', userId, userName: 'Ava', color: '#fff', strokeWidth, points }) as CanvasElement;

  it('finds a stamp the eraser passes over, and not one far away', () => {
    const els = [stamp('near', 0, 0), stamp('far', 1000, 1000)];
    const hit = stampsHitByEraser(els, eraser([-200, 0, 200, 0]));
    assert.deepEqual(hit.map((e) => e.id), ['near']);
  });

  it('catches a stamp between two widely spaced points of a fast swipe', () => {
    const hit = stampsHitByEraser([stamp('s', 0, 0)], eraser([-2000, 0, 2000, 0], 8));
    assert.equal(hit.length, 1);
  });

  it('catches a single-click eraser dab on the stamp', () => {
    assert.equal(stampsHitByEraser([stamp('s', 50, 50)], eraser([50, 50])).length, 1);
  });

  it("ignores other users' stamps and non-stamp elements", () => {
    const pen = { id: 'p', tool: 'solid', userId: 'u1', userName: 'Ava', color: '#000', strokeWidth: 4, points: [0, 0, 5, 5] } as CanvasElement;
    const hit = stampsHitByEraser([stamp('theirs', 0, 0, 'u2'), pen], eraser([-50, 0, 50, 0]));
    assert.equal(hit.length, 0);
  });

  it('returns nothing for a non-eraser stroke', () => {
    const pen = { ...eraser([-50, 0, 50, 0]), tool: 'solid' } as CanvasElement;
    assert.equal(stampsHitByEraser([stamp('s', 0, 0)], pen).length, 0);
  });
});
