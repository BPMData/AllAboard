import { getGoogleConfig } from './googleConfig';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const SLIDES_MIME = 'application/vnd.google-apps.presentation';
export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
export const PPT_MIME = 'application/vnd.ms-powerpoint';
export const PDF_MIME = 'application/pdf';
export const OCTET_STREAM_MIME = 'application/octet-stream';
export const JSON_MIME = 'application/json';
/**
 * Lessons saved to Drive get their own type, so the lesson picker can list only lessons: the Picker filters by type,
 * not by file name, and room saves are application/json too. Lessons saved before this are application/json.
 */
export const LESSON_MIME = 'application/vnd.allaboard.lesson+json';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const MAX_PPTX_BYTES = 100 * 1024 * 1024;

export function isPowerPointMime(mimeType: string): boolean {
  return mimeType === PPTX_MIME || mimeType === PPT_MIME;
}

export function isWorksheetMime(mimeType: string): boolean {
  return mimeType === SLIDES_MIME || mimeType === PDF_MIME || isPowerPointMime(mimeType);
}
/** + roomId -> JSON DriveSaveRecord for that room's last Drive save. */
export const DRIVE_SAVE_KEY_PREFIX = 'drawchat_drive_save_';
/** JSON DriveFolder: the folder the teacher last saved any room to. */
export const DRIVE_LAST_FOLDER_KEY = 'drawchat_drive_last_folder';
/** Older format (plain file id per room). Read once for migration, then removed. */
const LEGACY_DRIVE_FILE_KEY_PREFIX = 'drawchat_drive_file_';

export class GoogleError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function downloadUrlFor(doc: { id: string; mimeType: string }): string {
  const id = encodeURIComponent(doc.id);
  if (doc.mimeType === SLIDES_MIME) {
    return `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=application%2Fpdf`;
  }
  return `https://www.googleapis.com/drive/v3/files/${id}?alt=media`;
}

export function importedFileName(doc: { name: string; mimeType: string }): string {
  if (doc.mimeType === SLIDES_MIME) return `${doc.name}.pdf`;
  if (isPowerPointMime(doc.mimeType)) {
    const base = doc.name.replace(/\.pptx?$/i, '') || doc.name;
    return `${base}.pdf`;
  }
  return doc.name;
}

export function friendlyGoogleError(code: string): string {
  switch (code) {
    case 'script_load_failed':
      return "Couldn't reach Google. Your network may block it. Local upload still works.";
    case 'popup_failed_to_open':
      return 'Your browser blocked the Google sign-in window. Allow popups for this site, or open AllAboard in its own tab.';
    case 'popup_closed':
      return 'Google sign-in was cancelled.';
    case 'access_denied':
    case 'admin_policy_enforced':
      return "Your Google account (or school) didn't allow AllAboard to use Drive. Download the file and use Upload instead, or ask your IT admin to allow AllAboard.";
    case 'exportSizeLimitExceeded':
      return 'This deck is too big for Google to convert (10 MB limit). Open it in Google Slides, use File \u2192 Download \u2192 PDF, then use Upload (.JPG / .PNG / .PDF). Big PDFs work fine that way.';
    case 'timeout':
      return 'Google took too long to convert this deck. For big decks, open it in Google Slides, use File \u2192 Download \u2192 PDF, then use Upload (.JPG / .PNG / .PDF). Big PDFs work fine that way.';
    case 'pptx_conversion_failed':
      return "This PowerPoint file couldn't be converted. Open it in Google Slides (or save it as PDF in PowerPoint) and try again.";
    case 'unsupported_worksheet_type':
      return 'Please choose a Google Slides presentation or a PDF.';
    case 'not_found':
      return "AllAboard can't open that file. Pick it again from Drive.";
    default:
      return 'Google Drive request failed. Local upload still works.';
  }
}

const scriptPromises = new Map<string, Promise<void>>();

