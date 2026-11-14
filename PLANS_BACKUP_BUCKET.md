# AllAboard — Backup Bucket: Make Rooms Survive Cold Starts and Redeploys

> **Who this is for:** an implementing agent (Codex / Terra / anyone) for Phases 1–3, and the
> **human** (Bryan) for Phase 4, which happens in the Google Cloud console.
> **How to use it:** Do the phases **in order**. Each phase lists exact files and code to paste
> and ends with a **checkpoint**. Do not start the next phase until its checkpoint passes. The
> design is decided (Appendix A). Do not redesign anything. If the code does not match this
> plan, stop and report it.

---

## 0. Read this first

### 0.1 The problem in one paragraph

The app runs on Cloud Run with **min instances = 0**, **max instances = 1**, and no volumes.
Cloud Run's local disk lives in memory and is wiped on every cold start (after ~15 min idle)
and every redeploy, so `allaboard.db` (and the old `rooms-store.json` before it) never
survives. We add a durable copy in a Cloud Storage bucket and restore from it at startup.
(Boot-time crashes from an unusable data dir were already fixed on `main` in `d815c59`:
`RoomStore` now falls back to a temp dir by itself. Do not touch that.)

### 0.2 Mental model (memorize these 6 facts)

1. **SQLite stays the working copy** on local disk. Nothing about how rooms are read or
   written during a class changes.
2. A new module, `backupMirror.ts`, copies rooms and worksheet images as **plain files** into
   `BACKUP_DIR`. In production that is a **Cloud Storage bucket mounted as a Cloud Run volume**
   (Phase 4). There is no SDK and no credentials code; Cloud Run handles bucket access.
3. Layout: `BACKUP_DIR/rooms/<roomId>.json.gz` (one gzipped file per room) and
   `BACKUP_DIR/assets/<sha256>` (one file per worksheet image, written once, never changed).
4. **Write-behind:** after a room is saved to SQLite it is queued for backup. The queue is
   written at most every **10 s**, and a room's state is read **at write time**, so the latest
   state wins. Images a room references are written **before** the room file. On SIGTERM the
   queue is flushed immediately.
5. **Restore:** at startup, `restoreFromBackup()` copies every backed-up room into SQLite
   **before** the server accepts connections. Images are restored **lazily**: the first
   `GET /api/assets/<hash>` that misses locally reads the file from the bucket.
6. An unusable or unset `BACKUP_DIR` **never crashes** the server: it logs loudly and runs
   without backups.

### 0.3 Hard rules for the implementer

- **R1.** After every phase, run `npm run lint`, `npm test`, **and the plain-node check** below.
  All three must pass before you continue.
- **R2.** No new npm dependencies. No socket protocol changes. No client (`src/`) changes.
- **R3.** Only whole-file writes into `BACKUP_DIR` (`fs.promises.writeFile` / `rm`). **No**
  appends, renames, `fs.watch`, or SQLite files in `BACKUP_DIR`: a bucket mount supports none
  of those safely.
- **R4.** Do not change `roomStore.ts` or `package.json`.
- **R5.** **Production runs `node server.ts` with type stripping.** In any `.ts` file the server
  loads, do **not** use TypeScript parameter properties (`constructor(private x: T)`), `enum`,
  `namespace`, or `import x = require(…)`. The test suite runs under `tsx` and will **not** catch
  these. Only the plain-node check does.
- **R6.** Commit after each phase with a message like `feat(backup): phase N – <summary>`.

**The plain-node check (part of every checkpoint):**
```bash
node -e "import('./server.ts').then(() => console.log('OK: loads under plain node'))"
```
It must print `OK: loads under plain node`. Production starts with `node server.ts` (Node's
built-in type stripping), which rejects some TypeScript syntax that `tsx` and the test suite accept.

### 0.4 Files you will touch

