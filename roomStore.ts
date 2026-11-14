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
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ASSET_URL_PREFIX = '/api/assets/';
const ASSET_URL_RE = /\/api\/assets\/([a-f0-9]{64})/g;
const HASH_RE = /^[a-f0-9]{64}$/;
const DATA_URL_RE = /^data:([a-z0-9.+\/-]+);base64,/i;

const requireModule = createRequire(import.meta.url);

function loadSqliteDatabaseSync(): (new (dbFile: string) => DatabaseSync) | null {
  try {
    const mod = requireModule('node:sqlite') as { DatabaseSync?: new (dbFile: string) => DatabaseSync };
    return typeof mod?.DatabaseSync === 'function' ? mod.DatabaseSync : null;
  } catch {
    return null;
  }
}

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

interface FallbackAssetRecord {
  mime: string;
  bytes: Uint8Array;
  createdAt: number;
}

export class RoomStore {
  private db: DatabaseSync | null = null;
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
  } | null = null;

  // Fallback in-memory + disk store used only if node:sqlite is unavailable in the container runtime
  private fallbackFile: string;
  private fallbackRooms = new Map<string, { state: string; lastActiveAt: number }>();
  private fallbackAssets = new Map<string, FallbackAssetRecord>();
  private fallbackRoomAssets = new Map<string, Set<string>>();

  constructor(dbFile: string) {
    this.fallbackFile = `${dbFile}.fallback.json`;

    const SqliteDatabaseSync = loadSqliteDatabaseSync();
    if (SqliteDatabaseSync) {
      const candidatePaths = [
        dbFile,
        path.join(os.tmpdir(), 'allaboard-data', path.basename(dbFile)),
      ];
      for (const candidate of candidatePaths) {
        try {
          fs.mkdirSync(path.dirname(candidate), { recursive: true });
          const db = new SqliteDatabaseSync(candidate);
          try {
            db.exec('PRAGMA journal_mode = WAL;');
          } catch {
            // Overlay filesystems without shared-memory mmap fall back to default journal mode
          }
          db.exec(`
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

          this.db = db;
          this.q = {
            getRoom: db.prepare('SELECT state, last_active FROM rooms WHERE id = ?'),
            upsertRoom: db.prepare(
              `INSERT INTO rooms (id, state, last_active) VALUES (?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET state = excluded.state, last_active = excluded.last_active`
            ),
            deleteRoom: db.prepare('DELETE FROM rooms WHERE id = ?'),
            deleteRoomAssets: db.prepare('DELETE FROM room_assets WHERE room_id = ?'),
            insertRoomAsset: db.prepare('INSERT OR IGNORE INTO room_assets (room_id, hash) VALUES (?, ?)'),
            expiredRoomIds: db.prepare('SELECT id FROM rooms WHERE last_active < ?'),
            putAsset: db.prepare(
              'INSERT OR IGNORE INTO assets (hash, mime, bytes, created_at) VALUES (?, ?, ?, ?)'
            ),
            getAsset: db.prepare('SELECT mime, bytes FROM assets WHERE hash = ?'),
            gcAssets: db.prepare(
              `DELETE FROM assets
               WHERE created_at < ?
                 AND NOT EXISTS (SELECT 1 FROM room_assets ra WHERE ra.hash = assets.hash)`
            ),
            countAssets: db.prepare('SELECT COUNT(*) AS n FROM assets'),
          };
          return;
        } catch (err) {
          console.warn(`SQLite initialization failed at "${candidate}":`, err);
          this.db = null;
          this.q = null;
        }
      }
    }

    this.loadFallbackFromDisk();
  }

  private loadFallbackFromDisk(): void {
    try {
      if (!fs.existsSync(this.fallbackFile)) return;
      const raw = JSON.parse(fs.readFileSync(this.fallbackFile, 'utf-8'));
      if (raw && typeof raw.rooms === 'object') {
        for (const [id, entry] of Object.entries(raw.rooms) as Array<[string, any]>) {
          if (entry && typeof entry.state === 'string') {
            this.fallbackRooms.set(id, {
              state: entry.state,
              lastActiveAt: Number(entry.lastActiveAt) || Date.now(),
            });
            const hashes = new Set<string>();
            for (const m of entry.state.matchAll(ASSET_URL_RE)) hashes.add(m[1]);
            this.fallbackRoomAssets.set(id, hashes);
          }
        }
      }
    } catch {
      // Ignore corrupt fallback file
    }
  }

  private persistFallbackToDisk(): void {
    try {
      const roomsObj: Record<string, { state: string; lastActiveAt: number }> = {};
      for (const [id, row] of this.fallbackRooms.entries()) {
        roomsObj[id] = row;
      }
      fs.writeFileSync(this.fallbackFile, JSON.stringify({ rooms: roomsObj }), 'utf-8');
    } catch {
      // Ignore disk write errors in read-only environments
    }
  }

  // ---------- rooms ----------

  loadRoom<T>(roomId: string): StoredRoomRow<T> | null {
    if (this.q) {
      const row = this.q.getRoom.get(roomId) as { state: string; last_active: number } | undefined;
      if (!row) return null;
      try {
        return { state: JSON.parse(row.state) as T, lastActiveAt: row.last_active };
      } catch (err) {
        console.error(`Corrupt room row "${roomId}", ignoring:`, err);
        return null;
      }
    }

    const row = this.fallbackRooms.get(roomId);
    if (!row) return null;
    try {
      return { state: JSON.parse(row.state) as T, lastActiveAt: row.lastActiveAt };
    } catch {
      return null;
    }
  }

  /** Writes ONE room. Also records which assets that room references. */
  saveRoom(roomId: string, state: unknown, lastActiveAt: number): void {
    const json = JSON.stringify(state);
    const hashes = new Set<string>();
    for (const m of json.matchAll(ASSET_URL_RE)) hashes.add(m[1]);

    if (this.db && this.q) {
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
      return;
    }

    this.fallbackRooms.set(roomId, { state: json, lastActiveAt });
    this.fallbackRoomAssets.set(roomId, hashes);
    this.persistFallbackToDisk();
  }

  deleteRoom(roomId: string): void {
    if (this.q) {
      this.q.deleteRoom.run(roomId); // room_assets rows cascade
      return;
    }
    this.fallbackRooms.delete(roomId);
    this.fallbackRoomAssets.delete(roomId);
    this.persistFallbackToDisk();
  }

  /** Deletes rooms inactive since before `cutoff`. Returns their IDs. */
  deleteRoomsInactiveBefore(cutoff: number): string[] {
    if (this.q) {
      const ids = (this.q.expiredRoomIds.all(cutoff) as Array<{ id: string }>).map((r) => r.id);
      for (const id of ids) this.q.deleteRoom.run(id);
      return ids;
    }
    const ids: string[] = [];
    for (const [id, row] of this.fallbackRooms.entries()) {
      if (row.lastActiveAt < cutoff) {
        ids.push(id);
        this.fallbackRooms.delete(id);
        this.fallbackRoomAssets.delete(id);
      }
    }
    if (ids.length > 0) this.persistFallbackToDisk();
    return ids;
  }

  // ---------- assets ----------

  /** Stores bytes once (dedup by sha256). Returns the hash. */
  putAsset(bytes: Uint8Array, mime: string): string {
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (this.q) {
      this.q.putAsset.run(hash, mime, bytes, Date.now());
      return hash;
    }
    if (!this.fallbackAssets.has(hash)) {
      this.fallbackAssets.set(hash, { mime, bytes: new Uint8Array(bytes), createdAt: Date.now() });
    }
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
    if (this.q) {
      const row = this.q.getAsset.get(hash) as { mime: string; bytes: Uint8Array } | undefined;
      return row ? { mime: row.mime, bytes: row.bytes } : null;
    }
    const asset = this.fallbackAssets.get(hash);
    return asset ? { mime: asset.mime, bytes: asset.bytes } : null;
  }

  /**
   * Deletes assets no room references. `graceMs` protects assets that were just uploaded
   * but whose room has not been flushed yet (default 1 hour).
   */
  gcAssets(graceMs = 60 * 60 * 1000): number {
    const cutoff = Date.now() - graceMs;
    if (this.q) {
      const res = this.q.gcAssets.run(cutoff);
      return Number(res.changes);
    }
    const referenced = new Set<string>();
    for (const set of this.fallbackRoomAssets.values()) {
      for (const h of set) referenced.add(h);
    }
    let deleted = 0;
    for (const [hash, asset] of this.fallbackAssets.entries()) {
      if (asset.createdAt < cutoff && !referenced.has(hash)) {
        this.fallbackAssets.delete(hash);
        deleted++;
      }
    }
    return deleted;
  }

  countAssets(): number {
    if (this.q) {
      return Number((this.q.countAssets.get() as { n: number }).n);
    }
    return this.fallbackAssets.size;
  }

  close(): void {
    if (this.db && this.db.isOpen) this.db.close();
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
