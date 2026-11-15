import { expect, test, type Page } from '@playwright/test';
import { joinRoom, uniqueRoom } from './helpers';

const EXPORT_MOD = '/src/lib/batchPdfExport.ts';

interface FakeGoogleOptions {
  omitGsi?: boolean;
  pickerAction?: 'picked' | 'cancel';
  pickerDoc?: { id: string; name: string; mimeType: string };
}

async function makePdfBuffer(page: Page, pageCount: number): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ({ exporter, count }) => {
      const { buildMultiPagePdfFromJpegs } = await import(/* @vite-ignore */ exporter);
      const pages = Array.from({ length: count }, (_, i) => {
        const c = document.createElement('canvas');
        c.width = 400;
        c.height = 283;
        const ctx = c.getContext('2d')!;
        ctx.fillStyle = `hsl(${i * 30}, 80%, 50%)`;
        ctx.fillRect(0, 0, c.width, c.height);
        const jpgB64 = c.toDataURL('image/jpeg', 0.9).split(',')[1];
        const bytes = Uint8Array.from(atob(jpgB64), (ch) => ch.charCodeAt(0));
        return { jpegBytes: bytes, widthPx: c.width, heightPx: c.height };
      });
      const blob = buildMultiPagePdfFromJpegs(pages);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    },
    { exporter: EXPORT_MOD, count: pageCount }
  );
  return Buffer.from(b64, 'base64');
}

async function installFakeGoogle(page: Page, opts: FakeGoogleOptions = {}) {
  await page.addInitScript((options: FakeGoogleOptions) => {
    (window as any).__ALLABOARD_GOOGLE_CONFIG__ = {
      clientId: 'test-client-id',
      apiKey: 'test-api-key',
      appId: '123456789',
    };
    (window as any).__FAKE_PICKER_ACTION__ = options.pickerAction ?? 'picked';
    (window as any).__FAKE_PICKER_DOC__ = options.pickerDoc ?? {
      id: 'doc-1',
      name: 'worksheet.pdf',
      mimeType: 'application/pdf',
    };

    if (options.omitGsi) return;

    (window as any).gapi = {
      load: (_name: string, cb: () => void) => cb(),
    };

    class FakeDocsView {
      setIncludeFolders() { return this; }
      setSelectFolderEnabled() { return this; }
      setMimeTypes() { return this; }
    }

    class FakePickerBuilder {
      private cb: ((data: any) => void) | null = null;
      setOAuthToken() { return this; }
      setDeveloperKey() { return this; }
      setAppId() { return this; }
      addView() { return this; }
      setOrigin() { return this; }
      setCallback(cb: (data: any) => void) {
        this.cb = cb;
        return this;
      }
      build() {
        const cb = this.cb;
        return {
          setVisible: (visible: boolean) => {
            if (!visible || !cb) return;
            const action = (window as any).__FAKE_PICKER_ACTION__;
            if (action === 'cancel') {
              cb({ action: 'cancel' });
            } else {
              cb({
                action: 'picked',
                docs: [(window as any).__FAKE_PICKER_DOC__],
              });
            }
          },
        };
      }
    }

    (window as any).google = {
      accounts: {
        oauth2: {
          initTokenClient: (cfg: { callback: (resp: any) => void }) => ({
            requestAccessToken: () => {
              cfg.callback({ access_token: 'fake-token', expires_in: 3600 });
            },
          }),
        },
      },
      picker: {
        ViewId: { DOCS: 'DOCS' },
        Action: { PICKED: 'picked', CANCEL: 'cancel' },
        DocsView: FakeDocsView,
        PickerBuilder: FakePickerBuilder,
      },
    };
  }, opts);
}

