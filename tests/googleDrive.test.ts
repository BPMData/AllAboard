import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRIVE_LAST_FOLDER_KEY,
  DRIVE_SAVE_KEY_PREFIX,
  DEFAULT_DRIVE_DOWNLOAD_TIMEOUT_MS,
  MY_DRIVE,
  normalizeJsonFileName,
  replacesLastSave,
  DRIVE_SCOPE,
  GoogleError,
  JSON_MIME,
  PDF_MIME,
  SLIDES_MIME,
  downloadUrlFor,
  formatDownloadProgress,
  formatElapsedTimer,
  friendlyGoogleError,
  getDriveDownloadTimeoutMs,
  importedFileName,
} from '../src/lib/googleDrive';
import {
  getGoogleConfig,
  isGoogleDriveConfigured,
  isGoogleSignInConfigured,
} from '../src/lib/googleConfig';

describe('googleConfig (node environment)', () => {
  it('provides non-empty public Google defaults and supports window override', () => {
    const cfg = getGoogleConfig();
    assert.ok(cfg.clientId.endsWith('.apps.googleusercontent.com'));
    assert.ok(cfg.apiKey.length > 0);
    assert.ok(/^\d+$/.test(cfg.appId));
    assert.equal(isGoogleSignInConfigured(), true);
    assert.equal(isGoogleDriveConfigured(), true);

    const prevWindow = (globalThis as any).window;
    try {
      (globalThis as any).window = {
        __ALLABOARD_GOOGLE_CONFIG__: { clientId: '', apiKey: '', appId: '' },
      };
      assert.equal(isGoogleSignInConfigured(), false);
      assert.equal(isGoogleDriveConfigured(), false);

      (globalThis as any).window = {
        __ALLABOARD_GOOGLE_CONFIG__: { clientId: 'test', apiKey: 'test', appId: '1' },
      };
      assert.deepEqual(getGoogleConfig(), { clientId: 'test', apiKey: 'test', appId: '1' });
      assert.equal(isGoogleDriveConfigured(), true);
    } finally {
      if (prevWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = prevWindow;
    }
  });
});

describe('googleDrive pure helpers', () => {
  it('exports expected constants and GoogleError', () => {
    assert.equal(DRIVE_SCOPE, 'https://www.googleapis.com/auth/drive.file');
    assert.equal(DRIVE_SAVE_KEY_PREFIX, 'drawchat_drive_save_');
    assert.equal(DRIVE_LAST_FOLDER_KEY, 'drawchat_drive_last_folder');
    const err = new GoogleError('popup_closed', 'cancelled');
    assert.ok(err instanceof Error);
    assert.equal(err.code, 'popup_closed');
    assert.equal(err.message, 'cancelled');
  });

  it('builds export URL for Slides and alt=media URL for PDF and JSON', () => {
    assert.equal(
      downloadUrlFor({ id: 'slide-1', mimeType: SLIDES_MIME }),
      'https://www.googleapis.com/drive/v3/files/slide-1/export?mimeType=application%2Fpdf'
    );
    assert.equal(
      downloadUrlFor({ id: 'pdf-1', mimeType: PDF_MIME }),
      'https://www.googleapis.com/drive/v3/files/pdf-1?alt=media'
    );
    assert.equal(
      downloadUrlFor({ id: 'json-1', mimeType: JSON_MIME }),
      'https://www.googleapis.com/drive/v3/files/json-1?alt=media'
    );
  });

  it('appends .pdf to Slides names and preserves other filenames', () => {
    assert.equal(importedFileName({ name: 'Fractions Deck', mimeType: SLIDES_MIME }), 'Fractions Deck.pdf');
    assert.equal(importedFileName({ name: 'worksheet.pdf', mimeType: PDF_MIME }), 'worksheet.pdf');
    assert.equal(importedFileName({ name: 'room.json', mimeType: JSON_MIME }), 'room.json');
  });

  it('maps known Google error codes to friendly messages and falls back safely', () => {
    assert.match(friendlyGoogleError('script_load_failed'), /Couldn't reach Google/);
    assert.match(friendlyGoogleError('popup_failed_to_open'), /blocked the Google sign-in window/);
    assert.match(friendlyGoogleError('popup_closed'), /cancelled/);
    assert.match(friendlyGoogleError('access_denied'), /didn't allow AllAboard/);
    assert.match(friendlyGoogleError('admin_policy_enforced'), /didn't allow AllAboard/);
    assert.match(friendlyGoogleError('exportSizeLimitExceeded'), /10 MB limit/);
    assert.match(friendlyGoogleError('exportSizeLimitExceeded'), /Download → PDF/);
    assert.match(friendlyGoogleError('timeout'), /too long to convert/);
    assert.match(friendlyGoogleError('timeout'), /Download → PDF/);
    assert.match(friendlyGoogleError('not_found'), /Pick it again from Drive/);
    assert.equal(friendlyGoogleError('something_unexpected'), 'Google Drive request failed. Local upload still works.');
  });

  it('formats elapsed timer and download progress labels', () => {
    assert.equal(formatElapsedTimer(0), '0:00');
    assert.equal(formatElapsedTimer(35_400), '0:35');
    assert.equal(formatElapsedTimer(65_000), '1:05');

    assert.equal(
      formatDownloadProgress({ mimeType: SLIDES_MIME }, { loadedBytes: 0, elapsedMs: 35_000 }),
      'Google is converting the deck... 0:35'
    );
    assert.equal(
      formatDownloadProgress({ mimeType: PDF_MIME }, { loadedBytes: 0, elapsedMs: 5_000 }),
      'Downloading from Drive... 0:05'
    );
    assert.equal(
      formatDownloadProgress({ mimeType: SLIDES_MIME }, { loadedBytes: Math.round(4.2 * 1024 * 1024), elapsedMs: 12_000 }),
      'Downloading from Drive... 4.2 MB'
    );
    assert.equal(
      formatDownloadProgress({ mimeType: PDF_MIME }, { loadedBytes: 42 * 1024, elapsedMs: 1_000 }),
      'Downloading from Drive... 42 KB'
    );
  });

  it('defaults download timeout to 120s and respects window.__ALLABOARD_DRIVE_TIMEOUT_MS__', () => {
    assert.equal(DEFAULT_DRIVE_DOWNLOAD_TIMEOUT_MS, 120_000);
    assert.equal(getDriveDownloadTimeoutMs(), 120_000);

    const prevWindow = (globalThis as any).window;
    try {
      (globalThis as any).window = { __ALLABOARD_DRIVE_TIMEOUT_MS__: 500 };
      assert.equal(getDriveDownloadTimeoutMs(), 500);
      (globalThis as any).window = { __ALLABOARD_DRIVE_TIMEOUT_MS__: -1 };
      assert.equal(getDriveDownloadTimeoutMs(), 120_000);
    } finally {
      if (prevWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = prevWindow;
    }
  });

  it('normalizeJsonFileName trims, strips slashes, falls back and adds .json once', () => {
    assert.equal(normalizeJsonFileName('  period 3 notes ', 'x.json'), 'period 3 notes.json');
    assert.equal(normalizeJsonFileName('room.JSON', 'x.json'), 'room.JSON');
    assert.equal(normalizeJsonFileName('a/b\\c', 'x.json'), 'a-b-c.json');
    assert.equal(normalizeJsonFileName('   ', 'allaboard-room-math-2026-11-15.json'), 'allaboard-room-math-2026-11-15.json');
  });

  it('replacesLastSave only when name and folder both match the last save', () => {
    const last = { fileId: 'f1', fileName: 'room.json', folder: { id: 'fold-1', name: 'Period 3' } };
    assert.equal(replacesLastSave(null, 'room.json', MY_DRIVE), false);
    assert.equal(replacesLastSave(last, 'room.json', { id: 'fold-1', name: 'Period 3' }), true);
    assert.equal(replacesLastSave(last, 'room-v2.json', { id: 'fold-1', name: 'Period 3' }), false);
    assert.equal(replacesLastSave(last, 'room.json', MY_DRIVE), false);
    const inRoot = { fileId: 'f2', fileName: 'room.json', folder: MY_DRIVE };
    assert.equal(replacesLastSave(inRoot, 'room.json', { id: null, name: 'My Drive' }), true);
  });
});
