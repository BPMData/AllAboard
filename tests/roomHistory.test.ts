import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ROOM_HISTORY,
  ROOM_HISTORY_STORAGE_KEY,
  checkRoomHistoryStatus,
  clearRoomHistory,
  formatRoomAge,
  formatRoomStatusLabel,
  loadRoomHistory,
  recordRoomHistory,
  removeRoomHistoryEntry,
  sanitizeRoomHistoryEntries,
  sortAndFilterRoomHistory,
  type RoomStatusInfo,
} from '../src/lib/roomHistory';

function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

describe('roomHistory helpers', () => {
  it('records, normalizes, deduplicates, sorts, and caps room history entries', () => {
    const storage = createMemoryStorage();

    const first = recordRoomHistory('  Bio 101!! ', 1000, storage);
    assert.deepEqual(first, [{ code: 'bio-101', createdAt: 1000, lastUsedAt: 1000 }]);

    recordRoomHistory('chem-202', 2000, storage);
    const updated = recordRoomHistory('BIO-101', 3000, storage);
    assert.deepEqual(updated, [
      { code: 'bio-101', createdAt: 1000, lastUsedAt: 3000 },
      { code: 'chem-202', createdAt: 2000, lastUsedAt: 2000 },
    ]);

    // Ignores blank inputs
    assert.deepEqual(recordRoomHistory('   ', 4000, storage), updated);

    // Caps at MAX_ROOM_HISTORY
    for (let i = 0; i < MAX_ROOM_HISTORY + 5; i += 1) {
      recordRoomHistory(`room-${i}`, 5000 + i, storage);
    }
    const capped = loadRoomHistory(storage);
    assert.equal(capped.length, MAX_ROOM_HISTORY);
    assert.equal(capped[0].code, `room-${MAX_ROOM_HISTORY + 4}`);

    // Removes a single room and clears all
    const afterRemove = removeRoomHistoryEntry(`room-${MAX_ROOM_HISTORY + 4}`, storage);
    assert.equal(afterRemove.length, MAX_ROOM_HISTORY - 1);
    assert.equal(afterRemove[0].code, `room-${MAX_ROOM_HISTORY + 3}`);

    clearRoomHistory(storage);
    assert.deepEqual(loadRoomHistory(storage), []);
  });

  it('sanitizes malformed storage payloads and merges duplicate normalized codes', () => {
    const storage = createMemoryStorage();
    storage.setItem(ROOM_HISTORY_STORAGE_KEY, 'not-valid-json');
    assert.deepEqual(loadRoomHistory(storage), []);

    storage.setItem(
      ROOM_HISTORY_STORAGE_KEY,
      JSON.stringify([
        null,
        { code: '' },
        { code: '   ' },
        { code: 'Valid 1', createdAt: 100, lastUsedAt: 500 },
        { code: 'valid-1', createdAt: 200, lastUsedAt: 900 },
      ])
    );
    assert.deepEqual(loadRoomHistory(storage), [
      { code: 'valid-1', createdAt: 100, lastUsedAt: 900 },
    ]);

    assert.deepEqual(sanitizeRoomHistoryEntries('nope'), []);
  });

  it('checks room live, saved, expired, and unknown statuses via /api/rooms/:roomId', async () => {
    assert.deepEqual(await checkRoomHistoryStatus('   '), {
      status: 'expired',
      activeUserCount: 0,
      hasTeacherPin: false,
    });

    const fakeFetch = (async (url: string) => {
      if (url.endsWith('/live-1')) {
        return new Response(
          JSON.stringify({ roomId: 'live-1', exists: true, activeUserCount: 3, hasTeacherPin: true }),
          { status: 200 }
        );
      }
      if (url.endsWith('/saved-1')) {
        return new Response(
          JSON.stringify({ roomId: 'saved-1', exists: true, activeUserCount: 0, hasTeacherPin: false }),
          { status: 200 }
        );
      }
      if (url.endsWith('/gone-1')) {
        return new Response(
          JSON.stringify({ roomId: 'gone-1', exists: false, activeUserCount: 0, hasTeacherPin: false }),
          { status: 200 }
        );
      }
      if (url.endsWith('/err-1')) {
        return new Response('bad gateway', { status: 502 });
      }
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;

    assert.deepEqual(await checkRoomHistoryStatus('live-1', fakeFetch), {
      status: 'live',
      activeUserCount: 3,
      hasTeacherPin: true,
    });
    assert.deepEqual(await checkRoomHistoryStatus('saved-1', fakeFetch), {
      status: 'saved',
      activeUserCount: 0,
      hasTeacherPin: false,
    });
    assert.deepEqual(await checkRoomHistoryStatus('gone-1', fakeFetch), {
      status: 'expired',
      activeUserCount: 0,
      hasTeacherPin: false,
    });
    assert.deepEqual(await checkRoomHistoryStatus('err-1', fakeFetch), {
      status: 'unknown',
      activeUserCount: 0,
      hasTeacherPin: false,
    });
    assert.deepEqual(await checkRoomHistoryStatus('net-1', fakeFetch), {
      status: 'unknown',
      activeUserCount: 0,
      hasTeacherPin: false,
    });
  });

  it('sorts rooms by status rank then recency and filters live-only', () => {
    const entries = [
      { code: 'old-expired', createdAt: 100, lastUsedAt: 5000 },
      { code: 'saved-room', createdAt: 100, lastUsedAt: 4000 },
      { code: 'live-older', createdAt: 100, lastUsedAt: 1000 },
      { code: 'live-newer', createdAt: 100, lastUsedAt: 3000 },
      { code: 'still-checking', createdAt: 100, lastUsedAt: 2000 },
    ];
    const statuses: Record<string, RoomStatusInfo | undefined> = {
      'old-expired': { status: 'expired', activeUserCount: 0, hasTeacherPin: false },
      'saved-room': { status: 'saved', activeUserCount: 0, hasTeacherPin: true },
      'live-older': { status: 'live', activeUserCount: 1, hasTeacherPin: false },
      'live-newer': { status: 'live', activeUserCount: 4, hasTeacherPin: true },
      'still-checking': undefined,
    };

    assert.deepEqual(
      sortAndFilterRoomHistory(entries, statuses, false).map((e) => e.code),
      ['live-newer', 'live-older', 'saved-room', 'still-checking', 'old-expired']
    );

    assert.deepEqual(
      sortAndFilterRoomHistory(entries, statuses, true).map((e) => e.code),
      ['live-newer', 'live-older', 'still-checking']
    );
  });

  it('formats relative room ages and status labels cleanly', () => {
    const now = 1_700_000_000_000;
    assert.equal(formatRoomAge(now - 10_000, now), 'Just now');
    assert.equal(formatRoomAge(now - 5 * 60_000, now), '5m ago');
    assert.equal(formatRoomAge(now - 3 * 3_600_000, now), '3h ago');
    assert.equal(formatRoomAge(now - 2 * 86_400_000, now), '2d ago');
    assert.equal(
      formatRoomAge(now - 10 * 86_400_000, now),
      new Date(now - 10 * 86_400_000).toLocaleDateString()
    );

    assert.equal(formatRoomStatusLabel(undefined), 'Checking…');
    assert.equal(
      formatRoomStatusLabel({ status: 'live', activeUserCount: 2, hasTeacherPin: true }),
      'Live · 2 online'
    );
    assert.equal(
      formatRoomStatusLabel({ status: 'saved', activeUserCount: 0, hasTeacherPin: false }),
      'Saved · rejoinable'
    );
    assert.equal(
      formatRoomStatusLabel({ status: 'expired', activeUserCount: 0, hasTeacherPin: false }),
      'Expired'
    );
    assert.equal(
      formatRoomStatusLabel({ status: 'unknown', activeUserCount: 0, hasTeacherPin: false }),
      'Status unknown'
    );
  });
});
