/**
 * Browser-side tests for src/lib/worksheetLoader.ts and src/lib/batchPdfExport.ts.
 *
 * Both modules depend on <canvas>, Image, FileReader and pdf.js, so they run inside real
 * Chromium: each test imports the module straight from the Vite dev server with a dynamic
 * import() and calls it inside page.evaluate().
 */
import { expect, test } from '@playwright/test';
import { joinRoom, uniqueRoom } from './helpers';

const LOADER = '/src/lib/worksheetLoader.ts';
const EXPORT = '/src/lib/batchPdfExport.ts';

test.beforeEach(async ({ page }) => {
  // Any page served by Vite works as a host for module imports; the lobby is the cheapest.
  await page.goto('/');
});

test.describe('worksheetLoader (in browser)', () => {
  test('generates every built-in template as a 1400 × 920 JPEG background', async ({ page }) => {
    const results = await page.evaluate(async (loader) => {
      const mod = await import(/* @vite-ignore */ loader);
      return mod.BUILT_IN_TEMPLATES.map((t: { id: string }) => {
        const bg = mod.generateTemplateBackground(t.id, 'Photosynthesis');
        return {
          id: bg.id,
          pages: bg.pages.length,
          width: bg.pages[0].width,
          height: bg.pages[0].height,
          isJpeg: bg.pages[0].dataUrl.startsWith('data:image/jpeg;base64,'),
          dataLen: bg.pages[0].dataUrl.length,
          x: bg.x,
          y: bg.y,
          layout: bg.layout,
        };
      });
    }, LOADER);

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.id).toMatch(/^tpl_(checkin-columns|four-corners|frayer-model)_[a-z0-9]+$/);
      expect(r).toMatchObject({ pages: 1, width: 1400, height: 920, isJpeg: true, x: -700, y: -460, layout: 'stack' });
      expect(r.dataLen).toBeGreaterThan(5_000); // a real drawing, not an empty canvas
    }
  });

  test('templates render visibly different layouts and use the custom prompt', async ({ page }) => {
    const out = await page.evaluate(async (loader) => {
      const mod = await import(/* @vite-ignore */ loader);
      const a = mod.generateTemplateBackground('checkin-columns', 'Lab 3');
      const b = mod.generateTemplateBackground('four-corners', 'Lab 3');
      const c1 = mod.generateTemplateBackground('frayer-model', 'Quadratics');
      const c2 = mod.generateTemplateBackground('frayer-model', 'Mitosis');
      const fallback = mod.generateTemplateBackground('not-a-template', '');
      return {
        layoutsDiffer: a.pages[0].dataUrl !== b.pages[0].dataUrl,
        promptChangesImage: c1.pages[0].dataUrl !== c2.pages[0].dataUrl,
        fallbackName: fallback.fileName,
      };
    }, LOADER);

    expect(out.layoutsDiffer).toBe(true);
    expect(out.promptChangesImage).toBe(true);
    expect(out.fallbackName).toBe('Task Pulse Check (Got It / Working / Help)');
  });

  test('downscales large images to fit within 1800px, keeping aspect ratio', async ({ page }) => {
    const sizes = await page.evaluate(async (loader) => {
      const mod = await import(/* @vite-ignore */ loader);
      const makePng = async (w: number, h: number, name: string) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d')!;
        ctx.fillStyle = '#3366ff';
        ctx.fillRect(0, 0, w, h);
        const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
        return new File([blob], name, { type: 'image/png' });
      };
      const big = await mod.processWorksheetFile(await makePng(3600, 900, 'wide.png'));
      const tall = await mod.processWorksheetFile(await makePng(1000, 4000, 'tall.png'));
      const small = await mod.processWorksheetFile(await makePng(640, 480, 'small.png'));
      return [big, tall, small].map((pages) => ({
        count: pages.length,
        w: pages[0].width,
        h: pages[0].height,
        jpeg: pages[0].dataUrl.startsWith('data:image/jpeg'),
      }));
    }, LOADER);

    expect(sizes[0]).toEqual({ count: 1, w: 1800, h: 450, jpeg: true });
    expect(sizes[1]).toEqual({ count: 1, w: 450, h: 1800, jpeg: true });
    expect(sizes[2]).toEqual({ count: 1, w: 640, h: 480, jpeg: true });
  });

  test('rejects files that are not decodable images', async ({ page }) => {
    const message = await page.evaluate(async (loader) => {
      const mod = await import(/* @vite-ignore */ loader);
      const junk = new File([new Uint8Array([1, 2, 3, 4])], 'notes.png', { type: 'image/png' });
      try {
        await mod.processWorksheetFile(junk);
        return 'resolved';
      } catch (e) {
        return (e as Error).message;
      }
    }, LOADER);
    expect(message).toBe('Invalid image file.');
  });

  test('renders PDFs page by page with pdf.js and caps uploads at 10 pages', async ({ page }) => {
    // Build real PDFs in the page using the app's own PDF writer, then load them back through
    // pdf.js. This doubles as a round-trip check that exported PDFs are readable.
    const result = await page.evaluate(
      async ({ loader, exporter }) => {
        const { processWorksheetFile } = await import(/* @vite-ignore */ loader);
        const { buildMultiPagePdfFromJpegs } = await import(/* @vite-ignore */ exporter);

        const jpegPage = (hue: number) => {
          const c = document.createElement('canvas');
          c.width = 400;
          c.height = 283;
          const ctx = c.getContext('2d')!;
          ctx.fillStyle = `hsl(${hue}, 80%, 50%)`;
          ctx.fillRect(0, 0, c.width, c.height);
          const b64 = c.toDataURL('image/jpeg', 0.9).split(',')[1];
          const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
          return { jpegBytes: bytes, widthPx: c.width, heightPx: c.height };
        };
        const pdfFile = (n: number, name: string, type = 'application/pdf') =>
          new File([buildMultiPagePdfFromJpegs(Array.from({ length: n }, (_, i) => jpegPage(i * 30)))], name, { type });

        const two = await processWorksheetFile(pdfFile(2, 'two.pdf'));
        const twelve = await processWorksheetFile(pdfFile(12, 'twelve.pdf'));
        // Detected by extension even when the browser reports no MIME type
        const noMime = await processWorksheetFile(pdfFile(1, 'SCAN.PDF', ''));

        return {
          two: two.map((p: { width: number; height: number }) => [p.width, p.height]),
          twelve: twelve.length,
          noMime: noMime.length,
        };
      },
      { loader: LOADER, exporter: EXPORT }
    );

    // 842 × 595pt pages are rendered at min(2, 1400 / 842) scale → 1400 × 989
    expect(result.two).toEqual([
      [1400, 989],
      [1400, 989],
    ]);
    expect(result.twelve).toBe(10);
    expect(result.noMime).toBe(1);
  });
});

