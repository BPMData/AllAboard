# AllAboard — Google Drive Import/Save + Optional Google Name Autofill: Implementation Plan

> **Who this is for:** an implementing agent (Antigravity / Gemini, or Claude Code).
> **How to use it:** Do the phases **in order**. Each phase lists exact files and functions and ends
> with a **checkpoint**. Do not start the next phase until its checkpoint passes. The design decisions
> are already made (see Appendix A). Do not redesign anything. **Do not add Firebase.** If the code does
> not match this plan, stop and report it. Do not improvise a different design.
>
> Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first. This feature is **100% client-side**: no changes to
> `server.ts`, `roomStore.ts`, or `backupMirror.ts`.

---

## 0. Read this first

### 0.1 What we are building

1. **Page-range import for long PDFs.** Today `renderPdfToPages` silently keeps only the first
   `MAX_PDF_PAGES = 10` pages. When a PDF has more pages, the teacher picks which 10 (or fewer) to import.
   This helps local uploads too, and Drive imports need it.
2. **Import from Drive (teacher).** A **From Drive** button next to the worksheet upload button opens
   Google Picker filtered to Google Slides and PDFs. The chosen file becomes a `File` and goes through
   the **same** worksheet import path as a local upload.
3. **Save to Drive / Open from Drive (teacher).** Save the same v2 room snapshot that **Save .JSON** builds.
   Open a snapshot from Drive into the **existing** Import Snapshot modal (Replace / Merge preview).
4. **Optional name autofill (Welcome screen, last and optional).** A "Sign in with Google" button that
   only pre-fills the display-name input with the user's **given name**. No Drive access. No teacher powers.

### 0.2 Mental model (memorize these facts)

1. **Two separate Google libraries, two separate purposes.**
   - Drive access = **Google Identity Services token client** (`google.accounts.oauth2.initTokenClient`),
     scope **`https://www.googleapis.com/auth/drive.file` only**. Requested only when a teacher clicks a
     Drive button.
   - Name autofill = **Google Identity Services Sign In With Google button** (`google.accounts.id`). It
     returns an ID token (JWT). We read `given_name` from it. That is all.
2. **The access token lives in module memory only.** Never in `localStorage`, never in React state that
   persists. It expires (`expires_in`, ~1 hour). Treat it as expired 60 s early. A page reload loses it;
   the next Drive click gets a new one (usually with no prompt).
3. **Google scripts load lazily, on click.** Never in `index.html`, never on page load. Students who never
   click a Google button never contact Google. If a script fails to load, the button shows an inline
   error and every local workflow still works (fail open).
4. **Picker + `drive.file` needs the App ID.** `PickerBuilder.setAppId(<project number>)` is what grants
   the app read access to the file the teacher picks. Without it, downloading the picked file returns 404.
5. **Branch on `mimeType` to download.** Google Slides
   (`application/vnd.google-apps.presentation`) → `files/{id}/export?mimeType=application/pdf`.
   Everything else (`application/pdf`, `application/json`) → `files/{id}?alt=media`.
6. **Google sign-in never grants teacher status.** Teacher auth stays PIN-only (`teacher:auth`).

### 0.3 Non-goals (do not build these)

- Firebase, Firestore, or any server-side OAuth.
- The `drive.metadata.readonly` scope (restricted; needs a security audit; Picker does not need it).
- A Drive folder picker for saving. Saves go to My Drive root.
- Background or automatic Drive sync.
- Importing more than `MAX_PDF_PAGES` pages at once. Annotating long slideshows is a future
  **OverBoard** feature, not AllAboard.
- Storing the user's email or photo.

---

## Phase 0 — Google Cloud setup (a **human** does this, not the agent)

The agent cannot do this. The agent should start at Phase 1 and leave the config values empty; the
Google buttons stay hidden until a human fills them in (see Phase 2.1).

Use the Google Cloud project that hosts AllAboard's Cloud Run service (or any project you own).

