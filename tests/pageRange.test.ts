import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampPageRange,
  MAX_PDF_PAGES,
  DEFAULT_WORKSHEET_IMPORT_SCALE,
  WORKSHEET_SCALE_OPTIONS,
  normalizeWorksheetImportScale,
  scalePageDimensions,
} from '../src/lib/pageRange';

describe('clampPageRange', () => {
  it('clamps requested page ranges to total and max pages', () => {
    assert.equal(MAX_PDF_PAGES, 30);
    assert.deepEqual(clampPageRange(1, 10, 34, 10), { first: 1, last: 10 });
    assert.deepEqual(clampPageRange(25, 40, 34, 10), { first: 25, last: 34 });
    assert.deepEqual(clampPageRange(5, 30, 34, 10), { first: 5, last: 14 });
    assert.deepEqual(clampPageRange(1, 35, 35, MAX_PDF_PAGES), { first: 1, last: 30 });
    assert.deepEqual(clampPageRange(0, 0, 3, 10), { first: 1, last: 1 });
    assert.deepEqual(clampPageRange(50, 60, 34, 10), { first: 34, last: 34 });
    assert.deepEqual(clampPageRange(3, 2, 34, 10), { first: 3, last: 3 });
  });
});

describe('worksheet import scale (0.5x to 3x, default 2x)', () => {
  it('defaults to 2x and clamps values to [0.5, 3]', () => {
    assert.equal(DEFAULT_WORKSHEET_IMPORT_SCALE, 2);
    assert.deepEqual(WORKSHEET_SCALE_OPTIONS, [0.5, 1, 1.5, 2, 2.5, 3]);
    assert.equal(normalizeWorksheetImportScale(undefined), 2);
    assert.equal(normalizeWorksheetImportScale(null), 2);
    assert.equal(normalizeWorksheetImportScale('not-a-number'), 2);
    assert.equal(normalizeWorksheetImportScale(0.1), 0.5);
    assert.equal(normalizeWorksheetImportScale(0.5), 0.5);
    assert.equal(normalizeWorksheetImportScale(1.5), 1.5);
    assert.equal(normalizeWorksheetImportScale(2), 2);
    assert.equal(normalizeWorksheetImportScale(3), 3);
    assert.equal(normalizeWorksheetImportScale(5), 3);
  });

  it('scales page world dimensions by multiplier while capping raster pixels at 2400px', () => {
    // Omitted importScale defaults to 1x for raw loader calls
    assert.deepEqual(scalePageDimensions(1400, 989), {
      width: 1400,
      height: 989,
      renderWidth: 1400,
      renderHeight: 989,
      multiplier: 1,
    });

    // 0.5x shrinks world and render size in half
    assert.deepEqual(scalePageDimensions(1400, 1000, 0.5), {
      width: 700,
      height: 500,
      renderWidth: 700,
      renderHeight: 500,
      multiplier: 0.5,
    });

    // 2x doubles world size to 2800x2000 while capping raster pixels at 2400px wide
    assert.deepEqual(scalePageDimensions(1400, 1000, 2), {
      width: 2800,
      height: 2000,
      renderWidth: 2400,
      renderHeight: 1714,
      multiplier: 2,
    });

    // 3x triples world size to 4200x3000 while capping raster pixels at 2400px wide
    assert.deepEqual(scalePageDimensions(1400, 1000, 3), {
      width: 4200,
      height: 3000,
      renderWidth: 2400,
      renderHeight: 1714,
      multiplier: 3,
    });
  });
});