test.describe('Google Drive integration (stubbed Google)', () => {
  test.beforeEach(async ({ page }) => {
    // Safety net: ensure stubbed Drive tests never contact real Google endpoints.
    await page.route('https://accounts.google.com/**', (route) => route.abort());
    await page.route('https://apis.google.com/**', (route) => route.abort());
    await page.route('https://www.googleapis.com/**', (route) => route.abort());
  });

  test('hides Drive buttons when googleConfig is empty', async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__ALLABOARD_GOOGLE_CONFIG__ = { clientId: '', apiKey: '', appId: '' };
    });
    await joinRoom(page, uniqueRoom('gd-empty'), 'Ms T', '4829');
    await expect(page.getByRole('button', { name: 'From Drive', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save to Drive', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open from Drive', exact: true })).toHaveCount(0);
  });

  test('From Drive imports a PDF worksheet onto the board', async ({ page }) => {
    await page.goto('/');
    const pdfBuf = await makePdfBuffer(page, 2);

    await installFakeGoogle(page, {
      pickerDoc: { id: 'pdf-1', name: 'algebra.pdf', mimeType: 'application/pdf' },
    });

    const requestedUrls: string[] = [];
    await page.route('https://www.googleapis.com/**', async (route) => {
      const req = route.request();
      requestedUrls.push(req.url());
      if (req.url().includes('/drive/v3/files/pdf-1?alt=media')) {
        expect(req.headers()['authorization']).toBe('Bearer fake-token');
        await route.fulfill({
          status: 200,
          contentType: 'application/pdf',
          body: pdfBuf,
        });
        return;
      }
      await route.abort();
    });

    await joinRoom(page, uniqueRoom('gd-pdf'), 'Ms T', '4829');
    await page.getByRole('button', { name: 'From Drive', exact: true }).click();

    await expect(page.getByTitle('Remove background worksheet from this board')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Side-by-Side' })).toBeVisible();
    expect(requestedUrls).toContain('https://www.googleapis.com/drive/v3/files/pdf-1?alt=media');
  });

  test('From Drive exports a Google Slides deck via /export?mimeType=application%2Fpdf', async ({ page }) => {
    await page.goto('/');
    const pdfBuf = await makePdfBuffer(page, 2);

    await installFakeGoogle(page, {
      pickerDoc: {
        id: 'slides-1',
        name: 'Geometry Deck',
        mimeType: 'application/vnd.google-apps.presentation',
      },
    });

    const requestedUrls: string[] = [];
    await page.route('https://www.googleapis.com/**', async (route) => {
      const req = route.request();
      requestedUrls.push(req.url());
      if (req.url().includes('/drive/v3/files/slides-1/export?mimeType=application%2Fpdf')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/pdf',
          body: pdfBuf,
        });
        return;
      }
      await route.abort();
    });

    await joinRoom(page, uniqueRoom('gd-slides'), 'Ms T', '4829');
    await page.getByRole('button', { name: 'From Drive', exact: true }).click();

    await expect(page.getByTitle('Remove background worksheet from this board')).toBeVisible();
    expect(requestedUrls).toContain(
      'https://www.googleapis.com/drive/v3/files/slides-1/export?mimeType=application%2Fpdf'
    );
  });

  test('From Drive opens the page-range modal for a >10 page PDF', async ({ page }) => {
    await page.goto('/');
    const pdfBuf = await makePdfBuffer(page, 12);

    await installFakeGoogle(page, {
      pickerDoc: { id: 'pdf-12', name: 'long-deck.pdf', mimeType: 'application/pdf' },
    });

    await page.route('https://www.googleapis.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        body: pdfBuf,
      });
    });

    await joinRoom(page, uniqueRoom('gd-12'), 'Ms T', '4829');
    await page.getByRole('button', { name: 'From Drive', exact: true }).click();

    await expect(page.getByText('Choose Pages to Import')).toBeVisible();
    await page.getByLabel('From').fill('3');
    await page.getByLabel('To').fill('12');
    await page.getByRole('button', { name: 'Import pages' }).click();

    await expect(page.getByTitle('Remove background worksheet from this board')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Side-by-Side' })).toBeVisible();
  });

  test('cancelling the Drive picker does nothing and shows no error', async ({ page }) => {
    await installFakeGoogle(page, { pickerAction: 'cancel' });

    await joinRoom(page, uniqueRoom('gd-cancel'), 'Ms T', '4829');
    await page.getByRole('button', { name: 'From Drive', exact: true }).click();

    await expect(page.getByRole('button', { name: 'From Drive', exact: true })).toBeEnabled();
    await expect(page.getByTitle('Remove background worksheet from this board')).toBeHidden();
    await expect(page.getByText(/Could not import from Drive|Google Drive request failed/)).toHaveCount(0);
  });

  test('shows inline error when Google script is blocked and local Upload still works', async ({ page }) => {
    await installFakeGoogle(page, { omitGsi: true });
    await page.route('https://accounts.google.com/**', (route) => route.abort());

    await joinRoom(page, uniqueRoom('gd-blocked'), 'Ms T', '4829');
    await page.getByRole('button', { name: 'From Drive', exact: true }).click();

    await expect(
      page.getByText("Couldn't reach Google. Your network may block it. Local upload still works.")
    ).toBeVisible();

    const png = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 400;
      c.height = 300;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 400, 300);
      return c.toDataURL('image/png').split(',')[1];
    });
    await page
      .locator('input[type="file"][accept*="application/pdf"]')
      .setInputFiles({ name: 'local.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });

    await expect(page.getByTitle('Remove background worksheet from this board')).toBeVisible();
  });

  test('Open from Drive opens the Restore Room Snapshot modal and restores on confirm', async ({ page }) => {
    await installFakeGoogle(page, {
      pickerDoc: { id: 'snap-1', name: 'saved-room.json', mimeType: 'application/json' },
    });

    const snapshotPayload = {
      version: 2,
      roomId: 'prev-room',
      exportedAt: 1700000000000,
      exportedBy: 'Ms T',
      elements: [
        {
          id: 'el-from-drive',
          userId: 'u1',
          userName: 'Ms T',
          tool: 'solid',
          color: '#000000',
          strokeWidth: 4,
          points: [10, 10, 100, 100],
        },
      ],
      messages: [
        {
          id: 'msg-from-drive',
          userId: 'u1',
          userName: 'Ms T',
          text: 'Welcome back from Drive!',
          timestamp: 1700000000001,
        },
      ],
      background: null,
    };

    await page.route('https://www.googleapis.com/**', async (route) => {
      if (route.request().url().includes('/drive/v3/files/snap-1?alt=media')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(snapshotPayload),
        });
        return;
      }
      await route.abort();
    });

    await joinRoom(page, uniqueRoom('gd-open'), 'Ms T', '4829');
    await page.getByRole('button', { name: 'Open from Drive' }).click();

    await expect(page.getByText('Restore Room Snapshot (.JSON)')).toBeVisible();
    await expect(page.getByText('saved-room.json')).toBeVisible();
    await expect(page.getByText('#prev-room')).toBeVisible();
    await expect(page.getByText('1 items')).toBeVisible();
    await expect(page.getByText('1 messages')).toBeVisible();

    // Nothing is applied until the teacher confirms
    await expect(page.getByText('Welcome back from Drive!')).toHaveCount(0);

    await page.getByRole('button', { name: 'Restore Room Snapshot' }).click();
    await expect(page.getByText('Welcome back from Drive!')).toBeVisible();
  });

  test('Save to Drive creates a file on first save and PATCHes it on second save', async ({ page }) => {
    await installFakeGoogle(page);

    const requests: Array<{ method: string; url: string; body: string | null }> = [];
    let sessionCount = 0;

    await page.route('https://www.googleapis.com/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const method = req.method();
      const body = req.postData();
      requests.push({ method, url, body });

      if (url === 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable' && method === 'POST') {
        sessionCount += 1;
        await route.fulfill({
          status: 200,
          headers: {
            Location: `https://www.googleapis.com/upload/drive/v3/upload-session-${sessionCount}`,
            'access-control-expose-headers': 'Location',
          },
          body: '',
        });
        return;
      }

      if (
        url === 'https://www.googleapis.com/upload/drive/v3/files/drive-file-42?uploadType=resumable' &&
        method === 'PATCH'
      ) {
        sessionCount += 1;
        await route.fulfill({
          status: 200,
          headers: {
            Location: `https://www.googleapis.com/upload/drive/v3/upload-session-${sessionCount}`,
            'access-control-expose-headers': 'Location',
          },
          body: '',
        });
        return;
      }

      if (url.startsWith('https://www.googleapis.com/upload/drive/v3/upload-session-') && method === 'PUT') {
        const parsed = JSON.parse(body || '{}');
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'drive-file-42',
            name: `allaboard-room-${parsed.roomId}-saved.json`,
          }),
        });
        return;
      }

      await route.abort();
    });

    const room = uniqueRoom('gd-save');
    await joinRoom(page, room, 'Ms T', '4829');

    await page.getByRole('button', { name: 'Save to Drive' }).click();
    await expect(page.getByText(/Saved .* to Google Drive/)).toBeVisible();

    await page.getByRole('button', { name: 'Save to Drive' }).click();
    await expect(page.getByText(/Saved .* to Google Drive/)).toBeVisible();

    expect(requests.map((r) => r.method)).toEqual(['POST', 'PUT', 'PATCH', 'PUT']);
    const uploadedSnapshot = JSON.parse(requests[3].body || '{}');
    expect(uploadedSnapshot.version).toBe(2);
    expect(uploadedSnapshot.roomId).toBe(room);

    const storedId = await page.evaluate((r) => localStorage.getItem(`drawchat_drive_file_${r}`), room);
    expect(storedId).toBe('drive-file-42');
  });

  test('Save to Drive creates a new file with POST when previously saved file returns 404 notFound', async ({ page }) => {
    await installFakeGoogle(page);

    const methods: string[] = [];
    await page.route('https://www.googleapis.com/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const method = req.method();
      methods.push(method);

      if (url.includes('/files/stale-id?uploadType=resumable') && method === 'PATCH') {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 404, errors: [{ reason: 'notFound' }] } }),
        });
        return;
      }

      if (url === 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable' && method === 'POST') {
        await route.fulfill({
          status: 200,
          headers: {
            Location: 'https://www.googleapis.com/upload/drive/v3/upload-session-new',
            'access-control-expose-headers': 'Location',
          },
          body: '',
        });
        return;
      }

      if (url === 'https://www.googleapis.com/upload/drive/v3/upload-session-new' && method === 'PUT') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'drive-file-99', name: 'recovered.json' }),
        });
        return;
      }

      await route.abort();
    });

    const room = uniqueRoom('gd-404');
    await joinRoom(page, room, 'Ms T', '4829');
    await page.evaluate((r) => localStorage.setItem(`drawchat_drive_file_${r}`, 'stale-id'), room);

    await page.getByRole('button', { name: 'Save to Drive' }).click();
    await expect(page.getByText('Saved recovered.json to Google Drive')).toBeVisible();
    expect(methods).toEqual(['PATCH', 'POST', 'PUT']);

    const storedId = await page.evaluate((r) => localStorage.getItem(`drawchat_drive_file_${r}`), room);
    expect(storedId).toBe('drive-file-99');
  });
});
