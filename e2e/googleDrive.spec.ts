import { expect, test, type Page } from '@playwright/test';
import { joinRoom, uniqueRoom } from './helpers';

const EXPORT_MOD = '/src/lib/batchPdfExport.ts';

interface FakeDoc {
  id: string;
  name: string;
  mimeType: string;
}

interface FakeGoogleOptions {
  omitGsi?: boolean;
  pickerAction?: 'picked' | 'cancel';
  pickerDoc?: FakeDoc;
}

/** What one opened Picker was given: its title and each tab's view id and method calls. */
interface PickerLogEntry {
  title: string | null;
  views: Array<{ viewId: string; calls: Record<string, unknown[]> }>;
}

const pickerLog = (page: Page) => page.evaluate(() => (window as any).__PICKER_LOG__ as PickerLogEntry[]);

/** Queue the next Picker result (used before the default pickerDoc). */
const queuePick = (page: Page, doc: FakeDoc | 'cancel') =>
  page.evaluate((d) => (window as any).__FAKE_PICKER_QUEUE__.push(d), doc);

const todayFileName = (room: string) => `allaboard-room-${room}-${new Date().toISOString().slice(0, 10)}.json`;

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

    (window as any).__PICKER_LOG__ = [];
    (window as any).__FAKE_PICKER_QUEUE__ = [];

    class FakeDocsView {
      viewId: string;
      calls: Record<string, unknown[]> = {};
      constructor(viewId: string) {
        this.viewId = viewId;
      }
      private rec(name: string, args: unknown[]) {
        this.calls[name] = args;
        return this;
      }
      setIncludeFolders(...a: unknown[]) { return this.rec('setIncludeFolders', a); }
      setSelectFolderEnabled(...a: unknown[]) { return this.rec('setSelectFolderEnabled', a); }
      setMimeTypes(...a: unknown[]) { return this.rec('setMimeTypes', a); }
      setLabel(...a: unknown[]) { return this.rec('setLabel', a); }
      setOwnedByMe(...a: unknown[]) { return this.rec('setOwnedByMe', a); }
      setParent(...a: unknown[]) { return this.rec('setParent', a); }
      setMode(...a: unknown[]) { return this.rec('setMode', a); }
    }

    class FakePickerBuilder {
      private cb: ((data: any) => void) | null = null;
      private title: string | null = null;
      private views: FakeDocsView[] = [];
      setOAuthToken() { return this; }
      setDeveloperKey() { return this; }
      setAppId() { return this; }
      setTitle(t: string) { this.title = t; return this; }
      addView(v: FakeDocsView) { this.views.push(v); return this; }
      setOrigin() { return this; }
      setCallback(cb: (data: any) => void) {
        this.cb = cb;
        return this;
      }
      build() {
        const cb = this.cb;
        (window as any).__PICKER_LOG__.push({
          title: this.title,
          views: this.views.map((v) => ({ viewId: v.viewId, calls: v.calls })),
        });
        return {
          setVisible: (visible: boolean) => {
            if (!visible || !cb) return;
            const queued = (window as any).__FAKE_PICKER_QUEUE__.shift();
            const next = queued ?? ((window as any).__FAKE_PICKER_ACTION__ === 'cancel' ? 'cancel' : null);
            if (next === 'cancel') {
              cb({ action: 'cancel' });
            } else {
              cb({
                action: 'picked',
                docs: [next ?? (window as any).__FAKE_PICKER_DOC__],
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
        ViewId: { DOCS: 'DOCS', PRESENTATIONS: 'PRESENTATIONS', PDFS: 'PDFS', FOLDERS: 'FOLDERS' },
        DocsViewMode: { LIST: 'list', GRID: 'grid' },
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
    await expect(page.getByRole('button', { name: 'Slides / PDF from Drive', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save Room to Drive', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open Room from Drive', exact: true })).toHaveCount(0);
  });

  test('Slides / PDF from Drive imports a PDF worksheet onto the board', async ({ page }) => {
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
    await page.getByRole('button', { name: 'Slides / PDF from Drive', exact: true }).click();

    await expect(page.getByTitle('Remove background worksheet from this board')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Side-by-Side' })).toBeVisible();
    expect(requestedUrls).toContain('https://www.googleapis.com/drive/v3/files/pdf-1?alt=media');

    // Three tabs: Slides and PDFs as flat lists, then folder browsing filtered to Slides + PDFs.
    const [log] = await pickerLog(page);
    expect(log.views.map((v) => [v.viewId, v.calls.setLabel?.[0]])).toEqual([
      ['PRESENTATIONS', 'Slides'],
      ['PDFS', 'PDFs'],
      ['DOCS', 'Browse Drive'],
    ]);
    expect(log.views[0].calls.setIncludeFolders).toEqual([false]);
    expect(log.views[2].calls.setIncludeFolders).toEqual([true]);
    expect(log.views[2].calls.setMimeTypes).toEqual([
      'application/vnd.google-apps.presentation,application/pdf',
    ]);
  });

  test('Slides / PDF from Drive exports a Google Slides deck via /export?mimeType=application%2Fpdf', async ({ page }) => {
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
    await page.getByRole('button', { name: 'Slides / PDF from Drive', exact: true }).click();

    await expect(page.getByTitle('Remove background worksheet from this board')).toBeVisible();
    expect(requestedUrls).toContain(
      'https://www.googleapis.com/drive/v3/files/slides-1/export?mimeType=application%2Fpdf'
    );
  });

  test('Slides / PDF from Drive opens the page-range modal for a >10 page PDF', async ({ page }) => {
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
    await page.getByRole('button', { name: 'Slides / PDF from Drive', exact: true }).click();

    await expect(page.getByText('Choose Pages to Import')).toBeVisible();
    await page.getByLabel('From').fill('3');
    await page.getByLabel('To').fill('12');
    await page.getByRole('button', { name: 'Import pages' }).click();

    await expect(page.getByTitle('Remove background worksheet from this board')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Side-by-Side' })).toBeVisible();
  });

  test('hanging Slides export shows live timer and Cancel aborts cleanly with no error', async ({ page }) => {
    await installFakeGoogle(page, {
      pickerDoc: {
        id: 'slides-hang',
        name: 'Huge 370-Slide Deck',
        mimeType: 'application/vnd.google-apps.presentation',
      },
    });

    await page.route('https://www.googleapis.com/**', async () => {
      // Intentionally never respond to simulate a stalled Slides export.
    });

    await joinRoom(page, uniqueRoom('gd-hang-cancel'), 'Ms T', '4829');
    await page.getByRole('button', { name: 'Slides / PDF from Drive', exact: true }).click();

    await expect(page.getByRole('button', { name: /Google is converting the deck\.\.\. 0:0[0-9]/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Google is converting the deck\.\.\. 0:0[1-9]/ })).toBeVisible({
      timeout: 3000,
    });

    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await expect(page.getByRole('button', { name: 'Slides / PDF from Drive', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    await expect(page.getByText(/Could not import from Drive|Google took too long|Google Drive request failed/)).toHaveCount(0);
  });

  test('hanging Slides export times out with Download-as-PDF advice', async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__ALLABOARD_DRIVE_TIMEOUT_MS__ = 350;
    });
    await installFakeGoogle(page, {
      pickerDoc: {
        id: 'slides-timeout',
        name: 'Huge Deck',
        mimeType: 'application/vnd.google-apps.presentation',
      },
    });

    await page.route('https://www.googleapis.com/**', async () => {
      // Intentionally never respond so the timeout fires.
    });

    await joinRoom(page, uniqueRoom('gd-timeout'), 'Ms T', '4829');
    await page.getByRole('button', { name: 'Slides / PDF from Drive', exact: true }).click();

    await expect(
      page.getByText(
        'Google took too long to convert this deck. For big decks, open it in Google Slides, use File → Download → PDF, then use Upload (.JPG / .PNG / .PDF). Big PDFs work fine that way.'
      )
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Slides / PDF from Drive', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  });

  test('403 exportSizeLimitExceeded shows friendly Download-as-PDF advice', async ({ page }) => {
    await installFakeGoogle(page, {
      pickerDoc: {
        id: 'slides-too-big',
        name: '370 Slides',
        mimeType: 'application/vnd.google-apps.presentation',
      },
    });

    await page.route('https://www.googleapis.com/**', async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 403,
            errors: [{ reason: 'exportSizeLimitExceeded', message: 'This file is too large to be exported.' }],
          },
        }),
      });
    });

    await joinRoom(page, uniqueRoom('gd-403-limit'), 'Ms T', '4829');
    await page.getByRole('button', { name: 'Slides / PDF from Drive', exact: true }).click();

    await expect(
      page.getByText(/This deck is too big for Google to convert \(10 MB limit\).*Download → PDF/)
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Slides / PDF from Drive', exact: true })).toBeEnabled();
  });

  test('local Upload handles a 370-page PDF and opens the page-range modal', async ({ page }) => {
    await joinRoom(page, uniqueRoom('gd-local-370'), 'Ms T', '4829');

    const b64 = await page.evaluate(async (exporter) => {
      const { buildMultiPagePdfFromJpegs } = await import(/* @vite-ignore */ exporter);
      const c = document.createElement('canvas');
      c.width = 40;
      c.height = 30;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      const jpgB64 = c.toDataURL('image/jpeg', 0.7).split(',')[1];
      const bytes = Uint8Array.from(atob(jpgB64), (ch) => ch.charCodeAt(0));
      const pages = Array.from({ length: 370 }, () => ({ jpegBytes: bytes, widthPx: c.width, heightPx: c.height }));
      const blob = buildMultiPagePdfFromJpegs(pages);
      const out = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < out.length; i++) binary += String.fromCharCode(out[i]);
      return btoa(binary);
    }, EXPORT_MOD);

    await page
      .locator('input[type="file"][accept*="application/pdf"]')
      .setInputFiles({ name: 'textbook-370.pdf', mimeType: 'application/pdf', buffer: Buffer.from(b64, 'base64') });

    await expect(page.getByText('Choose Pages to Import')).toBeVisible();
    await expect(page.getByText(/370 pages/)).toBeVisible();
    await page.getByLabel('From').fill('1');
    await page.getByLabel('To').fill('2');
    await page.getByRole('button', { name: 'Import pages' }).click();

    await expect(page.getByTitle('Remove background worksheet from this board')).toBeVisible();
  });

  test('cancelling the Drive picker does nothing and shows no error', async ({ page }) => {
    await installFakeGoogle(page, { pickerAction: 'cancel' });

    await joinRoom(page, uniqueRoom('gd-cancel'), 'Ms T', '4829');
    await page.getByRole('button', { name: 'Slides / PDF from Drive', exact: true }).click();

    await expect(page.getByRole('button', { name: 'Slides / PDF from Drive', exact: true })).toBeEnabled();
    await expect(page.getByTitle('Remove background worksheet from this board')).toBeHidden();
    await expect(page.getByText(/Could not import from Drive|Google Drive request failed/)).toHaveCount(0);
  });

  test('shows inline error when Google script is blocked and local Upload still works', async ({ page }) => {
    await installFakeGoogle(page, { omitGsi: true });
    await page.route('https://accounts.google.com/**', (route) => route.abort());

    await joinRoom(page, uniqueRoom('gd-blocked'), 'Ms T', '4829');
    await page.getByRole('button', { name: 'Slides / PDF from Drive', exact: true }).click();

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

  test('Open Room from Drive opens the Restore Room Snapshot modal and restores on confirm', async ({ page }) => {
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
    await page.getByRole('button', { name: 'Open Room from Drive' }).click();

    await expect(page.getByText('Restore Room Snapshot (.JSON)')).toBeVisible();
    await expect(page.getByText('saved-room.json')).toBeVisible();
    await expect(page.getByText('#prev-room')).toBeVisible();
    await expect(page.getByText('1 items')).toBeVisible();
    await expect(page.getByText('1 messages')).toBeVisible();

    // Nothing is applied until the teacher confirms
    await expect(page.getByText('Welcome back from Drive!')).toHaveCount(0);

    await page.getByRole('button', { name: 'Restore Room Snapshot' }).click();
    await expect(page.getByText('Welcome back from Drive!')).toBeVisible();

    // First tab lists only my .json files, flat (no folders), in list mode.
    const [log] = await pickerLog(page);
    expect(log.views.map((v) => v.calls.setLabel?.[0])).toEqual(['My room saves', 'Browse Drive']);
    expect(log.views[0].calls.setMimeTypes).toEqual(['application/json']);
    expect(log.views[0].calls.setOwnedByMe).toEqual([true]);
    expect(log.views[0].calls.setIncludeFolders).toEqual([false]);
    expect(log.views[0].calls.setMode).toEqual(['list']);
  });

  /** Fakes Drive's resumable upload. Records each request; the PUT returns the name from the metadata. */
  async function fakeDriveUploads(page: Page, opts: { notFoundId?: string } = {}) {
    const requests: Array<{ method: string; url: string; meta: any }> = [];
    let session = 0;
    let lastName = '';
    await page.route('https://www.googleapis.com/**', async (route) => {
      const req = route.request();
      const url = req.url();
      const method = req.method();
      if (url.includes('/upload/drive/v3/files') && (method === 'POST' || method === 'PATCH')) {
        const meta = JSON.parse(req.postData() || '{}');
        requests.push({ method, url, meta });
        if (opts.notFoundId && method === 'PATCH' && url.includes(`/files/${opts.notFoundId}?`)) {
          await route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 404, errors: [{ reason: 'notFound' }] } }),
          });
          return;
        }
        lastName = meta.name;
        session += 1;
        await route.fulfill({
          status: 200,
          headers: {
            Location: `https://www.googleapis.com/upload/drive/v3/upload-session-${session}`,
            'access-control-expose-headers': 'Location',
          },
          body: '',
        });
        return;
      }
      if (url.includes('/upload/drive/v3/upload-session-') && method === 'PUT') {
        requests.push({ method, url, meta: JSON.parse(req.postData() || '{}') });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'drive-file-42', name: lastName }),
        });
        return;
      }
      await route.abort();
    });
    return requests;
  }

  test('Save Room to Drive asks for a name and folder, then replaces the same file on the next save', async ({ page }) => {
    await installFakeGoogle(page);
    const requests = await fakeDriveUploads(page);
    const room = uniqueRoom('gd-save');
    await joinRoom(page, room, 'Ms T', '4829');

    // First save: dialog with the usual file name, in My Drive.
    await page.getByRole('button', { name: 'Save Room to Drive', exact: true }).click();
    await expect(page.getByText('Save Room to Google Drive')).toBeVisible();
    await expect(page.getByLabel('File name')).toHaveValue(todayFileName(room));
    await expect(page.getByTestId('drive-save-folder')).toHaveText('My Drive');
    await expect(page.getByText('Saves a new file in My Drive.')).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText(`Saved ${todayFileName(room)} to My Drive`)).toBeVisible();
    await expect(page.getByText('Save Room to Google Drive')).toBeHidden();

    expect(requests[0].method).toBe('POST');
    expect(requests[0].meta).toEqual({ name: todayFileName(room), mimeType: 'application/json' });
    expect(requests[1].method).toBe('PUT');
    expect(requests[1].meta.version).toBe(2);
    expect(requests[1].meta.roomId).toBe(room);

    // Second save, same name and folder: offers to replace, and PATCHes the same file.
    await page.getByRole('button', { name: 'Save Room to Drive', exact: true }).click();
    await expect(page.getByText('Replaces the copy of this room you saved earlier in My Drive.')).toBeVisible();
    await page.getByRole('button', { name: 'Replace', exact: true }).click();
    await expect(page.getByText(`Saved ${todayFileName(room)} to My Drive`)).toBeVisible();
    expect(requests[2].method).toBe('PATCH');
    expect(requests[2].url).toContain('/files/drive-file-42?uploadType=resumable');
  });

  test('Save Room to Drive saves a renamed file into a chosen folder, and remembers that folder', async ({ page }) => {
    await installFakeGoogle(page);
    const requests = await fakeDriveUploads(page);
    const room = uniqueRoom('gd-folder');
    await joinRoom(page, room, 'Ms T', '4829');

    await page.getByRole('button', { name: 'Save Room to Drive', exact: true }).click();
    await page.getByLabel('File name').fill('Period 3 review');
    await queuePick(page, { id: 'fold-9', name: 'Period 3', mimeType: 'application/vnd.google-apps.folder' });
    await page.getByRole('button', { name: 'Change...' }).click();
    await expect(page.getByTestId('drive-save-folder')).toHaveText('Period 3');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved Period 3 review.json to Period 3')).toBeVisible();

    expect(requests[0].method).toBe('POST');
    expect(requests[0].meta).toEqual({
      name: 'Period 3 review.json',
      mimeType: 'application/json',
      parents: ['fold-9'],
    });

    // The folder picker offered folders only, with folder selection on, starting at My Drive.
    const [folderPicker] = await pickerLog(page);
    expect(folderPicker.views[0].viewId).toBe('FOLDERS');
    expect(folderPicker.views[0].calls.setSelectFolderEnabled).toEqual([true]);
    expect(folderPicker.views[0].calls.setParent).toBeUndefined();

    // Next time, the dialog starts in Period 3, and Change... opens inside it.
    await page.getByRole('button', { name: 'Save Room to Drive', exact: true }).click();
    await expect(page.getByTestId('drive-save-folder')).toHaveText('Period 3');
    await queuePick(page, 'cancel');
    await page.getByRole('button', { name: 'Change...' }).click();
    await expect(page.getByTestId('drive-save-folder')).toHaveText('Period 3');
    const log = await pickerLog(page);
    expect(log[1].views[0].calls.setParent).toEqual(['fold-9']);

    // Open Room from Drive's Browse tab also starts in the last save folder.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await queuePick(page, 'cancel');
    await page.getByRole('button', { name: 'Open Room from Drive', exact: true }).click();
    await expect.poll(async () => (await pickerLog(page)).length).toBe(3);
    const openLog = (await pickerLog(page))[2];
    expect(openLog.views[1].calls.setParent).toEqual(['fold-9']);
  });

  test('Save Room to Drive makes a new file when the earlier one was deleted (404)', async ({ page }) => {
    await installFakeGoogle(page);
    const requests = await fakeDriveUploads(page, { notFoundId: 'stale-id' });
    const room = uniqueRoom('gd-404');
    await joinRoom(page, room, 'Ms T', '4829');
    await page.evaluate(
      ({ r, name }) =>
        localStorage.setItem(
          `drawchat_drive_save_${r}`,
          JSON.stringify({ fileId: 'stale-id', fileName: name, folder: { id: null, name: 'My Drive' } })
        ),
      { r: room, name: todayFileName(room) }
    );

    await page.getByRole('button', { name: 'Save Room to Drive', exact: true }).click();
    await page.getByRole('button', { name: 'Replace', exact: true }).click();
    await expect(page.getByText(`Saved ${todayFileName(room)} to My Drive`)).toBeVisible();
    expect(requests.map((r) => r.method)).toEqual(['PATCH', 'POST', 'PUT']);

    const stored = await page.evaluate((r) => JSON.parse(localStorage.getItem(`drawchat_drive_save_${r}`) || '{}'), room);
    expect(stored.fileId).toBe('drive-file-42');
  });
});
