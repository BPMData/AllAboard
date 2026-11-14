/**
 * backupMirror.ts — durable off-box copy of rooms + worksheet assets.
 *
 * SQLite (roomStore.ts) is the fast local working copy, but on Cloud Run the local disk is
 * wiped on every cold start and redeploy. This module copies rooms and images to a durable
 * backend:
 *
 *   - GcsBackend: talks to a Cloud Storage bucket directly over HTTPS (JSON API), authenticated
 *     with a short-lived token from Cloud Run's metadata server. No SDK, no keys, no volume
 *     mount, no env vars required — so AI Studio redeploys can't break it.
 *   - DirBackend: plain files in a folder (local dev, tests, or a mounted bucket via BACKUP_DIR).
 *
 * Layout (same on both backends):
 *   rooms/<roomId>.json.gz   gzipped room JSON (same shape as SerializedRoom)
 *   assets/<sha256>          raw worksheet image bytes (immutable, written once)
 *
 * Rules:
 *   - Only ONE server process writes (Cloud Run max instances = 1).
 *   - Every write replaces a whole object. No appends, no renames.
 *   - Room writes are batched (default every 10 s) so a busy room costs ~6 writes/minute.
 *
 * No TypeScript parameter properties / enums / namespaces in this file: production runs
 * `node server.ts` (type stripping only).
 */
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

const ASSET_URL_RE = /\/api\/assets\/([a-f0-9]{64})/g;
const HASH_RE = /^[a-f0-9]{64}$/;
const ROOMS_PREFIX = 'rooms/';
const ASSETS_PREFIX = 'assets/';
const ROOM_SUFFIX = '.json.gz';

// ---------------------------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------------------------

/** Minimal object store. Keys look like "rooms/abc.json.gz" or "assets/<hash>". */
export interface BackupBackend {
  /** Human-readable target, for logs. */
  readonly label: string;
  /** Throws if the backend is unusable (e.g. no permission). Called once at startup. */
  probe(): Promise<void>;
  read(key: string): Promise<Uint8Array | null>;
  write(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** All keys starting with `prefix`. */
  list(prefix: string): Promise<string[]>;
}

/** Plain files under a directory (local dev, tests, or a bucket mounted as a volume). */
export class DirBackend implements BackupBackend {
  readonly label: string;
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    this.label = `folder "${dir}"`;
  }

  async probe(): Promise<void> {
    await fs.promises.mkdir(path.join(this.dir, ROOMS_PREFIX), { recursive: true });
    await fs.promises.mkdir(path.join(this.dir, ASSETS_PREFIX), { recursive: true });
  }

  async read(key: string): Promise<Uint8Array | null> {
    try {
      return await fs.promises.readFile(path.join(this.dir, key));
    } catch {
      return null;
    }
  }

  async write(key: string, bytes: Uint8Array): Promise<void> {
    await fs.promises.writeFile(path.join(this.dir, key), bytes);
  }

