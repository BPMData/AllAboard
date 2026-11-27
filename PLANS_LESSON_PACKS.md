# Plan: prepared breakout rounds and `.allaboard` lesson packs

> **For the agent implementing this:** read `CLAUDE.md` and `docs/ARCHITECTURE.md` first. **Every merge to `main`
> deploys to production**, so open one PR per phase and do not merge it yourself. Build **after PR #59 (Send
> worksheet) merges** and rebase on it: phase 1 reuses its `buildWorksheetBackground` helper, and both touch
> `CanvasModals.tsx` and the breakout handlers in `server.ts`. Phase 1 ships on its own. Phase 2 needs phase 1.
> Phase 3 is optional and waits on decision D1.

## Goal

A teacher builds a lesson once (main-board worksheet and instructions, several breakout rounds with their own
worksheets and groups, room settings) and saves it as **one `.allaboard` file**. Later, or on another teacher's
computer, **Load lesson…** sets all of it up in a fresh room. **No student moves until the teacher launches a round.**
The file never contains student data.

Today none of this works, for two reasons:

1. **A round can't exist without being live.** `teacher:configure-breakout` `'new-round'` (`server.ts` ~line 1350)
   always sets `mode` and `activeRoundId`, so every student moves at once.
2. **The room export isn't a lesson.** `buildSnapshotJson` (`Canvas.tsx` ~line 2374) saves student boards, chat and
   the roster, and it can't save round worksheets because `room.roundTemplates` never leaves the server.

## What the code says (corrections to the first sketch)

These came up while reading the code. Each changes the plan.

- **Round worksheets are server-only.** `RoomState.roundTemplates` is marked "Server-only; not broadcast", and
  neither `init` nor `breakout-sync` carries it. The client can't build a lesson from what it holds, so the server
  builds the lesson skeleton (`teacher:export-lesson`, phase 2) and teachers start receiving `roundTemplates` (phase 1).
- **Room saves already lose round worksheets.** `teacher:import-room` in `replace` and `readonly` mode sets
  `room.roundTemplates = {}`, and the snapshot has no field for them. Late joiners then fall back to "any individual
  board's background" (`getRoundTemplate`). With prepared rounds, which have no boards yet, the worksheet would be lost
  outright. Phase 1 fixes this.
- **Room saves miss one image.** `buildSnapshotJson` embeds assets from the main board and sub-boards only, not
  `breakoutConfig.autoIndividualBackground`. A room saved with "students start on their own boards" loads with a
  broken worksheet on a server that doesn't already have the image. Phase 1 fixes this.
- **Group assignments are student data.** A group's `assignedUserIds` are browser user ids from today's roster. They
  mean nothing in another class, so a pack keeps **group titles only**, and the teacher assigns students at launch.
- **A prepared individual round has no boards.** Individual boards are made per student by
  `provisionIndividualBoard`, at launch or when a student joins. So "pre-written ink on a round's worksheet" has no
  board to live on for individual rounds. That's why template ink (phase 3) needs its own storage. Prepared group
  rounds do have boards.
- **Launching an unassigned group round puts everyone in Group 1.** `findStudentBoardId` falls back to the first
  group. Launching a prepared group round must go through the group editor.
- **`new-round` overwrites room-wide settings.** It rebuilds `room.breakoutConfig` with the payload's `allowSelfSelect`
  and `chatScope`. A prepared round stores its own and applies them at launch.
