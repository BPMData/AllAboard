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
- **Other gotchas:**
  - Drive caps exports at **10 MB**. Show a clear error that suggests File → Download → PDF.
  - Decks often exceed the importer's 10-page cap (`MAX_PDF_PAGES`). Ship this with a slide/page picker (below).

### PDF import improvements
- [ ] **Page picker** ("use pages 3–5") instead of silently keeping only the first 10 pages (`MAX_PDF_PAGES = 10`).
- [ ] **Progress/feedback** while large PDFs render in the browser.
- [ ] Optionally render sharper (currently ~1400 px wide JPEG, which is soft on dense text).

### Other formats
- [ ] **HTML worksheets:** add a tip in the upload dialog to print to PDF first. Server-side HTML rendering
      would need a headless browser on Cloud Run, which isn't worth it.
- [ ] **PowerPoint (`.pptx`):** add a tip to use *Save as PDF*. Native `.pptx` rendering needs LibreOffice on the
      server (~500 MB, fights AI Studio's managed container) or JS renderers that mangle layouts. Only revisit if
      people actually ask for it.

## Housekeeping
- [ ] Add a lifecycle rule to the `run-sources-loyal-rookery-403218-us-east1` bucket (delete objects older than 30 days).
      It stores ~80 MB of uploaded source per deploy.