| File | Phase | What changes |
|---|---|---|
| `backupMirror.ts` (**new**, repo root) | 1 | The backup module |
| `tests/backupMirror.test.ts` (**new**) | 1 | Unit tests |
| `server.ts` | 2 | Backup wiring |
| `tests/server.test.ts` | 2 | 3 new tests |
| `README.md` | 3 | Storage section update |

### 0.5 Baseline

```bash
npm ci
```

```bash
npm run lint && npm test
```

Expect **77 tests** passing, and run the plain-node check. If anything fails, stop and report.

**Pre-validation:** This plan was applied verbatim to a scratch copy of `main` at `d815c59`
before handoff:
- `tsc --noEmit` is clean, all **87** tests pass (77 + 7 + 3), and the plain-node check passes.
- An end-to-end run under plain `node server.ts`, with `BACKUP_DIR` set, also passed:
  1. Draw a stroke.
  2. Send SIGTERM **within 10 s** of drawing it.
  3. Start a new server with a **fresh `DATA_DIR`** and the same `BACKUP_DIR`.
  4. Rejoin the room: the stroke is there.

---

## Phase 1: The backup module (`backupMirror.ts`, new file at repo root)

Create it **exactly** as below.

```ts
/**
 * backupMirror.ts — durable off-box copy of rooms + worksheet assets.
 *
 * SQLite (roomStore.ts) is the fast local working copy, but on Cloud Run the local disk is
 * wiped on every cold start and redeploy. This module writes plain files under BACKUP_DIR,
 * which in production is a Cloud Storage bucket mounted as a Cloud Run volume.
 *
 * Layout:
 *   <dir>/rooms/<roomId>.json.gz   gzipped room JSON (same shape as SerializedRoom)
 *   <dir>/assets/<sha256>          raw worksheet image bytes (immutable, written once)
 *
 * Rules that keep this safe on a bucket mount:
 *   - Only ONE server process writes (Cloud Run max instances = 1).
 *   - Every write replaces a whole file. No appends, no renames, no partial updates.
 *   - Room writes are batched (default every 10 s) so a busy room costs ~6 writes/minute.
 */
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

const ASSET_URL_RE = /\/api\/assets\/([a-f0-9]{64})/g;
const HASH_RE = /^[a-f0-9]{64}$/;

/** Returns the latest state to back up, or null if the room should be deleted from the backup. */
export type RoomStateGetter = () => { lastActiveAt?: number } | null;
/** Returns an asset's bytes from the local store, or null if it is not there. */
export type LocalAssetReader = (hash: string) => Uint8Array | null;

export interface BackedUpRoom {
  roomId: string;
  state: any;
  lastActiveAt: number;
}

/** Best-effort content type from magic bytes (worksheets are JPEG/PNG; templates may be SVG). */
export function sniffMime(bytes: Uint8Array): string {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  const head = Buffer.from(b.subarray(0, 256)).toString('utf8').trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return 'application/octet-stream';
}

function roomFileName(roomId: string): string {
  return `${encodeURIComponent(roomId)}.json.gz`;
}

export class BackupMirror {
  readonly dir: string;
  private readonly roomsDir: string;
  private readonly assetsDir: string;
  private readonly pending = new Map<string, RoomStateGetter>();
  private readonly knownAssets = new Set<string>();
  private readonly readLocalAsset: LocalAssetReader;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  // No TypeScript parameter properties here: production runs `node server.ts` (type stripping only).
  constructor(dir: string, readLocalAsset: LocalAssetReader, intervalMs = 10_000) {
    this.dir = dir;
    this.readLocalAsset = readLocalAsset;
    this.intervalMs = intervalMs;
    this.roomsDir = path.join(dir, 'rooms');
    this.assetsDir = path.join(dir, 'assets');
    fs.mkdirSync(this.roomsDir, { recursive: true });
    fs.mkdirSync(this.assetsDir, { recursive: true });
  }

  // ---------- restore (boot) ----------

  /** Reads every backed-up room. Synchronous: call once at startup, before accepting connections. */
  loadAllRoomsSync(): BackedUpRoom[] {
    const out: BackedUpRoom[] = [];
    for (const name of fs.readdirSync(this.roomsDir)) {
      if (!name.endsWith('.json.gz')) continue;
      const roomId = decodeURIComponent(name.slice(0, -'.json.gz'.length));
      try {
        const state = JSON.parse(gunzipSync(fs.readFileSync(path.join(this.roomsDir, name))).toString('utf8'));
        out.push({ roomId, state, lastActiveAt: Number(state?.lastActiveAt) || 0 });
      } catch (err) {
        console.error(`Backup: could not read room file "${name}", skipping:`, err);
      }
    }
    return out;
  }

  /** Reads one asset from the backup (used when the local store misses after a cold start). */
  async readAsset(hash: string): Promise<Uint8Array | null> {
    if (!HASH_RE.test(hash)) return null;
    try {
      const bytes = await fs.promises.readFile(path.join(this.assetsDir, hash));
      this.knownAssets.add(hash);
      return bytes;
    } catch {
      return null;
    }
  }

  // ---------- write-behind ----------

  /** Queue a room for backup. The getter is called at write time, so the latest state wins. */
  scheduleRoom(roomId: string, getState: RoomStateGetter): void {
    if (this.stopped) return;
    this.pending.set(roomId, getState);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flushNow();
      }, this.intervalMs);
      this.timer.unref();
    }
  }

  /** Queue a room's backup file for deletion. */
  deleteRoom(roomId: string): void {
    this.scheduleRoom(roomId, () => null);
  }

  /** Writes everything queued so far. Safe to call repeatedly; runs are serialized. */
  flushNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = [...this.pending.entries()];
    this.pending.clear();
    this.chain = this.chain.then(async () => {
      for (const [roomId, getState] of batch) {
        try {
          await this.writeRoom(roomId, getState());
        } catch (err) {
          console.error(`Backup: failed to write room "${roomId}", will retry:`, err);
          if (!this.pending.has(roomId)) this.scheduleRoom(roomId, getState);
        }
      }
    });
    return this.chain;
  }

  /** Flushes, then stops accepting new work. */
  async stop(): Promise<void> {
    await this.flushNow();
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async writeRoom(roomId: string, state: object | null): Promise<void> {
    const file = path.join(this.roomsDir, roomFileName(roomId));
    if (state === null) {
      await fs.promises.rm(file, { force: true });
      return;
    }
    const json = JSON.stringify(state);
    // Assets first, so a restored room never points at an image the backup does not have.
    for (const m of json.matchAll(ASSET_URL_RE)) {
      await this.ensureAsset(m[1]);
    }
    await fs.promises.writeFile(file, gzipSync(json));
  }

  private async ensureAsset(hash: string): Promise<void> {
    if (this.knownAssets.has(hash)) return;
    const file = path.join(this.assetsDir, hash);
    try {
      await fs.promises.access(file);
    } catch {
      const bytes = this.readLocalAsset(hash);
      if (!bytes) {
        console.error(`Backup: asset ${hash} is missing locally; room will reference a missing image.`);
        return;
      }
      await fs.promises.writeFile(file, bytes);
    }
    this.knownAssets.add(hash);
  }
}
```

