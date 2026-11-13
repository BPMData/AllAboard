import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExportEntries,
  buildMultiPagePdfFromJpegs,
  computeBoardWorldBounds,
} from '../src/lib/batchPdfExport';
import type { CanvasElement, RoomBackground, SubBoardData, User } from '../src/types';

function el(partial: Partial<CanvasElement>): CanvasElement {
  return {
    id: partial.id || 'e1',
    userId: 'u1',
    userName: 'Alex',
    tool: 'solid',
    color: '#000000',
    strokeWidth: 4,
    ...partial,
  };
}

function bg(partial: Partial<RoomBackground>): RoomBackground {
  return {
    id: 'bg1',
    fileName: 'sheet.pdf',
    pages: [],
    x: 0,
    y: 0,
    scale: 1,
    layout: 'stack',
    opacity: 1,
    ...partial,
  };
}

function subBoard(partial: Partial<SubBoardData>): SubBoardData {
  return {
    id: 'r1_ind_u1',
    title: 'Board',
    assignedUserIds: [],
    elements: [],
    background: null,
    messages: [],
    ...partial,
  };
}

const page = (width: number, height: number) => ({ dataUrl: 'data:,', width, height });

describe('computeBoardWorldBounds', () => {
  it('falls back to a default A4-ish frame for an empty board', () => {
    assert.deepEqual(computeBoardWorldBounds([], null), { minX: 40, minY: 40, maxX: 1140, maxY: 790 });
  });

  it('ignores eraser strokes when sizing the board', () => {
    const eraserOnly = [el({ tool: 'eraser', points: [0, 0, 5000, 5000] })];
    assert.deepEqual(computeBoardWorldBounds(eraserOnly, null), { minX: 40, minY: 40, maxX: 1140, maxY: 790 });
  });

  it('stacks worksheet pages vertically with a 32px gap', () => {
    const b = computeBoardWorldBounds([], bg({ pages: [page(100, 200), page(100, 200)] }));
    // pages span y 0..200 and 232..432, plus a 36px margin; width is padded up to the 400px minimum
    assert.deepEqual(b, { minX: -36, minY: -36, maxX: 400, maxY: 468 });
  });

  it('lays worksheet pages out in a row and applies background scale to the gap', () => {
    const b = computeBoardWorldBounds([], bg({ layout: 'row', scale: 2, pages: [page(100, 50), page(100, 50)] }));
    // page 1: x 0..200, gap 64, page 2: x 264..464; height 100 is padded to the 280px minimum
    assert.deepEqual(b, { minX: -36, minY: -36, maxX: 500, maxY: 280 });
  });

  it('pads shapes by max(12, 2 × strokeWidth)', () => {
    const rect = el({ tool: 'rect', x: 100, y: 100, width: 1000, height: 500, strokeWidth: 4 });
    assert.deepEqual(computeBoardWorldBounds([rect], null), { minX: 52, minY: 52, maxX: 1148, maxY: 648 });

    const stroke = el({ tool: 'solid', points: [0, 0, 1000, 800], strokeWidth: 10 });
    assert.deepEqual(computeBoardWorldBounds([stroke], null), { minX: -56, minY: -56, maxX: 1056, maxY: 856 });
  });

  it('gives stamps a fixed footprint and enforces a 400 × 280 minimum board size', () => {
    const stamp = el({ tool: 'stamp', stamp: 'star', x: 500, y: 500 });
    assert.deepEqual(computeBoardWorldBounds([stamp], null), { minX: 374, minY: 419, maxX: 810, maxY: 735 });
  });

  it('skips non-finite coordinates instead of poisoning the bounds', () => {
    const bad = el({ tool: 'solid', points: [NaN, 0, Infinity, 10] });
    const good = el({ id: 'e2', tool: 'rect', x: 0, y: 0, width: 600, height: 400 });
    const b = computeBoardWorldBounds([bad, good], null);
    for (const v of Object.values(b)) assert.ok(Number.isFinite(v));
    assert.deepEqual(b, { minX: -48, minY: -48, maxX: 648, maxY: 448 });
  });
});

