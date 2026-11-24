# AllAboard — System Architecture (read this first if you're new here)

> **Audience:** any agent or developer arriving "blind." This is the map. For deployment and persistence
> rules, read **[`DEPLOYMENT.md`](DEPLOYMENT.md)**. Those rules are non-negotiable and were learned the hard way.
> For planned work, see **[`../TODO.md`](../TODO.md)**. Written Nov 2026 from a long working session (PRs #12–#20).
> If the code disagrees with this file, trust the code and **update this file**.

---

## 1. What it is

A **real-time multiplayer classroom whiteboard**: an infinite canvas with pen, highlighter, text, shapes and stamps;
PDF/image **worksheets** as non-erasable backgrounds; **breakout rounds** (individual or group boards); IRC-style
chat; a class timer; and teacher moderation (lock canvas, kick/ban, rename, purge a student's work). Sister
project of **OverBoard** (`src/lib/inkCore.ts` is ported from it).

**Design values to preserve:**
- **No accounts. No install.**
- **Runs on a cheap school Chromebook** in the browser.
- **Rooms export as plain files the teacher keeps.**

Teachers are identified by a per-room **PIN**, not a login.

## 2. Stack

| Layer | What |
|---|---|
| Client | React 19, TypeScript, Vite 6, Tailwind 4, **Konva / react-konva** (canvas), `pdfjs-dist` (PDF → images in the browser), `lucide-react`, `motion` |
| Server | One Node process: Express + **Socket.IO 4** (`server.ts`). In dev it serves Vite as middleware; in prod it serves `dist/`. |
| Storage | **SQLite via built-in `node:sqlite`** (`roomStore.ts`), plus a **write-behind backup to Cloud Storage** (`backupMirror.ts`) |
| Hosting | **Cloud Run**, deployed by GitHub Actions (`.github/workflows/deploy.yml`, Buildpacks) on every push to `main` (see DEPLOYMENT.md). Prod start is **`node server.ts`, with Node's type stripping, not tsx**. |
| Tests | `node:test` via `tsx` (`npm test`, ~99 tests), **Playwright** e2e (`npm run test:e2e`, ~20), `tsc --noEmit` (`npm run lint`). CI: `.github/workflows/ci.yml` (Node 22). |

## 3. Repo map

| File | Lines | Role |
|---|---|---|
| `server.ts` | ~2000 | **Everything server-side:** room state, all socket handlers, permissions, breakouts, timer, persistence wiring, `/api/assets/:hash`, `/healthz`, startup/shutdown. Exports `startServer(options)` (used by tests). |
| `roomStore.ts` | ~350 | SQLite store: one row per room plus content-addressed assets (`assets`, `room_assets`). Has a JSON fallback if `node:sqlite` is missing. Fails open to `os.tmpdir()`. |
| `backupMirror.ts` | ~375 | `BackupMirror` (batch, assets-first, retry, flush on SIGTERM) over `BackupBackend`: `GcsBackend` (Cloud Storage JSON API + metadata token) or `DirBackend` (folder). |
| `src/App.tsx` | ~1800 | Client root: identity (`localStorage`), socket lifecycle, **all client state** (elements, messages, subBoards, settings), lobby/welcome screen, handlers passed down as props. |
| `src/components/Canvas.tsx` | ~5200 | The whiteboard: Konva stage, tools, selection/lasso, worksheet layer, stamps (`STAMP_OPTIONS`), teacher toolbars, breakout UI, import/export JSON, PDF export. **The biggest file; search before scrolling.** |
| `src/components/CanvasModals.tsx` | ~1070 | Breakout manager, live grid overview (teacher sees all boards), import modal (`PendingSnapshotData`). |
| `src/components/Chat.tsx` | ~1000 | Chat sidebar (resizable/collapsible), roster, room-code bar. |
| `src/components/RoomExistsModal.tsx`, `PurgeContributionsModal.tsx` | — | Lobby collision warning; teacher "purge a student's work." |
| `src/lib/breakoutRounds.ts` | ~290 | **Pure helpers shared by client and server** for rounds/boards. Never parse board-ID strings. Use these. |
| `src/lib/lessonPack.ts`, `src/components/LessonPackModals.tsx` | — | `.allaboard` lesson packs: pure build / validate / asset helpers (used by client and server) and the **Save lesson…** / **Load lesson…** dialogs. |
| `src/lib/worksheetLoader.ts` | ~390 | PDF/image → `BackgroundPage[]` (browser-side render to JPEG data URLs). Built-in templates (`four-corners`, `frayer-model`, `checkin-columns`). `MAX_PDF_PAGES = 30` (`src/lib/pageRange.ts`). |
| `src/lib/batchPdfExport.ts` | ~590 | Export boards to PDF (renders background plus ink). |
| `src/lib/inkCore.ts` | — | Ink smoothing, highlighter/cover, text-note logic (from OverBoard). |
| `problemReportRoute.ts`, `src/lib/problemReport.ts`, `src/components/ProblemReportModal.tsx` | — | **"Something not working?"** problem reports: `POST /api/report` → OverBoard's Apps Script relay → public GitHub issue + private email. See [`REPORTS.md`](REPORTS.md). |
| `socketGuards.ts` | — | Per-socket rate limits, element size caps, Teacher PIN hashing (scrypt). See §5. |
| `staticAssets.ts` | — | Production `dist/` serving: hashed `/assets` cached 1 year (`immutable`) and gzipped once in memory; `index.html` `no-cache`. |
| `src/lib/pointBatcher.ts`, `src/lib/drawThrottle.ts`, `src/lib/boardDigest.ts` | — | Client-side coalescing of streaming ink (send every 50 ms, apply incoming once per frame) and the network pacing constants (ink 500 ms, cursor 250 ms). Teacher overview digests (1.5 s). |
| `scripts/loadtest.ts` | — | `npx tsx scripts/loadtest.ts --mode main\|individual --client legacy\|batched` — N fake drawing students, prints msg/s in and out and server CPU. |
| `src/lib/roomCode.ts` | — | `normalizeRoomCode` (**must match** server `normalizeRoomId`), `sanitizeRoomCodeDraft`. |
| `src/lib/chatSidebar.ts` | — | Chat sidebar sizing constants plus `localStorage` keys. |
| `src/types.ts` | — | Shared types (`CanvasElement`, `RoomBackground`, `BreakoutConfig`, `RoomSnapshot`, …). |
| `tests/*.test.ts` | — | Server integration (`server.test.ts`, real sockets against `startServer`), store, backup (incl. `fakeGcs.ts`), breakout helpers, ink, PDF export, chat. |
| `e2e/*.spec.ts` | — | Playwright: classroom flows, worksheets. `e2e/serve.ts` starts the server. |
| `PLANS_*.md` | — | **Historical** implementation plans (already executed). Useful as examples of the plan format; they don't describe pending work. |

## 4. Runtime topology

```
Browser (React + Konva)
  │  Socket.IO (real-time state)         HTTP GET /api/assets/<sha256> (worksheet images, immutable cache), POST /api/report
  ▼                                       ▼
Cloud Run service "allaboard"  ── one container :3000 (node server.ts, Buildpacks)
                                                                        │
                                       in-memory Map<roomId, RoomState>  (hot state, source of truth while running)
                                                                        │ dirty-room flush ≤ 2 s
                                                         SQLite on local disk (wiped on cold start/redeploy)
                                                                        │ write-behind ≤ 10 s, flush on SIGTERM
                                                         gs://allaboard-data  rooms/<id>.json.gz, assets/<sha256>
```

- **Max instances = 1** (required: room state lives in one process, and there's no Socket.IO adapter).
- **Startup order:** open SQLite → open backup (probe; fail open) → migrate legacy `rooms-store.json` → **restore all rooms
  from the backup into SQLite** → listen. Rooms are then **lazy-loaded** into memory on join or `check-room` (`findRoom`) and
  **unloaded** after 15 min with no sockets.
- **Housekeeping every 5 min:** flush, unload idle rooms, delete rooms idle > **7 days** (`ROOM_TTL_MS`, from SQLite and the
  backup), GC unreferenced assets (1 h grace).

## 5. Identity, roles, trust

- **User identity:** `usr_…` id and a private random `userKey`, both generated in the browser and kept in `localStorage`,
  sent on `join-room` along with name and colour. The first key used for an id in a room claims it; the server keeps only
  its SHA-256 (`room.userKeyHashes`) and answers a wrong or missing key with `room-kicked { reason: 'identity' }`. There are
  still no accounts: display names aren't unique, and an id nobody has claimed in that room can be claimed by anyone.
- **Teacher:** per room, via `teacher:auth { pin }` (or `teacherPin` on `join-room`). **The first PIN claims the room**
  (`mode: 'claimed'`, at least `MIN_TEACHER_PIN_LENGTH` = 4 characters), and later matching PINs verify. The server
  stores only `teacherPinHash` (`scrypt:<salt>:<hash>`, random salt per room, `socketGuards.ts`). A legacy plain-text
  `teacherPin` (some rooms have 3 characters; they still verify) is hashed when its room loads and the row is rewritten
  at once. **10 wrong PINs per room per 5 minutes**, from any sockets, blocks PIN checks for that room; a teacher
  whose browser key already matches doesn't need the PIN. The PIN is cached in the teacher's `localStorage` per room.
  `isTeacher` lives on the server's per-user record, and every teacher-only handler checks it.
- **Guards against a misbehaving client** (`socketGuards.ts`, wired in at the top of `io.on('connection')`):
  - Each socket's handlers run **one at a time, in arrival order**, even async ones, and a thrown error is logged, never
    left uncaught. (One instance: an uncaught throw takes every room down. `push(...hugeArray)` used to do exactly that.)
  - **Per-socket rate limits** by event class (`RATE_LIMITS`: draw 60/s, cursor/laser 50/s, chat 1/s, other 20/s, each
    with a burst). Over the limit the packet is dropped (acks get `{ ok: false }`), never the connection. Drops are
    counted in the `[load]` log line and the first per socket is logged as `[ratelimit]`.
  - **Size caps:** points must be finite numbers (≤ 4,000 per append, ≤ 50,000 per stroke), text ≤ 20,000 chars, other
    fields small, ≤ 2,000 elements per batch, **≤ 10,000 elements per board** (the sender gets `state-sync` +
    `board-full`), chat ≤ 2,000 chars.
  - **Board chat** (`chatScope: 'board'`) goes only to that board's channel and teachers; students may post only to
    main or their own board, and get other boards' chat stripped (like their ink) until they move there.
- **Moderation state per room:** `lockedNames`, `bannedUsers`, `isCanvasLocked`.
- **⚠️ Known trust gaps (see TODO):**
  - Elements are stored **as the client sent them**, apart from `userId`/`userName` (set by the server), teacher-only
    stamps (refused for students) and the size caps above. **Check any new "teacher-only" element field server-side.**
  - `data:` URLs are only converted to assets for **backgrounds**. Elements carrying images would bloat state.
  - Socket.IO `cors: { origin: '*' }` and `maxHttpBufferSize: 30 MB` (needed because uploads travel as base64 over the socket).

## 6. Room data model (server `RoomState`, persisted as `SerializedRoom`)

| Field | Meaning |
|---|---|
| `id` | Normalized room code: `trim → lowercase → [^a-z0-9-_]→"-" → collapse "-" → trim "-" → '' means "main"` |
| `elements`, `messages`, `background` | The **main board**: ink and objects, chat (capped at 500), worksheet |
| `subBoards: Map<boardId, SubBoardState>` | Breakout boards. Each has `elements`, `messages`, `background`, `assignedUserIds`, `roundId`, `kind` (`individual`/`group`) |
| `breakoutConfig` | `mode` (`main`/`individual`/`groups`, i.e. where students are **now**), `activeRoundId`, `rounds[]`, `allowSelfSelect`, `chatScope`, `userBoardOverrides` |
| `roundTemplates[roundId]` | The worksheet each round's boards start with (copied to late joiners). Sent to **teachers only** (`init`, `breakout-sync`, `round-templates-sync`) and saved in room exports. |
| `roundTemplateInk[roundId]` | **Template ink**: teacher Main ink (no name stamps) a round copies onto each of its boards, with new ids and the teacher as author so students can't erase it. Individual boards get it as they're made (late joiners too); group boards at launch. Set by `copyInk` with `copyWorksheet` on `new-round` / `edit-prepared`. Teachers only, like `roundTemplates`; in room exports and lesson packs (`LessonRound.ink`). |
| `roundVariants[roundId]` | **Worksheet variants** for an individual round: worksheets B–D (A is always `roundTemplates[roundId]`), the rule (`same` / `rotate` / `corner` + corner map), the late-joiner rule, per-student picks by lowercased name, and `assigned` (userId → letter, session data). Used when each board is made (`provisionIndividualBoard`; launch deals out alphabetically). Set by `variants` on `new-round` / `edit-prepared` and by `teacher:set-round-variants` (Send worksheet…). Teachers only; in room exports and lesson packs without `assigned` (picks only when the teacher opts in). |
| `timer`, `lockedNames`, `bannedUsers`, `isCanvasLocked`, `hideStudentCursors`, `teacherPin`, `lastActiveAt` | As named |
| `usersByUserId` | **Runtime only** (not persisted): roster, `sockets` set, `isTeacher`, student status |

**Breakout rounds** (`teacher:configure-breakout` with `action`):
- `new-round` creates round N+1 with fresh boards (ids like `r2_ind_<userId>`, `r2_grp_1`). Its worksheet is either
  `copyWorksheet` (copies main) or `customBackground`. An optional `title` becomes the label in the round title.
- `new-round` with `prepare: true` makes a **prepared round**: `prepared: true` on its meta, its worksheet in
  `roundTemplates`, its own `allowSelfSelect` / `chatScope`, group boards for a group round, **no** individual boards,
  and it leaves `mode`, `activeRoundId` and the room's settings alone. Nobody moves.
- `resume` re-activates a round. On a prepared round it **launches** it: `prepared` is dropped, `launchedAt` set, and
  the round's stored settings applied (the payload's own values win).
- `edit-prepared` changes a prepared round's title, worksheet, settings and groups (titles, members, count: boards
  `1..min(old,new)` keep their ink). Its mode can't change.
- `delete-prepared` removes a prepared round, its boards and its worksheet. Launched rounds can't be deleted.
- `update-current` edits groups and settings.
- `return-to-main` sets `mode='main'` only.
- The client lists launched rounds with `getLaunchedRounds` and prepared ones with `getPreparedRounds`. A prepared
  round is never the active round.

**Rules:**
- `resume` / `update-current` / `return-to-main` **never touch board contents**.
- **Never infer anything from a board-ID string.** Use `roundId` and `kind` via `src/lib/breakoutRounds.ts`. Legacy ids
  (`ind_x`, `grp_1`) exist and are migrated to round `r1`.

## 7. Real-time protocol (Socket.IO)

**Client → server:**
- Room and identity: `check-room` (ack, no side effects), `join-room`, `update-profile`, `user:set-status`, `cursor-move`, `disconnect`
- Teacher actions: `teacher:auth`, `teacher:step-down`, `teacher:configure-breakout` (actions above), `teacher:set-background`,
  `teacher:set-background-multi` (one worksheet to many boards; optional `roundTemplateFor` sets the round template),
  `teacher:set-round-variants` (ack; an individual round's worksheets B–D, rule and picks, `src/lib/roundVariants.ts`),
  `teacher:update-background`, `teacher:rename-user`, `teacher:delete-message`, `teacher:unban-user`,
  `teacher:purge-user-contributions`, `teacher:set-lock`, `teacher:set-hide-cursors`, `teacher:set-one-name-stamp`, `teacher:clear-status`, `teacher:spotlight-board`, `laser-pulse`, `teacher:clear-all`, `teacher:import-room`
- Lesson packs (teacher-only, ack; `src/lib/lessonPack.ts`): `teacher:export-lesson` (server builds the skeleton,
  `assets: {}`; the browser embeds images), `teacher:has-assets` (≤ 1,000 URLs → `missing`), `teacher:upload-asset` (one
  PNG/JPEG/WebP `data:` URL per emit, checked with `sniffMime`; never SVG), `teacher:load-lesson` (`target: 'new'` makes a
  room with a PIN; `'current'` only from main). Load order: upload missing images first, then the small lesson, so any
  pack size fits the 30 MB socket limit. The server re-validates, assigns every round, board and element id, makes every
  round prepared, never sets `mode`/`activeRoundId`, and broadcasts like `teacher:spotlight-board` (not `room-restored`).
- Breakouts: `breakout:join-board`
- Chat: `chat-message`
- Drawing: `element-start`, `element-append-points` (streaming ink), `element-update`, `elements-batch-update`,
  `elements-batch-add`, `elements-batch-remove`, `element-remove`, `undo`, `clear-user-drawings`

**Server → client:**
- Full state: `init` (everything on join), `state-sync`, `room-restored` (after import)
- Room-level updates: `roster-sync`, `room-settings`, `breakout-sync`, `background-sync`, `board-replaced`,
  `round-templates-sync` (teachers only)
- Drawing deltas: `element-*` / `elements-batch-*` deltas, `cursor-move` / `cursor-leave`, ephemeral teacher `laser-pulse`
- Chat and moderation: `chat-message`, `message-deleted`, `user-renamed`, `user-contributions-purged`, `room-kicked`

**Patterns:**
- The client applies changes **optimistically**. The server validates (lock, ownership, teacher) and rebroadcasts. Deltas
  go out with `socket.to(...)` (excludes the sender); authoritative updates with `io.to(...)`.
- **Board channels.** Ink deltas, `state-sync` and `cursor-move` go to `boardAudience(roomId, boardId)`: only the sockets
  **viewing** that board. Students view their assigned board (`findStudentBoardId`); a teacher views whatever board
  they picked and the client tells the server with `teacher:view-board` (on every change and after each `init`).
  Each socket sits in exactly one board channel (`placeSocket`), re-checked whenever `broadcastRoster`,
  `broadcastRoomSettings` or `broadcastBreakoutSync` runs. A socket that changes board is sent a fresh `state-sync` of
  it; one that becomes a teacher gets full `state-sync` + `breakout-sync`. Roster, settings, chat, backgrounds and
  `breakout-sync` are still room-wide.
- **Teacher overview digests.** Teachers don't get live traffic for boards they aren't viewing. Instead, every
  `OVERVIEW_SYNC_MS` (1.5 s, `src/lib/boardDigest.ts`) each teacher gets one `boards-digest` with the **changed elements**
  of every other board (`upserts`/`removed`, or the whole board after a clear or reorder). That's enough for the live
  grid and moderation. **If you add a delta event, send it to `boardAudience` *and* call `noteChange`.**
- **Students only hold their own board's ink.** `init` and `breakout-sync` are built per socket (`subBoardsFor`):
  teachers get every board; students get every board's metadata, background and chat, but `elements: []` except on
  their own board (`placeSocket` sends the real contents when they move). So a student's Save .JSON contains only their
  own board's ink, and a teacher's copy of boards they aren't viewing is ≤ 1.5 s old. (`room-restored` after an import
  is still full, room-wide.)
- **Ink pacing (client).** `element-append-points` is queued and sent every 500 ms (`POINT_FLUSH_MS`); any other drawing emit goes through
  `emitDrawing`, which flushes the queue first so the server sees actions in order. Incoming points are applied once per
  animation frame; an `onAny` hook flushes them before any other event is handled. Cursors: at most 4/s plus a trailing send.
- **Cursor batching (server).** `cursor-move` is not relayed. The server keeps each user's latest position per board
  channel (only the channel the socket is actually on) and sends each board one `cursors-batch { cursors }` every
  `CURSOR_EMIT_MS`. The batch includes the receiver's own cursor; the client skips its own `userId`. This turns
  N senders × N viewers messages into one per viewer per tick.
  Measured (20 students, 40% pen-down): outbound 16.7k → 6.4k msg/s on the main board, → ~1 msg/s in individual
  breakouts (the teacher gets ~1 digest/s instead of ~800 msgs/s).
- Teacher actions use **ack callbacks** returning `{ ok, error? }`.
- Every mutation sets `room.lastActiveAt` and calls `scheduleSaveToDisk(room[, immediate])`.

## 8. Persistence and assets (summary; details in DEPLOYMENT.md §4)

1. **Hot state:** in-memory `RoomState`.
2. **Dirty-room flush (≤ 2 s):** `scheduleSaveToDisk(room)` adds the room to `dirtyRooms`. The flush writes **only those
   rooms** (one SQLite row each). Before #12 this was one giant JSON rewrite of every room, which blocked the event loop.
3. **Assets (content-addressed):** any worksheet `data:` URL is **interned**: decoded, sha256'd, stored once, and replaced
   with `/api/assets/<hash>`. `BackgroundPage.dataUrl` holds either form. This is why a 30-board breakout sync went from
   ~126 MB to ~11 KB per client.
   - **Interning points:** `teacher:set-background`, `teacher:update-background`, `cloneBackground` (round templates and
     every board copy), `teacher:import-room`, `teacher:upload-asset`, legacy migration, and a **safety net on every flush** (`internRoomAssets`).
   - `room_assets` and the backup find references by **regex over the room JSON**, so any future element that references
     `/api/assets/…` is tracked automatically.
4. **Backup (≤ 10 s, immediate on SIGTERM)** to `gs://allaboard-data` over the JSON API. Images are written before rooms.
   Restored at boot, with images restored lazily.
5. **Exports** (`handleExportJSON`) are **snapshot v2**: the room JSON plus an `assets` map `{url → data URL}` embedding each
   image once, so files stay portable. Imports accept v1 (inline base64) and v2.

## 9. Testing notes

- `tests/server.test.ts` starts a **real server** per test (`startServer({ port: 0, dataDir: tmp, skipVite: true })`) and
  drives it with `socket.io-client`. Helpers: `joinTracked`, `emitAck`, `waitForEvent`. `startServer` returns
  `{ store, backup, flushRoomsToDiskAsync, close, … }` for assertions.
- Backups are tested against `DirBackend` **and** `GcsBackend` via `tests/fakeGcs.ts` (an in-memory JSON API fake with
  paging and forced failures). Inject one with `startServer({ backupBackend })`.
- **Tests run under `tsx`, and production runs under Node type stripping.** Always also run
  `node -e "import('./server.ts').then(() => console.log('OK'))"`.
- To simulate production locally: `K_SERVICE=allaboard NODE_ENV=production node server.ts`. The bucket probe fails fast
  off-GCP, and the server still starts.
- **Gotcha:** Node's recursive `mkdir` **hangs forever under `/proc`**. Use a path whose parent is a regular file to
  simulate "unwritable."

## 10. Working agreements for agents

- **Read `DEPLOYMENT.md` before touching** server startup, storage, env vars, or anything Cloud Run.
- **Merging to `main` ships to production** (`deploy.yml`). Service settings live in that workflow; configuration that
  matters lives **in code**, not in console edits.
- **`.env.example` documents local-dev variables only.** Production config lives in `deploy.yml` and in code.
- **No client-side secrets.** The AI Studio template's `vite.config.ts` `define` that baked `GEMINI_API_KEY` into the
  public bundle has been removed. Never add a `define` (or a `VITE_*` variable) holding a key: anything in the client
  bundle is public.
- **Plans for other agents** (Codex/Terra/Antigravity) use the `PLANS_*.md` format: phases, exact code, a checkpoint per
  phase. **Pre-validate every checkpoint independently** on a scratch copy. Once code is fully written and tested, ship
  it and have the agent **review** rather than retype.
- **Verify AI-assistant root-cause claims** (Gemini Cloud Assist, AI Studio) against logs and code. Their fixes were often
  fine, but their explanations were wrong several times.
- **Frontend-only changes** (lobby, chat, canvas UI) can't affect persistence. Still do the 60-second log check after
  a deploy (DEPLOYMENT.md §5).

## 11. Glossary

| Term | Meaning |
|---|---|
| **Main board** | The room's shared canvas (`room.elements` / `room.background`) |
| **Sub-board / breakout board** | A board in `subBoards`, belonging to a round, of kind `individual` or `group` |
| **Round** | One breakout activity (`breakoutConfig.rounds[]`, ids `r1`, `r2`, …), with its own boards and worksheet template |
| **Worksheet / background** | `RoomBackground`: pages of images under the ink, non-erasable, teacher-controlled |
| **Asset** | An image stored once by sha256, served at `/api/assets/<hash>` |
| **Interning** | Converting an inline `data:` image into an asset URL |
| **Snapshot v1/v2** | Room export format. v2 embeds each asset once in an `assets` map. |
| **Lesson pack** | A `.allaboard` file (JSON, `kind: 'allaboard-lesson'`): main worksheet and teacher ink, rounds as definitions (worksheet, group names, never members), settings, embedded images. No student data. `src/lib/lessonPack.ts` |
