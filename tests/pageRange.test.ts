import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clampPageRange } from '../src/lib/pageRange';

describe('clampPageRange', () => {
  it('clamps requested page ranges to total and max pages', () => {
    assert.deepEqual(clampPageRange(1, 10, 34, 10), { first: 1, last: 10 });
    assert.deepEqual(clampPageRange(25, 40, 34, 10), { first: 25, last: 34 });
    assert.deepEqual(clampPageRange(5, 30, 34, 10), { first: 5, last: 14 });
    assert.deepEqual(clampPageRange(0, 0, 3, 10), { first: 1, last: 1 });
    assert.deepEqual(clampPageRange(50, 60, 34, 10), { first: 34, last: 34 });
    assert.deepEqual(clampPageRange(3, 2, 34, 10), { first: 3, last: 3 });
  });
});
