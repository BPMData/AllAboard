import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSnapshotText, snapshotFileName } from '../src/lib/roomSnapshot';

describe('roomSnapshot helpers', () => {
  it('formats snapshotFileName with roomId and ISO date', () => {
    const d = new Date('2026-11-14T15:00:00Z');
    assert.equal(snapshotFileName('math-101', d), 'allaboard-room-math-101-2026-11-14.json');
  });

  it('parses a valid v2 snapshot and keeps assets, subBoards, and valid elements/messages', () => {
    const raw = JSON.stringify({
      version: 2,
      roomId: 'bio-2',
      exportedAt: 1700000000000,
      exportedBy: 'Ms T',
      assets: { '/api/assets/abc': 'data:image/jpeg;base64,AAA' },
      elements: [
        { id: 'e1', userId: 'u1', userName: 'T', tool: 'solid', color: '#000', strokeWidth: 4, points: [0, 0, 10, 10] },
        { id: 'bad1' }, // missing tool
        { tool: 'solid' }, // missing id
        null,
      ],
      messages: [
        { id: 'm1', userId: 'u1', userName: 'T', text: 'hi', timestamp: 1 },
        { id: 'badm' }, // missing text
      ],
      background: {
        id: 'bg1',
        fileName: 'sheet.pdf',
        pages: [{ dataUrl: '/api/assets/abc', width: 100, height: 100 }],
        x: 0,
        y: 0,
        scale: 1,
        layout: 'stack',
        opacity: 1,
      },
      subBoards: { r1_ind_u1: { id: 'r1_ind_u1', title: 'A', assignedUserIds: ['u1'], elements: [], background: null, messages: [] } },
      breakoutConfig: { mode: 'main', allowSelfSelect: false, chatScope: 'unified' },
    });

    const res = parseSnapshotText('snap.json', raw, 'fallback-room');
    assert.equal(res.error, null);
    assert.equal(res.pending.fileName, 'snap.json');
    assert.equal(res.pending.roomId, 'bio-2');
    assert.equal(res.pending.elements.length, 1);
    assert.equal(res.pending.elements[0].id, 'e1');
    assert.equal(res.pending.messages.length, 1);
    assert.equal(res.pending.messages[0].id, 'm1');
    assert.deepEqual(res.pending.assets, { '/api/assets/abc': 'data:image/jpeg;base64,AAA' });
    assert.ok(res.pending.subBoards?.r1_ind_u1);
    assert.equal(res.pending.breakoutConfig?.mode, 'main');
  });

  it('falls back to fallbackRoomId when snapshot roomId is missing or empty', () => {
    const raw = JSON.stringify({ elements: [], messages: [] });
    const res = parseSnapshotText('snap.json', raw, 'room-xyz');
    assert.equal(res.error, null);
    assert.equal(res.pending.roomId, 'room-xyz');
  });

  it('returns parse error on malformed JSON without throwing', () => {
    const res = parseSnapshotText('broken.json', '{not valid json', 'room-1');
    assert.match(res.error ?? '', /Could not parse JSON file/);
    assert.equal(res.pending.fileName, 'broken.json');
    assert.equal(res.pending.roomId, 'room-1');
    assert.deepEqual(res.pending.elements, []);
  });

  it('returns validation error on empty object {}', () => {
    const res = parseSnapshotText('empty.json', '{}', 'room-1');
    assert.match(res.error ?? '', /does not contain valid AllAboard room data/);
    assert.equal(res.pending.fileName, 'empty.json');
    assert.equal(res.pending.roomId, 'room-1');
  });
});