export function loadScript(src: string, globalCheck: () => boolean): Promise<void> {
  if (globalCheck()) return Promise.resolve();

  const existing = scriptPromises.get(src);
  if (existing) return existing;

  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;

    let settled = false;
    const finish = (err?: GoogleError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        scriptPromises.delete(src);
        script.remove();
        reject(err);
      } else {
        resolve();
      }
    };

    const fail = () => finish(new GoogleError('script_load_failed', friendlyGoogleError('script_load_failed')));
    const timer = setTimeout(fail, 15_000);

    script.onload = () => {
      if (globalCheck()) {
        finish();
      } else {
        fail();
      }
    };
    script.onerror = fail;

    document.head.appendChild(script);
  });

  scriptPromises.set(src, promise);
  return promise;
}

export interface DriveAccount {
  email: string;
  displayName?: string;
}

let token: string | null = null;
let expiresAt = 0;
let tokenClient: any = null;
let tokenClientForClientId: string | null = null;
let pendingTokenRequest: { resolve: (t: string) => void; reject: (err: unknown) => void } | null = null;
let inFlightTokenPromise: Promise<string> | null = null;
let cachedAccount: DriveAccount | null = null;
let inFlightAccountPromise: Promise<DriveAccount | null> | null = null;

export function clearAccessToken(): void {
  token = null;
  expiresAt = 0;
  cachedAccount = null;
  inFlightAccountPromise = null;
}

async function requestToken(prompt: '' | 'select_account'): Promise<string> {
  if (inFlightTokenPromise) {
    return inFlightTokenPromise;
  }

  inFlightTokenPromise = (async () => {
    await loadScript('https://accounts.google.com/gsi/client', () =>
      Boolean((window as any).google?.accounts?.oauth2)
    );

    const { clientId } = getGoogleConfig();
    if (!tokenClient || tokenClientForClientId !== clientId) {
      tokenClientForClientId = clientId;
      tokenClient = (window as any).google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: DRIVE_SCOPE,
        callback: (resp: any) => {
          const pending = pendingTokenRequest;
          pendingTokenRequest = null;
          if (!pending) return;
          if (resp?.error) {
            pending.reject(new GoogleError(resp.error, friendlyGoogleError(resp.error)));
            return;
          }
          if (!resp?.access_token) {
            pending.reject(new GoogleError('unknown', friendlyGoogleError('unknown')));
            return;
          }
          const expiresIn = Number(resp.expires_in) || 3600;
          token = resp.access_token;
          expiresAt = Date.now() + expiresIn * 1000;
          cachedAccount = null;
          pending.resolve(resp.access_token);
        },
        error_callback: (err: any) => {
          const pending = pendingTokenRequest;
          pendingTokenRequest = null;
          if (!pending) return;
          const code = err?.type || 'unknown';
          pending.reject(new GoogleError(code, friendlyGoogleError(code)));
        },
      });
    }

    return await new Promise<string>((resolve, reject) => {
      pendingTokenRequest = { resolve, reject };
      try {
        tokenClient.requestAccessToken({ prompt });
      } catch (err) {
        pendingTokenRequest = null;
        reject(err);
      }
    });
  })();

  try {
    return await inFlightTokenPromise;
  } finally {
    inFlightTokenPromise = null;
  }
}

export async function getAccessToken(): Promise<string> {
  if (token && Date.now() < expiresAt - 60_000) {
    return token;
  }
  return requestToken('');
}

export async function switchGoogleAccount(): Promise<string> {
  clearAccessToken();
  return requestToken('select_account');
}

export function getCachedDriveAccount(): DriveAccount | null {
  return cachedAccount;
}

export async function getDriveAccount(): Promise<DriveAccount | null> {
  if (cachedAccount && token && Date.now() < expiresAt - 60_000) {
    return cachedAccount;
  }
  if (inFlightAccountPromise) {
    return inFlightAccountPromise;
  }

  inFlightAccountPromise = (async () => {
    try {
      const res = await driveFetch(
        'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)'
      );
      const data = await res.json();
      const email = typeof data?.user?.emailAddress === 'string' ? data.user.emailAddress.trim() : '';
      if (!email) return null;
      const displayName =
        typeof data?.user?.displayName === 'string' && data.user.displayName.trim()
          ? data.user.displayName.trim()
          : undefined;
      cachedAccount = { email, displayName };
      return cachedAccount;
    } catch {
      return null;
    } finally {
      inFlightAccountPromise = null;
    }
  })();

  return inFlightAccountPromise;
}