### 1.1 Unit tests: create `tests/backupMirror.test.ts`

```ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { BackupMirror, sniffMime } from '../backupMirror.ts';

const HASH = 'a'.repeat(64);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

describe('BackupMirror', () => {
  let dir: string;
  let localAssets: Map<string, Uint8Array>;
  let mirror: BackupMirror;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-'));
    localAssets = new Map([[HASH, JPEG]]);
    mirror = new BackupMirror(dir, (h) => localAssets.get(h) ?? null, 60_000);
  });
  afterEach(async () => {
    await mirror.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a gzipped room file and its assets on flush', async () => {
    const state = { id: 'r1', lastActiveAt: 123, background: { pages: [{ dataUrl: `/api/assets/${HASH}` }] } };
    mirror.scheduleRoom('r1', () => state);
    assert.equal(fs.existsSync(path.join(dir, 'rooms', 'r1.json.gz')), false); // batched, not written yet
    await mirror.flushNow();
    const onDisk = JSON.parse(gunzipSync(fs.readFileSync(path.join(dir, 'rooms', 'r1.json.gz'))).toString());
    assert.deepEqual(onDisk, state);
    assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(dir, 'assets', HASH))), JPEG);
  });

  it('uses the latest state at write time', async () => {
    let n = 1;
    mirror.scheduleRoom('r1', () => ({ id: 'r1', n, lastActiveAt: 1 }));
    n = 2;
    mirror.scheduleRoom('r1', () => ({ id: 'r1', n, lastActiveAt: 2 }));
    await mirror.flushNow();
    assert.equal(mirror.loadAllRoomsSync()[0].state.n, 2);
  });

  it('round-trips rooms through loadAllRoomsSync, including odd room ids', async () => {
    mirror.scheduleRoom('a', () => ({ id: 'a', lastActiveAt: 10 }));
    mirror.scheduleRoom('b c/d', () => ({ id: 'b c/d', lastActiveAt: 20 }));
    await mirror.flushNow();
    const rooms = mirror.loadAllRoomsSync().sort((x, y) => x.lastActiveAt - y.lastActiveAt);
    assert.deepEqual(rooms.map((r) => [r.roomId, r.lastActiveAt]), [['a', 10], ['b c/d', 20]]);
  });

  it('deletes a room file', async () => {
    mirror.scheduleRoom('r1', () => ({ id: 'r1', lastActiveAt: 1 }));
    await mirror.flushNow();
    mirror.deleteRoom('r1');
    await mirror.flushNow();
    assert.equal(mirror.loadAllRoomsSync().length, 0);
  });

  it('reads assets back and rejects bad hashes', async () => {
    mirror.scheduleRoom('r1', () => ({ id: 'r1', lastActiveAt: 1, u: `/api/assets/${HASH}` }));
    await mirror.flushNow();
    assert.deepEqual(new Uint8Array((await mirror.readAsset(HASH))!), JPEG);
    assert.equal(await mirror.readAsset('b'.repeat(64)), null);
    assert.equal(await mirror.readAsset('../etc/passwd'), null);
  });

  it('skips unreadable room files instead of crashing', async () => {
    fs.writeFileSync(path.join(dir, 'rooms', 'broken.json.gz'), 'not gzip');
    mirror.scheduleRoom('ok', () => ({ id: 'ok', lastActiveAt: 1 }));
    await mirror.flushNow();
    assert.deepEqual(mirror.loadAllRoomsSync().map((r) => r.roomId), ['ok']);
  });

  it('sniffs common image types', () => {
    assert.equal(sniffMime(JPEG), 'image/jpeg');
    assert.equal(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
    assert.equal(sniffMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), 'image/svg+xml');
    assert.equal(sniffMime(new Uint8Array([1, 2, 3])), 'application/octet-stream');
  });
});
```