1. **Note the project number** (Cloud Console → Dashboard). This is the Picker **App ID**.
2. **Enable APIs:** *Google Drive API* and *Google Picker API*.
3. **OAuth consent screen (Google Auth Platform → Branding / Audience / Data access):**
   - User type: **External**.
   - App name: `AllAboard`. Add a support email and the production domain as an authorized domain.
   - Scopes: add **only** `.../auth/drive.file` (plus the default `openid`, `email`, `profile`).
   - Publishing status: **In production.** (In *Testing* mode only listed test users can sign in, and
     their grants expire after 7 days.) `drive.file` is a non-sensitive scope, so only light brand
     verification applies; until then users may see an "unverified app" screen.
4. **Credentials → Create OAuth client ID → Web application.**
   - Authorized JavaScript origins: the published app origin(s) (Cloud Run URL and any custom domain),
     and `http://localhost:3000` for local dev. **No redirect URIs** are needed.
   - Copy the **Client ID**.
5. **Credentials → Create API key.** Restrict it: *Application restrictions* → HTTP referrers (same
   origins as step 4); *API restrictions* → Google Picker API. Copy the key. (It is public by design.)
6. Paste the three values into `src/lib/googleConfig.ts` (created in Phase 2.1) and redeploy.
7. **School accounts:** a district Google Workspace may block third-party apps. Their admin can allow it
   in Admin console → Security → Access and data control → API controls → Manage third-party app access,
   by searching for the OAuth Client ID. Personal `@gmail.com` accounts work right away.

**AI Studio preview caveat:** the preview iframe's origin may change and may not be in the authorized
origins list, and the iframe may block popups. Test Google features on the **published URL** and on
`localhost:3000`. Not working in the preview pane is acceptable.

---

## Phase 1 — Refactors and page-range import (no Google code yet)

### 1.1 Move `PendingSnapshotData` to `src/types.ts`

- Cut `export interface PendingSnapshotData { ... }` from `src/components/CanvasModals.tsx` and paste it
  into `src/types.ts` next to `RoomSnapshot`. It already uses only types from `types.ts`.
- In `CanvasModals.tsx`, import it from `../types` and add `export type { PendingSnapshotData };` so
  existing imports keep working.

### 1.2 New file `src/lib/roomSnapshot.ts` (pure, no DOM, no React)

```ts
import type { CanvasElement, ChatMessage, PendingSnapshotData } from '../types';

export function snapshotFileName(roomId: string, date: Date = new Date()): string {
  return `allaboard-room-${roomId}-${date.toISOString().slice(0, 10)}.json`;
}

export interface ParsedSnapshot {
  pending: PendingSnapshotData;
  error: string | null;
}

/** Shared by local "Import .JSON" and "Open from Drive". Never throws. */
export function parseSnapshotText(fileName: string, text: string, fallbackRoomId: string): ParsedSnapshot {
  const empty: PendingSnapshotData = { fileName, roomId: fallbackRoomId, elements: [], messages: [], background: null };
  let parsed: any;
  try {
    parsed = JSON.parse(text || '{}');
  } catch {
    return { pending: empty, error: 'Could not parse JSON file. Make sure it is a valid .json room snapshot.' };
  }
  if (
    !parsed ||
    (!Array.isArray(parsed.elements) && !Array.isArray(parsed.messages) && !parsed.background && !parsed.subBoards)
  ) {
    return { pending: empty, error: 'This JSON file does not contain valid AllAboard room data.' };
  }
  const elements: CanvasElement[] = Array.isArray(parsed.elements)
    ? parsed.elements.filter((el: any) => el && typeof el.id === 'string' && typeof el.tool === 'string')
    : [];
  const messages: ChatMessage[] = Array.isArray(parsed.messages)
    ? parsed.messages.filter((m: any) => m && typeof m.id === 'string' && typeof m.text === 'string')
    : [];
  return {
    error: null,
    pending: {
      fileName,
      roomId: parsed.roomId || fallbackRoomId,
      exportedAt: parsed.exportedAt,
      exportedBy: parsed.exportedBy,
      elements,
      messages,
      background: parsed.background || null,
      subBoards: parsed.subBoards,
      breakoutConfig: parsed.breakoutConfig,
      assets: parsed.assets && typeof parsed.assets === 'object' ? parsed.assets : undefined,
    },
  };
}
```

