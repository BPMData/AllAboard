import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { latestNameStamp, quadrantForPoint, quadrantsByUser } from '../src/lib/stampQuadrants';
import type { CanvasElement, RoomBackground } from '../src/types';

const bg = (over: Partial<RoomBackground> = {}): RoomBackground => ({
  id: 'bg',
  fileName: 'four-corners.pdf',
  pages: [{ dataUrl: 'data:,', width: 1000, height: 800 }],
  x: -500,
  y: -400,
  scale: 1,
  layout: 'stack',
  opacity: 1,
  ...over,
});

let n = 0;
const stamp = (userId: string, x: number, y: number, extra: Partial<CanvasElement> = {}): CanvasElement => ({
  id: `s${n++}`,
  userId,
  userName: userId,
  tool: 'stamp',
  stamp: 'username',
  color: '#000',
  strokeWidth: 1,
  x,
  y,
  ...extra,
});

describe('stampQuadrants', () => {
  it('maps each quarter of one page', () => {
    const b = bg();
    assert.equal(quadrantForPoint(-250, -200, b), 'tl');
    assert.equal(quadrantForPoint(250, -200, b), 'tr');
    assert.equal(quadrantForPoint(-250, 200, b), 'bl');
    assert.equal(quadrantForPoint(250, 200, b), 'br');
    const els = [stamp('a', -250, -200), stamp('b', 250, -200), stamp('c', -250, 200), stamp('d', 250, 200)];
    assert.deepEqual(quadrantsByUser(els, b, ['a', 'b', 'c', 'd']), { a: 'tl', b: 'tr', c: 'bl', d: 'br' });
  });

  it('uses the latest stamp by timestamp, then by array order', () => {
    const later = stamp('a', 250, 200, { timestamp: 20 });
    const els = [later, stamp('a', -250, -200, { timestamp: 10 })];
    assert.equal(latestNameStamp(els, 'a'), later);
    assert.deepEqual(quadrantsByUser(els, bg(), ['a']), { a: 'br' });
    const noTs = [stamp('b', -250, -200), stamp('b', 250, -200)];
    assert.deepEqual(quadrantsByUser(noTs, bg(), ['b']), { b: 'tr' });
  });

  it('returns null for no stamp, off-page stamps and a missing background', () => {
    const els = [stamp('off', 900, 900), stamp('on', -250, -200)];
    assert.deepEqual(quadrantsByUser(els, bg(), ['none', 'off']), { none: null, off: null });
    assert.deepEqual(quadrantsByUser(els, null, ['on']), { on: null });
  });

  it("ignores other stamp kinds and other users' name stamps", () => {
    const els = [stamp('a', -250, -200, { stamp: 'star' }), stamp('b', 250, 200)];
    assert.deepEqual(quadrantsByUser(els, bg(), ['a']), { a: null });
  });

  it("splits a stamp on page 2 of a row layout by page 2's center", () => {
    const b = bg({
      x: 0,
      y: 0,
      layout: 'row',
      pages: [
        { dataUrl: 'data:,', width: 1000, height: 800 },
        { dataUrl: 'data:,', width: 1000, height: 800 },
      ],
    });
    // Page 2 spans x 1032..2032 (gap 32), center x 1532.
    assert.equal(quadrantForPoint(1100, 100, b), 'tl');
    assert.equal(quadrantForPoint(1600, 100, b), 'tr');
    assert.equal(quadrantForPoint(1100, 700, b), 'bl');
    assert.equal(quadrantForPoint(1016, 100, b), null); // in the gap
  });

  it('respects background scale', () => {
    const b = bg({ x: 0, y: 0, scale: 2 }); // 2000×1600
    assert.equal(quadrantForPoint(1500, 400, b), 'tr');
    assert.equal(quadrantForPoint(900, 1200, b), 'bl');
    assert.equal(quadrantForPoint(1999, 1599, b), 'br');
  });
});
