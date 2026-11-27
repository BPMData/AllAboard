import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyDigest, buildDigest, emptyChanges } from '../src/lib/boardDigest.ts';
import { appendPointBatches, createPointQueue, type PointBatch } from '../src/lib/pointBatcher.ts';

function manualScheduler() {
  const pending: Array<() => void> = [];
  return {
    schedule: (run: () => void) => {
      pending.push(run);
      return () => {
        const i = pending.indexOf(run);
        if (i >= 0) pending.splice(i, 1);
      };
    },
    fire: () => pending.splice(0).forEach((r) => r()),
    get pending() {
      return pending.length;
    },
  };
}

describe('createPointQueue', () => {
  it('coalesces many adds into one delivery per element, in order', () => {
    const sched = manualScheduler();
    const out: PointBatch[][] = [];
    const q = createPointQueue((b) => out.push(b), sched.schedule);
    q.add('main', 'a', [1, 1]);
    q.add('main', 'b', [9, 9]);
    q.add('main', 'a', [2, 2]);
    q.add('r1_ind_x', 'a', [5, 5]); // same id, other board: separate batch
    assert.equal(sched.pending, 1, 'one timer for the whole burst');
    sched.fire();
    assert.deepEqual(out, [
      [
        { boardId: 'main', id: 'a', points: [1, 1, 2, 2] },
        { boardId: 'main', id: 'b', points: [9, 9] },
        { boardId: 'r1_ind_x', id: 'a', points: [5, 5] },
      ],
    ]);
  });

  it('flush() delivers now and cancels the timer; empty flush is a no-op', () => {
    const sched = manualScheduler();
    const out: PointBatch[][] = [];
    const q = createPointQueue((b) => out.push(b), sched.schedule);
    q.flush();
    assert.equal(out.length, 0);
    q.add('main', 'a', [1, 2]);
    q.flush();
    assert.equal(out.length, 1);
    assert.equal(sched.pending, 0);
    sched.fire();
    assert.equal(out.length, 1, 'nothing delivered twice');
  });

  it('clear() drops queued points; ignores empty input', () => {
    const sched = manualScheduler();
    const out: PointBatch[][] = [];
    const q = createPointQueue((b) => out.push(b), sched.schedule);
    q.add('main', 'a', []);
    assert.equal(q.size, 0);
    q.add('main', 'a', [1, 2]);
    q.clear();
    sched.fire();
    q.flush();
    assert.equal(out.length, 0);
  });

  it('does not alias the caller array', () => {
    const sched = manualScheduler();
    const out: PointBatch[][] = [];
    const q = createPointQueue((b) => out.push(b), sched.schedule);
    const pts = [1, 2];
    q.add('main', 'a', pts);
    q.add('main', 'a', [3, 4]);
    assert.deepEqual(pts, [1, 2]);
  });
});

describe('appendPointBatches', () => {
  it('appends to matching strokes in one pass and keeps identity when nothing matches', () => {
    const list = [{ id: 'a', points: [0, 0] }, { id: 'n', text: 'note' } as { id: string; points?: number[] }];
    const next = appendPointBatches(list, [
      { boardId: 'main', id: 'a', points: [1, 1] },
      { boardId: 'main', id: 'a', points: [2, 2] },
    ]);
    assert.deepEqual(next[0].points, [0, 0, 1, 1, 2, 2]);
    assert.equal(next[1], list[1]);
    assert.equal(appendPointBatches(list, [{ boardId: 'main', id: 'zzz', points: [1, 1] }]), list);
  });
});

describe('board digests', () => {
  it('round-trips upserts, removals and replacements while keeping order', () => {
    const server = [
      { id: 'a', v: 2 },
      { id: 'c', v: 1 },
    ];
    const changes = emptyChanges();
    changes.upserts.add('a');
    changes.upserts.add('c');
    changes.upserts.add('gone'); // touched then deleted: becomes a removal
    changes.removed.add('b');
    const digest = buildDigest('main', changes, server);
    assert.deepEqual(digest.removed?.sort(), ['b', 'gone']);
    const client = [
      { id: 'a', v: 1 },
      { id: 'b', v: 1 },
      { id: 'gone', v: 1 },
    ];
    assert.deepEqual(applyDigest(client, digest), server);
  });

  it('full digests replace the board; empty ones keep identity', () => {
    const changes = emptyChanges();
    changes.full = true;
    assert.deepEqual(applyDigest([{ id: 'x' }], buildDigest('b', changes, [])), []);
    const list = [{ id: 'x' }];
    assert.equal(applyDigest(list, { boardId: 'b' }), list);
  });
});
