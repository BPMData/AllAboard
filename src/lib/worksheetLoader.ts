import { BackgroundPage, RoomBackground } from '../types';
import {
  clampPageRange,
  MAX_PDF_PAGES,
  MAX_RENDER_PIXEL_DIMENSION,
  WORKSHEET_SCALE_OPTIONS,
  DEFAULT_WORKSHEET_IMPORT_SCALE,
  WORKSHEET_IMPORT_SCALE_STORAGE_KEY,
  normalizeWorksheetImportScale,
  scalePageDimensions,
  type PageRange,
} from './pageRange';
import * as pdfjsLib from 'pdfjs-dist';
// @ts-ignore - Vite ?url import for pdf.worker.mjs
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const MAX_IMAGE_DIMENSION = 1800;
export {
  MAX_PDF_PAGES,
  MAX_RENDER_PIXEL_DIMENSION,
  WORKSHEET_SCALE_OPTIONS,
  DEFAULT_WORKSHEET_IMPORT_SCALE,
  WORKSHEET_IMPORT_SCALE_STORAGE_KEY,
  normalizeWorksheetImportScale,
  scalePageDimensions,
};

export type BuiltInTemplateId = 'checkin-columns' | 'four-corners' | 'frayer-model';

export interface BuiltInTemplateDefinition {
  id: BuiltInTemplateId;
  name: string;
  description: string;
  defaultPrompt: string;
  promptPlaceholder: string;
}

export const BUILT_IN_TEMPLATES: BuiltInTemplateDefinition[] = [
  {
    id: 'checkin-columns',
    name: 'Task Pulse Check (Got It / Working / Help)',
    description: 'Three spacious columns where students drop a stamp or sign their name based on their progress.',
    defaultPrompt: "Put a stamp where you feel you are on today's task",
    promptPlaceholder: 'e.g. Put a stamp where you feel you are on Lab #3...',
  },
  {
    id: 'four-corners',
    name: 'Four Corners Debate & Spectrum',
    description: 'Four quadrants (Strongly Agree, Agree, Disagree, Strongly Disagree) for class-wide stance mapping.',
    defaultPrompt: 'Place your stamp in the quadrant that matches your stance & sketch why',
    promptPlaceholder: 'e.g. Statement: Renewable energy can replace fossil fuels by 2040...',
  },
  {
    id: 'frayer-model',
    name: 'Collaborative Concept Map (4-Box Frayer)',
    description: 'Central concept box surrounded by Definition, Visual Sketch, Examples, and Non-Examples.',
    defaultPrompt: "Today's Core Concept: Photosynthesis",
    promptPlaceholder: "e.g. Today's Core Concept: Quadratic Functions...",
  },
];

