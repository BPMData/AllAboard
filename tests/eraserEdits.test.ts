// The real eraser (TODO "A real eraser"): an eraser stroke becomes edits on pen-up, in order, with exact undo.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { CanvasElement } from '../src/types.ts';
import { applyElementGroups, eraseGroups, eraseWithStroke, splitStroke } from '../src/lib/eraserEdits.ts';
import { type ServerHandle, delay, socketPool, startTestServer, waitForEvent } from './socketHelpers.ts';

let n = 0;
const makeId = () => `new${++n}`;

const ink = (id: string, points: number[], extra: Partial<CanvasElement> = {}): CanvasElement =>
  ({
    id,
    boardId: 'main',
    userId: 'u1',
    userName: 'Ann',
    tool: 'solid',
    color: '#000',
    strokeWidth: 4,
    points,
    timestamp: 1,
    ...extra,
  }) as CanvasElement;

/** A horizontal line from x=0 to x=200 at y, sampled every 10. */
const hline = (y: number) => Array.from({ length: 21 }, (_, i) => [i * 10, y]).flat();
/** A vertical eraser swipe through x, top to bottom. */
const eraser = (id: string, x: number, extra: Partial<CanvasElement> = {}) =>
  ink(id, [x, -50, x, 50], { tool: 'eraser', strokeWidth: 20, ...extra });

const ids = (list: CanvasElement[]) => list.map((el) => el.id);

describe('eraserEdits', () => {
  it('splits a pen stroke into two pieces that stop short of the eraser', () => {
    const board = [ink('a', hline(0)), eraser('E', 100)];
    const res = eraseWithStroke(board, board[1], makeId);
    assert.equal(res.edits.length, 1);
    const [left, right] = res.edits[0].after;
    assert.ok(left && right, 'two pieces');
    assert.ok(Math.max(...left.points!.filter((_, i) => i % 2 === 0)) < 100 - 15);
    assert.ok(Math.min(...right.points!.filter((_, i) => i % 2 === 0)) > 100 + 15);
    assert.equal(left.color, '#000');
    assert.deepEqual(res.keptEraser, []);
  });

  it('cuts a long straight segment with no points near the eraser', () => {
    const res = splitStroke([0, 0, 200, 0], 4, [100, -50, 100, 50], 15);
    assert.equal(res?.length, 2);
  });

  it('removes fully covered ink and leaves untouched ink alone', () => {
    const board = [ink('dot', [100, 0]), ink('far', hline(300)), eraser('E', 100)];
    const res = eraseWithStroke(board, board[2], makeId);
    assert.deepEqual(
      res.edits.map((e) => [e.before[0].id, e.after.length]),
      [['dot', 0]]
    );
  });

  it("only erases the eraser's own author's ink drawn before it", () => {
    const board = [ink('other', hline(0), { userId: 'u2' }), eraser('E', 100), ink('later', hline(0))];
    assert.deepEqual(eraseWithStroke(board, board[1], makeId).edits, []);
  });

  it('splits a shape-brush (hollow star) stroke and keeps its shape settings', () => {
    const star = ink('star', hline(0), { tool: 'hollow', strokeWidth: 24, hollowShape: 'star', hollowWeight: 3 });
    const board = [star, eraser('E', 100)];
    const res = eraseWithStroke(board, board[1], makeId);
    assert.equal(res.edits[0].after.length, 2);
    for (const piece of res.edits[0].after) {
      assert.equal(piece.tool, 'hollow');
      assert.equal(piece.hollowShape, 'star');
      assert.equal(piece.hollowWeight, 3);
      assert.ok(piece.points!.length >= 4);
    }
    assert.deepEqual(res.keptEraser, [], 'no eraser stroke is stored');
  });

  it('removes notes and stamps it touches', () => {
    const note = ink('note', [], { tool: 'text', text: 'hi', x: 95, y: -5, points: undefined });
    const stamp = ink('st', [], { tool: 'stamp', stamp: 'star', x: 100, y: 0, points: undefined });
    const board = [note, stamp, eraser('E', 100)];
    const res = eraseWithStroke(board, board[2], makeId);
    assert.deepEqual(res.edits.map((e) => e.before[0].id).sort(), ['note', 'st']);
    assert.ok(res.edits.every((e) => e.after.length === 0));
  });

  it('keeps a trimmed eraser over a rectangle it only partly covers, and removes one it covers', () => {
    const big = ink('big', [], { tool: 'rect', x: 50, y: -20, width: 100, height: 40, points: undefined });
    const tiny = ink('tiny', [], { tool: 'rect', x: 98, y: -2, width: 4, height: 4, points: undefined });
    const board = [
      big,
      tiny,
      ink('a', [300, 500, 400, 500]),
      eraser('E', 100, { points: [100, -100, 100, 100, 100, 600] }),
    ];
    const res = eraseWithStroke(board, board[3], makeId);
    assert.deepEqual(
      res.edits.map((e) => e.before[0].id),
      ['tiny']
    );
    assert.ok(res.keptEraser.length >= 1, 'a piece of the eraser stays over the big rectangle');
    const kept = res.keptEraser.flatMap((e) => e.points!.filter((_, i) => i % 2 === 1));
    assert.ok(Math.max(...kept) < 100, 'only near the rectangle, not down at the far stroke');
  });

  it('forward then backward groups give back the exact board, in order', () => {
    const board = [
      ink('a', hline(0)),
      ink('x', hline(0), { userId: 'u2' }),
      ink('dot', [100, 0]),
      ink('b', hline(0), { tool: 'highlighter' }),
      ink('c', hline(300)),
      eraser('E', 100),
    ];
    const res = eraseWithStroke(board, board[5], makeId);
    const { forward, backward } = eraseGroups(res, 'E');
    const erased = applyElementGroups(board, forward);
    assert.equal(
      erased.find((el) => el.id === 'E'),
      undefined,
      'the eraser stroke is gone'
    );
    assert.equal(
      erased.find((el) => el.id === 'dot'),
      undefined
    );
    // Pieces stay where their stroke was: a's pieces before x, b's pieces after x and before c.
    const order = ids(erased);
    assert.ok(order.indexOf('x') > 1 && order.indexOf('c') === order.length - 1);
    const restored = applyElementGroups(erased, backward);
    assert.deepEqual(restored, board.slice(0, 5));
    assert.deepEqual(ids(applyElementGroups(restored, forward)), order, 'redo');
    assert.deepEqual(applyElementGroups(erased, forward), erased, 'applying twice changes nothing');
  });
});

