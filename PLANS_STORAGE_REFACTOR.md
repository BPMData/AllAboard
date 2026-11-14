# AllAboard — Storage Refactor: SQLite + Deduplicated Worksheet Assets

> **Who this is for:** an implementing agent (Codex / Antigravity / anyone).
> **How to use it:** Do the phases **in order**. Each phase lists exact files, exact
> functions, and code to paste. Each phase ends with a **checkpoint**. Do not start the
> next phase until its checkpoint passes. The architecture decisions are already made
> (see Appendix A). Do not redesign anything. If something in the code does not match
> this plan, stop and report it. Do not improvise a different design.

---

## 0. Read this first

### 0.1 The problem in one paragraph

All rooms live in one file, `.data/rooms-store.json`. Any edit in any room re-stringifies
**every** room and rewrites the whole file, which blocks the event loop. Worse, uploaded
worksheet pages are base64 `data:` URLs stored inline in `RoomBackground.pages[].dataUrl`,
and `cloneBackground()` copies them into **every** breakout sub-board. One 3 MB worksheet
across 30 individual boards is about 90 MB of room state. Because `breakout-sync` sends
**all** sub-boards to **every** socket in the room, a single breakout action can push
gigabytes of base64 over the network. We fix both problems at once.

### 0.2 Mental model (memorize these 6 facts)

1. Storage is one SQLite file: `<dataDir>/allaboard.db`, via the built-in `node:sqlite`
   module. **No new npm dependencies.**
2. **One row per room.** `rooms.state` is that room's JSON, the same shape as today's
   `SerializedRoom`. Saving room A never reads, stringifies, or writes room B.
3. **Worksheet images are stored once**, keyed by the sha256 of their bytes, in the `assets`
   table, and served at `GET /api/assets/<hash>` with immutable caching.
4. `BackgroundPage.dataUrl` **keeps its name**. Its value changes from
   `data:image/jpeg;base64,...` to `/api/assets/<64-hex-hash>`. `<img src>` and Konva accept
   both, so **rendering code does not change**.
5. A `dirtyRooms: Set<string>` tracks which rooms changed. The flush writes only those.
   `scheduleSaveToDisk` now takes the room: `scheduleSaveToDisk(room)` /
   `scheduleSaveToDisk(room, true)`.
6. Rooms are **lazy-loaded** from SQLite by `findRoom()` (used by `getOrCreateRoom` and the lobby's
   `getRoomAvailability`) and **unloaded** from RAM after 15 minutes with no connected sockets.
   Nothing is loaded at boot.

### 0.3 Where base64 is converted ("interned")

Any base64 page that reaches the server becomes an asset URL **before it is stored or
broadcast**. There are exactly these entry points, plus one safety net:

| Entry point | Function | Phase |
|---|---|---|
| `teacher:set-background` | `internBackground(store, …)` on the incoming background | 3.8 |
| `teacher:update-background` | `internBackground` on the merged background | 3.8 |
| `cloneBackground()` (breakout templates + every sub-board copy) | now calls `internBackground` | 3.8 |
| `teacher:import-room` | stores `snapshot.assets`, then `internRoomAssets(room)` before `room-restored` | 3.9 |
| Legacy `rooms-store.json` migration | `internRoomAssets(room)` per room | 3.4 |
| **Safety net:** every flush | `internRoomAssets(room)` before `store.saveRoom` | 3.6 |

### 0.4 Hard rules for the implementer

- **R1.** After every phase, run `npm run lint` and `npm test`. Both must pass before you continue.
- **R2.** Do not rename or add socket events. The only protocol change is a new optional `assets` field on the `teacher:import-room` payload.
- **R3.** Do not rename `BackgroundPage.dataUrl`. Do not change rendering code in `Canvas.tsx` (`WorksheetPageNode`, `computedBackgroundPages`) or `batchPdfExport.ts`.
- **R4.** The asset route is `/api/assets/:hash`. **Never use `/assets/`**: Vite's production build serves its JS/CSS chunks from `dist/assets/`, and the two would collide.
- **R5.** No new npm dependencies. Use `node:sqlite`, not `better-sqlite3` (it needs a native build).
- **R6.** Do not touch unrelated code (breakout logic, timer behaviour, moderation, chat UI, ink rendering).
- **R7.** Commit after each phase with a message like `feat(storage): phase N – <summary>`.

### 0.5 Files you will touch

| File | Phase | What changes |
|---|---|---|
| `roomStore.ts` (**new**, repo root next to `server.ts`) | 1 | SQLite store + asset helpers |
| `tests/roomStore.test.ts` (**new**) | 1 | Unit tests for the store |
| `server.ts` | 2–3 | Store wiring, asset route, lazy load (incl. lobby `check-room`), dirty-room flush, housekeeping, interning, legacy migration |
| `tests/server.test.ts` | 4 | Update two file-path assertions, add storage tests |
| `src/types.ts` | 5 | `RoomSnapshot` v2 (`assets` map), doc comment on `BackgroundPage.dataUrl` |
| `src/components/Canvas.tsx` | 5 | Export embeds assets; import passes `assets` through |
| `src/components/CanvasModals.tsx` | 5 | One optional field on `PendingSnapshotData` |
| `src/App.tsx` | 5 | `handleTeacherImportRoom` forwards `assets` |
| `package.json`, `README.md` | 6 | `engines.node`, short storage note |

