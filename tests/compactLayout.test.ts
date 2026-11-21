import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPhoneViewport } from '../src/lib/compactLayout';

describe('isPhoneViewport', () => {
  it('is true for phones either way up, false for tablets and computers', () => {
    assert.equal(isPhoneViewport(390, 844), true, 'phone upright');
    assert.equal(isPhoneViewport(844, 390), true, 'phone sideways');
    assert.equal(isPhoneViewport(744, 1133), false, 'iPad mini upright');
    assert.equal(isPhoneViewport(1133, 744), false, 'iPad mini sideways');
    assert.equal(isPhoneViewport(800, 1280), false, 'Android tablet');
    assert.equal(isPhoneViewport(1366, 768), false, 'Chromebook');
    assert.equal(isPhoneViewport(0, 0), false, 'unknown size');
    assert.equal(isPhoneViewport(NaN, 800), false);
  });
});