**Checkpoint 1:** `npm run lint && npm test` → 84 pass (77 + 7). Then run the plain-node check
and also this command, which must print `OK`:
```bash
node -e "import('./backupMirror.ts').then(() => console.log('OK'))"
```

---

## Phase 2: Wire the backup into `server.ts`

### 2.1 Import (after the `roomStore.ts` import, ~line 25)

```ts
import { BackupMirror, sniffMime } from './backupMirror.ts';
```

### 2.2 `StartServerOptions` (~line 34)

Add `backupDir?: string;` after `dataDir?: string;`.

### 2.3 Module-level helper (directly **above** `export async function startServer(`, ~line 111)

```ts
/** Opens the backup mirror if BACKUP_DIR is set. Returns null (and logs) if unset or unusable. */
function openBackupMirror(backupDir: string, store: RoomStore): BackupMirror | null {
  if (!backupDir) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('BACKUP_DIR is not set: rooms will NOT survive a cold start or redeploy.');
    }
    return null;
  }
  try {
    const mirror = new BackupMirror(backupDir, (hash) => store.getAsset(hash)?.bytes ?? null);
    console.log(`Backing up rooms to "${backupDir}".`);
    return mirror;
  } catch (err) {
    console.error(`BACKUP_DIR "${backupDir}" is unusable; running WITHOUT backups:`, err);
    return null;
  }
}
```