describe('buildExportEntries', () => {
  const users: User[] = [
    { userId: 'u1', name: 'Alex', color: '#f00', isTeacher: false },
    { userId: 'u2', name: 'Sam', color: '#0f0', isTeacher: false },
  ];

  it('exports only the main board when there are no breakout boards', () => {
    const entries = buildExportEntries([], null, [], users);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].boardId, 'main');
    assert.equal(entries[0].subtitle, 'Shared Classroom Stage · 0 item(s)');
  });

  it('skips an empty main board when breakout boards exist', () => {
    const entries = buildExportEntries([], null, [subBoard({ id: 'b1' })], users);
    assert.deepEqual(entries.map((e) => e.boardId), ['b1']);
  });

  it('keeps the main board when it has ink or a worksheet', () => {
    const withInk = buildExportEntries([el({})], null, [subBoard({ id: 'b1' })], users);
    assert.deepEqual(withInk.map((e) => e.boardId), ['main', 'b1']);

    const withSheet = buildExportEntries([], bg({}), [subBoard({ id: 'b1' })], users);
    assert.deepEqual(withSheet.map((e) => e.boardId), ['main', 'b1']);
  });

  it('names assigned students, falling back to "Student" for unknown ids', () => {
    const [entry] = buildExportEntries(
      [],
      null,
      [subBoard({ id: 'g1', title: 'Group 1', assignedUserIds: ['u1', 'ghost', 'u2'], elements: [el({}), el({ id: 'e2' })] })],
      users
    );
    assert.equal(entry.title, 'Group 1');
    assert.equal(entry.subtitle, 'Students: Alex, Student, Sam · 2 stroke(s)');
  });

  it('labels unassigned boards generically', () => {
    const [entry] = buildExportEntries([], null, [subBoard({ id: 'b1' })], users);
    assert.equal(entry.subtitle, 'Breakout / Individual Board · 0 stroke(s)');
  });
});

describe('buildMultiPagePdfFromJpegs', () => {
  // Fake "JPEG" payloads: the PDF writer treats them as opaque bytes, so any content works
  // and lets us check the stream lengths precisely.
  const fakeJpeg = (n: number, fill: number) => new Uint8Array(n).fill(fill);

  async function buildPdf(pages: Array<{ jpegBytes: Uint8Array; widthPx: number; heightPx: number }>) {
    const blob = buildMultiPagePdfFromJpegs(pages);
    assert.equal(blob.type, 'application/pdf');
    // latin1 keeps a 1:1 mapping between string index and byte offset
    return Buffer.from(await blob.arrayBuffer()).toString('latin1');
  }

  it('writes a valid header, trailer, and page tree', async () => {
    const pdf = await buildPdf([
      { jpegBytes: fakeJpeg(10, 1), widthPx: 1684, heightPx: 1190 },
      { jpegBytes: fakeJpeg(20, 2), widthPx: 800, heightPx: 600 },
    ]);
    assert.ok(pdf.startsWith('%PDF-1.4\n'));
    assert.ok(pdf.trimEnd().endsWith('%%EOF'));
    assert.match(pdf, /\/Kids \[ 3 0 R 6 0 R \] \/Count 2/);
    assert.match(pdf, /\/Size 9 \/Root 1 0 R/); // 2 + 2 pages × 3 objects, plus the free entry
    assert.equal((pdf.match(/\/Type \/Page /g) || []).length, 2);
    assert.match(pdf, /\/MediaBox \[0 0 842 595\]/);
  });

  it('records image dimensions and exact stream lengths', async () => {
    const pdf = await buildPdf([
      { jpegBytes: fakeJpeg(10, 1), widthPx: 1684, heightPx: 1190 },
      { jpegBytes: fakeJpeg(20, 2), widthPx: 800, heightPx: 600 },
    ]);
    assert.match(pdf, /5 0 obj\n<< [^>]*\/Width 1684 \/Height 1190 [^>]*\/Filter \/DCTDecode \/Length 10 >>/);
    assert.match(pdf, /8 0 obj\n<< [^>]*\/Width 800 \/Height 600 [^>]*\/Length 20 >>/);
    assert.ok(pdf.includes('stream\n' + '\x01'.repeat(10) + '\nendstream'));
    assert.ok(pdf.includes('stream\n' + '\x02'.repeat(20) + '\nendstream'));

    // Content stream /Length must match its body exactly
    const content = /4 0 obj\n<< \/Length (\d+) >>\nstream\n([\s\S]*?)endstream/.exec(pdf);
    assert.ok(content);
    assert.equal(Number(content[1]), content[2].length);
  });

  it('writes an xref table whose offsets point at each object', async () => {
    const pdf = await buildPdf([
      { jpegBytes: fakeJpeg(7, 0xff), widthPx: 10, heightPx: 10 },
      { jpegBytes: fakeJpeg(3, 0x00), widthPx: 10, heightPx: 10 },
      { jpegBytes: fakeJpeg(5, 0x41), widthPx: 10, heightPx: 10 },
    ]);

    const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(pdf)![1]);
    assert.ok(pdf.startsWith('xref\n0 12\n', startxref));

    const entries = pdf
      .slice(startxref)
      .split('\n')
      .filter((line) => /^\d{10} \d{5} [nf] $/.test(line));
    assert.equal(entries.length, 12);
    assert.equal(entries[0], '0000000000 65535 f ');
    entries.slice(1).forEach((line, i) => {
      const offset = Number(line.slice(0, 10));
      assert.ok(pdf.startsWith(`${i + 1} 0 obj\n`, offset), `object ${i + 1} not at offset ${offset}`);
    });
  });
});