export function generateTemplateBackground(templateId: BuiltInTemplateId, customPromptText: string): RoomBackground {
  const width = 1400;
  const height = 920;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const def = BUILT_IN_TEMPLATES.find((t) => t.id === templateId) || BUILT_IN_TEMPLATES[0];
  const titleText = (customPromptText || def.defaultPrompt).trim();

  // Base crisp studio sheet
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // Outer border frame
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 3;
  ctx.strokeRect(24, 24, width - 48, height - 48);

  // Top Header Banner
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(24, 24, width - 48, 108);

  ctx.fillStyle = '#94a3b8';
  ctx.font = '600 14px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(def.name.toUpperCase(), 56, 62);

  ctx.fillStyle = '#ffffff';
  ctx.font = '700 28px "Plus Jakarta Sans", sans-serif';
  ctx.fillText(titleText.slice(0, 82), 56, 104);

  if (templateId === 'checkin-columns') {
    const cols = [
      {
        title: '✓  GOT IT!',
        subtitle: 'I understand and can help a classmate',
        headerBg: '#dcfce7',
        borderCol: '#86efac',
        textCol: '#166534',
        bodyBg: '#f0fdf4',
      },
      {
        title: '⏳  STILL WORKING',
        subtitle: 'Making progress — practicing on my own',
        headerBg: '#fef3c7',
        borderCol: '#fcd34d',
        textCol: '#92400e',
        bodyBg: '#fffbeb',
      },
      {
        title: '?  CONFUSED / NEED HELP',
        subtitle: 'I have a question or need a hint',
        headerBg: '#fee2e2',
        borderCol: '#fca5a5',
        textCol: '#991b1b',
        bodyBg: '#fef2f2',
      },
    ];

    const startX = 52;
    const startY = 160;
    const gap = 28;
    const colW = Math.floor((width - startX * 2 - gap * 2) / 3);
    const colH = height - startY - 52;

    cols.forEach((col, i) => {
      const x = startX + i * (colW + gap);
      const y = startY;

      // Column body fill
      ctx.fillStyle = col.bodyBg;
      ctx.fillRect(x, y, colW, colH);

      // Column header fill
      ctx.fillStyle = col.headerBg;
      ctx.fillRect(x, y, colW, 86);

      // Column border
      ctx.strokeStyle = col.borderCol;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(x, y, colW, colH);

      // Divider line under header
      ctx.beginPath();
      ctx.moveTo(x, y + 86);
      ctx.lineTo(x + colW, y + 86);
      ctx.stroke();

      // Header text
      ctx.fillStyle = col.textCol;
      ctx.font = '700 22px "Plus Jakarta Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(col.title, x + colW / 2, y + 40);

      ctx.font = '500 14px "DM Sans", sans-serif';
      ctx.fillText(col.subtitle, x + colW / 2, y + 68);

      // Subtle guide grid dots inside column
      ctx.fillStyle = '#cbd5e1';
      for (let gx = x + 32; gx < x + colW - 20; gx += 36) {
        for (let gy = y + 120; gy < y + colH - 20; gy += 36) {
          ctx.beginPath();
          ctx.arc(gx, gy, 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });
  } else if (templateId === 'four-corners') {
    const quadrants = [
      {
        title: 'STRONGLY AGREE',
        subtitle: 'Place a stamp & write 1 key reason',
        headerBg: '#dbeafe',
        borderCol: '#93c5fd',
        textCol: '#1e40af',
      },
      {
        title: 'SOMEWHAT AGREE',
        subtitle: 'Place a stamp & note your condition',
        headerBg: '#dcfce7',
        borderCol: '#86efac',
        textCol: '#166534',
      },
      {
        title: 'SOMEWHAT DISAGREE',
        subtitle: 'Place a stamp & share your counterpoint',
        headerBg: '#fef3c7',
        borderCol: '#fcd34d',
        textCol: '#92400e',
      },
      {
        title: 'STRONGLY DISAGREE',
        subtitle: 'Place a stamp & explain why',
        headerBg: '#fee2e2',
        borderCol: '#fca5a5',
        textCol: '#991b1b',
      },
    ];

    const startX = 52;
    const startY = 160;
    const gap = 28;
    const boxW = Math.floor((width - startX * 2 - gap) / 2);
    const boxH = Math.floor((height - startY - 52 - gap) / 2);

    quadrants.forEach((q, idx) => {
      const col = idx % 2;
      const row = Math.floor(idx / 2);
      const x = startX + col * (boxW + gap);
      const y = startY + row * (boxH + gap);

      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(x, y, boxW, boxH);

      ctx.fillStyle = q.headerBg;
      ctx.fillRect(x, y, boxW, 64);

      ctx.strokeStyle = q.borderCol;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(x, y, boxW, boxH);

      ctx.fillStyle = q.textCol;
      ctx.font = '700 19px "Plus Jakarta Sans", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(q.title, x + 24, y + 30);

      ctx.font = '500 13px "DM Sans", sans-serif';
      ctx.fillText(q.subtitle, x + 24, y + 50);
    });
  } else {
    // 4-Box Collaborative Concept Map / Frayer Model
    const boxes = [
      { title: '1. DEFINITION / KEY FACTS', subtitle: 'In your own words, what does it mean?' },
      { title: '2. VISUAL SKETCH / DIAGRAM', subtitle: 'Draw a quick picture or diagram' },
      { title: '3. REAL-WORLD EXAMPLES', subtitle: 'Where do we see this in action?' },
      { title: '4. NON-EXAMPLES / WATCH OUT FOR', subtitle: 'Common mistakes or what it is NOT' },
    ];

    const startX = 52;
    const startY = 160;
    const gap = 28;
    const boxW = Math.floor((width - startX * 2 - gap) / 2);
    const boxH = Math.floor((height - startY - 52 - gap) / 2);

    boxes.forEach((b, idx) => {
      const col = idx % 2;
      const row = Math.floor(idx / 2);
      const x = startX + col * (boxW + gap);
      const y = startY + row * (boxH + gap);

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x, y, boxW, boxH);

      ctx.fillStyle = '#f1f5f9';
      ctx.fillRect(x, y, boxW, 60);

      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, boxW, boxH);

      ctx.fillStyle = '#0f172a';
      ctx.font = '700 17px "Plus Jakarta Sans", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(b.title, x + 24, y + 28);

      ctx.fillStyle = '#475569';
      ctx.font = '500 13px "DM Sans", sans-serif';
      ctx.fillText(b.subtitle, x + 24, y + 48);
    });

    // Center Concept Badge
    const centerX = width / 2;
    const centerY = startY + boxH + gap / 2;
    const pillW = 340;
    const pillH = 84;

    ctx.fillStyle = '#1e293b';
    ctx.beginPath();
    ctx.roundRect(centerX - pillW / 2, centerY - pillH / 2, pillW, pillH, 42);
    ctx.fill();

    ctx.lineWidth = 4;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    ctx.fillStyle = '#93c5fd';
    ctx.font = '600 11px "Plus Jakarta Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('CENTRAL TOPIC', centerX, centerY - 12);

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 18px "Plus Jakarta Sans", sans-serif';
    ctx.fillText(titleText.slice(0, 32), centerX, centerY + 16);
  }

  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  const page: BackgroundPage = { dataUrl, width, height };

  return {
    id: 'tpl_' + templateId + '_' + Math.random().toString(36).substring(2, 8),
    fileName: `${def.name}`,
    pages: [page],
    x: Math.round(-width / 2),
    y: Math.round(-height / 2),
    scale: 1,
    layout: 'stack',
    opacity: 1,
  };
}

export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

export interface PdfThumbnailHandle {
  numPages: number;
  renderThumb: (pageNumber: number, width?: number) => Promise<string>;
  destroy: () => Promise<void>;
}

/**
 * Opens a PDF once and returns a sequential thumbnail renderer so callers can
 * render only visible pages on demand without overwhelming Chromebooks.
 */
export async function openPdfForThumbnails(file: File): Promise<PdfThumbnailHandle> {
  const loadingTask = pdfjsLib.getDocument({ data: await file.arrayBuffer() });
  const pdf = await loadingTask.promise;
  let destroyed = false;
  let queue: Promise<unknown> = Promise.resolve();

  const renderThumb = (pageNumber: number, width = 120): Promise<string> => {
    const task = queue.then(async () => {
      if (destroyed) {
        throw new Error('PDF thumbnail loader destroyed.');
      }
      const page = await pdf.getPage(pageNumber);
      try {
        const unscaledViewport = page.getViewport({ scale: 1 });
        const scale = width / Math.max(unscaledViewport.width, 1);
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement('canvas');
        const targetW = Math.max(1, Math.round(viewport.width));
        const targetH = Math.max(1, Math.round(viewport.height));
        canvas.width = targetW;
        canvas.height = targetH;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          throw new Error('Canvas context unavailable.');
        }

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, targetW, targetH);

        await page.render({
          canvasContext: ctx,
          viewport,
          canvas,
        } as any).promise;

        return canvas.toDataURL('image/jpeg', 0.7);
      } finally {
        page.cleanup();
      }
    });
    queue = task.catch(() => undefined);
    return task;
  };

  return {
    numPages: pdf.numPages,
    renderThumb,
    destroy: async () => {
      if (destroyed) return;
      destroyed = true;
      await loadingTask.destroy();
    },
  };
}

