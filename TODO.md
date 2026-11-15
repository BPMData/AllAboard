# AllAboard — TODO

## Worksheet import

### ✅ Done: Google Drive import/save (PRs #23, #25)
Slides / PDF from Drive, Open Room from Drive and Save Room to Drive are live. See `PLANS_GOOGLE_DRIVE.md`.
School Google Workspace accounts may still need their IT admin to allow the app (by OAuth client ID).

### Next up: room name, worksheet polish, Drive follow-ups (ready for an agent)

**Order:** task 4 first (it's a bug), then 0, 1, 2, 3, 5, 6, 7.

Ground rules for every task:
- Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first. **No server changes are needed for any of these.**
- Run `npm run lint`, `npm test`, `npm run test:e2e`, and
  `node -e "import('./server.ts').then(() => console.log('OK'))"` before each commit. All must pass.
- One PR per task. Plain-language commit messages. Don't add npm dependencies.

#### 0. Show the room name clearly at the top of the sidebar
**Today:** the room code is in the sidebar's room bar (`src/components/Chat.tsx`, the block commented
`{/* Room Code Bar + Custom or Random "New Room" Controls */}`) as small grey `Room:` + monospace text **on the
same row as Copy Link and New Room**, so anything longer than ~7 characters is cut off (`math-m…`). When the
sidebar is hidden, the room name isn't on screen at all. Students and teachers don't think to check the URL.

- [ ] **Give the room name its own row** at the top of that bar:
      - a small label, `ROOM` (`text-[10px] uppercase tracking-wide text-slate-500`), and under it
      - the room code in **large, bold** text (`text-lg font-bold font-mono text-slate-900`), **wrapping instead of
        truncating** (`break-all`; room codes are at most 24 characters), still a button that opens the
        change-room box exactly like today (keep its `title="Click to enter a different room code"`).
      - Copy Link · New Room move to a **second row** under it, unchanged.
- [ ] **When the sidebar is hidden:** in `Canvas.tsx`, next to the **Chat** button shown when `isChatHidden`
      (search `title="Show chat sidebar"`), add a read-only chip: `Room: <code>` (`font-mono font-semibold`), with
      `data-testid="room-chip"`. Pass `roomId` in if Canvas doesn't already have it (it does: `roomId` prop).
- [ ] **Browser tab title: put the room first.** `src/App.tsx` (~line 263) sets
      `` `AllAboard — #${effectiveRoomId}` ``; narrow tabs cut off the room part. Change it to
      `` `#${effectiveRoomId} · AllAboard` `` (keep plain `AllAboard` for the `main` room), so teachers with
      several rooms open can tell the tabs apart.