export const DEFAULT_DRIVE_DOWNLOAD_TIMEOUT_MS = 120_000;

export function getDriveDownloadTimeoutMs(): number {
  if (typeof window !== 'undefined') {
    const override = Number((window as any).__ALLABOARD_DRIVE_TIMEOUT_MS__);
    if (Number.isFinite(override) && override > 0) return override;
  }
  return DEFAULT_DRIVE_DOWNLOAD_TIMEOUT_MS;
}

export interface DriveFetchInit extends RequestInit {
  timeoutMs?: number;
}

function createScopedAbort(
  callerSignal?: AbortSignal | null,
  timeoutMs?: number
): { signal: AbortSignal; isTimedOut: () => boolean; cleanup: () => void } {
  const controller = new AbortController();
  let timedOut = false;

  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }

  const timer =
    timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;

  return {
    signal: controller.signal,
    isTimedOut: () => timedOut,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

export async function driveFetch(url: string, init?: DriveFetchInit): Promise<Response> {
  const { timeoutMs, signal: callerSignal, ...restInit } = init || {};
  const scoped = createScopedAbort(callerSignal, timeoutMs);
  const sendWithToken = (accessToken: string) => {
    const headers = new Headers(restInit.headers);
    headers.set('Authorization', `Bearer ${accessToken}`);
    return fetch(url, { ...restInit, headers, signal: scoped.signal });
  };

  try {
    let accessToken = await getAccessToken();
    let res = await sendWithToken(accessToken);

    if (res.status === 401) {
      clearAccessToken();
      accessToken = await getAccessToken();
      res = await sendWithToken(accessToken);
    }

    if (!res.ok) {
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      const rawReason = body?.error?.errors?.[0]?.reason;
      const code =
        res.status === 404 || rawReason === 'notFound'
          ? 'not_found'
          : typeof rawReason === 'string' && rawReason
            ? rawReason
            : `http_${res.status}`;
      throw new GoogleError(code, friendlyGoogleError(code));
    }

    return res;
  } catch (err) {
    if (scoped.isTimedOut()) {
      throw new GoogleError('timeout', friendlyGoogleError('timeout'));
    }
    throw err;
  } finally {
    scoped.cleanup();
  }
}

/** A Drive folder. `id: null` means the top of My Drive. */
export interface DriveFolder {
  id: string | null;
  name: string;
}

export const MY_DRIVE: DriveFolder = { id: null, name: 'My Drive' };

/** What we remember about a room's last Drive save, so the next save can replace it. */
export interface DriveSaveRecord {
  fileId: string;
  fileName: string;
  folder: DriveFolder;
}

/** Trim the name and make sure it ends in .json. Empty names fall back to `fallback`. */
export function normalizeJsonFileName(name: string, fallback: string): string {
  const trimmed = name.trim().replace(/[\\/]+/g, '-');
  const base = trimmed || fallback;
  return /\.json$/i.test(base) ? base : `${base}.json`;
}

/**
 * True when saving `fileName` into `folder` should replace the room's last save
 * (same name, same folder) instead of creating a new file.
 */
export function replacesLastSave(
  last: DriveSaveRecord | null,
  fileName: string,
  folder: DriveFolder
): boolean {
  return Boolean(last && last.fileName === fileName && (last.folder.id ?? null) === (folder.id ?? null));
}

function isDriveFolder(v: any): v is DriveFolder {
  return Boolean(v) && typeof v.name === 'string' && (v.id === null || typeof v.id === 'string');
}

function readJson(key: string): any {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the next save just starts from defaults */
  }
}

function accountStorageKey(baseKey: string, accountEmail?: string | null): string {
  const email = (accountEmail === undefined ? cachedAccount?.email : accountEmail)?.trim().toLowerCase();
  return email ? `${baseKey}:${email}` : baseKey;
}

export function getLastDriveFolder(accountEmail?: string | null): DriveFolder {
  const v = readJson(accountStorageKey(DRIVE_LAST_FOLDER_KEY, accountEmail));
  return isDriveFolder(v) ? v : MY_DRIVE;
}