### 2.4 Create the mirror (directly below `const store = new RoomStore(…);`, ~line 114)

```ts
  const backup = openBackupMirror(options.backupDir ?? process.env.BACKUP_DIR ?? '', store);
```

### 2.5 Asset route: lazy restore (~line 131)

Replace the **whole** `app.get('/api/assets/:hash', …)` handler with this. The headers are the
same as today; the changes are `async`, the backup fallback, and a 500 on unexpected errors.

```ts
  app.get('/api/assets/:hash', async (req, res) => {
    const hash = req.params.hash;
    if (!isValidAssetHash(hash)) {
      res.status(404).end();
      return;
    }
    try {
      let asset = store.getAsset(hash);
      if (!asset && backup) {
        // Cold start: the local store is empty but the backup bucket has the image.
        const bytes = await backup.readAsset(hash);
        if (bytes && store.putAsset(bytes, sniffMime(bytes)) === hash) asset = store.getAsset(hash);
      }
      if (!asset) {
        res.status(404).end();
        return;
      }
      res.setHeader('Content-Security-Policy', 'sandbox');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', asset.mime);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.end(Buffer.from(asset.bytes));
    } catch (err) {
      console.error(`Failed to serve asset ${hash}:`, err);
      res.status(500).end();
    }
  });
```

### 2.6 Restore + queue helpers (directly **above** `const dirtyRooms = new Set<string>();`, ~line 280)

```ts
  /** Cold start: copy rooms from the backup into the local SQLite store. */
  function restoreFromBackup() {
    if (!backup) return;
    try {
      let restored = 0;
      for (const { roomId, state, lastActiveAt } of backup.loadAllRoomsSync()) {
        const room = hydrateRoom({ ...state, id: roomId, lastActiveAt });
        if (!room) {
          backup.deleteRoom(roomId); // expired
          continue;
        }
        const local = store.loadRoom<SerializedRoom>(roomId);
        if (local && local.lastActiveAt >= room.lastActiveAt) continue;
        store.saveRoom(roomId, serializeRoom(room), room.lastActiveAt);
        restored++;
      }
      console.log(`Restored ${restored} room(s) from backup.`);
    } catch (err) {
      console.error('Restoring from backup failed; starting with local state only:', err);
    }
  }

  /** Queue a room for the backup. Reads the latest state when the write happens; null deletes it. */
  function backupRoom(roomId: string) {
    backup?.scheduleRoom(roomId, () => {
      const live = rooms.get(roomId);
      if (live) return isRoomEmpty(live) ? null : serializeRoom(live);
      return store.loadRoom<SerializedRoom>(roomId)?.state ?? null;
    });
  }
```

### 2.7 Queue rooms for backup in `flushRoomsToDisk`

Inside the `for (const roomId of [...dirtyRooms])` loop:
- After `store.deleteRoom(roomId);` (the `isRoomEmpty` branch), add `backupRoom(roomId);`.
- After `store.saveRoom(roomId, serializeRoom(room), room.lastActiveAt);`, add `backupRoom(roomId);`.

### 2.8 Expired rooms leave the backup too (`runHousekeeping`, ~line 331)

Replace:
```ts
      store.deleteRoomsInactiveBefore(now - ROOM_TTL_MS);
```
with:
```ts
      for (const roomId of store.deleteRoomsInactiveBefore(now - ROOM_TTL_MS)) backupRoom(roomId);
```

### 2.9 Restore at boot (~line 338)

Directly after `migrateLegacyJsonStore();`, add:
```ts
  restoreFromBackup();
```

