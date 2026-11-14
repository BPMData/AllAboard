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
  it('defaults to empty config and false configured flags', () => {
    assert.deepEqual(getGoogleConfig(), { clientId: '', apiKey: '', appId: '' });
    assert.equal(isGoogleSignInConfigured(), false);
    assert.equal(isGoogleDriveConfigured(), false);
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
