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
  - **Server:** a teacher-only path that applies `internBackground` once and then reuses the same asset URL for
    every board. With content-addressed assets, 30 boards cost one stored image.

### Prepared ("draft") breakout rounds
Plan: [`PLANS_LESSON_PACKS.md`](PLANS_LESSON_PACKS.md) phase 1.
- [ ] **Create breakout rounds in advance without moving anyone**, each with its own worksheet, mode
      (individual/groups) and groups. Launch one later with a click.
  - **Mostly exists:** rounds are already saved objects (`breakoutConfig.rounds`, `room.roundTemplates`), and
    `resume` already activates an existing round. What's missing is a `new-round` variant that creates the round
    **without** setting `mode`/`activeRoundId` (e.g. `prepare: true`), plus UI to list, edit and launch prepared rounds.
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
- [ ] **Export/import a "lesson pack"**: one file with everything needed to run a lesson, minus student data:
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
