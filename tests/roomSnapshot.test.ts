import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CanvasElement, RoomBackground } from '../src/types';
import { emptyRoundVariants } from '../src/lib/roundVariants';
import { buildSnapshotJson, parseSnapshotText, snapshotFileName, type SnapshotSource } from '../src/lib/roomSnapshot';

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

  it('round-trips worksheets, ink, chat, and breakout rounds in a portable class-work file', async () => {
    const worksheet = (id: string): RoomBackground => ({
      id, fileName: id + '.png', pages: [{ dataUrl: '/api/assets/' + id, width: 20, height: 30 }],
      x: 0, y: 0, scale: 1, layout: 'stack', opacity: 1,
    });
    const mainInk: CanvasElement = {
      id: 'main-ink', userId: 't', userName: 'Teacher', tool: 'solid', color: '#000', strokeWidth: 2, points: [1, 2],
    };
    const message = { id: 'm1', userId: 's1', userName: 'Sam', text: 'Done', timestamp: 123 };
    const variants = emptyRoundVariants();
    variants.extra[0] = worksheet('variant');
    variants.assigned.s1 = 1;
    const source: SnapshotSource = {
      roomId: 'math', exportedBy: 'Teacher', background: worksheet('main'), elements: [mainInk], messages: [message],
      subBoards: { team: {
        id: 'team', title: 'Team', kind: 'group', roundId: 'r1', assignedUserIds: ['s1'], background: worksheet('group'),
        elements: [{ ...mainInk, id: 'team-ink', boardId: 'team' }], messages: [message],
      } },
      breakoutConfig: {
        mode: 'groups', activeRoundId: 'r1', allowSelfSelect: false, chatScope: 'board',
        rounds: [{ id: 'r1', number: 1, title: 'Practice', mode: 'groups', createdAt: 123 }],
        autoIndividualBackground: worksheet('auto'),
      },
      roundTemplates: { r1: worksheet('group') }, roundTemplateInk: { r1: [mainInk] }, roundVariants: { r1: variants },
    };
    const fetched: string[] = [];
    const { json, fileName } = await buildSnapshotJson(source, async (url) => {
      fetched.push(url);
      return new Response(url, { headers: { 'content-type': 'image/png' } });
    });
    const urls = ['main', 'group', 'auto', 'variant'].map((id) => '/api/assets/' + id);
    assert.deepEqual(fetched.sort(), urls.sort(), 'the shared worksheet is fetched once');
    assert.equal(JSON.parse(json).version, 2);
    const { pending, error } = parseSnapshotText(fileName, json, 'fallback');
    assert.equal(error, null);
    assert.deepEqual(pending, {
      ...source, fileName, exportedAt: JSON.parse(json).exportedAt,
      assets: Object.fromEntries(urls.map((url) => [url, 'data:image/png;base64,' + Buffer.from(url).toString('base64')])),
    });
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
