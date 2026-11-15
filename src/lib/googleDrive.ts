import { getGoogleConfig } from './googleConfig';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const SLIDES_MIME = 'application/vnd.google-apps.presentation';
export const PDF_MIME = 'application/pdf';
export const JSON_MIME = 'application/json';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
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
  return doc.mimeType === SLIDES_MIME ? `${doc.name}.pdf` : doc.name;
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
      return 'This deck is too big for Google to convert (10 MB limit). In Slides, use File \u2192 Download \u2192 PDF, then Upload.';
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

let token: string | null = null;
let expiresAt = 0;
let tokenClient: any = null;
let tokenClientForClientId: string | null = null;
let pendingTokenRequest: { resolve: (t: string) => void; reject: (err: unknown) => void } | null = null;
let inFlightTokenPromise: Promise<string> | null = null;

export function clearAccessToken(): void {
  token = null;
  expiresAt = 0;
}

export async function getAccessToken(): Promise<string> {
  if (token && Date.now() < expiresAt - 60_000) {
    return token;
  }
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
        tokenClient.requestAccessToken({ prompt: '' });
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

export async function driveFetch(url: string, init?: RequestInit): Promise<Response> {
  const sendWithToken = (accessToken: string) => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${accessToken}`);
    return fetch(url, { ...init, headers });
  };

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

export function getLastDriveFolder(): DriveFolder {
  const v = readJson(DRIVE_LAST_FOLDER_KEY);
  return isDriveFolder(v) ? v : MY_DRIVE;
}

export function getRoomDriveSave(roomId: string): DriveSaveRecord | null {
  const v = readJson(DRIVE_SAVE_KEY_PREFIX + roomId);
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

function rememberSave(roomId: string, record: DriveSaveRecord): void {
  writeJson(DRIVE_SAVE_KEY_PREFIX + roomId, record);
  writeJson(DRIVE_LAST_FOLDER_KEY, record.folder);
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
 */
export async function pickDriveFile(kind: 'worksheet' | 'snapshot'): Promise<PickedDriveDoc | null> {
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
        v.setIncludeFolders(true).setSelectFolderEnabled(false).setMimeTypes(`${SLIDES_MIME},${PDF_MIME}`);
      }),
    ];
  } else {
    title = 'Open a saved room';
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

export async function downloadDriveFile(doc: PickedDriveDoc): Promise<File> {
  const res = await driveFetch(downloadUrlFor(doc));
  const blob = await res.blob();
  return new File([blob], importedFileName(doc), {
    type: doc.mimeType === SLIDES_MIME ? PDF_MIME : doc.mimeType,
  });
}

/**
 * Saves a room snapshot to Drive as `fileName` inside `folder`.
 * If that's the same name and folder as this room's last save, the file is updated in place;
 * otherwise a new file is created. Remembers the result for next time.
 */
export async function saveJsonToDrive(
  roomId: string,
  fileName: string,
  folder: DriveFolder,
  json: string
): Promise<DriveSaveRecord> {
  const last = getRoomDriveSave(roomId);
  const replaceId = replacesLastSave(last, fileName, folder) ? last!.fileId : null;

  const startResumable = async (fileId: string | null): Promise<string> => {
    const url = fileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=resumable`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';
    const method = fileId ? 'PATCH' : 'POST';
    const metadata: Record<string, unknown> = fileId
      ? { name: fileName }
      : { name: fileName, mimeType: JSON_MIME, ...(folder.id ? { parents: [folder.id] } : {}) };
    const res = await driveFetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': JSON_MIME,
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
    headers: { 'Content-Type': JSON_MIME },
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