This must behave **exactly** like the current inline logic in `Canvas.tsx` `handleFileChange`
(around line 2015). Compare them line by line.

### 1.3 Use it in `Canvas.tsx`

- Add a helper inside the component:
  ```ts
  const openSnapshotText = (fileName: string, text: string) => {
    const { pending, error } = parseSnapshotText(fileName, text, roomId);
    setImportError(error);
    setPendingSnapshot(pending);
    if (!error) setImportMode('replace');
  };
  ```
- Rewrite `handleFileChange` to read the file and call `openSnapshotText(file.name, String(reader.result || ''))`.
  Keep any existing `e.target.value` reset.
- Split `handleExportJSON` into:
  - `buildSnapshotJson(): Promise<{ json: string; fileName: string }>` — everything up to and including
    `JSON.stringify(snapshot, null, 2)`, with `fileName = snapshotFileName(roomId)`.
  - `handleExportJSON` — calls `buildSnapshotJson()` and does the existing `<a download>` click.

### 1.4 New file `src/lib/pageRange.ts` (pure)

```ts
export interface PageRange { first: number; last: number } // 1-based, inclusive

/** Clamp a requested range to [1, total] and to at most `max` pages, keeping `first` fixed when possible. */
export function clampPageRange(first: number, last: number, total: number, max: number): PageRange {
  const t = Math.max(1, Math.floor(total));
  let f = Math.min(Math.max(1, Math.floor(first) || 1), t);
  let l = Math.min(Math.max(f, Math.floor(last) || f), t);
  if (l - f + 1 > max) l = f + max - 1;
  return { first: f, last: l };
}
```

### 1.5 `src/lib/worksheetLoader.ts`

- `export const MAX_PDF_PAGES = 10;` (add `export`).
- Add:
  ```ts
  export async function getPdfPageCount(file: File): Promise<number> {
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    return pdf.numPages;
  }
  ```
- Change signatures:
  `processWorksheetFile(file: File, range?: PageRange)` → passes `range` to
  `renderPdfToPages(file: File, range?: PageRange)`.
- In `renderPdfToPages`, replace the `for (let pageNum = 1; pageNum <= numPages; ...)` bounds with
  `const { first, last } = clampPageRange(range?.first ?? 1, range?.last ?? MAX_PDF_PAGES, pdf.numPages, MAX_PDF_PAGES);`
  and loop `first..last`. With no `range`, behavior is unchanged (pages 1–10).
- Add `export function isPdfFile(file: File): boolean` using the existing `isPdf` test, and use it in
  `processWorksheetFile`.

### 1.6 Page-range modal

In `src/components/CanvasModals.tsx`, add `PdfPageRangeModal`:

- Props: `fileName`, `totalPages`, `maxPages`, `onConfirm(range: PageRange)`, `onCancel()`.
- Two number inputs, **From** and **To**, default `1` and `maxPages`. Clamp with `clampPageRange` on
  blur and on confirm.
- Text: `"<fileName>" has <totalPages> pages. AllAboard imports up to <maxPages> at a time.`
  Below the inputs, live: `Importing pages <first>–<last>.`
- Buttons: **Import pages** (primary), **Cancel**. Match the styling of the existing import modal in
  the same file.

### 1.7 One worksheet import path in `Canvas.tsx`

Refactor `handleWorksheetFileChange` (around line 1902):

- New state: `const [pendingPdfRange, setPendingPdfRange] = useState<{ file: File; totalPages: number } | null>(null);`
- New function `importWorksheetFile(file: File, range?: PageRange)` = the current body from
  `setIsUploadingWorksheet(true)` through `finally`, calling `processWorksheetFile(file, range)`.