### 2.10 `handleShutdown` (~line 1830)

Cloud Run gives ~10 s after SIGTERM. Replace the final `io.close(…)` block:
```ts
    io.close(() => {
      httpServer.close(() => {
        process.exit(0);
      });
    });
```
with:
```ts
    // Cloud Run allows ~10 s after SIGTERM: push pending room backups before exiting.
    void (backup ? backup.stop() : Promise.resolve()).finally(() => {
      io.close(() => {
        httpServer.close(() => {
          process.exit(0);
        });
      });
    });
```
Keep the existing `flushRoomsToDisk();` call and the 8 s force-exit timer **above** it.

### 2.11 `close()` (~line 1853)

Replace:
```ts
    flushRoomsToDisk();
    store.close();
```
with:
```ts
    flushRoomsToDisk();
    await backup?.stop();
    store.close();
```
The order matters: `backup.stop()` may read from the store, so it must run before `store.close()`.

### 2.12 Return it

In the `return { … }` at the end of `startServer`, add `backup,` after `store,`.

### 2.13 Server tests (`tests/server.test.ts`)

Add this block **directly above** `describe('storage: SQLite + worksheet assets', …)`:

```ts
  describe('storage: backup bucket (BACKUP_DIR)', () => {
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    it('B1 – a cold start restores rooms and worksheets from the backup', async () => {
      const backupDir = path.join(tmpDir, 'bucket');
      await srv.close();
      srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: path.join(tmpDir, 'disk-1'), backupDir, skipVite: true });

      const { socket: teacher } = await joinTracked({ roomId: 'cold', userId: 't', name: 'Teacher' });
      await emitAck(teacher, 'teacher:auth', { pin: '1234' });
      const bgSync = waitForEvent<any>(teacher, 'background-sync');
      await emitAck(teacher, 'teacher:set-background', {
        boardId: 'main',
        background: { id: 'ws', fileName: 'w.png', pages: [{ dataUrl: PNG, width: 1, height: 1 }], x: 0, y: 0, scale: 1, layout: 'stack', opacity: 1 },
      });
      const url = (await bgSync).background.pages[0].dataUrl as string;
      await srv.flushRoomsToDiskAsync();
      await srv.backup!.flushNow();

      // Simulate Cloud Run wiping the local disk: same bucket, brand-new data dir.
      for (const s of openSockets.splice(0)) if (s.connected) s.disconnect();
      await srv.close();
      srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: path.join(tmpDir, 'disk-2'), backupDir, skipVite: true });

      const { init } = await joinTracked({ roomId: 'cold', userId: 's', name: 'Student' });
      assert.equal(init.background.pages[0].dataUrl, url);
      assert.equal(srv.store.countAssets(), 0); // not restored until requested
      const res = await fetch(`http://127.0.0.1:${srv.port}${url}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/png');
      assert.equal(srv.store.countAssets(), 1);
    });

    it('B2 – an unusable DATA_DIR falls back instead of crashing', async () => {
      const blocker = path.join(tmpDir, 'not-a-dir');
      fs.writeFileSync(blocker, 'x');
      await srv.close();
      srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: path.join(blocker, 'data'), skipVite: true });
      const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
      assert.equal(res.status, 200);
    });

    it('B3 – an unusable BACKUP_DIR runs without backups instead of crashing', async () => {
      const blocker = path.join(tmpDir, 'not-a-bucket');
      fs.writeFileSync(blocker, 'x');
      await srv.close();
      srv = await startServer({ port: 0, host: '127.0.0.1', dataDir: tmpDir, backupDir: path.join(blocker, 'b'), skipVite: true });
      assert.equal(srv.backup, null);
      assert.equal((await fetch(`http://127.0.0.1:${srv.port}/healthz`)).status, 200);
    });
  });
