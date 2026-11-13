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