export function getRoomDriveSave(roomId: string, accountEmail?: string | null): DriveSaveRecord | null {
  const v = readJson(accountStorageKey(DRIVE_SAVE_KEY_PREFIX + roomId, accountEmail));
  if (v && typeof v.fileId === 'string' && typeof v.fileName === 'string' && isDriveFolder(v.folder)) {
    return v;
  }
  try {
    localStorage.removeItem(LEGACY_DRIVE_FILE_KEY_PREFIX + roomId);
  } catch {
    /* ignore */
  }
  return null;
}

function rememberSave(roomId: string, record: DriveSaveRecord, accountEmail?: string | null): void {
  writeJson(accountStorageKey(DRIVE_SAVE_KEY_PREFIX + roomId, accountEmail), record);
  writeJson(accountStorageKey(DRIVE_LAST_FOLDER_KEY, accountEmail), record.folder);
}

function pickerOrigin(): string {
  const ancestors = window.location.ancestorOrigins;
  if (ancestors && ancestors.length > 0) {
    return ancestors[ancestors.length - 1];
  }
  return window.location.origin;
}

export interface PickedDriveDoc {
  id: string;
  name: string;
  mimeType: string;
}

/** Calls an optional Picker view method if this version of the Picker has it. */
function tryCall(target: any, method: string, ...args: unknown[]): any {
  if (target && typeof target[method] === 'function') target[method](...args);
  return target;
}

async function loadPicker(): Promise<any> {
  await loadScript('https://apis.google.com/js/api.js', () => Boolean((window as any).gapi));
  await new Promise<void>((resolve) => (window as any).gapi.load('picker', resolve));
  const pickerNs = (window as any).google?.picker;
  if (!pickerNs) {
    throw new GoogleError('script_load_failed', friendlyGoogleError('script_load_failed'));
  }
  return pickerNs;
}

function makeView(pickerNs: any, viewId: string, label: string, setup: (view: any) => void): any {
  const view = new pickerNs.DocsView(pickerNs.ViewId[viewId] ?? viewId);
  tryCall(view, 'setLabel', label);
  setup(view);
  return view;
}

