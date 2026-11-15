import { getGoogleConfig } from './googleConfig';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const SLIDES_MIME = 'application/vnd.google-apps.presentation';
export const PDF_MIME = 'application/pdf';
export const JSON_MIME = 'application/json';
export const DRIVE_FILE_KEY_PREFIX = 'drawchat_drive_file_'; // + roomId -> Drive fileId of the last save

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

export async function pickDriveFile(kind: 'worksheet' | 'snapshot'): Promise<PickedDriveDoc | null> {
  const accessToken = await getAccessToken();
  await loadScript('https://apis.google.com/js/api.js', () => Boolean((window as any).gapi));
  await new Promise<void>((resolve) => (window as any).gapi.load('picker', resolve));

  const pickerNs = (window as any).google?.picker;
  if (!pickerNs) {
    throw new GoogleError('script_load_failed', friendlyGoogleError('script_load_failed'));
  }

  const { apiKey, appId } = getGoogleConfig();
  const view = new pickerNs.DocsView(pickerNs.ViewId.DOCS)
    .setIncludeFolders(true)
    .setSelectFolderEnabled(false)
    .setMimeTypes(kind === 'worksheet' ? `${SLIDES_MIME},${PDF_MIME}` : JSON_MIME);

  return await new Promise<PickedDriveDoc | null>((resolve, reject) => {
    try {
      const picker = new pickerNs.PickerBuilder()
        .setOAuthToken(accessToken)
        .setDeveloperKey(apiKey)
        .setAppId(appId)
        .addView(view)
        .setOrigin(pickerOrigin())
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

export async function downloadDriveFile(doc: PickedDriveDoc): Promise<File> {
  const res = await driveFetch(downloadUrlFor(doc));
  const blob = await res.blob();
  return new File([blob], importedFileName(doc), {
    type: doc.mimeType === SLIDES_MIME ? PDF_MIME : doc.mimeType,
  });
}

export async function saveJsonToDrive(
  roomId: string,
  fileName: string,
  json: string
): Promise<{ id: string; name: string }> {
  const storageKey = DRIVE_FILE_KEY_PREFIX + roomId;
  let existingId: string | null = null;
  try {
    existingId = localStorage.getItem(storageKey);
  } catch {
    existingId = null;
  }

  const startResumable = async (fileId: string | null): Promise<string> => {
    const url = fileId
      ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=resumable`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';
    const method = fileId ? 'PATCH' : 'POST';
    const metadata = fileId ? { name: fileName } : { name: fileName, mimeType: JSON_MIME };
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
      throw new GoogleError(
        'missing_upload_location',
        'Google Drive did not return an upload URL.'
      );
    }
    return location;
  };

  let uploadUrl: string;
  if (existingId) {
    try {
      uploadUrl = await startResumable(existingId);
    } catch (err) {
      if (err instanceof GoogleError && err.code === 'not_found') {
        try {
          localStorage.removeItem(storageKey);
        } catch {
          /* ignore */
        }
        existingId = null;
        uploadUrl = await startResumable(null);
      } else {
        throw err;
      }
    }
  } else {
    uploadUrl = await startResumable(null);
  }

  const putRes = await driveFetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': JSON_MIME },
    body: json,
  });
  const saved = await putRes.json();
  const savedId = String(saved?.id || existingId || '');
  const savedName = String(saved?.name || fileName);
  if (savedId) {
    try {
      localStorage.setItem(storageKey, savedId);
    } catch {
      /* ignore */
    }
  }
  return { id: savedId, name: savedName };
}
