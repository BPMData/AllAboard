# Plan: "Send worksheet to…" (different worksheets for different student boards)

> **For the agent implementing this:** read `CLAUDE.md` and `docs/ARCHITECTURE.md` first. **Every merge to `main`
> deploys to production**, so open a PR and do not merge it yourself. The teacher needs this live by **class tomorrow**,
> so keep the scope to what's below. Bigger related ideas (prepared rounds, lesson packs, auto-forming _groups_ from stamps) are out of scope.

## Goal

A teacher runs an **individual** breakout round (one board per student) and gives students **different worksheets**,
e.g. four versions of a bingo card, A/B/C/D. Today the only ways are:

- **One worksheet for the whole round.** `new-round` with `copyWorksheet` or `customBackground` sets
  `room.roundTemplates[roundId]`, and every board gets a copy.
- **One board at a time.** The teacher opens a student's board and uploads a worksheet. That's `teacher:set-background`
  with `boardId` = the active board, at `src/App.tsx` `handleTeacherSetBackground`. For 30 students it means 30 visits
  and 30 uploads.

**Build:** a **Send worksheet…** button in the teacher's **Live Grid View** that opens a modal. In it the teacher:

1. Uploads **1–4 worksheet files** (PDF or image), labeled **A, B, C, D**.
2. Picks the target boards: checkboxes for the boards in the round being viewed, with select all and select none.
3. Picks a distribution: **"Same worksheet for all"** (A only), **"Rotate A → B → C → D"** across the selected boards
   in roster order, or **"By name-stamp corner on the main board"** (§4 below). A preview table shows `Board (student name) → A/B/C/D`, and each row has a dropdown to override it.
4. Clicks **Send**. Each variant is sent **once** and the server applies it to its boards, so each image is stored once
   because assets are content-addressed.

This is the first half of the **"Send this worksheet to…"** item under _Planned_ in `TODO.md`.

## Server (`server.ts`)

Add a socket handler next to `teacher:set-background` (around line 1520), mirroring its structure:

```ts
socket.on('teacher:set-background-multi', (payload, callback) => { ... });
```

**Payload:** `{ boardIds: string[]; background: RoomBackground | null; roundTemplateFor?: string }`

**Rules:**

- Return `{ ok: false, error }` if there's no `meta` or room, or if the caller isn't `isTeacher`. Use the same messages
  as `teacher:set-background`.
- `boardIds` must be an array. Dedupe it, cap it at **500**, and keep only ids where `room.subBoards.has(id)`. Also
  allow `'main'`, which sets `room.background`. Don't build or parse board-id strings (see the ARCHITECTURE rule).
  Unknown ids go into `skipped`.