```

**Checkpoint 2:** `npm run lint && npm test` → **87 pass**, and the plain-node check passes. Then
run `npx playwright install chromium` (once) and `npm run test:e2e`, which must pass.

---

## Phase 3: Docs (`README.md`)

Replace the "Storage" section's production paragraph with:

> In production on Cloud Run, local disk is wiped on cold starts and redeploys. Mount a Cloud
> Storage bucket as a volume and set `BACKUP_DIR` to its mount path (e.g. `/mnt/backup`). Rooms
> are copied there within ~10 s of changing (immediately on shutdown) and restored automatically
> at startup. Keep **max instances = 1**: one server process must be the only writer. Leave
> `DATA_DIR` unset (local disk); never point it at the bucket mount, because SQLite needs real
> file locking.

**Checkpoint 3:** `npm run lint && npm test` → 87 pass.

---

## Phase 4: Cloud Run setup (**human, in the Google Cloud console**)

The bucket can be mounted **before** Phases 1–3 deploy (the current code ignores it). `BACKUP_DIR`
only takes effect once this code is deployed. **Nothing here needs code or keys.**

1. **Mount a Cloud Storage volume** (Cloud Run → `allaboard` → Edit & deploy new revision →
   Containers → Volumes → Mount volume → Cloud Storage bucket):
   - **Mount path:** `/mnt/backup`
   - **Bucket:** Browse → create a new bucket: region **us-east1**, class **Standard**,
     **public access prevention on**, uniform access control.
   - **Read-only:** unchecked.
   - **UID / GID:** the runtime user's IDs (see the walkthrough in the PR / chat). If they are
     wrong, the logs say `BACKUP_DIR "/mnt/backup" is unusable` with `EACCES`.
   - Everything else: defaults.
2. **Permission:** in the bucket → Permissions → Grant access → the service account shown on the
   Cloud Run service's **Security** tab → role **Storage Object User**.
3. **Variables:** add `BACKUP_DIR` = `/mnt/backup`. Make sure `DATA_DIR` and `PORT` are **not** set.
4. **Scaling:** confirm **max instances = 1**.
5. **Verify** after deploying the code:
   - Logs show `Backing up rooms to "/mnt/backup".` and `Restored N room(s) from backup.`
   - Draw in a room, deploy a new revision, and re-open the room: the drawing is still there.
   - The bucket browser shows `rooms/<roomId>.json.gz` and `assets/<hash>`.

---

## Appendix A: Decisions (do not revisit)

| Decision | Why |
|---|---|
| **Bucket as a backup folder, not as the database** | A Cloud Storage mount has no file locking and turns every small write into a whole-object upload. SQLite on it would corrupt or crawl. Whole-file JSON snapshots are exactly what object storage is good at. |
| **Mounted volume, not the `@google-cloud/storage` SDK** | No dependency, no credentials code, and the same code works locally with any folder. Cloud Run authenticates the mount with the service's own service account. |
| **Not Filestore/NFS** | It would let SQLite live on durable disk directly, but costs roughly $200+/month minimum. |
| **Batch every 10 s, read state at write time** | A busy room costs ~6 small writes/minute (fractions of a cent per class). On a crash, at most ~10 s of strokes are lost. On a normal shutdown (SIGTERM), nothing is lost. |
| **Restore rooms eagerly at boot, images lazily** | Room files are small, and keeping `findRoom()` synchronous avoids touching every socket handler. Images can be large, so they're fetched only when a browser asks. |
| **Assets written before the room file** | A restored room can never reference an image that isn't in the bucket. |
| **Max instances = 1 is required** | Two instances would both write the same room files. It's also required for Socket.IO rooms to work without an adapter. |
| **Backup images are not garbage-collected** | They're immutable and deduplicated, and a heavy year is likely a few GB, i.e. cents per month. Add a cleanup job later only if the bucket bill ever matters. |

## Appendix B: Out of scope

- Point-in-time recovery / version history (could enable bucket Object Versioning later, no code needed).
- Running more than one instance.
- Removing `RoomStore`'s JSON fallback mode from `d815c59` (it's only used if `node:sqlite` is missing, which it isn't on the deployed Node 22.23).