/** Opens Google's Picker with the given tabs. Resolves with the picked item, or null on cancel. */
async function openPicker(
  accessToken: string,
  pickerNs: any,
  views: any[],
  title: string
): Promise<PickedDriveDoc | null> {
  const { apiKey, appId } = getGoogleConfig();
  return await new Promise<PickedDriveDoc | null>((resolve, reject) => {
    try {
      let builder = new pickerNs.PickerBuilder()
        .setOAuthToken(accessToken)
        .setDeveloperKey(apiKey)
        .setAppId(appId)
        .setOrigin(pickerOrigin());
      tryCall(builder, 'setTitle', title);
      for (const view of views) builder = builder.addView(view);
      const picker = builder
        .setCallback((data: any) => {
          const action = data?.action;
          if (action === pickerNs.Action.PICKED) {
            const doc = data?.docs?.[0];
            resolve(doc ? { id: doc.id, name: doc.name, mimeType: doc.mimeType } : null);
          } else if (action === pickerNs.Action.CANCEL) {
            resolve(null);
          }
        })
        .build();
      picker.setVisible(true);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Worksheet picker: Slides | PDFs | Browse Drive tabs.
 * Snapshot picker: My room saves (only my .json files) | Browse Drive (starting in the last save folder).
 * Lesson picker: My lessons (only files saved as lessons, LESSON_MIME) | Browse Drive. Browse also lists
 * application/json (lessons saved before LESSON_MIME existed) and application/octet-stream (a `.allaboard` file someone
 * uploaded to Drive by hand). Still `drive.file`: the Picker grants per-file access.
 */
export async function pickDriveFile(kind: 'worksheet' | 'snapshot' | 'lesson'): Promise<PickedDriveDoc | null> {
  const accessToken = await getAccessToken();
  const pickerNs = await loadPicker();
  const listMode = pickerNs.DocsViewMode?.LIST;

  let views: any[];
  let title: string;
  if (kind === 'worksheet') {
    title = 'Choose Google Slides or a PDF';
    views = [
      makeView(pickerNs, 'PRESENTATIONS', 'Slides', (v) => tryCall(v, 'setIncludeFolders', false)),
      makeView(pickerNs, 'PDFS', 'PDFs', (v) => tryCall(v, 'setIncludeFolders', false)),
      makeView(pickerNs, 'DOCS', 'Browse Drive', (v) => {
        v.setIncludeFolders(true)
          .setSelectFolderEnabled(false)
          .setMimeTypes(`${SLIDES_MIME},${PDF_MIME},${PPTX_MIME},${PPT_MIME}`);
      }),
    ];
  } else if (kind === 'lesson') {
    title = 'Open a lesson';
    if (!cachedAccount) await getDriveAccount();
    const lastFolder = getLastDriveFolder();
    views = [
      makeView(pickerNs, 'DOCS', 'My lessons', (v) => {
        v.setIncludeFolders(false).setSelectFolderEnabled(false).setMimeTypes(LESSON_MIME);
        tryCall(v, 'setOwnedByMe', true);
        if (listMode) tryCall(v, 'setMode', listMode);
      }),
      makeView(pickerNs, 'DOCS', 'Browse Drive', (v) => {
        v.setIncludeFolders(true)
          .setSelectFolderEnabled(false)
          .setMimeTypes(`${LESSON_MIME},${JSON_MIME},${OCTET_STREAM_MIME}`);
        if (lastFolder.id) tryCall(v, 'setParent', lastFolder.id);
        if (listMode) tryCall(v, 'setMode', listMode);
      }),
    ];
  } else {
    title = 'Open a saved room';
    if (!cachedAccount) await getDriveAccount();
    const lastFolder = getLastDriveFolder();
    views = [
      makeView(pickerNs, 'DOCS', 'My room saves', (v) => {
        v.setIncludeFolders(false).setSelectFolderEnabled(false).setMimeTypes(JSON_MIME);
        tryCall(v, 'setOwnedByMe', true);
        if (listMode) tryCall(v, 'setMode', listMode);
      }),
      makeView(pickerNs, 'DOCS', 'Browse Drive', (v) => {
        v.setIncludeFolders(true).setSelectFolderEnabled(false).setMimeTypes(JSON_MIME);
        if (lastFolder.id) tryCall(v, 'setParent', lastFolder.id);
        if (listMode) tryCall(v, 'setMode', listMode);
      }),
    ];
  }
  return openPicker(accessToken, pickerNs, views, title);
}

/** Folder picker for "Save Room to Drive", opening inside `startIn` when it's a real folder. */
export async function pickDriveFolder(startIn: DriveFolder): Promise<DriveFolder | null> {
  const accessToken = await getAccessToken();
  const pickerNs = await loadPicker();
  const view = makeView(pickerNs, 'FOLDERS', 'Folders', (v) => {
    v.setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes(FOLDER_MIME);
    if (startIn.id) tryCall(v, 'setParent', startIn.id);
  });
  const picked = await openPicker(accessToken, pickerNs, [view], 'Choose a folder to save in');
  return picked ? { id: picked.id, name: picked.name } : null;
}

export interface DownloadDriveProgress {
  loadedBytes: number;
  elapsedMs: number;
  stage?: 'converting-pptx' | 'exporting';
}

export interface DownloadDriveOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (progress: DownloadDriveProgress) => void;
}

export function formatElapsedTimer(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function formatDownloadProgress(
  doc: Pick<PickedDriveDoc, 'mimeType'>,
  progress: DownloadDriveProgress
): string {
  if (progress.stage === 'converting-pptx') {
    return 'Converting PowerPoint...';
  }
  if (progress.loadedBytes <= 0) {
    const timer = formatElapsedTimer(progress.elapsedMs);
    return doc.mimeType === SLIDES_MIME || progress.stage === 'exporting'
      ? `Google is converting the deck... ${timer}`
      : `Downloading from Drive... ${timer}`;
  }
  const mb = progress.loadedBytes / (1024 * 1024);
  if (mb >= 0.1) {
    return `Downloading from Drive... ${mb.toFixed(1)} MB`;
  }
  const kb = Math.max(1, Math.round(progress.loadedBytes / 1024));
  return `Downloading from Drive... ${kb} KB`;
}

export function buildMultipartRelatedBody(
  boundary: string,
  metadata: Record<string, unknown>,
  mediaType: string,
  mediaBytes: Uint8Array
): Blob {
  const preamble =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mediaType}\r\n\r\n`;
  const closing = `\r\n--${boundary}--`;
  return new Blob([preamble, mediaBytes as BlobPart, closing], {
    type: `multipart/related; boundary=${boundary}`,
  });
}

/** Creates a new folder in Google Drive inside `parent` (or in My Drive root when `parent.id` is null). */
export async function createDriveFolder(name: string, parent: DriveFolder): Promise<DriveFolder> {
  await getAccessToken();
  const folderName = name.trim() || 'AllAboard rooms';
  const metadata: Record<string, unknown> = {
    name: folderName,
    mimeType: FOLDER_MIME,
    ...(parent.id ? { parents: [parent.id] } : {}),
  };
  const res = await driveFetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(metadata),
  });
  const created = await res.json();
  if (!created?.id) {
    throw new GoogleError('invalid_response', 'Google Drive did not return a folder ID.');
  }
  return {
    id: String(created.id),
    name: String(created.name || folderName),
  };
}

async function readResponseBlob(
  res: Response,
  outputType: string,
  onBytes: (loadedBytes: number) => void
): Promise<Blob> {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loadedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        chunks.push(value);
        loadedBytes += value.byteLength;
        onBytes(loadedBytes);
      }
    }
    return new Blob(chunks as BlobPart[], { type: outputType });
  }
  return res.blob();
}

const PRESERVED_POWERPOINT_CODES = new Set([
  'abort',
  'timeout',
  'exportSizeLimitExceeded',
  'access_denied',
  'admin_policy_enforced',
  'popup_failed_to_open',
  'popup_closed',
  'script_load_failed',
  'not_found',
]);

async function convertPowerPointAndExportPdf(
  doc: PickedDriveDoc,
  scopedSignal: AbortSignal,
  setStage: (stage: 'converting-pptx' | 'exporting', loadedBytes: number) => void
): Promise<Blob> {
  setStage('converting-pptx', 0);

  // 1. Download original .pptx/.ppt bytes (check against ~100 MB ceiling).
  const sourceRes = await driveFetch(downloadUrlFor(doc), { signal: scopedSignal });
  const contentLen = Number(sourceRes.headers?.get?.('content-length') || 0);
  if (contentLen > MAX_PPTX_BYTES) {
    throw new GoogleError('pptx_conversion_failed', friendlyGoogleError('pptx_conversion_failed'));
  }
  const sourceBuffer = await sourceRes.arrayBuffer();
  if (sourceBuffer.byteLength > MAX_PPTX_BYTES) {
    throw new GoogleError('pptx_conversion_failed', friendlyGoogleError('pptx_conversion_failed'));
  }
  const sourceBytes = new Uint8Array(sourceBuffer);

  // 2. Upload as a temporary Google Slides presentation so Drive converts it.
  const boundary = `allaboard-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const body = buildMultipartRelatedBody(
    boundary,
    { name: `${doc.name} (AllAboard temp)`, mimeType: SLIDES_MIME },
    doc.mimeType,
    sourceBytes
  );
  const createRes = await driveFetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
      signal: scopedSignal,
    }
  );
  const created = await createRes.json();
  const tempId = typeof created?.id === 'string' ? created.id : '';
  if (!tempId) {
    throw new GoogleError('pptx_conversion_failed', friendlyGoogleError('pptx_conversion_failed'));
  }

  // 3. Export the converted Slides copy as PDF, then always delete the temp copy.
  try {
    setStage('exporting', 0);
    const exportRes = await driveFetch(downloadUrlFor({ id: tempId, mimeType: SLIDES_MIME }), {
      signal: scopedSignal,
    });
    return await readResponseBlob(exportRes, PDF_MIME, (bytes) => setStage('exporting', bytes));
  } finally {
    try {
      await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(tempId)}`, {
        method: 'DELETE',
      });
    } catch {
      /* best-effort cleanup of temp file */
    }
  }
}

export async function downloadDriveFile(
  doc: PickedDriveDoc,
  opts?: DownloadDriveOptions
): Promise<File> {
  const timeoutMs = opts?.timeoutMs ?? getDriveDownloadTimeoutMs();
  const scoped = createScopedAbort(opts?.signal, timeoutMs);
  const startedAt = Date.now();
  let loadedBytes = 0;
  const isPpt = isPowerPointMime(doc.mimeType);
  let stage: 'converting-pptx' | 'exporting' | undefined = isPpt ? 'converting-pptx' : undefined;

  const reportProgress = () => {
    opts?.onProgress?.({ loadedBytes, elapsedMs: Date.now() - startedAt, stage });
  };

  const progressTimer = opts?.onProgress
    ? setInterval(() => {
        if (loadedBytes === 0 && stage !== 'converting-pptx') reportProgress();
      }, 1000)
    : undefined;

  try {
    reportProgress();
    let blob: Blob;
    let outputType: string;
    if (isPpt) {
      outputType = PDF_MIME;
      blob = await convertPowerPointAndExportPdf(doc, scoped.signal, (nextStage, bytes) => {
        stage = nextStage;
        loadedBytes = bytes;
        reportProgress();
      });
    } else {
      outputType = doc.mimeType === SLIDES_MIME ? PDF_MIME : doc.mimeType;
      const res = await driveFetch(downloadUrlFor(doc), { signal: scoped.signal });
      blob = await readResponseBlob(res, outputType, (bytes) => {
        loadedBytes = bytes;
        reportProgress();
      });
    }

    return new File([blob], importedFileName(doc), { type: outputType });
  } catch (err: any) {
    if (scoped.isTimedOut()) {
      throw new GoogleError('timeout', friendlyGoogleError('timeout'));
    }
    if (err?.name === 'AbortError' || opts?.signal?.aborted) {
      throw err;
    }
    if (isPpt) {
      if (err instanceof GoogleError && PRESERVED_POWERPOINT_CODES.has(err.code)) {
        throw err;
      }
      throw new GoogleError('pptx_conversion_failed', friendlyGoogleError('pptx_conversion_failed'));
    }
    throw err;
  } finally {
    if (progressTimer !== undefined) clearInterval(progressTimer);
    scoped.cleanup();
  }
}

/**
 * Saves a room snapshot (or, with LESSON_MIME, a lesson) to Drive as `fileName` inside `folder`.
 * If that's the same name and folder as this room's last save, the file is updated in place;
 * otherwise a new file is created. Remembers the result for next time.
 * The type is set on updates too, so re-saving an older lesson makes it show under "My lessons".
 */
export async function saveJsonToDrive(
  roomId: string,
  fileName: string,
  folder: DriveFolder,
  json: string,
  mimeType: string = JSON_MIME
): Promise<DriveSaveRecord> {
  if (!cachedAccount) await getDriveAccount();
  const last = getRoomDriveSave(roomId);
  const replaceId = replacesLastSave(last, fileName, folder) ? last!.fileId : null;

  const startResumable = async (fileId: string | null): Promise<string> => {
    const url = fileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=resumable`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';
    const method = fileId ? 'PATCH' : 'POST';
    const metadata: Record<string, unknown> = fileId
      ? { name: fileName, ...(mimeType !== JSON_MIME ? { mimeType } : {}) }
      : { name: fileName, mimeType, ...(folder.id ? { parents: [folder.id] } : {}) };
    const res = await driveFetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
      },
      body: JSON.stringify(metadata),
    });
    const location = res.headers.get('Location') || res.headers.get('location');
    if (!location) {
      throw new GoogleError('missing_upload_location', 'Google Drive did not return an upload URL.');
    }
    return location;
  };

  let uploadUrl: string;
  let targetId = replaceId;
  try {
    uploadUrl = await startResumable(targetId);
  } catch (err) {
    if (targetId && err instanceof GoogleError && err.code === 'not_found') {
      targetId = null; // the old file was deleted or trashed: make a new one
      uploadUrl = await startResumable(null);
    } else {
      throw err;
    }
  }

  const putRes = await driveFetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: json,
  });
  const saved = await putRes.json();
  const record: DriveSaveRecord = {
    fileId: String(saved?.id || targetId || ''),
    fileName: String(saved?.name || fileName),
    folder,
  };
  if (record.fileId) rememberSave(roomId, record);
  return record;
}