export async function renderPdfThumbnails(
  file: File,
  opts: { width: number; onThumb: (pageNumber: number, dataUrl: string) => void; signal?: AbortSignal }
): Promise<void> {
  if (opts.signal?.aborted) return;
  const doc = await openPdfForThumbnails(file);
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      if (opts.signal?.aborted) break;
      const dataUrl = await doc.renderThumb(pageNumber, opts.width);
      if (opts.signal?.aborted) break;
      opts.onThumb(pageNumber, dataUrl);
    }
  } finally {
    await doc.destroy();
  }
}

export async function getPdfPageCount(file: File): Promise<number> {
  const loadingTask = pdfjsLib.getDocument({ data: await file.arrayBuffer() });
  try {
    const pdf = await loadingTask.promise;
    return pdf.numPages;
  } finally {
    await loadingTask.destroy();
  }
}

export async function processWorksheetFile(
  file: File,
  range?: PageRange,
  importScale?: number
): Promise<BackgroundPage[]> {
  if (isPdfFile(file)) {
    return renderPdfToPages(file, range, importScale);
  }
  const singlePage = await renderImageFileToPage(file, importScale);
  return [singlePage];
}

async function renderImageFileToPage(file: File, importScale?: number): Promise<BackgroundPage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read image file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Invalid image file.'));
      img.onload = () => {
        let baseWidth = img.naturalWidth || img.width;
        let baseHeight = img.naturalHeight || img.height;

        if (baseWidth > MAX_IMAGE_DIMENSION || baseHeight > MAX_IMAGE_DIMENSION) {
          const ratio = Math.min(MAX_IMAGE_DIMENSION / baseWidth, MAX_IMAGE_DIMENSION / baseHeight);
          baseWidth = Math.round(baseWidth * ratio);
          baseHeight = Math.round(baseHeight * ratio);
        }

        const { width, height, renderWidth, renderHeight } = scalePageDimensions(baseWidth, baseHeight, importScale);

        const canvas = document.createElement('canvas');
        canvas.width = renderWidth;
        canvas.height = renderHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas context unavailable.'));
          return;
        }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, renderWidth, renderHeight);
        ctx.drawImage(img, 0, 0, renderWidth, renderHeight);

        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        resolve({ dataUrl, width, height });
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

