export interface PageRange { first: number; last: number } // 1-based, inclusive

export const MAX_PDF_PAGES = 30;
export const MAX_RENDER_PIXEL_DIMENSION = 2400;
export const WORKSHEET_SCALE_OPTIONS = [0.5, 1, 1.5, 2, 2.5, 3] as const;
export const DEFAULT_WORKSHEET_IMPORT_SCALE = 2;
export const WORKSHEET_IMPORT_SCALE_STORAGE_KEY = 'allaboard-worksheet-import-scale';

/** Clamp a requested range to [1, total] and to at most `max` pages, keeping `first` fixed when possible. */
export function clampPageRange(first: number, last: number, total: number, max: number): PageRange {
  const t = Math.max(1, Math.floor(total));
  const f = Math.min(Math.max(1, Math.floor(first) || 1), t);
  let l = Math.min(Math.max(f, Math.floor(last) || f), t);
  if (l - f + 1 > max) l = f + max - 1;
  return { first: f, last: l };
}

export function normalizeWorksheetImportScale(raw: unknown): number {
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num) || num <= 0) {
    return DEFAULT_WORKSHEET_IMPORT_SCALE;
  }
  const clamped = Math.min(3, Math.max(0.5, num));
  return Math.round(clamped * 100) / 100;
}

export function scalePageDimensions(
  baseWidth: number,
  baseHeight: number,
  importScale?: number
): {
  width: number;
  height: number;
  renderWidth: number;
  renderHeight: number;
  multiplier: number;
} {
  const multiplier =
    importScale === undefined ? 1 : normalizeWorksheetImportScale(importScale);
  const safeBaseW = Math.max(1, baseWidth);
  const safeBaseH = Math.max(1, baseHeight);
  const width = Math.max(1, Math.round(safeBaseW * multiplier));
  const height = Math.max(1, Math.round(safeBaseH * multiplier));

  let renderWidth = width;
  let renderHeight = height;
  if (renderWidth > MAX_RENDER_PIXEL_DIMENSION || renderHeight > MAX_RENDER_PIXEL_DIMENSION) {
    const capRatio = Math.min(
      MAX_RENDER_PIXEL_DIMENSION / renderWidth,
      MAX_RENDER_PIXEL_DIMENSION / renderHeight
    );
    renderWidth = Math.max(1, Math.round(renderWidth * capRatio));
    renderHeight = Math.max(1, Math.round(renderHeight * capRatio));
  }

  return { width, height, renderWidth, renderHeight, multiplier };
}