- New function `startWorksheetImport(file: File)`:
  ```ts
  if (isPdfFile(file)) {
    try {
      const total = await getPdfPageCount(file);
      if (total > MAX_PDF_PAGES) { setPendingPdfRange({ file, totalPages: total }); return; }
    } catch { /* fall through; importWorksheetFile reports the error */ }
  }
  await importWorksheetFile(file);
  ```
- `handleWorksheetFileChange` now just reads the file, resets `e.target.value`, and calls
  `startWorksheetImport(file)`.
- Render `PdfPageRangeModal` when `pendingPdfRange` is set. Confirm → clear state, then
  `importWorksheetFile(file, range)`. Cancel → clear state.
- For the background's `fileName`, when a range was used, append ` (pp. <first>–<last>)`.

### 1.8 Tests

- `tests/roomSnapshot.test.ts`: valid v2 snapshot; bad JSON → parse error; `{}` → "does not contain"
  error; filters out elements without `id`/`tool`; `roomId` falls back; `snapshotFileName` format.
- `tests/pageRange.test.ts`: `(1,10,34,10)→1–10`; `(25,40,34,10)→25–34`; `(5,30,34,10)→5–14`;
  `(0,0,3,10)→1–1`; `(50,60,34,10)→34–34`; `(3,2,34,10)→3–3`.
- `e2e/worksheets.spec.ts`: add a case that builds a 12-page PDF (reuse the existing in-browser PDF
  fixture approach in that file), imports it, sees the modal, picks 3–12, and gets 10 pages.

**Checkpoint 1:** `npm run lint`, `npm test`, `npm run test:e2e` all pass. Manually: import a 12+ page
PDF locally → modal → chosen pages appear. Import .JSON and Save .JSON behave exactly as before.

---

## Phase 2 — Google client library (`src/lib/`), no UI yet

### 2.1 `src/lib/googleConfig.ts`

```ts
// Public, non-secret values from Phase 0. Hardcoded on purpose: AI Studio Publish rewrites env vars (CLAUDE.md rule 1).
const DEFAULTS = {
  clientId: '',  // OAuth 2.0 Web client ID
  apiKey: '',    // Browser API key restricted to the Picker API
  appId: '',     // Google Cloud project NUMBER
};

export interface GoogleConfig { clientId: string; apiKey: string; appId: string }

export function getGoogleConfig(): GoogleConfig {
  // Test hook (Playwright). All values are public, so this is harmless in production.
  const override = typeof window !== 'undefined' ? (window as any).__ALLABOARD_GOOGLE_CONFIG__ : undefined;
  return { ...DEFAULTS, ...(override || {}) };
}

export function isGoogleSignInConfigured(): boolean { return Boolean(getGoogleConfig().clientId); }
export function isGoogleDriveConfigured(): boolean {
  const c = getGoogleConfig();
  return Boolean(c.clientId && c.apiKey && c.appId);
}
```

**Every Google button is hidden when its `is...Configured()` is false.**

### 2.2 `src/lib/googleDrive.ts`

Rules: no access to `window`/`document` at import time (node tests import this file). Export the pure
helpers so they can be unit-tested.