- [ ] **Tests** (`e2e/classroom.spec.ts`): after joining room `period-3-biology-lab`, the sidebar shows the full code
      (not truncated: the element's `scrollWidth <= clientWidth`), the tab title is `#period-3-biology-lab · AllAboard`,
      and after hiding the sidebar `room-chip` shows the code.

#### 1. "Remove worksheet" button: clearer name, and a second tap to confirm
**Today:** the worksheet controls (Move · − 100% + · Side-by-Side · **Remove**) live in the teacher bar
in `src/components/Canvas.tsx`, in the block commented `{/* Active Background Worksheet Controls */}`.
**Remove** works (`onTeacherSetBackground(null)`), but the label doesn't say *what* it removes, and one
misclick wipes the worksheet with no undo.

- [ ] Change the label to **Remove worksheet**. Keep the existing `title="Remove background worksheet from this
      board"`; e2e tests look for it.
- [ ] **Tap twice to confirm:** the first click changes the label to **Tap again to remove** (still red, bold) for
      3 seconds; a second click within 3 s removes it; otherwise it resets. Use local state + a timeout that is
      cleared on unmount. (Same pattern OverBoard uses for Clear all.)
- [ ] Ink on the board is **not** removed. Say so in the tooltip: "Removes the worksheet from this board. Ink stays."
      (Update the `title` only if you also update the e2e selectors that use it.)
- [ ] **Test** (`e2e/worksheets.spec.ts`): upload a worksheet → one click on Remove worksheet → worksheet still
      there and the button reads "Tap again to remove" → second click → worksheet gone. And: one click, wait
      3.5 s, the label resets and the worksheet is still there.

#### 2. Page thumbnails in the "Choose Pages to Import" dialog
**Today:** a PDF (or Slides deck) with more than `MAX_PDF_PAGES` (10) pages opens `PdfPageRangeModal`
(`src/components/CanvasModals.tsx`) with only **From / To** number boxes. Teachers can't see which page is which.

- [ ] **Loader** (`src/lib/worksheetLoader.ts`): add
      `export async function renderPdfThumbnails(file: File, opts: { width: number; onThumb: (pageNumber: number, dataUrl: string) => void; signal?: AbortSignal }): Promise<void>`.
      - Open the PDF **once** with pdf.js (same `pdfjsLib.getDocument({ data })` call `getPdfPageCount` uses).
      - Render each page at a scale that makes it `opts.width` px wide (use **120**), to a canvas, then
        `toDataURL('image/jpeg', 0.7)`, and call `onThumb` as each page finishes, **in order, one at a time**
        (don't render all pages in parallel; big textbooks will freeze a Chromebook).
      - Stop early if `signal.aborted` (the dialog was closed). Call `pdf.destroy()` at the end.
      - **No page cap, but render lazily:** decks of 300+ pages are real (a teacher tried 370). Keep one open
        pdf.js document for the dialog's lifetime and render a page's thumbnail only when its placeholder
        scrolls into view (`IntersectionObserver` on the grid, `rootMargin: '400px'`), still one at a time
        through a small queue. So the API is better as
        `openPdfForThumbnails(file) → { numPages, renderThumb(pageNumber, width): Promise<string>, destroy() }`.
- [ ] **Dialog:** pass the `File` into `PdfPageRangeModal` (new prop `file`; `Canvas.tsx` already has it in
      `pendingPdfRange.file`). Under the From/To boxes, show a scrollable grid of thumbnails (max height ~50vh,
      `grid-template-columns: repeat(auto-fill, minmax(120px, 1fr))`), each with its page number under it and
      `data-testid="pdf-thumb-<n>"`. Show a light grey placeholder box until a thumbnail arrives.
      - Pages inside the current From–To range get a **blue border and a light blue background**; others are
        slightly faded.
      - **Click a page:** From = that page, To = min(page + 9, total). (Starts a 10-page range there.)
      - **Shift-click a page:** To = that page (if it's after From), clamped with `clampPageRange` so the range is
        never more than 10 pages.
      - Typing in From/To still works and updates the highlight.
      - Start rendering in a `useEffect` when the dialog opens; abort it in the cleanup.
- [ ] Widen the dialog to `max-w-3xl` so ~5 thumbnails fit per row.
- [ ] **Tests:**
      - Thumbnails off-screen are not rendered: with a 40-page PDF, fewer than 40 `<img>` thumbnails exist
        before scrolling the grid to the bottom.
      - `e2e/worksheets.spec.ts`: a 12-page PDF (reuse the in-browser PDF builder used there) shows 12
        thumbnails; click page 3 → From = 3, To = 12; shift-click page 5 → To = 5; Import pages → 3 pages on the board.
      - `e2e/googleDrive.spec.ts` "page-range modal for a >10 page PDF" must still pass.

#### 3. Page layout: Row / Column / Grid, with a sensible default
**Today:** multi-page worksheets default to `layout: 'row'` (all pages side by side). Ten slides in a row is a
very long strip that's tiny when you Fit All. There *is* a toggle, but it shows the **current** layout
("Side-by-Side" / "Stacked") instead of an action, so it doesn't look like a button.

⚠️ **Changing the layout moves the pages but not the ink.** Ink is stored in world coordinates, so ink
written on page 3 stays where it was while page 3 moves. This is true of the existing toggle too.

- [ ] **One layout function, used everywhere.** The page-placement loop is copied in four places:
      `Canvas.tsx` (the `backgroundPages` memo, ~line 1545, and the Fit All bounds, ~line 1865) and
      `src/lib/batchPdfExport.ts` (~lines 60 and 335). Replace all four with a new pure module
      `src/lib/worksheetLayout.ts`:
      `export function layoutPages(bg: Pick<RoomBackground, 'pages' | 'x' | 'y' | 'scale' | 'layout'>, gap = 32): Array<{ x: number; y: number; width: number; height: number }>`.
      Add `tests/worksheetLayout.test.ts` covering row, stack and grid.
- [ ] **Add `'grid'`** to `RoomBackground.layout` in `src/types.ts` (`'row' | 'stack' | 'grid'`). Grid places
      pages left to right, wrapping into rows. **Columns:** pick the column count `c` (1…n) whose overall block
      (c × widest page) by (rows × tallest page) is closest to a **16:9** board. That gives ~3 columns for 10
      landscape slides and ~4 for 10 portrait worksheets. Export `gridColumns(pages, targetAspect = 16 / 9)`
      and unit-test it. Unknown layout values (old snapshots) fall back to `'row'`.
- [ ] **Default for new imports** (`importWorksheetFile` in `Canvas.tsx`, where it sets
      `layout: pages.length > 1 ? 'row' : 'stack'`): 1 page → `'stack'`; 2 pages → `'row'`; **3 or more → `'grid'`**.
- [ ] **Replace the toggle** with a small labeled segmented control in the same spot:
      **Layout: Row | Column | Grid** (lucide icons `Columns`, `Rows`, `LayoutGrid`), current one highlighted,
      each with a tooltip ("Pages side by side", "Pages top to bottom", "Pages in a grid"). Only shown when the
      worksheet has 2+ pages.
- [ ] **Protect ink:** if the board has any ink or stamps (any element besides erasers), changing layout first asks
      with `window.confirm`: "Changing the layout moves the pages but not the ink already on them. Continue?"
      If the board is empty, switch without asking.
- [ ] **Server:** no change needed. `teacher:update-background` already accepts any `layout` in the patch.
      Double-check that snapshot import (`teacher:import-room`) passes `'grid'` through.
- [ ] **Tests:** unit tests above; an e2e test that imports a 6-page PDF, sees **Grid** selected, switches to
      **Row** on an empty board (no confirm), and Fit All still shows every page (`e2e/worksheets.spec.ts`).
      Update existing tests that click `'Side-by-Side'`.

#### 4. Big Slides decks hang on "Importing from Drive..." forever (bug; do this one first)
**What happened:** picking a **370-slide** Google Slides deck in *Slides / PDF from Drive* never reached the
"Choose Pages to Import" dialog. The button stayed greyed out on **Importing from Drive...** forever.

**Why (from the code):** `downloadDriveFile` → `driveFetch` (`src/lib/googleDrive.ts`) has **no timeout**, and
`handleWorksheetFromDrive` (`Canvas.tsx`) only clears `driveBusy` when that promise settles. Google's
`files.export` is also **limited to 10 MB** of output
([files.export reference](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export)):
a big deck either takes minutes to convert or fails with `exportSizeLimitExceeded`. There is **no official way
around the 10 MB limit**. The `exportLinks` / `docs.google.com/.../export` URLs some forums mention aren't part of
the API and aren't usable from the browser (no CORS), so **don't try them**.

- [ ] **Timeout and Cancel.** Give `driveFetch` an optional `{ timeoutMs, signal }`. Use an `AbortController`;
      for downloads/exports use **120 s**. While importing, show a small **Cancel** link next to the busy button
      that aborts. Always clear `driveBusy` in `finally`. On timeout, throw `GoogleError('timeout')`.
- [ ] **Show progress** instead of a frozen label: read the response with `res.body.getReader()` and update the
      button text, e.g. `Downloading from Drive... 4.2 MB`. If Google is still converting (no bytes yet), show
      `Google is converting the deck... 0:35` with a running timer.
- [ ] **Clear messages** (add to `friendlyGoogleError`):
      - `timeout`: "Google took too long to convert this deck. For big decks, open it in Google Slides, use
        File → Download → PDF, then use Upload (.JPG / .PNG / .PDF). Big PDFs work fine that way."
      - `exportSizeLimitExceeded`: already exists; make sure the same advice shows.
- [ ] **Make sure the local-PDF path handles huge files** (it's the fallback we tell teachers to use): a 370-page
      PDF must reach the page dialog. `getPdfPageCount` only reads the page count, which is fine; the thumbnail
      work in task 2 must stay lazy.
- [ ] **Tests** (`e2e/googleDrive.spec.ts`): a fake export that never responds → the busy label shows a timer,
      Cancel brings the button back with no error; a fake export that answers 403 `exportSizeLimitExceeded` →
      the friendly message. Use a short `timeoutMs` in the test via a test-only override (e.g.
      `window.__ALLABOARD_DRIVE_TIMEOUT_MS__`), not a 2-minute wait.
- [ ] **Optional, verify before building:** the **Slides API** can return a deck's slide count and per-slide
      thumbnails (`presentations.get?fields=slides.objectId`, `presentations.pages.getThumbnail`), which would
      let a teacher pick slides *before* the 10 MB export. **But:** it's unconfirmed whether these accept our
      `drive.file` scope (Google's Slides scope list highlights `presentations` / `presentations.readonly`,
      which are **sensitive** and would need Google's review), and `getThumbnail` counts as an "expensive read"
      against quota. **Do not add new scopes.** Try it with the existing token; if Google says 403
      insufficient scope, drop this item.

#### 5. Switch Google account (and show which one is connected)
**What happened:** the first Drive click shows Google's account chooser (and a district Workspace account
**worked**). After that, AllAboard silently reuses that account. If you picked the wrong one, there's no way back.

**Why:** `getAccessToken` keeps the token in memory for ~1 hour and asks Google with `prompt: ''`, which skips the
chooser once you've consented.

- [ ] In `src/lib/googleDrive.ts` add `switchGoogleAccount()`: `clearAccessToken()`, then
      `tokenClient.requestAccessToken({ prompt: 'select_account' })`
      ([GIS token client reference](https://developers.google.com/identity/oauth2/web/reference/js-reference)).
      Must run directly in a click handler (popup rules). **Don't** call `google.accounts.oauth2.revoke` for a
      plain switch: that removes consent and makes the teacher click through the consent screen again.
- [ ] Add `getDriveAccount()`: `GET https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)`
      ([about.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get); the current
      reference lists `drive.file` as an accepted scope, so **no new scope**). Cache it with the token; clear it
      when the token is cleared. If the call fails, just don't show an email.
- [ ] **UI:** once connected, show a quiet line in the teacher bar next to the Drive buttons:
      `Drive: ms.t@school.org · Switch`. **Switch** calls `switchGoogleAccount()`, then refreshes the email.
      Also add **Switch account** as a small link in the Save Room to Drive dialog, under the folder.
- [ ] **Remembered folders/files belong to one account.** Key `drawchat_drive_last_folder` and
      `drawchat_drive_save_<room>` by account email (e.g. `drawchat_drive_last_folder:<email>`), falling back to
      the un-keyed values when no email is known. Otherwise, after switching, the dialog offers a folder the new
      account can't see.
- [ ] **Tests:** with the fake GIS, Switch calls `requestAccessToken` with `prompt: 'select_account'`; the
      email line updates; the Save dialog starts in the new account's last folder (or My Drive).

#### 6. "New folder" when saving a room
**Ask:** create a Drive folder without leaving AllAboard.

**Finding:** Google's Picker has **no "create folder" option** (none in the
[DocsView reference](https://developers.google.com/workspace/drive/picker/reference/picker.docsview)), so it
can't go *inside* the Open Room / folder picker. But AllAboard can create one itself with the Drive API under the
existing `drive.file` scope (an app can always create files and folders, and keeps access to what it creates).
**No new permission.**

- [ ] In the **Save Room to Drive** dialog (`DriveSaveModal`, `CanvasModals.tsx`), add **New folder...** next to
      **Change...**. It shows an inline name box (default `AllAboard rooms`) with Create / Cancel.
- [ ] `createDriveFolder(name, parent: DriveFolder)` in `googleDrive.ts`:
      `POST https://www.googleapis.com/drive/v3/files?fields=id,name` with
      `{ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent.id] }` (omit `parents` for My Drive).
      Call `getAccessToken()` first inside the click.
- [ ] The new folder becomes the dialog's folder (and so the remembered last folder after saving).
- [ ] **Tests:** fake the POST; after Create, the folder row shows the new name; Save sends `parents: [<new id>]`.

#### 7. PowerPoint (.pptx) files picked from Drive
**What happened:** the **Slides** tab of the picker also lists `.pptx` files uploaded to Drive (Google treats them as
presentations), but importing one fails: `files.export` only works on Google-format files, and a `.pptx`
downloaded as-is isn't a PDF.

**Plan: convert it through Google, then treat it like a Slides deck. No new permission.**
- [ ] When the picked file's `mimeType` is
      `application/vnd.openxmlformats-officedocument.presentationml.presentation` (or `application/vnd.ms-powerpoint`):
      1. Download the bytes (`files/<id>?alt=media`; we have access because the teacher picked it).
      2. **Upload a temporary converted copy:** multipart `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`
         with metadata `{ name: '<original name> (AllAboard temp)', mimeType: 'application/vnd.google-apps.presentation' }`
         and the .pptx bytes as the media part. Setting a Google `mimeType` on create is how Drive's API imports
         (converts) Office files. **Use create, not `files.copy`:** community reports say `copy` doesn't convert.
      3. Export the temp copy as PDF (same as Slides, same 10 MB limit and timeout from task 4).
      4. **Delete the temp copy** (`DELETE https://www.googleapis.com/drive/v3/files/<tempId>`) in a `finally`,
         even if the export fails. AllAboard created it, so `drive.file` allows deleting it.
      5. Continue into the normal page dialog (thumbnails, 10-page range).
- [ ] Busy text: `Converting PowerPoint...`, then the usual steps.
- [ ] **If conversion fails** (Google rejects it, or the file is over ~100 MB), show: "This PowerPoint file couldn't
      be converted. Open it in Google Slides (or save it as PDF in PowerPoint) and try again." Keep a separate
      message for plain unsupported types: "Please choose a Google Slides presentation or a PDF."
- [ ] **Verify first:** run the conversion once by hand with a real .pptx and the real token before building the UI.
      If Drive won't convert under `drive.file`, skip the conversion, filter `.pptx` out of the Slides tab with
      `setMimeTypes('application/vnd.google-apps.presentation')`, and show the message above if one still gets
      through Browse Drive.
- [ ] **Privacy policy:** if conversion ships, add one line to `privacy.html` in the `BPMData.github.io` repo:
      "To import a PowerPoint file, AllAboard briefly saves a converted copy in your Drive and deletes it right after."
- [ ] **Tests:** fake download → multipart create (assert the metadata `mimeType` is the Slides type) → export →
      DELETE of the temp id, in that order; and DELETE still happens when the export fails.

### PDF import improvements
- [ ] **Import PDFs bigger, with a user-set multiplier (default 3×).** Today a page is rendered at ~1224–1400 px
      wide (`renderPdfToPages` in `src/lib/worksheetLoader.ts`, scale capped at 2.0) and placed at `scale: 1`
      (`Canvas.tsx` ~line 1922). That's about print size, which is too small for comfortable annotation with
      AllAboard's tools. The existing ± buttons only stretch the same pixels, so it goes blurry.
  - **Add a "Size: 1× / 2× / 3× / 4×" choice** at import, default **3×**, remembered per teacher in
    `localStorage`. Applies to images too.
  - **Render at the bigger size, not just display bigger.** Make the world size (`BackgroundPage.width/height`)
    = PDF points × multiplier, and render pixels to match, capped at about **2400 px on the long side** so
    Chromebooks and the 30 MB socket limit stay happy. Above the cap, keep the world size and let the
    image upscale slightly.
  - **Cost check:** a Letter page at 3× is ~1836×2376 px, roughly 0.5–1 MB as JPEG. That's fine: assets are
    deduplicated and stored once (`/api/assets/<hash>`).
  - Make sure templates/built-ins and the PDF export (`batchPdfExport.ts`) still line up at the new sizes.
- [x] **Page picker** ("use pages 3–5") instead of silently keeping only the first 10 pages (`MAX_PDF_PAGES = 10`). Done in #23; thumbnails are task 2 above.
- [ ] **Progress/feedback** while large PDFs render in the browser.
- [ ] Optionally render sharper (currently ~1400 px wide JPEG, which is soft on dense text).

### Other formats
- [ ] **HTML worksheets:** add a tip in the upload dialog to print to PDF first. Server-side HTML rendering
      would need a headless browser on Cloud Run, which isn't worth it.
- [ ] **PowerPoint (`.pptx`):** for now, add a tip to use *Save as PDF*. A **no-server** option now exists:
      LibreOffice compiled to WebAssembly converts `.pptx` → PDF **in the browser**, and the existing PDF importer
      takes it from there.
  - **Download:** ~50–100 MB, but it can be a **one-time download per device**, cached by the browser or a
    service worker (PWA-style, like language packs). Caveats:
    - Managed school Chromebooks may wipe storage on sign-out.
    - The browser can evict the cache when storage runs low.
  - **Only the teacher's device converts.** The slides become ordinary worksheet images that students load like
    any worksheet, so students never download LibreOffice. That makes it far more viable than it first sounds.
  - Load it **lazily**, only when a teacher actually picks a `.pptx`, never on page load.
  - Check fidelity (fonts, SmartArt, embedded media) against real teacher decks before committing to it.

## Teacher tools

### Teacher-only feedback stamps
- [ ] **Stamps only the teacher can place:** **APPROVED**, **DENIED**, **NEEDS WORK**, **INCOMPLETE**, **LATE**,
      and maybe **REDO**, **SEE ME**, **EXCELLENT**, and a custom-text stamp. Rendered as a bold "rubber stamp"
      look (border, slight rotation, color per kind: green/red/amber/gray). Good targets for breakout boards
      during grading.
  - **Where it plugs in:** the student stamp tool already exists (`STAMP_OPTIONS` in `Canvas.tsx`, `StampKind`
    in `src/types.ts`). Add the teacher kinds to `StampKind` and show them in a separate "Teacher stamps" group
    only when `isTeacher`.
  - **⚠️ This must be enforced on the server, not just hidden in the UI.** Right now `element-start` (and the
    batch-add path) in `server.ts` stores the element **exactly as the client sent it**, including `userId`.
    Today any student could therefore:
    - forge a teacher stamp by sending `stamp: 'approved'`;
    - mark their own drawing as authored by someone else, including the teacher.
  - **Fix as part of this work (it's worth doing even without stamps):**
    1. In `element-start` and `elements-batch-add`, **overwrite `element.userId` with the socket's real
       `meta.userId`** (and `userName` from the roster) instead of trusting the client.
    2. **Reject teacher stamp kinds from non-teachers.**
    3. Make sure students can't move/delete teacher stamps. The existing "owner or teacher" check does this
       once `userId` can't be spoofed.
    4. Add server tests for all three.

### "Students start on their own boards" room mode
- [ ] **Room setting (teacher-only toggle): "Students start on their own boards."** When it's on, every
      non-teacher who joins goes straight to their **own individual board**, pre-loaded with a **student worksheet**
      the teacher chose. The **main board is independent** and can hold completely different content. When the
      teacher **brings everyone back to main**, the class moves on to that.
  - **Example lesson:** students fill out a reading worksheet on their own boards. Then the teacher brings
    everyone to main, which shows the built-in **Four Corners** template, and each student stamps their
    name badge in the quadrant that best matches how they felt about the worksheet. The main board *could* be
    the teacher's copy of the worksheet, but it doesn't have to be.
  - **Mostly already built:**
    - An individual breakout round already provisions boards for **late joiners** with the round's worksheet
      template (`ensureIndividualBoardForUser` / `provisionIndividualBoard` in `server.ts`, called from `join-room`).
    - `teacher:configure-breakout` already has `return-to-main`.
    - The teacher can already watch everyone in `LiveGridOverview`.

    - Rounds already accept a separate student worksheet: `teacher:configure-breakout` → `new-round` takes
      `customBackground` (or `copyWorksheet: true` to copy main), stored per round in `room.roundTemplates`.

    So the feature is mainly: **when the setting is on and a student joins while no individual round is active,
    auto-start one** (`new-round`, `mode: 'individual'`, `customBackground: <the chosen student worksheet>`)
    instead of waiting for the teacher to click.
  - **Two separate pickers in the setting:**
    - **"Students start with:"** a worksheet (upload / template / "same as main board" / blank). This is
      saved with the setting as the round template.
    - **The main board:** whatever the teacher puts there, set with the normal worksheet tools. It is never
      copied to students unless the teacher picks "same as main board."
  - **Store the flag and the student-worksheet choice** in `breakoutConfig` (e.g. `autoIndividual: boolean`, plus the
    chosen worksheet as an asset-backed background like `roundTemplates`), so it persists and backs up with the
    room like every other setting. Toggle it via `teacher:configure-breakout` (one new optional field, with no new
    socket event). Include it in `getRoomSettingsPayload`.
  - **Decisions to make when building:**
    - **After "return to main," where do new joiners go?** Suggested: they follow the class (main) until the teacher
      starts another round or re-enables the mode. Otherwise a late student lands alone while everyone else is on main.
    - **The teacher changes the worksheet after students have started.** Today a round's template is captured
      when the round starts. Suggested: add a teacher button, "Send this worksheet to everyone's board," that
      replaces only the **background**, never the student's ink. Or start a new round.
    - **Teacher PIN:** the room needs a claimed teacher for the mode to mean anything. Disable the toggle until a
      PIN is set.
  - **Tests:** a student joining with the flag on lands on `r1_ind_<id>` with the **chosen student worksheet**, not
    the main board's background. The teacher stays on main, and the main board keeps its own, different background. `return-to-main` moves everyone. The flag survives a restart (backup/restore).

### "Send this worksheet to…" (live boards and prepared rounds)
- [ ] **Teacher button: "Send this worksheet to…"**
  - **Everyone's current boards:** replaces only each board's **background**, never the student's ink.
  - **A prepared breakout round** (see below): sets that round's worksheet template, so students who enter
    it later get it.
  - **Server:** a teacher-only path that applies `internBackground` once and then reuses the same asset URL for
    every board. With content-addressed assets, 30 boards cost one stored image.

### Prepared ("draft") breakout rounds
- [ ] **Create breakout rounds in advance without moving anyone**, each with its own worksheet, mode
      (individual/groups) and groups. Launch one later with a click.
  - **Mostly exists:** rounds are already saved objects (`breakoutConfig.rounds`, `room.roundTemplates`), and
    `resume` already activates an existing round. What's missing is a `new-round` variant that creates the round
    **without** setting `mode`/`activeRoundId` (e.g. `prepare: true`), plus UI to list, edit and launch prepared rounds.
  - **Stretch:** **"Group by quadrant."** After a Four Corners vote on main, auto-assign students to groups (or to
    one of several prepared rounds) based on which quadrant their name stamp is in. The server already knows each
    stamp's position and owner (once the `userId` spoofing fix below lands).
    - **Mapping:** each region maps to a prepared round or group, e.g. top-left → Round A; top-right and
      bottom-right → Round B. It's saved in the lesson pack. Works for any template with labeled regions (number
      line, agree/disagree spectrum, Venn diagram), not just Four Corners.
    - **Preconfigured "unassigned" destination:** students who never stamped go to a room the teacher chose in
      advance (e.g. a catch-up or "come see me" board) instead of a manual list. Manual placement stays as an option.
    - **Preview before launch:** "8 → A, 11 → B, 6 → C, 3 → unassigned", with drag-to-adjust before anyone moves.
    - If a student stamped more than once (setting below is off), use their **most recent** stamp.

### "One name stamp per student" setting
- [ ] **Teacher toggle: each student's name stamp can exist at most once** (per board). It makes votes like Four
      Corners clean.
  - **Student UX:**
    - After placing their name stamp, the name-stamp option **disappears or greys out** for that student.
    - If they **delete their own stamp**, the option comes back.
    - Also let them **drag their own stamp** to a different quadrant. That's usually what a student who
      "messed up" actually wants, and the existing owner-or-teacher check on `element-update` already allows it.
  - **Client:** derive availability from the board's elements: "does an element with `stamp === 'username'` and
    `userId === me` exist on this board?" There's no extra state to sync, and it updates automatically when the
    stamp is deleted.
  - **Server (the real enforcement):** in `element-start` and `elements-batch-add`, if the setting is on and the
    sender already has a `username` stamp on that board, **reject** the new one. Depends on the `userId` spoofing
    fix, otherwise a student could dodge the limit by claiming to be someone else. Teachers are exempt.
  - Store the flag in room settings (persisted and backed up), and include it in lesson packs.

### Lesson packs: a whole lesson in one file, shareable between teachers
- [ ] **Export/import a "lesson pack"**: one file with everything needed to run a lesson, minus student data:
  - the **main board** (background and teacher ink), e.g. a Four Corners "how did that feel?" vote that students
    don't see until they finish
  - **prepared rounds** with their worksheets and groups, e.g. three follow-up activities, one per reaction
  - room settings like **"students start on their own boards"** and the student starting worksheet
  - the teacher's **custom image stamps** (below)
- **Builds on the existing room export (snapshot v2):** `handleExportJSON` / `teacher:import-room` already
  carry the main board, sub-boards, `breakoutConfig`, and an `assets` map that embeds each image once. A lesson
  pack is a new `kind: 'lesson'` (or `version: 3`) that:
  - **strips student data:** student boards, chat, roster, banned/locked names
  - **adds** prepared rounds, `roundTemplates`, and room settings
  - **gets a friendly extension** (e.g. `.allaboard`, still JSON inside)

  Base64 inside a *file* is fine. The problem was only base64 in live room state and broadcasts.
- **Import flow:** "Load lesson…" sets up the current room (or a fresh one) with all of it. No students are moved
  until the teacher launches something.
- **Decisions to make:**
  - Should packs include teacher ink on student worksheets (e.g. pre-written instructions)? Probably yes, as
    part of the template.
  - How are packs shared? Email/Drive/file is fine to start. A shared library would need accounts, so avoid it.

### Custom image stamps (teacher)
- [ ] **Teachers upload their own stamp images** (PNG/SVG: a signature, a custom "APPROVED" stamp, a school logo)
      and place them like the built-in stamps. Pairs with the teacher-only stamps above.
  - **Why it's cheap now:** the content-addressed asset system (`/api/assets/<hash>`, since #12) stores each image
    **once**. A placed stamp is just a small element that references the asset URL. Backups need no new code:
    `BackupMirror` and `room_assets` find every `/api/assets/` URL by scanning the room JSON. (The *bucket* is what
    makes assets survive restarts. The *asset system* is what removed the base64 bloat.)
  - **Server work:**
    1. Today `internRoomAssets` / `internBackground` only convert **backgrounds**. Add a teacher upload path (e.g. a
       `teacher:upload-asset` socket ack that returns the asset URL) so stamp elements never carry `data:` URLs. Also
       reject or intern `data:` URLs on elements in `element-start` / `elements-batch-add`.
    2. Size limit (e.g. ≤ 1 MB, with a max dimension) and image-type check (`sniffMime`).
  - **The stamp library lives with the teacher, not the server.** There are no accounts, and `gcAssets` deletes
    assets no room references after 1 hour. Keep the teacher's library in their browser (`localStorage` or
    IndexedDB, holding the small image files) and in **lesson packs**, and re-upload on use. Deduplication makes
    re-uploads free and gives the same URL.

## Housekeeping
- [ ] Add a lifecycle rule to the `run-sources-loyal-rookery-403218-us-east1` bucket (delete objects older than 30 days).
      It stores ~80 MB of uploaded source per deploy.
