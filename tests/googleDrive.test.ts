import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRIVE_FILE_KEY_PREFIX,
  DRIVE_SCOPE,
  GoogleError,
  JSON_MIME,
  PDF_MIME,
  SLIDES_MIME,
  downloadUrlFor,
  friendlyGoogleError,
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
    assert.equal(DRIVE_FILE_KEY_PREFIX, 'drawchat_drive_file_');
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
    assert.match(friendlyGoogleError('not_found'), /Pick it again from Drive/);
    assert.equal(friendlyGoogleError('something_unexpected'), 'Google Drive request failed. Local upload still works.');
  });
});
