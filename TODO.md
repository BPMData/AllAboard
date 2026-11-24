# AllAboard — TODO

Status of every feature idea. Before building anything, read `CLAUDE.md` and `docs/ARCHITECTURE.md`. Older, finished
specs are in git history.

**Sections:** [Planned](#planned) · [On hold](#on-hold) · [Ideas](#ideas-not-decided) ·
[Not doing](#not-doing) · [Done](#done)

## Planned

### "Send this worksheet to…" (live boards and prepared rounds)
- [ ] **Teacher button: "Send this worksheet to…"**
  - [x] **Everyone's current boards:** replaces only each board's **background**, never the student's ink.
    Done (Nov 2026): Live Grid → **Send worksheet…** sends up to four variants (A–D) to selected boards of the
    viewed round (same / rotate / by name-stamp corner), via `teacher:set-background-multi`.
  - [ ] **A prepared breakout round** (see below): sets that round's worksheet template, so students who enter
    it later get it.
  - [ ] **Set up worksheet variants (A–D) before class, on a prepared round.** Today variants can only be sent
    from Live Grid → **Send worksheet…**, after the round is live and students already have boards.
    - In the prepared-round form (Breakout manager → **Save for later** / **Edit**), let the teacher upload up to
      four variants and pick the distribution: same for all / deal out in turn / by name-stamp corner.
    - On **Launch**, the server gives each new board its variant. Corner mode reads the main board's stamps at
      launch time. Late joiners get their variant by the same rule, not always A.
    - Save variants and the distribution rule **on the round**, so they survive a restart.
    - **Lesson packs must carry all of it.** Anything a teacher sets up ahead of time (prepared rounds, their
      variants A–D, the distribution rule, the corner mapping, per-student overrides, the late-joiner rule) must
      go into **Save lesson…** (`.allaboard`) and come back intact with **Load lesson…**. Per-student overrides
      only make sense in the same class, so on load, match them by student name and drop the ones that don't
      match. Add a round-trip test: save a pack, load it into a fresh room, and check that every prepared field
      matches.
  - [ ] **Make a sent distribution editable.** Reopening **Send worksheet…** starts empty: the uploaded variants
    and who got which are forgotten, so changing one student's card means uploading everything again.
    - Remember each round's variants and assignments, and reopen the modal with them filled in.
    - Allow changing one board's letter, swapping a variant's file, or switching the distribution rule, and send
      only the boards whose worksheet actually changes.
    - Keep the existing rule: ink stays and only the worksheet underneath changes. Warn about boards that
      already have work, as the modal does now.
  - **Server:** a teacher-only path that applies `internBackground` once and then reuses the same asset URL for
    every board. With content-addressed assets, 30 boards cost one stored image.

### Prepared ("draft") breakout rounds
Plan: [`PLANS_LESSON_PACKS.md`](PLANS_LESSON_PACKS.md) phase 1.
- [x] **Create breakout rounds in advance without moving anyone**, each with its own worksheet, mode
      (individual/groups) and groups. Launch one later with a click.
  - Done (Nov 2026, `PLANS_LESSON_PACKS.md` phase 1): Breakout manager → **Save for later**, then a **Prepared
    rounds** list with Launch / Edit / Delete. Server: `new-round` + `prepare: true`, `edit-prepared`,
    `delete-prepared`; `resume` launches. Room saves now keep round worksheets.
- [ ] **Stretch: "Group by quadrant."** After a Four Corners vote on main, auto-assign students to groups (or to
      one of several prepared rounds) based on which region their name stamp is in.
  - [x] **First slice done (Nov 2026):** Send worksheet's "By name-stamp corner" mode sends worksheet A–D by the
        corner of each student's name stamp on the main board (`src/lib/stampQuadrants.ts`). Still open:
        auto-forming groups and routing students into prepared rounds.
  - **Mapping:** each region maps to a prepared round or group, e.g. top-left → Round A; top-right and
    bottom-right → Round B. Works for any template with labeled regions (number line, agree/disagree spectrum,
    Venn diagram), not just Four Corners.
  - **Unassigned students:** anyone who never stamped goes to a room the teacher chose in advance. Manual placement
    stays as an option.
  - **Preview before launch:** "8 → A, 11 → B, 6 → C, 3 → unassigned", with drag-to-adjust before anyone moves.
  - If a student stamped more than once (one-name-stamp rule off), use their **most recent** stamp.

### Lesson packs: a whole lesson in one file, shareable between teachers
Plan: [`PLANS_LESSON_PACKS.md`](PLANS_LESSON_PACKS.md) phases 2–3, with the open decisions listed there.
- [x] **Export/import a "lesson pack"**: one file with everything needed to run a lesson, minus student data.
  *Done (PLANS_LESSON_PACKS.md phase 2): **Save lesson…** / **Load lesson…**, `.allaboard` files. Custom stamps aren't
  in packs yet (they don't exist). Phase 3 is built too: **Also copy my ink from Main** on a round copies the teacher's
  Main ink onto every board of that round (late joiners included), and packs carry it.*
  Original notes:
  - the **main board** (background and teacher ink)
  - **prepared rounds** with their worksheets and groups
  - room settings, including "students start on their own boards", the student starting worksheet and the
    one-name-stamp rule
  - the teacher's **custom stamps**, once those exist
- **Builds on the room export (snapshot v2):** `handleExportJSON` / `teacher:import-room` already carry the main board,
  sub-boards, `breakoutConfig`, and an `assets` map that embeds each image once. A lesson pack is a new `kind: 'lesson'`
  (or `version: 3`) that strips student boards, chat, roster and banned/locked names, adds prepared rounds,
  `roundTemplates` and room settings, and uses a friendly extension (e.g. `.allaboard`, still JSON inside).
- **Import flow:** "Load lesson…" sets up the current room (or a fresh one). No students move until the teacher
  launches something.
- **Decisions to make:**
  - Should packs include teacher ink on student worksheets (e.g. pre-written instructions)? Probably yes.
  - Sharing starts with email/Drive/file. A shared library would need accounts, so avoid it.

### Worksheet import polish
- [ ] **Show page-by-page progress** while large PDFs render in the browser. Today the button only says "Rendering...".
- [ ] **HTML worksheets:** add a tip in the upload dialog to print to PDF first.
- [ ] **PowerPoint (`.pptx`) uploads:** add a tip to use *Save as PDF*, or to import through Slides / PDF from Drive.

### Problem reports
- [x] **"Something not working?"** guided report (issue #57): public GitHub issue plus private email to the shared
      inbox, with copy/download/email fallback. See [`docs/REPORTS.md`](docs/REPORTS.md).
  - [ ] **Owner setup:** turn on AllAboard reports in OverBoard's report script (BPMData/OverBoard PR 56), add the
        `REPORT_RELAY_URL` / `REPORT_RELAY_TOKEN` secrets, send a test report. Until then every report uses the fallback.

### A real eraser (remove objects instead of covering them)
- [ ] **Make the eraser delete or trim what it touches, instead of adding an "eraser stroke" element.** Today the
      eraser is a white ink stroke stored like any other ink, and `getVisibleStrokeRuns` / `expandElementVisiblePieces`
      (`src/lib/inkCore.ts`) work out what still shows at render time. Effects:
  - Erasing makes a board **heavier**, not lighter. Each swipe is another element (it counts toward the 10,000-per-board
    cap) and makes every later render, digest and PDF export do more work.
  - Hidden objects still exist. That was the one-name-stamp bug (fixed Nov 2026 for **stamps only**: erasing a stamp
    now deletes it, via `stampsHitByEraser`). Erased text notes (`allGoneNoteIds`) and fully erased strokes still sit
    in the data, still show up in lasso selection, and still count in "N drawn".
  - **Goal:** on pen-up, an eraser stroke turns into edits.
    - Fully covered strokes, notes and shapes are **removed**.
    - Partly erased freehand strokes are **split** into their visible pieces. `expandElementVisiblePieces` already
      computes them, and lasso-move already uses it.
    - No eraser element is stored.
    - Undo stays one step: one `replace` entry with what was removed and what was added.
  - **Watch out for:**
    - Live erasing feedback while the pen is down. Keep drawing the white stroke locally and only commit edits on
      pen-up.
    - Other users' views. They get remove and add batches, not a stroke.
    - Shapes and hollow strokes, which can't be split cleanly. Remove them only when fully covered, and otherwise
      keep a covering stroke for just those.
    - Old rooms that already contain eraser elements. Keep rendering them, or migrate them on load.
    - Rate and size caps on large batches (`socketGuards.ts`).
  - **Tests:** element counts go **down** after erasing, a partial erase leaves the right pieces, undo/redo restores
    them exactly, and a second browser sees the same result.

### Classroom simulator: fake students for testing alone
- [ ] **One command that fills a room with fake students** so a teacher can test breakouts, worksheet variants,
      corner mode, late joiners and lesson-pack reloads from one laptop, without a pile of incognito tabs.
  - **Build on `scripts/loadtest.ts`.** It already connects fake Socket.IO students, locally or to `--url`, and
    gets through the HTTPS proxy. Put the new script at `scripts/classroom.ts`, add `"classroom": "tsx scripts/classroom.ts"`
    to `package.json`, and add a short **"Test with fake students"** section to `README.md`.
  - **What the fake students do:**
    - Join with readable names (`Ava (bot)`, `Ben (bot)`, …) and stay connected until you stop the script.
    - **Stamp their name** on the main board, either in random corners or as you set with
      `--corners tl:5,tr:5,bl:4,br:6`. The stamp position is worked out from the main board's worksheet bounds, so
      it lands inside the boxes.
    - **Follow breakouts.** When moved to their own board or a group board, each one writes its name in a text box
      there, so the Live Grid shows who is who and which worksheet each got.
    - Set status (**Need help** / **Done**) at random if `--statuses` is given.
  - **Controls while it runs** (keys in the terminal, listed when it starts):
    `l` = one late joiner, `L` = five late joiners, `s` = everyone re-stamps, `r` = everyone disconnects and
    rejoins, `d` = everyone draws a scribble, `q` = everyone leaves and the script quits.
  - **Safety:**
    - Refuse to start unless the room code begins with `test-` (or `--i-know`), so it can never land in a real
      class.
    - Cap at 40 students.
    - Never send the teacher PIN.
    - On quit, remove the bots' ink and stamps (`clear-user-drawings`) and disconnect cleanly.
  - **How to launch it**, once built (the README section should say exactly this):
    1. **Against production (easiest):** open AllAboard yourself as teacher in room `test-whatever`. Then, in a
       Claude Code session on this repo, say: *"Run `npm run classroom -- --url https://<the AllAboard URL>
       --room test-whatever --students 20` and leave it running."* Tell Claude when you're done, and it presses `q`.
    2. **On your own computer** (needs Node 22): `npm ci` once, then
       `npm run classroom -- --url https://<the AllAboard URL> --room test-whatever --students 20`.
    3. **Fully local:** run `npm run dev` in one terminal and `npm run classroom -- --room test-whatever` in
       another. It defaults to `http://localhost:3000`. Then open `http://localhost:3000` as teacher.
  - **Tests:** a `node:test` that runs the script against `startServer` with 5 bots, `--corners tl:2,br:3` and no
    keyboard (`--seconds 5`). Check that 5 users joined, the stamps fall in the right quadrants
    (`src/lib/stampQuadrants.ts`), and the bots' ink is gone after quit.

### Housekeeping
- [ ] **Hosting: undecided.** Options, measurements, prices and a Compute Engine VM sketch are archived in
      [`docs/HOSTING_OPTIONS.md`](docs/HOSTING_OPTIONS.md). Nothing chosen; first read the `[load]` logs after PR #48.
- [ ] Add a lifecycle rule to the `run-sources-loyal-rookery-403218-us-east1` bucket (delete objects older than 30 days).
      It stores ~80 MB of uploaded source per deploy.

## On hold

### Custom teacher stamps (SVG only)
- [ ] **Teachers upload their own stamps** (a signature, a custom badge, a school logo) and place them like the
      built-in stamps.
  - **Decision: SVG only.** No PNG or JPEG uploads. SVGs are small, stay sharp at any size, and keep this simple.
  - **⚠️ SVGs can contain scripts, so uploads must be cleaned on the server.** Rendering through `<img>` blocks
    scripts, but `/api/assets/<hash>` is on the app's own origin, so opening a malicious SVG directly could run code
    there. Remove scripts, event handlers, external references and `foreignObject`, and serve SVG assets with
    `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`.
  - **Storage:** the content-addressed asset system stores each file once, and a placed stamp is a small element that
    references its asset URL. `sniffMime` already recognizes SVG. Add a teacher-only upload path that returns the URL,
    with a small size limit (e.g. 100 KB), so elements never carry `data:` URLs.
  - **Rendering:** the SVG must draw correctly on the board and in PNG and batch PDF exports. Require or infer a usable
    `viewBox` or width and height.
  - **The stamp library lives with the teacher.** There are no accounts, and `gcAssets` deletes assets no room
    references after 1 hour. Keep the library in the teacher's browser and in lesson packs, and re-upload on use.
    Deduplication gives the same URL each time.

### Unique display names
- [ ] **Stop two people in a room from using the same display name.**
  - **Decision needed:** refuse the name, or adjust it automatically (e.g. "Sam 2").
  - Must handle a student rejoining under their own name, teacher renames, locked names, and people who have left.

## Ideas (not decided)
- [ ] **Follow-teacher view:** bring students to the page or region the teacher is explaining on large worksheets.
- [ ] **Per-student drawing mute:** stop one student drawing without locking the board or kicking them.
- [ ] **4× worksheet import size.** The picker currently goes up to 3×.
- [ ] **PowerPoint conversion in the browser:** LibreOffice compiled to WebAssembly converts `.pptx` → PDF on the
      teacher's device only. It's a 50–100 MB lazy download, and fidelity must be checked against real decks.
- [ ] **Slide picker before the Drive export:** only if the Slides API accepts the existing `drive.file` token. Never
      request `presentations` or `presentations.readonly` (rule 6 in `CLAUDE.md`).

## Not doing
- **Record of who deleted or erased ink.** Not worth the added storage, UI and performance cost.
- **Server-side HTML worksheet rendering.** It would need a headless browser on Cloud Run.
- **A shared lesson library with accounts.** File and Drive sharing are enough.

## Done

### Classroom and teacher tools
- [x] **Selection shows who made the ink** (teachers only)
- [x] **"Ink by" filter:** a teacher can fade everyone else's ink on their own screen
- [x] **One name stamp per student:** teacher toggle, enforced on the server
- [x] **Share a student board to Main**, optionally anonymized, with each author's erasers kept separate
- [x] **Student status badges:** Need Help, Got It, Done
- [x] **Teacher laser pointer**
- [x] **Hide student cursors**
- [x] **Teacher-only feedback stamps**, enforced on the server
- [x] **"Students start on their own boards" room mode**
- [x] **Multi-round breakouts**
- [x] **Browser room history**

### Security and identity
- [x] **Private browser keys:** user IDs and teacher powers can't be taken over by reusing someone's ID
- [x] **Server-assigned ink authorship**
- [x] **Masked Teacher PIN fields** without password autofill

### Worksheet import
- [x] **Google Drive import and save** (`PLANS_GOOGLE_DRIVE.md`). School Workspace admins may still need to allow the
      app by OAuth client ID.
- [x] **Room name shown clearly:** sidebar, hidden-sidebar chip and browser tab title
- [x] **"Remove worksheet" asks for a second tap**
- [x] **Page picker with lazy thumbnails**
- [x] **Row / Column / Grid page layouts**, with Grid as the default for 3+ pages
- [x] **Import Size picker:** 0.5× to 3×, default 2×, remembered per teacher
- [x] **Drive import timeout, Cancel, progress and clear size-limit messages**
- [x] **Switch Google account** and show the connected account
- [x] **New folder when saving a room to Drive**
- [x] **PowerPoint files picked from Drive** are converted through a temporary Slides copy

### Infrastructure
- [x] **Faster, more reliable CI:** avoids the slow Ubuntu mirror, limits the install step to 5 minutes, and runs
      browser tests in parallel