test.describe('batch PDF export (in browser)', () => {
  test('downloads one PDF page per board, readable by pdf.js', async ({ page }) => {
    const roomId = uniqueRoom('pdf');
    const downloadPromise = page.waitForEvent('download');

    const progress = await page.evaluate(
      async ({ exporter, roomId }) => {
        const { exportAllBoardsToPdf } = await import(/* @vite-ignore */ exporter);
        const stroke = (id: string, userId: string, tool = 'solid', extra = {}) => ({
          id,
          userId,
          userName: userId,
          tool,
          color: '#e11d48',
          strokeWidth: 6,
          points: [0, 0, 120, 60, 240, 0, 360, 90],
          ...extra,
        });
        const calls: Array<[number, number]> = [];
        await exportAllBoardsToPdf({
          roomId,
          mainElements: [
            stroke('m1', 'teacher'),
            { id: 'n1', userId: 'teacher', userName: 'T', tool: 'text', color: '#000', strokeWidth: 4, x: 10, y: 120, text: 'Hello\nclass' },
            { id: 's1', userId: 'teacher', userName: 'T', tool: 'stamp', stamp: 'username', color: '#2563eb', strokeWidth: 4, x: 200, y: 200 },
          ],
          mainBackground: null,
          subBoards: [
            {
              id: 'r1_ind_u1',
              title: 'Alex',
              assignedUserIds: ['u1'],
              elements: [stroke('a1', 'u1', 'highlighter'), stroke('a2', 'u1', 'eraser')],
              background: null,
              messages: [],
            },
            { id: 'r1_ind_u2', title: 'Sam', assignedUserIds: ['u2'], elements: [], background: null, messages: [] },
          ],
          users: [
            { userId: 'u1', name: 'Alex', color: '#f00', isTeacher: false },
            { userId: 'u2', name: 'Sam', color: '#0f0', isTeacher: false },
          ],
          onProgress: (cur: number, total: number) => calls.push([cur, total]),
          fileLabel: 'round1',
        });
        return calls;
      },
      { exporter: EXPORT, roomId }
    );

    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);

    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(new RegExp(`^allaboard-${roomId}-round1-\\d{4}-\\d{2}-\\d{2}\\.pdf$`));

    const fs = await import('node:fs/promises');
    const bytes = await fs.readFile((await download.path())!);
    const text = bytes.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Count 3');

    // Feed the downloaded file back through the worksheet loader: pdf.js must render all 3 pages.
    const pageCount = await page.evaluate(
      async ({ loader, b64 }) => {
        const { processWorksheetFile } = await import(/* @vite-ignore */ loader);
        const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const pages = await processWorksheetFile(new File([data], 'export.pdf', { type: 'application/pdf' }));
        return pages.length;
      },
      { loader: LOADER, b64: bytes.toString('base64') }
    );
    expect(pageCount).toBe(3);
  });
});

test.describe('worksheet UI', () => {
  test('teacher applies a built-in template from the Templates dialog', async ({ page }) => {
    await joinRoom(page, uniqueRoom('tpl'), 'Ms T', '4829');
    await page.getByTitle('Choose from 3 customizable classroom worksheet templates').click();
    await page.getByRole('button', { name: /Four Corners Debate/ }).click();
    await page.getByLabel(/Customize Task \/ Topic Prompt/).fill('Phones belong in class');
    await page.getByRole('button', { name: 'Apply Worksheet to Board' }).click();
    await expect(page.getByTitle('Remove background worksheet from this board')).toBeVisible();
  });

  test('teacher uploads an image worksheet and can remove it', async ({ page }) => {
    await joinRoom(page, uniqueRoom('upload'), 'Ms T', '4829');

    const png = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 800;
      c.height = 600;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 800, 600);
      ctx.fillStyle = '#111827';
      ctx.font = '48px sans-serif';
      ctx.fillText('Worksheet 1', 40, 80);
      return c.toDataURL('image/png').split(',')[1];
    });

    await page
      .locator('input[type="file"][accept*="application/pdf"]')
      .setInputFiles({ name: 'worksheet.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });

    const remove = page.getByTitle('Remove background worksheet from this board');
    await expect(remove).toBeVisible();
    page.once('dialog', (d) => d.accept());
    await remove.click();
    await expect(remove).toBeHidden();
  });
});