```ts
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const SLIDES_MIME = 'application/vnd.google-apps.presentation';
export const PDF_MIME = 'application/pdf';
export const JSON_MIME = 'application/json';
export const DRIVE_FILE_KEY_PREFIX = 'drawchat_drive_file_'; // + roomId → Drive fileId of the last save

export class GoogleError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
```
(No parameter properties; keep the explicit field to match the repo's TS style.)

**Pure helpers (export and unit test):**

- `downloadUrlFor(doc: { id: string; mimeType: string }): string`
  - Slides → `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=application%2Fpdf`
  - else → `https://www.googleapis.com/drive/v3/files/${id}?alt=media`
- `importedFileName(doc: { name: string; mimeType: string }): string` → Slides gets `.pdf` appended.
- `friendlyGoogleError(code: string): string` — map:

  | code | message |
  |---|---|
  | `script_load_failed` | Couldn't reach Google. Your network may block it. Local upload still works. |
  | `popup_failed_to_open` | Your browser blocked the Google sign-in window. Allow popups for this site, or open AllAboard in its own tab. |
  | `popup_closed` | Google sign-in was cancelled. |
  | `access_denied` / `admin_policy_enforced` | Your Google account (or school) didn't allow AllAboard to use Drive. Download the file and use Upload instead, or ask your IT admin to allow AllAboard. |
  | `exportSizeLimitExceeded` | This deck is too big for Google to convert (10 MB limit). In Slides, use File → Download → PDF, then Upload. |
  | `not_found` | AllAboard can't open that file. Pick it again from Drive. |
  | anything else | Google Drive request failed. Local upload still works. |

**Browser functions:**

- `loadScript(src: string, globalCheck: () => boolean): Promise<void>` — resolve immediately if
  `globalCheck()` is true; otherwise append `<script async>` once (cache the promise); reject with
  `GoogleError('script_load_failed', ...)` on error or after a 15 s timeout.
- `getAccessToken(): Promise<string>`
  - Module vars: `let token: string | null = null; let expiresAt = 0; let tokenClient: any = null;`
  - If `token && Date.now() < expiresAt - 60_000` → return it.
  - Load `https://accounts.google.com/gsi/client` (check: `window.google?.accounts?.oauth2`).
  - Lazily create `google.accounts.oauth2.initTokenClient({ client_id, scope: DRIVE_SCOPE, callback, error_callback })`.
    Use a single pending promise; set `callback`/`error_callback` to resolve/reject it.
  - Call `tokenClient.requestAccessToken({ prompt: '' })`. Always use `prompt: ''`; Google shows the
    consent screen only when it is needed.
  - On success: store `token`, `expiresAt = Date.now() + expires_in * 1000`.
  - On `response.error` → reject `GoogleError(response.error, ...)`. On `error_callback(err)` → reject
    `GoogleError(err.type, ...)`.
  - **Must be called directly from a click handler** (before any other `await`) so the popup is not blocked.
- `clearAccessToken()` — reset `token`/`expiresAt`.
- `driveFetch(url: string, init?: RequestInit): Promise<Response>` — adds `Authorization: Bearer`.
  On 401: `clearAccessToken()`, get a new token, retry once. On non-OK: read JSON body, use
  `error.errors[0].reason` (e.g. `exportSizeLimitExceeded`) or `not_found` for 404 as the
  `GoogleError` code.
- `pickDriveFile(kind: 'worksheet' | 'snapshot'): Promise<{ id: string; name: string; mimeType: string } | null>`
  - `const token = await getAccessToken();`
  - Load `https://apis.google.com/js/api.js` (check: `window.gapi`), then
    `await new Promise(r => gapi.load('picker', r))`.
  - View: `new google.picker.DocsView(google.picker.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false)`
    and `.setMimeTypes(kind === 'worksheet' ? `${SLIDES_MIME},${PDF_MIME}` : JSON_MIME)`.
  - Builder: `.setOAuthToken(token).setDeveloperKey(apiKey).setAppId(appId).addView(view)`
    `.setOrigin(pickerOrigin()).setCallback(cb).build().setVisible(true)`.
  - `pickerOrigin()` = last entry of `window.location.ancestorOrigins` if present (Chrome iframes),
    else `window.location.origin`.
  - `cb(data)`: `PICKED` → resolve `data.docs[0]` fields; `CANCEL` → resolve `null`.
- `downloadDriveFile(doc): Promise<File>` — `driveFetch(downloadUrlFor(doc))` → `blob()` →
  `new File([blob], importedFileName(doc), { type: doc.mimeType === SLIDES_MIME ? PDF_MIME : doc.mimeType })`.
- `saveJsonToDrive(roomId: string, fileName: string, json: string): Promise<{ id: string; name: string }>`
  - Existing id = `localStorage.getItem(DRIVE_FILE_KEY_PREFIX + roomId)` (wrap in try/catch).
  - Use a **resumable** upload (snapshots can exceed the 5 MB multipart limit):
    1. Start: existing id → `PATCH https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=resumable`
       with body `{ name }`; no id → `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable`
       with body `{ name, mimeType: JSON_MIME }`. Headers: `Content-Type: application/json; charset=UTF-8`,
       `X-Upload-Content-Type: application/json`.
    2. Read the `Location` header; `PUT` the JSON to it with `Content-Type: application/json`.
    3. If step 1 PATCH fails with `not_found` (file trashed/deleted), remove the stored id and redo as POST.
    4. Store the returned `id` under `DRIVE_FILE_KEY_PREFIX + roomId`.
  - **If the browser cannot read the `Location` header (CORS), stop and report.** Do not switch designs.

### 2.3 Tests

`tests/googleDrive.test.ts`: `downloadUrlFor` (Slides vs PDF vs JSON), `importedFileName`,
`friendlyGoogleError` (known codes + fallback). Importing the module in node must not throw.

**Checkpoint 2:** lint + tests pass; `node -e "import('./server.ts').then(() => console.log('OK'))"` prints OK.

---

## Phase 3 — "From Drive" worksheet import (teacher bar)

In `Canvas.tsx`, right after the **Upload (.JPG / .PNG / .PDF)** button (around line 4209), render
only when `isGoogleDriveConfigured()`:

- A button with the same classes, a `lucide-react` icon (e.g. `HardDrive`), label **From Drive**,
  title `Import a Google Slides deck or PDF from your Google Drive`, `disabled={isUploadingWorksheet || driveBusy}`.
- Handler:
  ```ts
  const handleWorksheetFromDrive = async () => {
    setWorksheetError(null);
    setDriveBusy('Opening Google Drive...');
    try {
      const doc = await pickDriveFile('worksheet'); // calls getAccessToken first, inside the click
      if (!doc) return;
      setDriveBusy('Importing from Drive...');
      const file = await downloadDriveFile(doc);
      await startWorksheetImport(file); // same path as local upload, including the page-range modal
    } catch (err: any) {
      setWorksheetError(err instanceof GoogleError ? friendlyGoogleError(err.code) : (err?.message || 'Could not import from Drive.'));
    } finally {
      setDriveBusy(null);
    }
  };
  ```
- `const [driveBusy, setDriveBusy] = useState<string | null>(null);` — show its text in the button label
  while set. Errors show wherever `worksheetError` already shows.

**Checkpoint 3:** with real config on `localhost:3000`: import a Slides deck, a PDF, and a >10 page deck
(modal appears). Cancel the picker → nothing happens, no error. With config empty → button hidden.

---

## Phase 4 — Save to Drive / Open from Drive

- **Save to Drive:** next to **Save .JSON** (around line 3870), same classes, label **Save to Drive**.
  ```ts
  const { json, fileName } = await buildSnapshotJson();
  const saved = await saveJsonToDrive(roomId, fileName, json);
  setDriveNotice(`Saved ${saved.name} to Google Drive`);
  ```
  **Important:** call `getAccessToken()` **first** in the handler (before `buildSnapshotJson()`, which
  awaits network fetches) so the sign-in popup is still tied to the click.
  Show `driveNotice` as quiet inline text next to the button; clear it after 6 s. Errors use
  `friendlyGoogleError`.
- **Open from Drive:** next to **Import .JSON** (around line 4313), same classes, label **Open from Drive**.
  `pickDriveFile('snapshot')` → `downloadDriveFile(doc)` → `openSnapshotText(doc.name, await file.text())`.
  This opens the existing Import Snapshot modal. Nothing is applied until the teacher confirms there.
- Both buttons only when `isGoogleDriveConfigured()`.

**Checkpoint 4:** Save twice from the same room → **one** file in Drive, updated (not two). Trash it in
Drive, save again → a new file is created. Open from Drive → Replace/Merge modal → apply works.

---

## Phase 5 — Optional name autofill (Welcome screen)

Only if the human still wants it after Phases 1–4 ship. Render only when `isGoogleSignInConfigured()`.

- In `src/App.tsx`, directly above the `Your Display Name` label (around line 1561):
  a container `<div ref={googleButtonRef} />` plus a small divider line of text
  `or type any name below` in `text-slate-500 text-xs`.
- On mount of the Welcome screen: `loadScript('https://accounts.google.com/gsi/client', ...)` then
  `google.accounts.id.initialize({ client_id, callback: onCredential })` and
  `google.accounts.id.renderButton(googleButtonRef.current, { theme: 'filled_black', size: 'large', text: 'signin_with', shape: 'pill' })`.
  If the script fails to load, render nothing (no error; typing a name is the default path).
  *(This is the one place a Google script loads without a click. If that's unacceptable, show a plain
  "Use my Google name" button that loads the script on click instead.)*
- `onCredential({ credential })`: decode the JWT payload (base64url → JSON) with a pure helper
  `decodeJwtPayload` in `googleDrive.ts` (unit test it). Use `given_name || name`, trimmed, `slice(0, 28)`.
  Call `setUserName(...)` **only if the input is empty**; otherwise show
  `Use "<given_name>"?` as a small inline link that sets it.
- The ID token is **not verified** and **not sent to the server**. It is only a name suggestion; the
  normal join flow (server name collision handling, teacher name locks) applies unchanged.
- Do not store the token, email, or photo anywhere.

**Checkpoint 5:** name fills in; editing it still works; Join works; no `localStorage` key other than
the existing `USER_NAME` changes.

---

## Phase 6 — End-to-end tests with stubbed Google

New `e2e/googleDrive.spec.ts`:

- `page.addInitScript` sets `window.__ALLABOARD_GOOGLE_CONFIG__ = { clientId: 'test', apiKey: 'test', appId: '1' }`
  and fake `window.google.accounts.oauth2.initTokenClient` (callback returns `{ access_token: 't', expires_in: 3600 }`),
  `window.gapi.load`, and `window.google.picker` (builder whose `setVisible(true)` immediately calls the
  callback with `PICKED` and a fixture doc).
- `page.route('https://www.googleapis.com/**', ...)` serves a fixture PDF for `alt=media`/`export`, and
  fake resumable-upload responses (with a `Location` header and `access-control-expose-headers: Location`).
- Cases: From Drive (PDF) → board shows pages; From Drive (Slides) → hits the `export` URL;
  Open from Drive → import modal appears; Save to Drive twice → second request is `PATCH`;
  **script blocked** (`route.abort()` on `accounts.google.com`) → inline error, local Upload still works;
  config empty → no Drive buttons.

**Final checkpoint:** `npm run lint`, `npm test`, `npm run test:e2e` all pass (all existing tests plus
the new ones), and `node -e "import('./server.ts').then(() => console.log('OK'))"` prints OK.
`git diff --stat` shows **no** changes to `server.ts`, `roomStore.ts`, `backupMirror.ts`, or `package.json`
dependencies.

---

## Appendix A — Decisions (already made; do not revisit)

| Decision | Why |
|---|---|
| Google Identity Services, not Firebase | Firebase adds a dependency and a project, can't refresh Google access tokens, and keeps a "signed in" user across reloads with no Drive token. GIS does both jobs directly. |
| `drive.file` only | Non-sensitive; access limited to files the teacher picks or the app creates. `drive.metadata.readonly` is restricted and not needed by Picker. |
| Drive scope requested on teacher click, not at Welcome | Students never see a Drive consent screen. |
| Token in memory only | Short-lived secret; reload → one click (usually silent) gets a new one. |
| Lazy script loading | School filters block Google domains; Chromebooks are slow; students who never click never contact Google. |
| Config hardcoded, buttons hidden when empty | AI Studio Publish rewrites env vars; fail open. |
| Resumable upload, update by stored fileId | Snapshots can exceed 5 MB; avoids duplicate files on every save. |
| Page range capped at `MAX_PDF_PAGES` | Long-deck annotation belongs in OverBoard later. |
| No server changes | Live multiplayer persistence (SQLite + `gs://allaboard-data`) stays as is. |