- **An HTTP upload endpoint doesn't fix the size limit by itself.** Cloud Run caps an HTTP/1 request body at 32 MiB
  (`deploy.yml` doesn't enable HTTP/2), about the same as the socket's 30 MB `maxHttpBufferSize`. Zip only removes the
  base64 overhead (~25%), because JPEG pages don't compress. See "Size" below: the recommendation is to upload images
  one at a time before the lesson.
- **`teacher:import-room` doesn't validate elements.** It skips `elementFieldsOk` and `MAX_BOARD_ELEMENTS`. A lesson
  file can come from another teacher, so lesson loading must validate.
- **Doc drift:** `docs/ARCHITECTURE.md` says `MAX_PDF_PAGES = 10`. It's 30 (`src/lib/pageRange.ts`). Fix it while
  you're in that file.

---

## Phase 1: prepared ("draft") breakout rounds

### Types (`src/types.ts`)

```ts
export interface BreakoutRoundMeta {
  // existing: id, number, title, mode, createdAt
  prepared?: boolean; // true until launched. Absent on every existing round.
  launchedAt?: number;
  allowSelfSelect?: boolean; // applied to breakoutConfig when launched
  chatScope?: 'unified' | 'board'; // applied to breakoutConfig when launched
}

export type BreakoutAction = /* existing */ 'edit-prepared' | 'delete-prepared';

export interface ConfigureBreakoutPayload {
  // existing fields, plus:
  prepare?: boolean; // 'new-round': create it without moving anyone
  title?: string; // 'new-round' / 'edit-prepared': teacher's own round name, ≤ 40 chars
}

export interface RoomSnapshot {
  // existing fields, plus:
  roundTemplates?: Record<string, RoomBackground | null>;
}
```

`normalizeBreakoutConfig` already keeps whole round objects (it filters, it doesn't map), so the new fields persist.
Still coerce them there: `prepared` and `allowSelfSelect` to booleans, `chatScope` to `'board' | 'unified'`, and drop
`launchedAt` if it isn't a number.

### Shared helpers (`src/lib/breakoutRounds.ts`)

```ts
export function isPreparedRound(r: BreakoutRoundMeta): boolean; // r.prepared === true
export function getPreparedRounds(config: BreakoutConfigLike): BreakoutRoundMeta[];
export function getLaunchedRounds(config: BreakoutConfigLike): BreakoutRoundMeta[];
```

`buildRoundTitle(number, mode, label)` stays. When the payload has a `title`, use it as the label.

### Server (`server.ts`, `teacher:configure-breakout`)

1. **Extract** the `'new-round'` branch into `function createRound(room, payload, prepared: boolean)` returning
   `{ ok: true, roundId } | { ok: false, error }`, with no change in behavior when `prepared` is false.
2. **`new-round` with `prepare: true`:**
   - Same validation (a group round still needs at least one group), same `makeRoundId(getNextRoundNumber(cfg))`, same
     `room.roundTemplates[roundId] = cloneBackground(templateBg)`.
   - The meta gets `prepared: true`, `allowSelfSelect` and `chatScope` from the payload.
   - **Individual:** create **no boards**.
   - **Groups:** create the group boards exactly as now (titles, `cloneBackground(templateBg)`), keeping any
     `assignedUserIds` sent (cleaned by `uniqueStrings` + the existing `seen` set). Usually that's `[]`.
   - **Don't touch** `cfg.mode`, `cfg.activeRoundId`, `cfg.allowSelfSelect`, `cfg.chatScope`, `userBoardOverrides`.
     Only `cfg.rounds = [...getRounds(cfg), meta]`.
   - Ack adds `roundId`.
3. **Launch = `resume` on a prepared round.** The existing `resume` path already sets `activeRoundId` and `mode` and
   provisions individual boards. Add, before `applyRoundEdits`: if the round is prepared, replace it in `cfg.rounds`
   with `{ ...round, prepared: undefined, launchedAt: Date.now() }` (rebuild the array; don't mutate shared objects),
   and set `cfg.allowSelfSelect` / `cfg.chatScope` from the round's stored values. The payload's own values, applied by
   `applyRoundEdits` right after, win.
4. **`edit-prepared`** (`roundId` required, round must be prepared, else `{ ok: false }`):
   - `title` → rebuild `meta.title` with `buildRoundTitle`.
   - `customBackground` or `copyWorksheet` → set `room.roundTemplates[roundId]`, and for group rounds also each group
     board's `background` (own copy each), emitting `background-sync` per board.
   - `allowSelfSelect`, `chatScope` → stored on the meta.
   - `groups` (group rounds): titles and assignments as `applyRoundEdits` does. If the **count** changes, keep boards
     `1..min(old,new)` with their ink and create or delete the rest with `makeGroupBoardId`. Never parse ids.
   - Changing `mode` isn't allowed. Delete and recreate instead.
5. **`delete-prepared`** (`roundId`, round must be prepared): remove the meta, every board with that `roundId`, and
   `room.roundTemplates[roundId]`. Launched rounds can't be deleted here.
6. **All of the above:** `room.lastActiveAt = Date.now(); scheduleSaveToDisk(room, true); broadcastRoomSettings(room);
broadcastBreakoutSync(room);` as the handler already does at the end.
7. **Teachers receive round worksheets.** Add `roundTemplates` to `breakout-sync` and `init` **for teachers only**
   (`meta.inTeachers` in `broadcastBreakoutSync`, `isVerifiedTeacher` in the `join-room` `init`, and the teacher's
   `state-sync` + `breakout-sync` when they become a teacher). Values are interned asset URLs, so it's small. Students
   never get it.
8. **Room saves keep round worksheets.** `teacher:import-room` accepts `roundTemplates`. In `replace` / `readonly`,
   use the imported map (each value through `cloneBackground`, keys kept only if a round with that id exists) instead
   of `{}`. Keep `{}` when it's absent (old files). `merge` adds templates only for rounds it adds.

Type-stripping rules apply (no `enum`, `namespace`, parameter properties, `import x = require()`). Run
`node -e "import('./server.ts').then(() => console.log('OK'))"`.

### Client

- **`App.tsx`:** store `roundTemplates` from `init` / `breakout-sync` (teachers only) and pass it down with
  `breakoutConfig`. `handleConfigureBreakout` returns the ack's `roundId`.
- **`Canvas.tsx` `buildSnapshotJson`:** add `roundTemplates` to the snapshot, and collect asset URLs from
  `breakoutConfig.autoIndividualBackground` and every `roundTemplates` value as well. Extract the collect-and-fetch
  loop into `embedAssets(backgrounds: (RoomBackground | null | undefined)[]): Promise<Record<string, string>>` in
  `src/lib/roomSnapshot.ts`; phase 2 reuses it. `handleConfirmImport` sends `roundTemplates` through.
- **Everywhere rounds are listed** (round tabs in `LiveGridOverview`, the round switcher near `Canvas.tsx` ~4800 and
  ~5543, the Send worksheet modal from PR #59): use `getLaunchedRounds`. Prepared rounds appear only in the list below.
- **`BreakoutManagerModal` (`CanvasModals.tsx`):**
  - In "new round" mode, add a **Round name** field (optional) and a second button, **Save for later**, beside
    **Launch Round N**. It sends the same payload plus `prepare: true` and `title`, then stays open and shows the new
    round in the list.
  - Add a worksheet choice **Upload a file…** next to the built-in templates: `processWorksheetFile` +
    `buildWorksheetBackground` (PR #59), with the same `accept` list and the `MAX_PDF_PAGES` note.
  - **Prepared rounds list** at the top of the modal when any exist: one row each with title, Individual/Groups,
    worksheet file name (from `roundTemplates`), group count, and buttons **Launch**, **Edit**, **Delete** (Delete asks
    for a second tap, like "Remove worksheet").
    - **Launch (individual):** `{ action: 'resume', roundId }`, then close and open Live Grid, as today.
    - **Launch (groups):** switch the modal to the edit view with that round selected and the group editor open. The
      primary button reads **Launch "<title>"** and sends `{ action: 'resume', roundId, groups }`. It's disabled while
      every group is empty, with the hint "Assign students first, or turn on self-select".
    - **Edit:** the same form as "new round", prefilled, sending `edit-prepared`.
  - A prepared group round's boards can be opened and drawn on like any board. That ink stays when the round launches.

### Tests

**`tests/breakoutRounds.test.ts`:** `isPreparedRound`, `getPreparedRounds`, `getLaunchedRounds`;
`normalizeBreakoutConfig` keeps and coerces `prepared`, `launchedAt`, `allowSelfSelect`, `chatScope`.

**`tests/server.test.ts`** (helpers `joinTracked`, `emitAck`, `waitForEvent`; fixtures `worksheet()` / `PNG`):

1. Prepared individual round: ack `ok` with `roundId`; `mode` stays `'main'`, `activeRoundId` unchanged, no new
   boards; a connected student's board is still `'main'`.
2. Prepared group round with 3 groups: 3 boards exist with the worksheet; nobody moves.
3. Launch the prepared individual round with `resume`: students get boards with the round's worksheet; `prepared` is
   gone and `launchedAt` is set; a late joiner gets the worksheet.
4. Launch applies the round's stored `chatScope` / `allowSelfSelect`; payload values override them.
5. `edit-prepared` changes title and worksheet; on a launched round it fails.
6. `edit-prepared` group count 3 → 2 removes `_grp_3` only; 2 → 4 adds two; ink on group 1 survives.
7. `delete-prepared` removes meta, boards and template; on a launched round it fails.
8. A student calling any of these gets `ok: false`.
9. Teachers' `breakout-sync` includes `roundTemplates`; students' doesn't.
10. Room save round trip: `teacher:import-room` with `roundTemplates` restores a prepared round's worksheet, and
    launching it afterwards gives students that worksheet.
11. Persistence: prepared rounds survive `flushRoomsToDiskAsync()` and a restart.

**`e2e/`:** teacher prepares an individual round with an uploaded PNG, a student stays on main, the teacher launches
it from the list, and the student sees the worksheet.

### Phase 1 done when

- [ ] `npm run lint`, `npm test`, the `node -e` import check, and `npm run test:e2e` pass (or failures also fail on
      `main`).
- [ ] Manual check (`npm run dev`, teacher + two incognito students): prepare an individual round and a group round
      while both students stay on main; launch the group round, assign both students, and each lands on their group;
      Save .JSON, Import .JSON into a new room, and the prepared rounds keep their worksheets.
- [ ] `docs/ARCHITECTURE.md` §6 describes prepared rounds and the two new actions. `TODO.md`: tick "Create breakout
      rounds in advance".
- [ ] PR into `main`, not merged.

---

## Phase 2: the `.allaboard` lesson pack

### File format (`src/lib/lessonPack.ts`, new, pure: no React, DOM or Node imports)

Plain JSON, the same idea as snapshot v2: images embedded once in an `assets` map keyed by `/api/assets/<hash>` URL.
The extension is `.allaboard`; the `Blob` type and Drive MIME type stay `application/json`.

```ts
export const LESSON_KIND = 'allaboard-lesson';
export const LESSON_VERSION = 1; // bump only on a breaking change; loaders refuse newer versions

export interface LessonPack {
  kind: typeof LESSON_KIND;
  version: number;
  title: string; // ≤ 80 chars
  exportedAt: number;
  exportedBy?: string; // teacher's display name; the export dialog lets them clear it
  main: { background: RoomBackground | null; elements: CanvasElement[] };
  rounds: LessonRound[]; // in launch order
  settings: LessonSettings;
  assets: Record<string, string>; // '/api/assets/<hash>' → data URL. Empty in the server's skeleton.
}

export interface LessonRound {
  key: string; // 'a', 'b', … unique in the file. Never a room round id.
  title: string;
  mode: 'individual' | 'groups';
  worksheet: RoomBackground | null;
  groups?: { title: string }[]; // groups only: titles, never assignments
  groupInk?: CanvasElement[][]; // groups only: ink drawn on each prepared group board, by index
  ink?: CanvasElement[]; // phase 3 (template ink); absent until then
  allowSelfSelect?: boolean;
  chatScope?: 'unified' | 'board';
}

export interface LessonSettings {
  oneNameStamp?: boolean;
  hideStudentCursors?: boolean;
  allowSelfSelect?: boolean;
  chatScope?: 'unified' | 'board';
  autoIndividual?: boolean; // "students start on their own boards"
  autoIndividualBackground?: RoomBackground | null;
  autoIndividualTemplateLabel?: string;
  timerDurationMs?: number;
  timerAutoLock?: boolean;
}

export function buildLessonPack(input: LessonBuildInput): LessonPack; // used by the server
export function parseLessonText(fileName: string, text: string): { lesson: LessonPack | null; error: string | null };
export function lessonAssetUrls(lesson: LessonPack): string[]; // every page URL in every background
export function rewriteAssetUrls(lesson: LessonPack, map: Record<string, string>): LessonPack;
export function lessonFileName(title: string, date?: Date): string; // 'photosynthesis-2026-11-24.allaboard'
```

**Included:** main-board worksheet; main-board ink (see `mainInk` below); every round as a `LessonRound` (prepared
rounds always; launched rounds by default, converted to definitions: worksheet from `roundTemplates`, group titles,
no board contents except prepared group boards' ink); the settings above.

**Never included:** sub-board ink and chat of launched rounds, `messages`, roster, `assignedUserIds`,
`userBoardOverrides`, `lockedNames`, `bannedUsers`, `userKeyHashes`, `teacherPinHash`, `isCanvasLocked`, live timer
state, `activeRoundId`, `mode`, student status, and every `username` (name) stamp anywhere.

**Main-board ink (`mainInk`):** `'teacher'` (default) keeps elements whose `userId` belongs to a teacher: the exporting
teacher plus any record in `room.usersByUserId` with `isTeacher`. `'all'` keeps everything except name stamps (for a
worked example). `'none'` keeps nothing. Limitation to state in the dialog: ink by a co-teacher who hasn't been in
the room since the server last restarted counts as student ink under `'teacher'`, because teacher status isn't
persisted.

`parseLessonText` checks `kind`, refuses `version > LESSON_VERSION` ("made by a newer AllAboard"), and checks shape:
strings are strings, arrays are arrays, ≤ 50 rounds, ≤ 30 groups per round, ≤ `MAX_BOARD_ELEMENTS` (10,000) elements
per list, every background has a `pages` array. It never throws. A room save (`version` 1/2, no `kind`) gets
"This is a room save. Use Import .JSON instead." `parseSnapshotText` gets the mirror message for a lesson file.

### Export

**Server: `teacher:export-lesson`** (teacher-only, ack):

- Payload `{ title?: string; mainInk?: 'teacher' | 'all' | 'none'; includeLaunchedRounds?: boolean }`.
- Ack `{ ok: true, lesson }` with `assets: {}`, built by `buildLessonPack` from `room.background`, `room.elements`,
  `getRounds(room.breakoutConfig)`, `room.roundTemplates`, the group boards, and the settings. It's small: backgrounds
  are asset URLs.
- The server builds it because only the server has `roundTemplates` and knows who is a teacher.

**Client:**

- `App.tsx` `handleTeacherExportLesson(opts)` wraps the emit, like `handleTeacherImportRoom`.
- Then `lesson.assets = await embedAssets(...)` over `lessonAssetUrls(lesson)`. **If any image fails to download,
  stop and say so.** Today's room save only logs it and produces a broken file.
- **Download:** the same `Blob` + link pattern as `handleExportJSON`, named `lessonFileName(title)`.
- **Save to Drive:** `saveJsonToDrive` with the `.allaboard` name. It already uses a resumable upload, so size is fine.
  `drive.file` only; no new scopes.
- **UI:** a **Save lesson…** item next to **Save .JSON** in the teacher toolbar (`Canvas.tsx` ~line 4306), opening
  `SaveLessonModal` in a new file `src/components/LessonPackModals.tsx`:
  - Title (default: the room name), "Include my name as author" (checked).
  - Main board: worksheet file name, and a 3-way choice for ink with counts ("Teacher ink only (42) / All ink except
    name stamps (310) / No ink").
  - Rounds: a checklist (title, mode, worksheet name), launched rounds checked by default.
  - A fixed line: "Never saved: student boards, chat, student names, groups' members, your PIN."
  - Size estimate after embedding ("about 14 MB"), then **Download** and **Save to Drive**.

### Load

Order: **upload the images first, then send the small lesson.** That's what keeps packs of any size under the socket
limit (see "Size").

**Server events (all teacher-only, ack):**

1. **`teacher:has-assets { urls: string[] }`** → `{ ok, missing: string[] }`. Cap 1,000 URLs; check each with
   `isValidAssetHash` and `store.getAsset`.
2. **`teacher:upload-asset { dataUrl: string }`** → `{ ok, url }`. Accept only `data:image/(png|jpeg|webp);base64,`,
   and refuse it if `sniffMime(bytes)` (`backupMirror.ts`) disagrees. Store with `store.internDataUrl`. One image per
   emit, so each stays far under 30 MB. Lands in rate class `'other'` (20/s); the client sends one at a time. No room
   references the asset yet; `gcAssets`' 1-hour grace covers the gap before the lesson arrives.
3. **`teacher:load-lesson { lesson, target: 'new' | 'current', newRoomId?, pin? }`** → `{ ok, roomId, rounds }`.
   - **Validate on the server**, whatever the client did: `parseLessonText` rules on the object, plus
     `elementFieldsOk` on every element and `MAX_BOARD_ELEMENTS` per list. Run every background through
     `cloneBackground` (interning any stray `data:` URL), then check every `/api/assets/<hash>` it references exists
     in `store`; if not, `{ ok: false, error: 'N worksheet images are missing. Try loading again.' }`.
   - **`target: 'new'`** (the default in the UI): `newRoomId` through `normalizeRoomId`; refuse if `findRoom(id)` finds
     it (`'That room code is taken.'`). Require `pin` of `MIN_PIN_LENGTH` to `MAX_PIN_LENGTH` characters (`socketGuards.ts`, as `teacher:auth` checks). Create with
     `getOrCreateRoom(id)` and set `teacherPinHash = await hashPin(pin)`. The calling socket stays in its current
     room; the client switches afterwards.
   - **`target: 'current'`:** refuse unless `room.breakoutConfig.mode === 'main'` ("Bring everyone to Main first").
     Existing launched rounds, their boards and chat stay. Existing **prepared** rounds are replaced.
   - **Apply** (`applyLessonToRoom(room, lesson, author)`, a plain function in `server.ts`):
     - Main: `room.background = cloneBackground(lesson.main.background)`; `room.elements` = the lesson's main elements,
       each with a new `randomUUID()` id, `boardId: 'main'`, `userId` / `userName` set to the loading teacher, fresh
       `timestamp`. Reassigning authorship makes the ink the loader's own for undo, erase and the "Ink by" filter, and
       students can't erase it (removal checks `el.userId === meta.userId || isTeacher`).
     - Rounds, in file order: `roundId = makeRoundId(getNextRoundNumber(cfg))` (**the server assigns every id**; `key`
       is never used as an id), meta `{ prepared: true, title, mode, allowSelfSelect, chatScope, createdAt }`,
       `room.roundTemplates[roundId] = cloneBackground(worksheet)`. Group rounds: boards from `makeGroupBoardId`,
       `assignedUserIds: []`, own background copy, and `groupInk[i]` remapped like main ink.
     - Settings: `oneNameStamp`, `hideStudentCursors`, `cfg.allowSelfSelect`, `cfg.chatScope`, timer `durationMs` /
       `autoLockOnExpire` (timer stays stopped). `autoIndividual*` only when `room.teacherPinHash !== null`, the same
       rule as `set-auto-individual`.
     - **Never** set `cfg.mode` or `cfg.activeRoundId`. Nobody moves.
   - Then `room.lastActiveAt = Date.now(); scheduleSaveToDisk(room, true)`.
   - **Broadcast (current room only):** don't use `room-restored` (it sends every board to everyone). Do what
     `teacher:spotlight-board` does: `background-sync` for main, `board-replaced { boardId: 'main' }`,
     `noteChange(room, 'main', { full: true })`, `state-sync` to `boardAudience(room.id, 'main')`, then
     `broadcastRoomSettings(room)` and `broadcastBreakoutSync(room)`.

Add the four events to `docs/ARCHITECTURE.md` §7 and `teacher:upload-asset` to the interning points in §8.

**Client:**

- `App.tsx`: `handleTeacherHasAssets`, `handleTeacherUploadAsset`, `handleTeacherLoadLesson` wrapping the emits. After
  a `'new'` load succeeds: save the PIN under `STORAGE_KEYS.TEACHER_PIN_PREFIX + roomId` (as `performLobbyJoin` does),
  `recordRoomHistory`, then `performSwitchRoom(roomId)`. The normal join with the cached PIN makes them teacher there.
- **`LoadLessonModal`** (in `LessonPackModals.tsx`), opened from a **Load lesson…** item next to **Import .JSON**
  (`Canvas.tsx` ~line 5307):
  - File input `accept=".allaboard,.json,application/json"`, and **Open from Drive** (`pickDriveFile` gains a
    `'lesson'` kind). A `.allaboard` file someone else uploaded to Drive may carry `application/octet-stream`, so the
    lesson picker's Browse view also allows that type. The Picker grants per-file access under `drive.file`.
  - After `parseLessonText`: a preview with title, author, date, main worksheet and ink count, the rounds (title, mode,
    worksheet), settings that change behavior ("Students start on their own boards: Frayer Model"), and total image
    size.
  - **Load into:** **A new room** (default; room code prefilled from `generateUnusedRoomCode()`, editable; Teacher PIN
    prefilled from this room's saved PIN, masked) or **This room** (disabled with the reason while a round is live;
    warns "The main board's ink and worksheet will be replaced. Prepared rounds will be replaced." and offers Save .JSON
    first).
  - **Load:** `has-assets` → upload each missing data URL one after another, showing "Uploading worksheet images
    3/27…" → if an uploaded URL differs from its key (the file was edited by hand), `rewriteAssetUrls` → send
    `load-lesson` without `assets` → switch room or close. Errors show inline with a Retry; uploads already done are
    skipped on retry because of `has-assets`.

### Tests

**`tests/lessonPack.test.ts`:**

1. `buildLessonPack` strips messages, student boards, assignments, overrides, locks, bans, key hashes, PIN hash, mode
   and active round; keeps the main worksheet and prepared rounds.
2. `mainInk`: `'teacher'` keeps only teacher ids, `'all'` drops only name stamps, `'none'` keeps nothing.
3. A launched group round becomes `{ mode: 'groups', groups: [{ title }…] }` with no assignments.
4. `lessonAssetUrls` finds URLs in main, rounds and `autoIndividualBackground`, each once.
5. `parseLessonText`: bad JSON, wrong kind, newer version, a room save, too many rounds, and a valid file.
6. `rewriteAssetUrls` rewrites every reference.

**`tests/server.test.ts`:**

1. `export-lesson` from a room with student ink, chat, a launched round and a prepared round contains no student ids
   or names anywhere (`JSON.stringify` and search for each student's id and name).
2. `has-assets` reports missing ones; `upload-asset` stores a PNG and returns its URL; SVG, HTML and a mime/bytes
   mismatch are refused.
3. `load-lesson` into a new room: the room exists, its PIN verifies, `mode` is `'main'`, rounds are prepared with
   server-made ids, main ink belongs to the loader, nothing has the file's ids.
4. A student who joins the loaded room stays on main; after the teacher launches round 1, they get its worksheet.
5. `load-lesson` with a missing asset fails and creates no room; a taken room code fails; a short PIN fails.
6. `target: 'current'` while a round is live fails; from main it keeps launched rounds' boards and replaces main.
7. A student calling any of the four events gets `ok: false`.
8. Round trip: export → embed assets → `load-lesson` on a **second** server (`startServer` twice, separate
   `dataDir`s) gives the same worksheets and rounds.
9. Oversized or malformed elements in the lesson are rejected.

**`e2e/`:** teacher builds a lesson (worksheet, ink, one prepared round), Save lesson downloads a `.allaboard` file,
Load lesson into a new room, and the new room shows the worksheet, the ink and the prepared round.

### Phase 2 done when

- [ ] All checks from phase 1 pass.
- [ ] Manual check: build a lesson with a 30-page PDF on main and two prepared rounds; save it; load it into a new
      room in another browser profile (empty asset cache); a student joining stays on main until launch.
- [ ] Record the 30-page pack's real size in the PR.
- [ ] `docs/ARCHITECTURE.md` §7/§8 and the glossary entry for "Lesson pack" updated. `TODO.md`: tick "Export/import a
      lesson pack" and note phase 3's status.
- [ ] PR into `main`, not merged.

---

## Phase 3 (optional, decision D1): template ink on round worksheets

Teacher instructions written on a round's worksheet, copied onto every student's board, including late joiners.

- **Storage:** `room.roundTemplateInk: Record<roundId, CanvasElement[]>` in `RoomState` and `SerializedRoom` (hydrate
  to `{}`; include in `isRoomEmpty`'s checks). Sent to teachers with `roundTemplates`.
- **Authoring without a new editor:** the teacher sets up the worksheet and writes the instructions on **Main** (or any
  board), then in the round form picks **Copy worksheet and ink from this board**. That's `copyWorksheet` plus a new
  `copyInk: true` on `new-round` / `edit-prepared`: the server copies that board's background and its **teacher-owned**
  elements (no name stamps) into the template. A dedicated template canvas isn't worth its UI cost.
- **Use:** `provisionIndividualBoard` and group-board creation copy `roundTemplateInk[roundId]` with new ids
  (`randomUUID()`), keeping the teacher as author, so students can't erase it.
- **Packs:** `LessonRound.ink`; `applyLessonToRoom` remaps authorship to the loader.
- **Tests:** a late joiner gets the ink; a student can't remove it; the export/load round trip keeps it.

---

## Size: packs over the 30 MB socket limit

Worksheets are JPEG pages rendered in the browser. Base64 adds a third. A long PDF at the default 2× import size can
plausibly reach tens of MB, and a lesson multiplies that across rounds. Phase 2 must measure a real 30-page pack.

| Option                                                                | Over 30 MB?     | Cost                           | Verdict                                                                                                               |
| --------------------------------------------------------------------- | --------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Send the whole pack over the socket (how `teacher:import-room` works) | No              | none                           | Hits `maxHttpBufferSize`. Raising it raises every socket's limit, and one huge `JSON.parse` blocks the only instance. |
| HTTP `POST` upload endpoint                                           | Only if chunked | token auth, chunking           | Cloud Run caps HTTP/1 request bodies at 32 MiB, so it needs chunking anyway.                                          |
| Zip format                                                            | No              | a zip library, a binary format | Saves only the base64 third; JPEGs don't compress. Still needs chunked upload. Loses "JSON inside".                   |
| **Upload images first, one per emit, then the small lesson**          | **Yes**         | two small socket events        | **Recommended.** No new dependency or config. Skips images the server already has. Retry resumes.                     |

Export has no limit: the browser fetches each image from `/api/assets` and builds the file. For sharing, Gmail caps
attachments at 25 MB, so the Save dialog should suggest Drive for big packs. The same upload-first path can later fix
**Import .JSON** for big room saves; that's out of scope here.

---

## Open decisions for Bryan

- **D1. Template ink on round worksheets (phase 3):** build it, with "copy worksheet and ink from this board" as the
  way to write it? Recommendation: yes, after phases 1 and 2.
- **D2. Main-board ink default:** "teacher ink only" (recommended), "all ink except name stamps", or none.
- **D3. Load target default:** a new room (recommended) or the current room.
- **D4. Launched rounds in a pack:** export them as prepared rounds, checked by default? Recommendation: yes, so a
  lesson you ran today becomes a pack without rebuilding it.
- **D5. Settings carried:** include the timer length and "students start on their own boards"? Recommendation: both,
  shown in the load preview.
- **D6. Extension:** `.allaboard` (recommended, accepting `.json` too) or `.allaboard.json`, which every app opens.
- **D7. Group members:** dropped from packs. Confirm that's what you want.

## Don'ts

- Don't add Google OAuth scopes. Drive stays on `drive.file` (`CLAUDE.md` rule 6).
- Don't change `resume` / `update-current` / `return-to-main` semantics for launched rounds, or the board-id format.
  Never parse board ids.
- Don't raise `maxHttpBufferSize`, enable HTTP/2, or change `deploy.yml`.
- Don't put student data in a pack, and don't use `room-restored` for lesson loads.
- Don't let a pack's ids become room ids: the server assigns every round, board and element id.
- Don't accept SVG or non-image assets in `teacher:upload-asset`. Custom SVG stamps are a separate, on-hold item.
- No shared lesson library or accounts (TODO "Not doing").