describe('elements-replace on the server', () => {
  let srv: ServerHandle;
  let dir: string;
  const pool = socketPool();

  beforeEach(async () => {
    ({ srv, dir } = await startTestServer());
  });
  afterEach(async () => {
    pool.closeAll();
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('applies edits in order, syncs other screens, keeps them after a rejoin, and protects other ink', async () => {
    const roomId = 'erase-room';
    const { socket: ann } = await pool.join(srv, { roomId, userId: 'u1', name: 'Ann' });
    const { socket: bo } = await pool.join(srv, { roomId, userId: 'u2', name: 'Bo' });
    ann.emit('element-start', ink('a', hline(0)));
    bo.emit('element-start', ink('x', hline(0), { userId: 'u2' }));
    ann.emit('element-start', ink('dot', [100, 0]));
    ann.emit('element-start', eraser('E', 100));
    await delay(80);

    const board = [ink('a', hline(0)), ink('x', hline(0), { userId: 'u2' }), ink('dot', [100, 0]), eraser('E', 100)];
    const { forward, backward } = eraseGroups(eraseWithStroke(board, board[3], makeId), 'E');
    const seen = waitForEvent<any>(bo, 'elements-replaced');
    ann.emit('elements-replace', { boardId: 'main', groups: forward });
    const got = await seen;
    assert.equal(got.groups.length, forward.length);

    // A late joiner sees the same board: two pieces of a, then Bo's x; no dot, no eraser.
    const { init } = await pool.join(srv, { roomId, userId: 'u3', name: 'Cy' });
    const order = (init.elements as CanvasElement[]).map((el) => el.id);
    assert.equal(order.length, 3);
    assert.equal(order[2], 'x');
    assert.ok(!order.includes('E') && !order.includes('dot') && !order.includes('a'));

    // Undo puts a and dot back where they were.
    ann.emit('elements-replace', { boardId: 'main', groups: backward });
    await delay(80);
    const { init: again } = await pool.join(srv, { roomId, userId: 'u4', name: 'Di' });
    assert.deepEqual(
      (again.elements as CanvasElement[]).map((el) => el.id),
      ['a', 'x', 'dot']
    );

    // Ann can't remove Bo's ink this way.
    ann.emit('elements-replace', { boardId: 'main', groups: [{ ids: ['x'], elements: [] }] });
    await delay(80);
    const { init: third } = await pool.join(srv, { roomId, userId: 'u5', name: 'Ed' });
    assert.ok((third.elements as CanvasElement[]).some((el) => el.id === 'x'));
  });
});
