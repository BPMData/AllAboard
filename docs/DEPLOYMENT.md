# AllAboard — Deployment & Persistence: How It Actually Works

> **Read this before touching deployment, storage, env vars, Cloud Run settings, or `server.ts`
> startup code.** Every rule below was learned the hard way (Nov 2026, PRs #12–#17). If something here
> contradicts what an AI assistant (Gemini Cloud Assist, AI Studio, Codex, Claude) tells you, **this file
> wins** until proven wrong. Then update this file.

---

## 1. The one-paragraph version

The app is published from **Google AI Studio** to **Cloud Run** (service `allaboard`). Cloud Run's disk is
**in-memory and wiped** on every cold start (~15 min idle) and every redeploy. So rooms live in a
local SQLite file as a fast working copy, and are **backed up to the Cloud Storage bucket
`gs://allaboard-data` directly over the Cloud Storage HTTP API**. That copy survives. **AI Studio's
Publish button rewrites the Cloud Run service config**, so anything that must keep working is
**configured in code, never in the Cloud Run console.**

---

## 2. The deployment, as it really is

| Thing | Value |
|---|---|
| GCP project | `loyal-rookery-403218` (project number `606573080592`) |
| Cloud Run service | `allaboard`, region `us-east1`, public URL `https://allaboard.ai.studio` |
| Deployed by | AI Studio "Publish/Deploy". Logs carry the label `managed-by: google-ai-studio`. |
| Containers | **Two.** `nginx-container` is the ingress: it listens on **8080** and forwards to `app-container`. `app-container` runs `node server.ts` and listens on **3000**. |
| Scaling | **max instances = 1** (required), min instances = 0, session affinity on |
| Runtime | Node 22.23 base image. Start command: `node server.ts`, which uses **Node's built-in TypeScript type stripping, not tsx**. |
| Service account | `606573080592-compute@developer.gserviceaccount.com` (the default compute SA) |
| Backup bucket | `gs://allaboard-data` (us-east1). The SA has **`roles/storage.objectUser`** on it. |
| Junk bucket | `run-sources-loyal-rookery-403218-us-east1` holds Cloud Run's uploaded sources (~80 MB per deploy). It's safe to add a lifecycle rule deleting objects older than 30 days. |

---

## 3. 🔴 Hard rules (each one cost hours)

### R1. AI Studio Publish rewrites the Cloud Run service config. Never depend on console settings.
Every AI Studio publish **replaces** the revision template. Things observed:
- **Volume mounts added in the console disappear.** The `/backup` bucket mount vanished on the next publish.
- **Env vars added in the console may disappear, or survive while what they point to doesn't.**
  `BACKUP_DIR=/backup` survived after its mount was gone, and that turned backups off.
- **Env vars you deleted can come back.** `DATA_DIR=/data` reappeared after being removed.

**So:** anything that must persist (bucket name, feature flags) lives **in code**. Example:
`DEFAULT_BACKUP_BUCKET` in `server.ts`. Code must also **tolerate** stale env vars instead of trusting them.
After every publish, glance at **Cloud Run → allaboard → Containers → app-container**.

### R2. Production runs `node server.ts` (type stripping). The test suite runs `tsx`.
Node's type stripping **rejects** TypeScript-only runtime syntax:
- parameter properties: `constructor(private x: T)`
- `enum`
- `namespace`
- `import x = require(...)`

`tsx` (tests, `npm run dev`) accepts all of these, so **the tests pass and production crashes on boot**.
This nearly shipped once. Every change to server-side code must pass:
```bash
node -e "import('./server.ts').then(() => console.log('OK: loads under plain node'))"
```

### R3. Keep `PORT=3000` on `app-container`. Never "fix" the port.
nginx owns 8080 and forwards to 3000. Without `PORT=3000`, the app grabs Cloud Run's default 8080, collides with
nginx, and the startup probe on 3000 fails: *"STARTUP TCP probe failed … on port 3000"*. Do **not** follow advice to
point the probe at 8080. That "fixes" the probe and breaks every request.

### R4. Never put SQLite on a Cloud Storage bucket mount.
A bucket mount (gcsfuse) has no file locking. SQLite there corrupts or crawls. The bucket is only ever written as
**whole objects** (one gzipped JSON per room, one file per image).

### R5. Max instances must stay 1.
Two instances would both write the same backup objects, and students in one class could land on different
servers and stop seeing each other. Socket.IO has no adapter configured.

### R6. Never "fix" a backup or storage error by pointing it at `/tmp` or an in-memory volume.
It makes the error disappear while backing up to memory that's wiped on restart. Gemini Cloud Assist suggested
exactly this. Ignore it.

### R7. A broken backup must never take the site down.
All storage setup **fails open**. `RoomStore` falls back to a temp dir; the backup probe logs and continues. Keep it that way.

---

## 4. How persistence works (code map)

| Piece | File | What it does |
|---|---|---|
| Working copy | `roomStore.ts` | SQLite (`node:sqlite`), one row per room plus content-addressed assets. Falls back to `os.tmpdir()` if `DATA_DIR` isn't writable. |
| Backup engine | `backupMirror.ts` → `BackupMirror` | Batches changed rooms and writes every **10 s**. Writes images **before** the room that references them. Retries on failure. Flushes immediately on SIGTERM. |
| Bucket backend | `backupMirror.ts` → `GcsBackend` | Cloud Storage JSON API over `fetch`. Auth is a token from `http://metadata.google.internal/…/token` (built into Cloud Run, no keys). 20 s timeout per request. |
| Folder backend | `backupMirror.ts` → `DirBackend` | Plain files. Used for local dev, tests, and `BACKUP_DIR`. |
| Choosing a target | `server.ts` → `openBackupMirror` | Tries `BACKUP_DIR`, then the bucket (`BACKUP_BUCKET`, else `allaboard-data` when `K_SERVICE` is set **and** `NODE_ENV=production`). **The first one whose probe succeeds wins**, and the rest are logged as skipped. |
| Restore | `server.ts` → `restoreFromBackup` | At boot, **before listening**: copies every backed-up room into SQLite. Images are restored lazily by `GET /api/assets/:hash`. |

**Bucket layout:** `rooms/<roomId>.json.gz` and `assets/<sha256>`. The old `rooms-store.json` in the bucket
root is legacy and harmless.

**Known fragility:** automatic bucket backups need `NODE_ENV=production` on `app-container`, which comes from
AI Studio's template. If a publish ever drops it, the log shows `Backups are OFF`. Fix that in code; don't add an env var.

---

## 5. After every publish: the 60-second check

1. **Cloud Run → allaboard → Observability → Logs**, then search `Backing up`. You want:
   ```
   Backing up rooms to bucket "gs://allaboard-data".
   Restored N room(s) from backup.
   ```
2. If you're unsure, draw in a room, wait **≥ 10 s**, and refresh the bucket browser. `rooms/<room>.json.gz` should
   be there with a fresh timestamp.

## 6. Symptom → cause table

| You see | Cause | Fix |
|---|---|---|
| `failed to start and listen on the port defined … PORT=8080` | App crashed before listening, or `PORT` is wrong | Read the app-container logs. Check that `PORT=3000` is on app-container (R3). |
| `STARTUP TCP probe failed … on port 3000` | `PORT=3000` missing from app-container | Re-add `PORT=3000` (R3) |
| `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at boot | TS-only syntax in server code | Remove it (R2). Add the plain-node check to the PR. |
| `Backup target folder "/backup" is unusable, skipping` | Stale `BACKUP_DIR` from an old console setting | Harmless (falls through to the bucket). Optionally delete the env var. |
| `Backup target bucket … unusable … HTTP 403` | SA lost `roles/storage.objectUser` on `allaboard-data` | Bucket → Permissions → grant it again |
| `Backups are OFF: rooms will NOT survive…` | No usable target: no `K_SERVICE`, no `NODE_ENV=production`, or every probe failed | Read the skipped-target lines above it |
| Room empty after republish, bucket has no `rooms/` folder | Backups never ran on the old revision | Check the logs from the **previous** revision for the lines in §5 |
| `EACCES … mkdir '/data'` | Stale `DATA_DIR=/data` | Harmless (`RoomStore` falls back to the temp dir). Optionally delete it. |

---

## 7. Working with AI agents on this repo (process lessons)

- **Plans for implementing agents (Terra/Codex/Antigravity) must be pre-validated**: apply the plan verbatim
  to a scratch copy and run **every phase's checkpoint on its own**, not just the final state. One plan's
  Phase 2 could never pass because it deleted a variable that Phase 3 code still used.
- Once a change is fully written and tested, **have the agent review it rather than retype it**. Retyping adds
  cost and drift without adding checking.
- **Verify AI Studio's / Gemini's explanations before acting on them.** Their fixes were often fine, but their
  root-cause stories were wrong several times (wrong Node version theory, `/tmp` advice, probe-port advice).
- Simulating production locally: `K_SERVICE=allaboard NODE_ENV=production node server.ts`. Without Google
  access the bucket probe fails fast with `ENOTFOUND metadata.google.internal`, and the server still starts.
  (Don't use `/proc/...` as an "unwritable" test path: Node's recursive `mkdir` hangs forever there.)

## 8. History (for context)

| PR | What |
|---|---|
| #12 | One-JSON-file → SQLite, one row per room, plus deduplicated worksheet assets (a 30-board breakout sync went from ~126 MB to 11 KB per client) |
| `d815c59` | (AI Studio) guarded `node:sqlite` import, temp-dir fallback, `start: node server.ts` |
| #15 | Backup to a mounted bucket via `BACKUP_DIR`. **Broken by R1:** AI Studio dropped the mount. |
| #16 | Backup over the Cloud Storage API with the bucket name in code |
| #17 | Fall through to the bucket when a stale `BACKUP_DIR` is unusable. **First confirmed working backup** (room `667`). |
