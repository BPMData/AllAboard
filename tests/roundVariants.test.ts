import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CanvasElement, RoomBackground } from '../src/types.ts';
import {
  availableLetters,
  emptyRoundVariants,
  normalizeRoundVariants,
  pickVariant,
  sameWorksheet,
  studentKey,
  uploadWorksheetPages,
  variantBackground,
  variantsNote,
  type RoundVariants,
} from '../src/lib/roundVariants.ts';

const sheet = (url: string): RoomBackground =>
  ({ fileName: url, pages: [{ dataUrl: url, width: 100, height: 100 }] }) as RoomBackground;

const withExtra = (patch: Partial<RoundVariants>): RoundVariants => ({ ...emptyRoundVariants(), ...patch });

const stamp = (userId: string, x: number, y: number): CanvasElement =>
  ({
    id: `s-${userId}`,
    boardId: 'main',
    userId,
    tool: 'stamp',
    stamp: 'username',
    x,
    y,
    timestamp: 1,
  }) as CanvasElement;

const ctx = (userId: string, name = userId, late = false, mainElements: CanvasElement[] = []) => ({
  userId,
  name,
  late,
  mainElements,
  mainBackground: sheet('/api/assets/main'),
});

describe('roundVariants', () => {
  it('normalizes junk to null and keeps valid fields', () => {
    assert.equal(normalizeRoundVariants(null), null);
    assert.equal(normalizeRoundVariants({ rule: 'rotate' }), null, 'no worksheets and no picks carries nothing');
    const v = normalizeRoundVariants({
      extra: [sheet('b'), 'junk', sheet('d')],
      rule: 'corner',
      cornerMap: { tl: 3, tr: 9, none: 1 },
      lateJoiners: 'a',
      overrides: { '  Alex ': 2, bea: 7 },
      assigned: { u1: 1 },
    })!;
    assert.deepEqual(
      v.extra.map((bg) => bg?.fileName ?? null),
      ['b', null, 'd']
    );
    assert.equal(v.rule, 'corner');
    assert.deepEqual(v.cornerMap, { tl: 3, tr: 1, bl: 2, br: 3, none: 1 });
    assert.equal(v.lateJoiners, 'a');
    assert.deepEqual(v.overrides, { alex: 2 });
    assert.deepEqual(v.assigned, { u1: 1 });
  });

  it('lists available letters and finds each worksheet', () => {
    const v = withExtra({ extra: [null, sheet('c'), null] });
    assert.deepEqual(availableLetters(v), [0, 2]);
    assert.equal(variantBackground(v, 0, sheet('a'))?.fileName, 'a');
    assert.equal(variantBackground(v, 2, sheet('a'))?.fileName, 'c');
    assert.equal(variantBackground(v, 1, sheet('a'))?.fileName, 'a', 'a letter with no worksheet falls back to A');
  });

  it('deals out in turn, honors picks by name and the late-joiner rule', () => {
    const v = withExtra({ extra: [sheet('b'), null, null], rule: 'rotate' });
    assert.equal(pickVariant(v, ctx('u1')), 0);
    v.assigned.u1 = 0;
    assert.equal(pickVariant(v, ctx('u2')), 1);
    v.assigned.u2 = 1;
    v.overrides[studentKey('Cal')] = 1;
    assert.equal(pickVariant(v, ctx('u3', ' cal ')), 1, 'pick by name wins over the rule');
    v.lateJoiners = 'a';
    assert.equal(pickVariant(v, ctx('u4', 'Dee', true)), 0);
    v.overrides.cal = 3;
    assert.equal(pickVariant(v, ctx('u3', 'Cal')), 0, 'a pick for a letter with no worksheet is ignored');
  });

  it('picks by name-stamp corner', () => {
    const v = withExtra({ extra: [sheet('b'), sheet('c'), sheet('d')], rule: 'corner' });
    const main = [stamp('u1', 10, 10), stamp('u2', 90, 90)];
    assert.equal(pickVariant(v, ctx('u1', 'u1', false, main)), 0);
    assert.equal(pickVariant(v, ctx('u2', 'u2', false, main)), 3);
    v.cornerMap.none = 1;
    assert.equal(pickVariant(v, ctx('u3', 'u3', false, main)), 1, 'no stamp uses the "none" letter');
  });

  it('compares worksheets and uploads only data pages', async () => {
    assert.ok(sameWorksheet(sheet('/api/assets/x'), sheet('/api/assets/x')));
    assert.ok(!sameWorksheet(sheet('/api/assets/x'), sheet('/api/assets/y')));
    assert.ok(sameWorksheet(null, undefined));
    const bg = {
      fileName: 'f',
      pages: [
        { dataUrl: 'data:image/png;base64,AA', width: 1, height: 1 },
        { dataUrl: '/api/assets/k', width: 1, height: 1 },
      ],
    } as RoomBackground;
    const uploaded: string[] = [];
    const out = await uploadWorksheetPages(bg, async (d) => {
      uploaded.push(d);
      return '/api/assets/new';
    });
    assert.deepEqual(
      out!.pages.map((p) => p.dataUrl),
      ['/api/assets/new', '/api/assets/k']
    );
    assert.equal(uploaded.length, 1);
  });

  it('describes a round with variants', () => {
    assert.equal(variantsNote(null), '');
    assert.equal(
      variantsNote(withExtra({ extra: [sheet('b'), null, sheet('d')], rule: 'corner' })),
      ' + worksheets B, D (by name-stamp corner)'
    );
  });
});