### 0.6 Baseline

Before you start, install **all** dependencies, including devDependencies such as `@playwright/test`
(`npm run lint` typechecks `playwright.config.ts` and `e2e/` too):

```bash
npm ci
```

```bash
npx playwright install chromium
```

Then run `npm run lint && npm test`. At the time of writing, both pass
(**64 tests**). If they don't pass, stop and report.

**Pre-validation:** Phases 1–3 of this plan were applied verbatim to a scratch copy of the
repo before it was handed off. Result: `tsc --noEmit` is clean, all 64 existing tests plus the
6 Phase 1 tests pass, and tests S3 (breakout copies share one asset; asset route 200/404) and
S7 (lobby sees an unloaded room) pass. The other S-tests and Phase 5 (client) were **not** pre-run. You need Node **≥ 22.13** (the repo
was checked on 22.23). `node:sqlite` prints a one-line `ExperimentalWarning` on start.
That is expected (newer Node versions may not print it). Do not try to suppress it.

---

## Phase 1: The store module (`roomStore.ts`, new file at repo root)

Create `roomStore.ts` **exactly** as below. (This file was tested before the plan was
written: the Phase 1 tests pass and `tsc --noEmit` is clean on `@types/node` 22.19.)

```ts
/**
 * roomStore.ts — SQLite persistence for AllAboard rooms + content-addressed worksheet assets.
 *
 * - One row per room (`rooms.state` is that room's JSON). Saving room A never touches room B.
 * - Worksheet page images are stored ONCE in `assets`, keyed by sha256 of their bytes.
 *   Room JSON only holds `/api/assets/<hash>` URLs (in `BackgroundPage.dataUrl`).
 * - `room_assets` records which rooms reference which assets, so unreferenced assets can be GC'd.
 *
 * Uses the built-in `node:sqlite` module (Node >= 22.13). All calls are synchronous and fast.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ASSET_URL_PREFIX = '/api/assets/';
const ASSET_URL_RE = /\/api\/assets\/([a-f0-9]{64})/g;
const HASH_RE = /^[a-f0-9]{64}$/;
const DATA_URL_RE = /^data:([a-z0-9.+\/-]+);base64,/i;

export function assetUrl(hash: string): string {
  return `${ASSET_URL_PREFIX}${hash}`;
}

export function isValidAssetHash(hash: string): boolean {
  return HASH_RE.test(hash);
}

export interface StoredRoomRow<T> {
  state: T;
  lastActiveAt: number;
}

export class RoomStore {
  private db: DatabaseSync;
  private q: {
    getRoom: StatementSync;
    upsertRoom: StatementSync;
    deleteRoom: StatementSync;
    deleteRoomAssets: StatementSync;
    insertRoomAsset: StatementSync;
    expiredRoomIds: StatementSync;
    putAsset: StatementSync;
    getAsset: StatementSync;
    gcAssets: StatementSync;
    countAssets: StatementSync;
  };

  constructor(dbFile: string) {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    this.db = new DatabaseSync(dbFile);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS rooms (
        id          TEXT PRIMARY KEY,
        state       TEXT NOT NULL,
        last_active INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS rooms_last_active ON rooms(last_active);

      CREATE TABLE IF NOT EXISTS assets (
        hash       TEXT PRIMARY KEY,
        mime       TEXT NOT NULL,
        bytes      BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS room_assets (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        hash    TEXT NOT NULL,
        PRIMARY KEY (room_id, hash)
      );
      CREATE INDEX IF NOT EXISTS room_assets_hash ON room_assets(hash);
    `);

    this.q = {
      getRoom: this.db.prepare('SELECT state, last_active FROM rooms WHERE id = ?'),
      upsertRoom: this.db.prepare(
        `INSERT INTO rooms (id, state, last_active) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, last_active = excluded.last_active`
      ),
      deleteRoom: this.db.prepare('DELETE FROM rooms WHERE id = ?'),
      deleteRoomAssets: this.db.prepare('DELETE FROM room_assets WHERE room_id = ?'),
      insertRoomAsset: this.db.prepare('INSERT OR IGNORE INTO room_assets (room_id, hash) VALUES (?, ?)'),
      expiredRoomIds: this.db.prepare('SELECT id FROM rooms WHERE last_active < ?'),
      putAsset: this.db.prepare(
        'INSERT OR IGNORE INTO assets (hash, mime, bytes, created_at) VALUES (?, ?, ?, ?)'
      ),
      getAsset: this.db.prepare('SELECT mime, bytes FROM assets WHERE hash = ?'),
      gcAssets: this.db.prepare(
        `DELETE FROM assets
         WHERE created_at < ?
           AND NOT EXISTS (SELECT 1 FROM room_assets ra WHERE ra.hash = assets.hash)`
      ),
      countAssets: this.db.prepare('SELECT COUNT(*) AS n FROM assets'),
    };
  }

  // ---------- rooms ----------

  loadRoom<T>(roomId: string): StoredRoomRow<T> | null {
    const row = this.q.getRoom.get(roomId) as { state: string; last_active: number } | undefined;
    if (!row) return null;
    try {
      return { state: JSON.parse(row.state) as T, lastActiveAt: row.last_active };
    } catch (err) {
      console.error(`Corrupt room row "${roomId}", ignoring:`, err);
      return null;
    }
  }

  /** Writes ONE room. Also records which assets that room references. */
  saveRoom(roomId: string, state: unknown, lastActiveAt: number): void {
    const json = JSON.stringify(state);
    const hashes = new Set<string>();
    for (const m of json.matchAll(ASSET_URL_RE)) hashes.add(m[1]);

    this.db.exec('BEGIN');
    try {
      this.q.upsertRoom.run(roomId, json, lastActiveAt);
      this.q.deleteRoomAssets.run(roomId);
      for (const h of hashes) this.q.insertRoomAsset.run(roomId, h);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  deleteRoom(roomId: string): void {
    this.q.deleteRoom.run(roomId); // room_assets rows cascade
  }

  /** Deletes rooms inactive since before `cutoff`. Returns their IDs. */
  deleteRoomsInactiveBefore(cutoff: number): string[] {
    const ids = (this.q.expiredRoomIds.all(cutoff) as Array<{ id: string }>).map((r) => r.id);
    for (const id of ids) this.q.deleteRoom.run(id);
    return ids;
  }

  // ---------- assets ----------

  /** Stores bytes once (dedup by sha256). Returns the hash. */
  putAsset(bytes: Uint8Array, mime: string): string {
    const hash = createHash('sha256').update(bytes).digest('hex');
    this.q.putAsset.run(hash, mime, bytes, Date.now());
    return hash;
  }

  /** If `value` is a base64 data: URL, stores it and returns its asset URL. Otherwise returns `value` unchanged. */
  internDataUrl(value: string): string {
    if (typeof value !== 'string') return value;
    const m = DATA_URL_RE.exec(value);
    if (!m) return value;
    const bytes = Buffer.from(value.slice(m[0].length), 'base64');
    if (bytes.length === 0) return value;
    return assetUrl(this.putAsset(bytes, m[1].toLowerCase()));
  }

  getAsset(hash: string): { mime: string; bytes: Uint8Array } | null {
    if (!isValidAssetHash(hash)) return null;
    const row = this.q.getAsset.get(hash) as { mime: string; bytes: Uint8Array } | undefined;
    return row ? { mime: row.mime, bytes: row.bytes } : null;
  }

  /**
   * Deletes assets no room references. `graceMs` protects assets that were just uploaded
   * but whose room has not been flushed yet (default 1 hour).
   */
  gcAssets(graceMs = 60 * 60 * 1000): number {
    const res = this.q.gcAssets.run(Date.now() - graceMs);
    return Number(res.changes);
  }

  countAssets(): number {
    return Number((this.q.countAssets.get() as { n: number }).n);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

/**
 * Returns a deep copy of `bg` where every `pages[i].dataUrl` that is a base64 data: URL
 * has been replaced with an `/api/assets/<hash>` URL. Safe to call on null / already-interned backgrounds.
 */
export function internBackground<T>(store: RoomStore, bg: T): T {
  if (!bg || typeof bg !== 'object') return bg;
  const copy: any = JSON.parse(JSON.stringify(bg));
  if (Array.isArray(copy.pages)) {
    for (const page of copy.pages) {
      if (page && typeof page.dataUrl === 'string') {
        page.dataUrl = store.internDataUrl(page.dataUrl);
      }
    }
  }
  return copy as T;
}
```

### 1.1 Unit tests: create `tests/roomStore.test.ts`

```ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RoomStore, internBackground, assetUrl } from '../roomStore.ts';

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function bg(dataUrl: string) {
  return { id: 'bg1', fileName: 'w.pdf', pages: [{ dataUrl, width: 1, height: 1 }], x: 0, y: 0, scale: 1, layout: 'stack', opacity: 1 };
}

describe('RoomStore', () => {
  let dir: string;
  let store: RoomStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomstore-'));
    store = new RoomStore(path.join(dir, 'allaboard.db'));
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('dedupes identical worksheet pages into one asset', () => {
    const a = internBackground(store, bg(PNG_1PX));
    const b = internBackground(store, bg(PNG_1PX));
    assert.match(a.pages[0].dataUrl, /^\/api\/assets\/[a-f0-9]{64}$/);
    assert.equal(a.pages[0].dataUrl, b.pages[0].dataUrl);
    assert.equal(store.countAssets(), 1);
    const hash = a.pages[0].dataUrl.split('/').pop()!;
    const asset = store.getAsset(hash)!;
    assert.equal(asset.mime, 'image/png');
    assert.ok(asset.bytes.length > 0);
  });

  it('leaves already-interned and null backgrounds alone', () => {
    const a = internBackground(store, bg(PNG_1PX));
    assert.deepEqual(internBackground(store, a), a);
    assert.equal(internBackground(store, null), null);
  });

  it('round-trips a room and isolates rooms', () => {
    store.saveRoom('a', { id: 'a', elements: [1] }, 100);
    store.saveRoom('b', { id: 'b', elements: [2] }, 200);
    assert.deepEqual(store.loadRoom('a'), { state: { id: 'a', elements: [1] }, lastActiveAt: 100 });
    store.saveRoom('a', { id: 'a', elements: [1, 3] }, 150);
    assert.deepEqual(store.loadRoom('b')!.state, { id: 'b', elements: [2] });
    assert.equal(store.loadRoom('missing'), null);
  });

  it('garbage-collects assets no room references', () => {
    const page = internBackground(store, bg(PNG_1PX));
    store.saveRoom('a', { id: 'a', background: page }, Date.now());
    assert.equal(store.gcAssets(0), 0); // still referenced
    store.saveRoom('a', { id: 'a', background: null }, Date.now());
    assert.equal(store.gcAssets(60_000), 0); // inside grace period
    assert.equal(store.gcAssets(-1), 1);
    assert.equal(store.countAssets(), 0);
  });

  it('cascade-deletes asset refs with expired rooms', () => {
    const page = internBackground(store, bg(PNG_1PX));
    store.saveRoom('old', { id: 'old', background: page }, 10);
    store.saveRoom('new', { id: 'new' }, Date.now());
    assert.deepEqual(store.deleteRoomsInactiveBefore(1000), ['old']);
    assert.equal(store.loadRoom('old'), null);
    assert.equal(store.gcAssets(-1), 1);
  });

  it('assetUrl is the expected shape', () => {
    assert.equal(assetUrl('a'.repeat(64)), '/api/assets/' + 'a'.repeat(64));
  });
});
```

**Checkpoint 1:** `npm run lint && npm test` → 70 tests pass (64 + 6).

---

## Phase 2: Wire the store into `server.ts` (setup only)

### 2.1 Imports (top of file, after the `breakoutRounds.ts` import)

```ts
import { RoomStore, internBackground, isValidAssetHash } from './roomStore.ts';
```

### 2.2 Constants (next to `ROOM_TTL_MS`, ~line 29)

```ts
const IDLE_UNLOAD_MS = 15 * 60 * 1000; // unload rooms from RAM after 15 min with no sockets
const HOUSEKEEPING_INTERVAL_MS = 5 * 60 * 1000;
```

### 2.3 In `startServer`, replace the `storeFile` line (~line 110)

Remove:
```ts
  const storeFile = path.join(dataDir, 'rooms-store.json');
```
Add:
```ts
  const legacyStoreFile = path.join(dataDir, 'rooms-store.json');
  const store = new RoomStore(path.join(dataDir, 'allaboard.db'));
```

### 2.4 Asset route (directly after the `/healthz` route, ~line 125)

It **must** be registered before the Vite middleware / `express.static` block near the
bottom of `startServer`. Putting it next to `/healthz` guarantees that.

```ts
  app.get('/api/assets/:hash', (req, res) => {
    const hash = req.params.hash;
    const asset = isValidAssetHash(hash) ? store.getAsset(hash) : null;
    if (!asset) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', asset.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(Buffer.from(asset.bytes));
  });
```

### 2.5 Return the store (the `return { … }` at the end of `startServer`)

Add `store,` to the returned object so tests can inspect it.

**Checkpoint 2:** `npm run lint && npm test` → 70 pass. (Nothing uses the store yet except the route.)

---

## Phase 3: Replace the JSON persistence in `server.ts`

### 3.1 Delete these

Delete all of them. Each one is replaced below.

- `let saveTimeout: NodeJS.Timeout | null = null;` (~line 129). It is re-declared in 3.6.
- `function loadRoomsFromDisk() { … }` (~line 160–207)
- `let isSavingAsync`, `let saveQueuedAsync`, `let activeSavePromise` (~line 209–211)
- `function buildSerializedRoomsPayload() { … }` (~line 213–257)
- `function flushRoomsToDisk() { … }`, `async function flushRoomsToDiskAsync() { … }`, `function scheduleSaveToDisk(…) { … }` (~line 259–319)
- `loadRoomsFromDisk();` and the `hourlyFlushInterval` block (~line 321–325)

### 3.2 `hydrateRoom`: the old per-item body of `loadRoomsFromDisk`, as a function

Put this where `loadRoomsFromDisk` was. The object it builds is **identical** to what
`loadRoomsFromDisk` built. Only the wrapper changed.

```ts
  /** SerializedRoom → in-memory RoomState. Returns null if missing/expired. */
  function hydrateRoom(item: SerializedRoom, now = Date.now()): RoomState | null {
    if (!item || !item.id) return null;
    const lastActive = item.lastActiveAt || now;
    if (now - lastActive > ROOM_TTL_MS) return null;

    const subBoards = deserializeSubBoards(item.subBoards);
    const breakoutConfig = normalizeBreakoutConfig(item.breakoutConfig);
    migrateLegacyBreakout(subBoards, breakoutConfig);
    return {
      id: item.id,
      messages: Array.isArray(item.messages) ? item.messages : [],
      elements: Array.isArray(item.elements) ? item.elements : [],
      background: item.background || null,
      subBoards,
      breakoutConfig,
      roundTemplates: item.roundTemplates && typeof item.roundTemplates === 'object' ? item.roundTemplates : {},
      timer: item.timer || {
        isRunning: false,
        durationMs: 5 * 60 * 1000,
        remainingMs: 0,
        endsAt: null,
        autoLockOnExpire: false,
      },
      usersByUserId: new Map(),
      lockedNames: item.lockedNames && typeof item.lockedNames === 'object' ? item.lockedNames : {},
      bannedUsers: item.bannedUsers && typeof item.bannedUsers === 'object' ? item.bannedUsers : {},
      isCanvasLocked: Boolean(item.isCanvasLocked),
      teacherPin: item.teacherPin || null,
      lastActiveAt: lastActive,
    };
  }
```

### 3.3 Small helpers (directly below `hydrateRoom`)

`serializeRoom` is the old `serialized.push({…})` object. `isRoomEmpty` is the **negation**
of the old `if (room.elements.length > 0 || …)` condition. Keep both exactly equivalent.

```ts
  function serializeRoom(room: RoomState): SerializedRoom {
    return {
      id: room.id,
      messages: room.messages,
      elements: room.elements,
      background: room.background,
      subBoards: serializeSubBoards(room.subBoards),
      breakoutConfig: room.breakoutConfig,
      roundTemplates: room.roundTemplates,
      timer: room.timer,
      lockedNames: room.lockedNames,
      bannedUsers: room.bannedUsers,
      isCanvasLocked: room.isCanvasLocked,
      teacherPin: room.teacherPin,
      lastActiveAt: room.lastActiveAt,
    };
  }

  function isRoomEmpty(room: RoomState): boolean {
    return (
      room.elements.length === 0 &&
      room.messages.length === 0 &&
      room.background === null &&
      room.subBoards.size === 0 &&
      room.teacherPin === null &&
      Object.keys(room.lockedNames).length === 0 &&
      Object.keys(room.bannedUsers).length === 0
    );
  }

  function roomHasActiveSockets(room: RoomState): boolean {
    for (const u of room.usersByUserId.values()) {
      if (u.sockets.size > 0) return true;
    }
    return false;
  }

  /** Safety net: converts any remaining base64 worksheet pages in a room to asset URLs. */
  function internRoomAssets(room: RoomState) {
    room.background = internBackground(store, room.background);
    for (const sb of room.subBoards.values()) {
      sb.background = internBackground(store, sb.background);
    }
    for (const key of Object.keys(room.roundTemplates)) {
      room.roundTemplates[key] = internBackground(store, room.roundTemplates[key]);
    }
  }
```

### 3.4 One-time legacy migration (below the helpers)

```ts
  /** Imports an old rooms-store.json (if present) into SQLite, then renames it. */
  function migrateLegacyJsonStore() {
    if (!fs.existsSync(legacyStoreFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(legacyStoreFile, 'utf-8'));
      let migrated = 0;
      if (parsed && Array.isArray(parsed.rooms)) {
        for (const item of parsed.rooms as SerializedRoom[]) {
          const room = hydrateRoom(item);
          if (!room) continue;
          internRoomAssets(room);
          store.saveRoom(room.id, serializeRoom(room), room.lastActiveAt);
          migrated++;
        }
      }
      fs.renameSync(legacyStoreFile, `${legacyStoreFile}.migrated-${Date.now()}`);
      console.log(`Migrated ${migrated} room(s) from rooms-store.json into SQLite.`);
    } catch (err) {
      console.error('Failed to migrate rooms-store.json (left in place):', err);
    }
  }
```

### 3.5 Lazy loading: `findRoom`, `getOrCreateRoom`, `getRoomAvailability`

Add this helper directly **above** `getOrCreateRoom` (~line 337):

```ts
  /** In-memory room, else hydrate it from SQLite (and cache it). Never creates a new room. */
  function findRoom(roomId: string): RoomState | null {
    const inMemory = rooms.get(roomId);
    if (inMemory) return inMemory;
    const stored = store.loadRoom<SerializedRoom>(roomId);
    if (!stored) return null;
    const restored = hydrateRoom({ ...stored.state, id: roomId, lastActiveAt: stored.lastActiveAt });
    if (!restored) {
      store.deleteRoom(roomId); // expired
      return null;
    }
    rooms.set(roomId, restored);
    return restored;
  }
```

In `getOrCreateRoom`, change the one line
```ts
    let room = rooms.get(roomId);
```
to
```ts
    let room = findRoom(roomId);
```
Leave the rest (the `if (!room) { … new room … }` block) unchanged.

In `getRoomAvailability` (~line 508, used by the lobby's `check-room` event), change
```ts
    const room = rooms.get(normalizedId);
```
to
```ts
    const room = findRoom(normalizedId);
```
**This one matters.** Without it, a saved room that has been unloaded from RAM reports
`exists: false` in the lobby, and the "room already exists" confirmation never shows.

Every other `rooms.get(meta.roomId)` in socket handlers stays as is. Those run only after
`join-room`, which already loaded the room through `getOrCreateRoom`.

### 3.6 Dirty-room flush (put these where the old flush functions were)

```ts
  const dirtyRooms = new Set<string>();
  let saveTimeout: NodeJS.Timeout | null = null;

  /** Writes ONLY rooms that changed since the last flush. Synchronous (node:sqlite is sync). */
  function flushRoomsToDisk() {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
    for (const roomId of [...dirtyRooms]) {
      dirtyRooms.delete(roomId);
      const room = rooms.get(roomId);
      if (!room) continue;
      try {
        if (isRoomEmpty(room)) {
          store.deleteRoom(roomId);
          continue;
        }
        internRoomAssets(room);
        store.saveRoom(roomId, serializeRoom(room), room.lastActiveAt);
      } catch (err) {
        dirtyRooms.add(roomId); // retry on next flush
        console.error(`Failed to save room "${roomId}":`, err);
      }
    }
  }

  /** Kept for the test suite / callers that await it. */
  async function flushRoomsToDiskAsync(): Promise<void> {
    flushRoomsToDisk();
  }

  function scheduleSaveToDisk(room: RoomState, immediate = false) {
    dirtyRooms.add(room.id);
    if (immediate) {
      flushRoomsToDisk();
      return;
    }
    if (saveTimeout) return;
    saveTimeout = setTimeout(flushRoomsToDisk, 2000);
  }

  /** Every 5 min: flush, unload idle rooms from RAM, expire old rooms, GC unreferenced assets. */
  function runHousekeeping() {
    flushRoomsToDisk();
    const now = Date.now();
    for (const [roomId, room] of rooms) {
      if (dirtyRooms.has(roomId) || roomHasActiveSockets(room)) continue;
      if (now - room.lastActiveAt > IDLE_UNLOAD_MS) rooms.delete(roomId);
    }
    try {
      store.deleteRoomsInactiveBefore(now - ROOM_TTL_MS);
      store.gcAssets();
    } catch (err) {
      console.error('Housekeeping failed:', err);
    }
  }

  migrateLegacyJsonStore();
  const housekeepingInterval = setInterval(runHousekeeping, HOUSEKEEPING_INTERVAL_MS);
  housekeepingInterval.unref();
```

### 3.7 Update every `scheduleSaveToDisk` call site

There are about 30. Each handler already has a `room` variable in scope. Mechanically:

- `scheduleSaveToDisk();` → `scheduleSaveToDisk(room);`
- `scheduleSaveToDisk(true);` → `scheduleSaveToDisk(room, true);`

Verify with:
```bash
grep -nE "scheduleSaveToDisk\((true)?\)" server.ts
```
It must print **nothing**. `npm run lint` will also flag any call you missed.

### 3.8 Interning at entry points

**`cloneBackground` (~line 436).** Replace the body:
```ts
  function cloneBackground(bg: any | null | undefined): any | null {
    return bg ? internBackground(store, bg) : null; // internBackground returns a deep copy
  }
```
`store` is created at the top of `startServer` (2.3), before any handler can call this.

**`teacher:set-background` (~line 844).** Replace:
```ts
      const bgData = payload && 'background' in payload ? payload.background : payload;
```
with:
```ts
      const bgData = internBackground(store, payload && 'background' in payload ? payload.background : payload);
```

**`teacher:update-background` (~line 863).** Replace the two merges:
```ts
        room.background = { ...room.background, ...patch };
```
→
```ts
        room.background = internBackground(store, { ...room.background, ...patch });
```
and
```ts
        sb.background = { ...sb.background, ...patch };
```
→
```ts
        sb.background = internBackground(store, { ...sb.background, ...patch });
```

### 3.9 `teacher:import-room` (~line 889)

1. Add `assets: importedAssets,` to the destructured payload (next to `mode,`).
2. Directly after the teacher-permission check (the `if (!callerRecord?.isTeacher) {…}` block), add:
   ```ts
        // v2 snapshots carry each worksheet image once, keyed by its /api/assets/<hash> URL.
        // The hash is derived from the bytes, so re-storing them recreates the same URL.
        if (importedAssets && typeof importedAssets === 'object') {
          for (const dataUrl of Object.values(importedAssets)) {
            if (typeof dataUrl === 'string') store.internDataUrl(dataUrl);
          }
        }
   ```
3. Directly after the existing `migrateLegacyBreakout(room.subBoards, room.breakoutConfig);`
   line (just before `room.lastActiveAt = Date.now();`), add:
   ```ts
        internRoomAssets(room); // v1 snapshots still contain inline base64 pages
   ```

### 3.10 Shutdown and `close()`

**`handleShutdown`.** Keep the existing `flushRoomsToDisk();` call. No other change.

**`close()`.**
- Replace `clearInterval(hourlyFlushInterval);` with `clearInterval(housekeepingInterval);`.
- Replace the final block:
  ```ts
    if (activeSavePromise) {
      await activeSavePromise;
    }
  ```
  with:
  ```ts
    flushRoomsToDisk();
    store.close();
  ```

### 3.11 Leave `maxHttpBufferSize` alone

Uploads still travel over the socket as base64 (one copy, interned on arrival), and v1
imports can be large. Keep `maxHttpBufferSize: 3e7`. Moving uploads to an HTTP POST is out
of scope (Appendix B).

**Checkpoint 3:** `npm run lint` passes. `npm test`: expect the two file-path assertions
in Phase 4.1 to fail and **everything else to pass**. If anything else fails, stop and report.

---

## Phase 4: Server tests (`tests/server.test.ts`)

### 4.1 Fix the existing tests

- In the "persist" test (~line 415), change
  `assert.equal(fs.existsSync(path.join(tmpDir, 'rooms-store.json')), true);`
  to
  `assert.equal(fs.existsSync(path.join(tmpDir, 'allaboard.db')), true);`
- **T6 (legacy migration, ~line 746)** should pass unchanged. It writes `rooms-store.json`
  and the restart migrates it. Add one assertion at the end of T6:
  ```ts
      assert.equal(fs.existsSync(path.join(tmpDir, 'rooms-store.json')), false);
  ```

### 4.2 New `describe('storage: SQLite + worksheet assets', …)` block

Use the file's existing helpers (`joinTracked`, `emitAck`, `waitForEvent`, `srv`, `tmpDir`).
Put a 1×1 PNG constant at the top of the block:

```ts
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const worksheet = () => ({
  id: 'ws1', fileName: 'w.png', pages: [{ dataUrl: PNG_1PX, width: 1, height: 1 }],
  x: 0, y: 0, scale: 1, layout: 'stack', opacity: 1,
});
```

Write these tests:

- **S1 – set-background stores one asset and broadcasts a URL.** The teacher joins with a PIN
  and emits `teacher:set-background` `{ boardId: 'main', background: worksheet() }`. Assert
  the `background-sync` payload's `pages[0].dataUrl` matches `/^\/api\/assets\/[a-f0-9]{64}$/`.
  `fetch(\`http://127.0.0.1:${srv.port}${url}\`)` returns 200, `content-type` is `image/png`,
  and `cache-control` contains `immutable`.
- **S2 – unknown / malformed asset hashes 404.** `GET /api/assets/` + `'0'.repeat(64)` → 404.
  `GET /api/assets/not-a-hash` → 404.
- **S3 – breakout copies share one asset.** Teacher plus 3 students. Set the main worksheet,
  then `teacher:configure-breakout` with `action: 'new-round'`, `mode: 'individual'`,
  `copyWorksheet: true` (copy the payload shape from the existing multi-round tests). Wait for
  `breakout-sync`. Assert every sub-board's `background.pages[0].dataUrl` is the **same**
  `/api/assets/…` string and `srv.store.countAssets() === 1`.
- **S4 – only dirty rooms are written.** Join room `iso-a` and room `iso-b`, and draw in both.
  Call `await srv.flushRoomsToDiskAsync()`. Then wrap the store method:
  ```ts
  const saved: string[] = [];
  const orig = srv.store.saveRoom.bind(srv.store);
  srv.store.saveRoom = (id: string, state: unknown, t: number) => { saved.push(id); orig(id, state, t); };
  ```
  Draw once more in `iso-a` only (wait for the peer's `element-start`), flush again, and assert
  `deepEqual(saved, ['iso-a'])`.
- **S5 – legacy base64 is interned on migration.** Same pattern as T6: close `srv`, write
  `rooms-store.json` with one room whose `background` is `worksheet()` and `teacherPin: '1234'`,
  then restart. Join that room and assert `init.background.pages[0].dataUrl` starts with
  `/api/assets/`.
- **S6 – v2 import with an `assets` map.** Set a background so an asset exists and capture its
  URL `u`. Use a fresh server or a different room. Emit `teacher:import-room` with `mode: 'replace'`,
  `elements: []`, `messages: []`, `background: { ...worksheet(), pages: [{ dataUrl: u, width: 1, height: 1 }] }`,
  `assets: { [u]: PNG_1PX }`. Assert `ok: true`, `room-restored`'s `background.pages[0].dataUrl === u`,
  and `GET u` → 200.
- **S7 – the lobby sees a saved room that is not in memory.** Teacher joins `lobby-room` and
  runs `emitAck(teacher, 'teacher:auth', { pin: '4242' })` (the PIN is set by `teacher:auth`,
  **not** by `join-room`). Then `await srv.flushRoomsToDiskAsync()`, disconnect, `await srv.close()`,
  and restart on the same `tmpDir`. A probe socket joins a *different* room and emits `check-room`
  `{ roomId: 'lobby-room' }`. Assert `exists === true` and `hasTeacherPin === true`.

**Checkpoint 4:** `npm run lint && npm test` → all pass (70 + 7 = 77).

---

## Phase 5: Client: portable exports

Rendering needs no change (R3). Exports do, because a `.json` snapshot full of
`/api/assets/…` URLs would break once the room expires or on another server. So v2
snapshots embed each image **once** in a top-level `assets` map.

### 5.1 `src/types.ts`

On `BackgroundPage`, add a doc comment above `dataUrl`:
```ts
  /** Either a base64 `data:` URL (fresh upload / old snapshot) or a server asset URL `/api/assets/<sha256>`. */
  dataUrl: string;
```
On `RoomSnapshot`, change `version: 1;` to `version: 1 | 2;` and add:
```ts
  /** v2+: worksheet images, keyed by their `/api/assets/<hash>` URL, value = base64 data URL. */
  assets?: Record<string, string>;
```

### 5.2 `src/components/Canvas.tsx`: export (`handleExportJSON`, ~line 1958)

Add this module-level helper above the `Canvas` component (next to the other top-level helpers):
```ts
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
```
Make `handleExportJSON` `async`. Before building `snapshot`, collect and embed the assets:
```ts
    const assetUrls = new Set<string>();
    const collect = (bg?: RoomBackground | null) => {
      for (const p of bg?.pages || []) {
        if (typeof p.dataUrl === 'string' && p.dataUrl.startsWith('/api/assets/')) assetUrls.add(p.dataUrl);
      }
    };
    collect(fullMainBackground);
    for (const sb of Object.values(subBoards || {})) collect(sb?.background);

    const assets: Record<string, string> = {};
    for (const url of assetUrls) {
      try {
        assets[url] = await blobToDataUrl(await (await fetch(url)).blob());
      } catch (err) {
        console.error('Could not embed worksheet asset in export:', url, err);
      }
    }
```
In the `snapshot` object, set `version: 2,` and add `assets,`. Leave the rest of the function
unchanged. `onClick={handleExportJSON}` (~line 3839) needs no change.

### 5.3 `src/components/Canvas.tsx`: import passes `assets` through

Add `assets?: Record<string, string>;` to each of these:
1. The `onTeacherImportRoom` prop's `snapshot` type (~line 160).
2. The `pendingSnapshot` `useState<{…}>` type (~line 878).

Then:
3. In the file reader's success `setPendingSnapshot({…})` (~line 2024), add
   `assets: parsed.assets && typeof parsed.assets === 'object' ? parsed.assets : undefined,`.
4. In `handleConfirmImport`'s `onTeacherImportRoom({…})` call (~line 2055), add
   `assets: pendingSnapshot.assets,`.

### 5.4 `src/components/CanvasModals.tsx`

Add `assets?: Record<string, string>;` to `PendingSnapshotData` (~line 23).

### 5.5 `src/App.tsx`: `handleTeacherImportRoom` (~line 884)

Add `assets?: Record<string, string>;` to the `snapshot` parameter type, and add
`assets: snapshot.assets,` to the `teacher:import-room` emit payload.

**Checkpoint 5:** `npm run lint && npm test` → all pass. `npm run test:e2e` → passes. Then do
a manual smoke test with `npm run dev`:
1. Upload a PDF worksheet. In DevTools → Network, the page images load from `/api/assets/…`.
2. Launch an individual breakout with "copy worksheet". The `breakout-sync` frame in
   Network → WS is a few KB, not megabytes.
3. Export the room as JSON, start a new room, and import it. The worksheet appears.
4. Import an **old** (v1) export. The worksheet appears.

---

## Phase 6: Housekeeping

1. `package.json`: add `"engines": { "node": ">=22.13" }`.
2. `README.md`: add a short "Storage" section. State is in `$DATA_DIR/allaboard.db` (SQLite,
   WAL mode, so also `-wal`/`-shm` files). Back it up by copying the `.db` while the server is
   stopped. An old `rooms-store.json` is migrated automatically on first start and renamed
   `rooms-store.json.migrated-<timestamp>`. Production needs a **persistent** `DATA_DIR`
   (a mounted volume). Running more than one server process against the same DB is not supported.
3. Final greps. **Each must print nothing:**
   ```bash
   grep -nE "scheduleSaveToDisk\((true)?\)" server.ts
   ```
   ```bash
   grep -nE "buildSerializedRoomsPayload|loadRoomsFromDisk|activeSavePromise|hourlyFlushInterval" server.ts
   ```
   ```bash
   grep -n "'/assets/" server.ts
   ```

**Checkpoint 6:** `npm run lint && npm test && npm run test:e2e` all pass.

---

## Appendix A: Decisions (do not revisit)

| Decision | Why |
|---|---|
| **SQLite over one-JSON-file-per-room** | Same isolation per room, plus atomic transactions (no tmp-file + rename dance), indexed TTL cleanup, one file to back up, and a natural home for the asset table. |
| **`node:sqlite`, not `better-sqlite3`** | Built into Node 22, so there's no native compile step and nothing extra to install on the host. |
| **One row per room (JSON snapshot), not one row per stroke** | `element-append-points` fires constantly. Per-stroke rows mean a DB write per point batch and re-implementing undo/clear/batch ops in SQL. The real cost was the blobs and the all-rooms flush, not stroke serialization. Without blobs, a room is ~50–300 KB and stringifies in about a millisecond. |
| **Assets in SQLite (BLOB), not loose files** | One file, transactional with the `room_assets` refs, trivial GC query. A few MB per blob is well within SQLite's comfort zone. |
| **Content addressing (sha256)** | The same worksheet copied to 30 boards, or uploaded twice, is stored once. The URL never changes for given bytes, so `immutable` caching is safe, and re-importing an export recreates identical URLs with no rewriting. |
| **Keep the field name `dataUrl`** | Zero rendering changes. `<img src>`, Konva and `batchPdfExport`'s `loadImage` accept a same-origin URL exactly like a data URL. |
| **`/api/assets/`, not `/assets/`** | `/assets/` collides with Vite's built chunk directory. |
| **Room-asset refs derived by regex over the room JSON** | The JSON is already being stringified for the save. Scanning it catches every reference (backgrounds, round templates, future image elements) without a hand-maintained walker. |
| **1-hour GC grace period** | An asset is stored the moment it arrives, but its room row is written up to 2 s later (or never, if the room is empty). The grace period stops GC racing a fresh upload. |
| **Sync flush** | `node:sqlite` is synchronous, and with blobs gone each room write is sub-millisecond, so async bookkeeping (`isSavingAsync`, `saveQueuedAsync`, …) is pure complexity. |

## Appendix B: Explicitly out of scope (later, if ever)

- Uploading worksheets via HTTP `POST /api/assets` instead of base64-over-socket. That would let
  `maxHttpBufferSize` drop to ~1 MB.
- Append-only op log per room with periodic compaction (only if per-room snapshots ever get slow).
- Multi-process / horizontal scaling (would need Postgres + a Socket.IO adapter).
- Exporting/importing `roundTemplates`.
