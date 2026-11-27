import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gridColumns, layoutPages } from '../src/lib/worksheetLayout';

const page = (width: number, height: number) => ({ dataUrl: 'data:,', width, height });

describe('gridColumns', () => {
  it('returns 1 for empty or single-page inputs', () => {
    assert.equal(gridColumns([]), 1);
    assert.equal(gridColumns([page(800, 600)]), 1);
  });

  it('picks ~3 columns for 10 landscape slides and ~4-5 for 10 portrait worksheets', () => {
    const landscape10 = Array.from({ length: 10 }, () => page(1600, 900));
    assert.equal(gridColumns(landscape10), 3);

    const portrait10 = Array.from({ length: 10 }, () => page(850, 1100));
    const portraitCols = gridColumns(portrait10);
    assert.ok(portraitCols >= 4 && portraitCols <= 5, `expected 4..5 cols, got ${portraitCols}`);

    const portrait6 = Array.from({ length: 6 }, () => page(850, 1100));
    assert.equal(gridColumns(portrait6), 5);
  });
});

describe('layoutPages', () => {
  it('places pages horizontally for row and vertically for stack with scaled gap', () => {
    const pages = [page(100, 80), page(120, 90)];
    assert.deepEqual(layoutPages({ pages, x: 10, y: 20, scale: 2, layout: 'row' }, 32), [
      { x: 10, y: 20, width: 200, height: 160 },
      { x: 274, y: 20, width: 240, height: 180 },
    ]);

    assert.deepEqual(layoutPages({ pages, x: 10, y: 20, scale: 2, layout: 'stack' }, 32), [
      { x: 10, y: 20, width: 200, height: 160 },
      { x: 10, y: 244, width: 240, height: 180 },
    ]);
  });

  it('places pages left-to-right wrapping into rows for grid', () => {
    const pages = Array.from({ length: 6 }, () => page(160, 90));
    // 6 landscape 16:9 pages -> 2 cols x 3 rows (aspect 32/27 vs 48/18 -> c=2)
    assert.equal(gridColumns(pages), 2);
    assert.deepEqual(layoutPages({ pages, x: 0, y: 0, scale: 1, layout: 'grid' }, 10), [
      { x: 0, y: 0, width: 160, height: 90 },
      { x: 170, y: 0, width: 160, height: 90 },
      { x: 0, y: 100, width: 160, height: 90 },
      { x: 170, y: 100, width: 160, height: 90 },
      { x: 0, y: 200, width: 160, height: 90 },
      { x: 170, y: 200, width: 160, height: 90 },
    ]);
  });

  it('falls back to row for unknown legacy layout values', () => {
    const pages = [page(100, 50), page(100, 50)];
    assert.deepEqual(layoutPages({ pages, x: 0, y: 0, scale: 1, layout: 'mystery' as any }, 32), [
      { x: 0, y: 0, width: 100, height: 50 },
      { x: 132, y: 0, width: 100, height: 50 },
    ]);
  });
});
