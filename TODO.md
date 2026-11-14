# AllAboard — TODO

## Worksheet import

### Google Slides import (Drive picker), blocked on school IT, try eventually
**Idea:** an "Import from Google Slides" button. The teacher signs in with Google, picks a deck in Google's
file picker, the browser exports it as a PDF through the Drive API, and the existing PDF importer turns it
into board pages. It all runs in the browser, with no server changes.

- **Approach:**
  - Google Identity Services token client with scope `drive.file` (only the files the teacher picks; non-sensitive, no Google app review).
  - Google Picker API to choose the deck.
  - Drive `files.export` with `mimeType=application/pdf`.
  - Feed the result into `processWorksheetFile()` in `src/lib/worksheetLoader.ts`.
- **One-time Google Cloud setup (project `loyal-rookery-403218`):**
  - Enable the Drive API and the Picker API.
  - OAuth consent screen, published to "In production".
  - OAuth Client ID (Web) with origins `https://allaboard.ai.studio` and the AI Studio dev URL.
  - An API key restricted to the same origins.
  - The client ID and API key are public values. Put them **in code, not Cloud Run env vars** (see `docs/DEPLOYMENT.md`, rule R1).
- **⚠️ Blocker: school Google Workspace accounts will almost certainly block it.** District admins restrict
  third-party OAuth apps, so sign-in fails with "app blocked by your administrator" until IT allowlists the
  client ID. That's unlikely for an `ai.studio` domain. Personal Gmail accounts would work immediately.
  Worth trying anyway, and worth asking IT if it ever looks valuable enough.
- **Shortcut: AI Studio's built-in Google Workspace integration.** Instead of the manual setup above, ask AI
  Studio to add a Drive/Slides (or Classroom) feature. It provisions Firebase Auth plus an OAuth client for
  the applet's origins and writes `firebase-applet-config.json` (in-repo, so it survives Publish). In React:
  `signInWithPopup(auth, provider)` with `provider.addScope('https://www.googleapis.com/auth/drive.file')`,
  then `GoogleAuthProvider.credentialFromResult(result).accessToken` as the Bearer token for Picker/Drive.
  - Does **not** fix the school-IT blocker above. Workspace admins can still block the client.
  - The access token lasts ~1 hour and can't be refreshed client-side. Re-run the popup on a 401.
  - Picker still needs a browser API key: **ours, created once by the developer**, hard-coded and
    restricted to our origins (users never see or touch it). Try the `apiKey` already in
    `firebase-applet-config.json` first (needs the Picker API enabled on the project and the key not
    API-restricted against it). Also call `.setAppId(<project number>)`, or `drive.file` won't unlock the picked file.
  - Same pattern covers Classroom (`classroom.courses.readonly`, `classroom.courseworkmaterials` to post a
    `?room=` link). Roster scopes (`classroom.rosters.readonly`) need Google verification for a public app.
- **Other gotchas:**
  - Drive caps exports at **10 MB**. Show a clear error that suggests File → Download → PDF.
  - Decks often exceed the importer's 10-page cap (`MAX_PDF_PAGES`). Ship this with a slide/page picker (below).

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
- [ ] **Page picker** ("use pages 3–5") instead of silently keeping only the first 10 pages (`MAX_PDF_PAGES = 10`).
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