- Call `internBackground(store, background)` **once**. For each board, assign its **own copy** of the result
  (`JSON.parse(JSON.stringify(interned))`, or `cloneBackground`, which interns again; that's cheap and dedupes), so
  boards never share one object.
- For each updated board, emit `background-sync` exactly like the single-board handler:
  `io.to(room.id).emit('background-sync', { boardId, background })`.
- If `roundTemplateFor` is a string that names an existing round (look it up via `getRounds(room.breakoutConfig)`), set
  `room.roundTemplates[roundTemplateFor] = cloneBackground(background)`. Late joiners then get it through
  `provisionIndividualBoard` → `getRoundTemplate`.
- `room.lastActiveAt = Date.now(); scheduleSaveToDisk(room, true);` **once**, after the loop.
- Ack: `{ ok: true, updated: number, skipped: string[] }`.
- Rate limiting needs no change. `eventClass()` in `socketGuards.ts` puts unknown events in `'other'` (20/s), and the
  client sends at most 4 of these per click.
- **Payload size:** a variant is base64 JPEG pages, the same as an ordinary worksheet upload, so it fits under
  `maxHttpBufferSize` (30 MB). Never send all variants in one packet. Send one emit per variant.

**Type-stripping rules** (prod runs `node server.ts`): no `enum`, `namespace`, parameter properties, or
`import x = require()`. When you're done, run `node -e "import('./server.ts').then(() => console.log('OK'))"`.

Add the new event to the client → server list in `docs/ARCHITECTURE.md` §7 (Teacher actions).

## Client

### 1. Shared helper: `src/lib/worksheetLoader.ts`

`Canvas.tsx` `importWorksheetFile` (around line 2235) builds a `RoomBackground` from `processWorksheetFile(...)` pages.
Move that object-building into an exported helper and use it in both places:

```ts
export function buildWorksheetBackground(pages: BackgroundPage[], fileName: string): RoomBackground;
```

It returns `{ id: 'bg_' + random, fileName, pages, x: -w/2, y: -h/2, scale: 1, layout: pages.length >= 3 ? 'grid' :
pages.length === 2 ? 'row' : 'stack', opacity: 1 }`, the same values as now. Refactor `importWorksheetFile` to call it,
with no change in behavior.

### 2. `src/App.tsx`

Add the callback next to `handleTeacherSetBackground`:

```ts
const handleTeacherSendWorksheet = useCallback(
  (boardIds: string[], bg: RoomBackground | null, roundTemplateFor?: string) =>
    new Promise<{ ok: boolean; updated?: number; skipped?: string[]; error?: string }>((resolve) => {
      if (!socket) return resolve({ ok: false, error: 'Not connected to server.' });
      socket.emit('teacher:set-background-multi', { boardIds, background: bg, roundTemplateFor }, (res: any) =>
        resolve(res || { ok: false, error: 'No response from server.' })
      );
    }),
  [socket]
);
```

Don't update `subBoards` optimistically. The `background-sync` events that come back already update each board, and
none of these is the board the teacher is drawing on. Pass the callback down as
`App → Canvas → LiveGridOverview` (prop `onSendWorksheet`).

### 3. `src/components/CanvasModals.tsx`

- **`LiveGridOverview`:** add an `onSendWorksheet` prop and a **"Send worksheet…"** button in the header bar, next to the
  existing round actions. Show it only when `viewingRound` is set (or `boards.length > 0`). It opens
  `SendWorksheetModal` with the boards of the round being viewed (the `boards` prop, filtered to
  `roundId === viewingRound.id`) and `users`.
- **New `SendWorksheetModal` component.** Put it in this file, or in its own file if it runs past about 250 lines.
  Match the look of the existing modals (`oh-panel-header`, `oh-btn`, `oh-btn-primary` classes).
  - **Variants A–D:** each is a file input (`accept` the same as the existing worksheet input; copy it from
    `Canvas.tsx` around line 3720). When a file is picked, call `processWorksheetFile(file, range)` and then
    `buildWorksheetBackground`. Show the file name, page count and "Rendering…" while it works. For PDFs over
    `MAX_PDF_PAGES`, pass `{ first: 1, last: MAX_PDF_PAGES }` and show a note like "using pages 1–30". Don't reuse the
    page-range modal here. Each variant has a "remove" button. "Add variant" appears while there are fewer than 4.
  - **Board list:** one row per board, with checkbox, title (e.g. "Maya's Board"), a hint showing the current worksheet
    `fileName`, and an **"has work"** badge when `board.elements.length > 0`. Include select all and select none.
  - **Distribution radio:** "Same worksheet for all selected" or "Rotate A → B → C → D". Use rotate by default when
    there are 2 or more variants. Rotation goes over the **selected** boards **sorted by title**, so the result is
    predictable. Each row has an A/B/C/D dropdown that overrides its letter.
  - **Checkbox, checked by default:** "Late joiners get worksheet A". It sends `roundTemplateFor: viewingRound.id`
    with variant A only.
  - **Warning** when any selected board "has work": _"N boards already have student work. Their ink stays, but the
    worksheet underneath will change."_ The send still goes ahead.
  - **Send:** group the boards by letter, then `await onSendWorksheet(ids, variantBg, A ? roundId : undefined)` for each
    variant **one after another** (not `Promise.all`, to keep the 30 MB packets apart). Show "Sending B (2/4)…". Close
    the modal on success, and show any `error` or `skipped` count inline.
  - Disable Send while a variant is still rendering, when no boards are selected, or when a selected board's letter
    has no file.

### 4. Distribution mode 3: "By name-stamp corner on the main board"

This is the first slice of TODO's **"Group by quadrant"**. It sends worksheets by quadrant only. It does **not** form
groups or prepared rounds. It runs entirely on the client: `LiveGridOverview` already receives `fullMainElements` and
`fullMainBackground`.

**New pure module `src/lib/stampQuadrants.ts`** (no React, no DOM):

```ts
export type Quadrant = 'tl' | 'tr' | 'bl' | 'br';
export function quadrantForPoint(x: number, y: number, bg: RoomBackground): Quadrant | null;
export function latestNameStamp(elements: CanvasElement[], userId: string): CanvasElement | null;
export function quadrantsByUser(
  elements: CanvasElement[],
  bg: RoomBackground | null,
  userIds: string[]
): Record<string, Quadrant | null>;
```

- **Name stamp:** `el.type === 'stamp' && el.stamp === 'username' && el.userId === userId`. If a student stamped more
  than once (one-name-stamp rule off), the **latest** wins: highest `timestamp`, and if timestamps are missing, the last
  one in the array. `el.x` / `el.y` are the stamp's **center**: `Canvas.tsx` renders it as a `Group` at `(x, y)` with a
  centered `Circle`.
- **Quadrant:** get the page rects with `layoutPages(bg)` from `src/lib/worksheetLayout.ts`. Find the page that contains
  the point and split **that page** at its center: `x < px + pw/2` is left, and `y < py + ph/2` is top. If the point is
  on no page, or there's no background, the result is `null` ("no stamp / off the worksheet").
- **Board → student:** an individual board's student is `board.assignedUserIds[0]`. Only individual rounds are in scope.
  For group boards, disable this mode with a tooltip: "Coming later: individual rounds only".

**UI in `SendWorksheetModal`:** a third distribution radio, "By name-stamp corner on the main board". It's disabled,
with a reason shown, when the main board has no worksheet or no name stamps. When it's selected:

- Show a small 2×2 mapping grid of dropdowns: top-left → **A**, top-right → **B**, bottom-left → **C**,
  bottom-right → **D** by default. Add one more dropdown, **"No stamp →"**, defaulting to **A**.
- The preview table gets a **Corner** column (`↖ ↗ ↙ ↘` or "none"), and the per-row override dropdown still works.
- Show a summary line above Send, e.g. "8 → A, 11 → B, 6 → C, 3 → no stamp (A)". This is the "preview before launch"
  that TODO asks for.

**Tests: `tests/stampQuadrants.test.ts`** (node:test, picked up by `npm test`)

1. One page at `x: -500, y: -400`, 1000×800, with stamps in each quarter, gives tl / tr / bl / br.
2. A user with two stamps: the later `timestamp` wins.
3. A user with no stamp, a stamp off the page, or a `null` background gives `null`.
4. Other stamp kinds (`'star'`) and other users' name stamps are ignored.
5. A 2-page `'row'` layout: a stamp on page 2 is split by **page 2's** center.
6. `scale: 2` is respected, because the rects come from `layoutPages`.

**Manual test for tomorrow's class:** set the Four Corners PDF as the main board's worksheet, have students stamp
their names, then start an individual round. Open Live Grid → Send worksheet → upload `card_A`–`card_D` and pick
"By name-stamp corner". Check the preview against the stamps on the main board.

## Tests

### `tests/server.test.ts`

Follow the existing style: `joinTracked`, `emitAck`, `waitForEvent`, and the `worksheet()` / `PNG` fixtures around
line 1499. To get breakout boards, configure an individual round the way the existing breakout tests do. Search for
`'new-round'` in the file.

1. A teacher sends worksheet X to 2 of 3 individual boards. The ack is `{ ok: true, updated: 2, skipped: [] }`, those two
   boards get `background-sync` with the asset URL (`/api/assets/...`, not `data:`), and the third board's background
   doesn't change.
2. Two different variants go to different boards, and each board ends up with the right `fileName`.
3. A student calling it gets `ok: false`, and nothing changes.
4. Unknown board ids end up in `skipped`, and the valid ones still update.
5. Sending one worksheet to 3 boards stores **one** asset (`srv.store.countAssets()` goes up by 1).
6. `roundTemplateFor` sets the template: a student who joins **after** the send, in individual mode, gets a board with
   that worksheet.
7. Persistence: after `srv.flushRoomsToDiskAsync()` and a restart (see the `restart` helper around line 1500), the
   boards still have their worksheets.

### `e2e/` (optional, only if time allows)

Teacher plus 2 students, an individual round, Send worksheet with two small PNG variants in rotate mode, and each
student sees a different worksheet. `e2e/worksheets.spec.ts` shows how to upload files.

## Done when

- [ ] `npm run lint`, `npm test`, and `node -e "import('./server.ts').then(() => console.log('OK'))"` all pass.
- [ ] `npm run test:e2e` passes, or any failures are confirmed to fail on `main` too.
- [ ] Manual check with `npm run dev` and three browser windows (teacher plus two incognito students): start an
      individual round, send A/B to the two boards, and each student sees their own; a third student who joins late
      gets A.
- [ ] `docs/ARCHITECTURE.md` §7 lists `teacher:set-background-multi`. In `TODO.md`, under "Send this worksheet to…",
      mark the live-boards half done. Under "Group by quadrant", note that the worksheet-by-corner slice is done
      (auto-forming groups and routing to prepared rounds are still open).
- [ ] Manual check for corner mode: stamp in all four corners from four student windows, send A–D by corner,
      and each student gets the right card.
- [ ] Open a PR into `main` that describes the manual test. **Don't merge it.** The teacher merges it, which deploys it.

## Don'ts

- Don't add Google OAuth scopes. This feature doesn't need any (see `CLAUDE.md` rule 6).
- Don't touch board **elements**. This only replaces backgrounds.
- Don't change `new-round` / `resume` / `update-current` semantics, the board-id format, or deploy settings.
- Don't send `data:` URLs to anything except this handler and the existing background handlers, which intern them.