  async remove(key: string): Promise<void> {
    await fs.promises.rm(path.join(this.dir, key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.promises.access(path.join(this.dir, key));
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const folder = path.join(this.dir, prefix);
    try {
      return (await fs.promises.readdir(folder)).map((name) => prefix + name);
    } catch {
      return [];
    }
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 20_000; // a hung request must not stall startup or the SIGTERM flush

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/**
 * A Cloud Storage bucket via the JSON API. Auth: Cloud Run's metadata server hands the
 * service account a short-lived OAuth token. Pass `getToken` / `fetchImpl` / `apiBase` only in tests.
 */
export class GcsBackend implements BackupBackend {
  readonly label: string;
  private readonly bucket: string;
  private readonly fetchImpl: FetchLike;
  private readonly apiBase: string;
  private readonly getTokenOverride: (() => Promise<string>) | null;
  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(
    bucket: string,
    opts: { fetchImpl?: FetchLike; apiBase?: string; getToken?: () => Promise<string> } = {}
  ) {
    this.bucket = bucket;
    this.label = `bucket "gs://${bucket}"`;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.apiBase = (opts.apiBase ?? 'https://storage.googleapis.com').replace(/\/$/, '');
    this.getTokenOverride = opts.getToken ?? null;
  }

  private async token(): Promise<string> {
    if (this.getTokenOverride) return this.getTokenOverride();
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + 60_000) return this.cachedToken.value;
    const res = await this.fetchImpl(METADATA_TOKEN_URL, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`metadata token request failed: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.cachedToken = { value: body.access_token, expiresAt: now + body.expires_in * 1000 };
    return body.access_token;
  }

  private objectUrl(key: string): string {
    return `${this.apiBase}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}`;
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${await this.token()}`);
    return this.fetchImpl(url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }

  private async fail(op: string, key: string, res: Response): Promise<never> {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`GCS ${op} "${key}" failed: HTTP ${res.status} ${detail}`);
  }

  async probe(): Promise<void> {
    const url = `${this.apiBase}/storage/v1/b/${encodeURIComponent(this.bucket)}/o?maxResults=1&prefix=${encodeURIComponent(ROOMS_PREFIX)}`;
    const res = await this.request(url);
    if (!res.ok) await this.fail('probe', ROOMS_PREFIX, res);
  }

  async read(key: string): Promise<Uint8Array | null> {
    const res = await this.request(`${this.objectUrl(key)}?alt=media`);
    if (res.status === 404) return null;
    if (!res.ok) await this.fail('read', key, res);
    return new Uint8Array(await res.arrayBuffer());
  }

  async write(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const url = `${this.apiBase}/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&name=${encodeURIComponent(key)}`;
    const res = await this.request(url, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: bytes,
    });
    if (!res.ok) await this.fail('write', key, res);
  }

  async remove(key: string): Promise<void> {
    const res = await this.request(this.objectUrl(key), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) await this.fail('delete', key, res);
  }

  async exists(key: string): Promise<boolean> {
    const res = await this.request(`${this.objectUrl(key)}?fields=name`);
    if (res.status === 404) return false;
    if (!res.ok) await this.fail('stat', key, res);
    return true;
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let pageToken = '';
    do {
      const url =
        `${this.apiBase}/storage/v1/b/${encodeURIComponent(this.bucket)}/o?fields=items(name),nextPageToken` +
        `&prefix=${encodeURIComponent(prefix)}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
      const res = await this.request(url);
      if (!res.ok) await this.fail('list', prefix, res);
      const body = (await res.json()) as { items?: Array<{ name: string }>; nextPageToken?: string };
      for (const item of body.items ?? []) keys.push(item.name);
      pageToken = body.nextPageToken ?? '';
    } while (pageToken);
    return keys;
  }
}

// ---------------------------------------------------------------------------------------------
// Mirror
// ---------------------------------------------------------------------------------------------

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

function roomKey(roomId: string): string {
  return `${ROOMS_PREFIX}${encodeURIComponent(roomId)}${ROOM_SUFFIX}`;
}

export class BackupMirror {
  readonly backend: BackupBackend;
  private readonly readLocalAsset: LocalAssetReader;
  private readonly intervalMs: number;
  private readonly pending = new Map<string, RoomStateGetter>();
  private readonly knownAssets = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(backend: BackupBackend, readLocalAsset: LocalAssetReader, intervalMs = 10_000) {
    this.backend = backend;
    this.readLocalAsset = readLocalAsset;
    this.intervalMs = intervalMs;
  }

  // ---------- restore (boot) ----------

  /** Reads every backed-up room. Call once at startup, before accepting connections. */
  async loadAllRooms(): Promise<BackedUpRoom[]> {
    const out: BackedUpRoom[] = [];
    for (const key of await this.backend.list(ROOMS_PREFIX)) {
      if (!key.endsWith(ROOM_SUFFIX)) continue;
      const roomId = decodeURIComponent(key.slice(ROOMS_PREFIX.length, -ROOM_SUFFIX.length));
      try {
        const bytes = await this.backend.read(key);
        if (!bytes) continue;
        const state = JSON.parse(gunzipSync(bytes).toString('utf8'));
        out.push({ roomId, state, lastActiveAt: Number(state?.lastActiveAt) || 0 });
      } catch (err) {
        console.error(`Backup: could not read "${key}", skipping:`, err);
      }
    }
    return out;
  }

  /** Reads one asset from the backup (used when the local store misses after a cold start). */
  async readAsset(hash: string): Promise<Uint8Array | null> {
    if (!HASH_RE.test(hash)) return null;
    try {
      const bytes = await this.backend.read(ASSETS_PREFIX + hash);
      if (bytes) this.knownAssets.add(hash);
      return bytes;
    } catch (err) {
      console.error(`Backup: could not read asset ${hash}:`, err);
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

  /** Queue a room's backup for deletion. */
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
    const key = roomKey(roomId);
    if (state === null) {
      await this.backend.remove(key);
      return;
    }
    const json = JSON.stringify(state);
    // Assets first, so a restored room never points at an image the backup does not have.
    for (const m of json.matchAll(ASSET_URL_RE)) {
      await this.ensureAsset(m[1]);
    }
    await this.backend.write(key, gzipSync(json), 'application/gzip');
  }

  private async ensureAsset(hash: string): Promise<void> {
    if (this.knownAssets.has(hash)) return;
    const key = ASSETS_PREFIX + hash;
    if (!(await this.backend.exists(key))) {
      const bytes = this.readLocalAsset(hash);
      if (!bytes) {
        console.error(`Backup: asset ${hash} is missing locally; room will reference a missing image.`);
        return;
      }
      await this.backend.write(key, bytes, sniffMime(bytes));
    }
    this.knownAssets.add(hash);
  }
}
