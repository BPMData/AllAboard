import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STAMP_OPTIONS,
  TEACHER_STAMP_OPTIONS,
  getTeacherStampAppearance,
  getTeacherStampDimensions,
  isTeacherStampKind,
} from '../src/lib/stamps';
import { getElementBounds } from '../src/lib/inkCore';
import type { CanvasElement } from '../src/types';

describe('stamp definitions and rubber-stamp helpers', () => {
  it('distinguishes teacher feedback stamps from student stamps', () => {
    for (const s of STAMP_OPTIONS) {
      assert.equal(isTeacherStampKind(s.kind), false);
      assert.equal(getTeacherStampAppearance(s.kind), null);
    }
    for (const t of TEACHER_STAMP_OPTIONS) {
      assert.equal(isTeacherStampKind(t.kind), true);
      assert.ok(getTeacherStampAppearance(t.kind, 'GOOD JOB'));
    }
    assert.equal(isTeacherStampKind('bogus'), false);
  });

  it('normalizes custom teacher stamp text and uses element color when provided', () => {
    const custom = getTeacherStampAppearance('teacher-custom', '  fix step 2  ', '#2563eb');
    assert.deepEqual(custom, {
      text: 'FIX STEP 2',
      color: '#2563eb',
      fill: '#ffffff',
      rotationDeg: -6,
    });
    const empty = getTeacherStampAppearance('teacher-custom', '   ', '#ffffff');
    assert.equal(empty?.text, 'FEEDBACK');
    assert.equal(empty?.color, '#7c3aed');
  });

  it('computes rubber stamp dimensions and rotated bounds for hit testing', () => {
    const dims = getTeacherStampDimensions('APPROVED', 6);
    assert.ok(dims.width >= 96);
    assert.ok(dims.height > dims.fontSize);

    const el: CanvasElement = {
      id: 'st-approved',
      userId: 'teacher-1',
      userName: 'Ms T',
      tool: 'stamp',
      stamp: 'approved',
      color: '#15803d',
      strokeWidth: 6,
      x: 200,
      y: 150,
    };
    const [x0, y0, x1, y1] = getElementBounds(el);
    assert.ok(x0 < 200 && x1 > 200);
    assert.ok(y0 < 150 && y1 > 150);
    assert.ok(x1 - x0 > dims.width * 0.9);
  });
});