async function renderPdfToPages(file: File, range?: PageRange, importScale?: number): Promise<BackgroundPage[]> {
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;

  const { first, last } = clampPageRange(range?.first ?? 1, range?.last ?? MAX_PDF_PAGES, pdf.numPages, MAX_PDF_PAGES);
  const pages: BackgroundPage[] = [];

  for (let pageNum = first; pageNum <= last; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const unscaledViewport = page.getViewport({ scale: 1 });
    const baseScale = Math.min(2.0, 1400 / Math.max(unscaledViewport.width, 1));
    const baseWidth = Math.round(unscaledViewport.width * baseScale);
    const baseHeight = Math.round(unscaledViewport.height * baseScale);

    const { width, height, renderWidth } = scalePageDimensions(baseWidth, baseHeight, importScale);
    const renderScale = renderWidth / Math.max(unscaledViewport.width, 1);
    const viewport = page.getViewport({ scale: renderScale });

    const canvas = document.createElement('canvas');
    const cWidth = Math.max(1, Math.round(viewport.width));
    const cHeight = Math.max(1, Math.round(viewport.height));
    canvas.width = cWidth;
    canvas.height = cHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) continue;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cWidth, cHeight);

    await page.render({
      canvasContext: ctx,
      viewport,
      canvas,
    } as any).promise;

    const dataUrl = canvas.toDataURL('image/jpeg', 0.84);
    pages.push({ dataUrl, width, height });
  }

  if (pages.length === 0) {
    throw new Error('No pages could be rendered from the PDF.');
  }

  return pages;
}

/** Wraps rendered worksheet pages in a centered `RoomBackground` (same defaults as a normal worksheet upload). */
export function buildWorksheetBackground(pages: BackgroundPage[], fileName: string): RoomBackground {
  const firstPage = pages[0];
  return {
    id: 'bg_' + Math.random().toString(36).substring(2, 10),
    fileName,
    pages,
    x: firstPage ? Math.round(-firstPage.width / 2) : -400,
    y: firstPage ? Math.round(-firstPage.height / 2) : -300,
    scale: 1,
    layout: pages.length >= 3 ? 'grid' : pages.length === 2 ? 'row' : 'stack',
    opacity: 1,
  };
}

/** File types the worksheet pickers accept. */
export const WORKSHEET_FILE_ACCEPT = '.png,.jpg,.jpeg,.webp,.pdf,image/png,image/jpeg,image/webp,application/pdf';

/**
 * One file → one worksheet background, keeping the first MAX_PDF_PAGES pages of a long PDF.
 * `note` is set when pages were dropped. Throws with a readable message on a bad file.
 */
export async function loadWorksheetFromFile(file: File): Promise<{ background: RoomBackground; note?: string }> {
  let range: PageRange | undefined;
  if (isPdfFile(file)) {
    const total = await getPdfPageCount(file);
    if (total > MAX_PDF_PAGES) range = { first: 1, last: MAX_PDF_PAGES };
  }
  const pages = await processWorksheetFile(file, range);
  const background = buildWorksheetBackground(
    pages,
    range ? `${file.name} (pp. ${range.first}–${range.last})` : file.name
  );
  return { background, note: range ? `using pages 1–${MAX_PDF_PAGES}` : undefined };
}
