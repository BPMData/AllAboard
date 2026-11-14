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
