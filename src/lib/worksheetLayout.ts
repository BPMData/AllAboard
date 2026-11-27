import type { BackgroundPage, RoomBackground } from '../types';

export const DEFAULT_PAGE_GAP = 32;

export interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Picks a grid column count (1..n) whose overall page block comes closest to `targetAspect`.
 */
export function gridColumns(pages: Array<Pick<BackgroundPage, 'width' | 'height'>>, targetAspect = 16 / 9): number {
  const n = pages.length;
  if (n <= 1) return 1;

  let maxW = 1;
  let maxH = 1;
  for (const p of pages) {
    if (p.width > maxW) maxW = p.width;
    if (p.height > maxH) maxH = p.height;
  }

  let bestCols = 1;
  let bestDiff = Infinity;
  for (let c = 1; c <= n; c++) {
    const rows = Math.ceil(n / c);
    const aspect = (c * maxW) / (rows * maxH);
    const diff = Math.abs(Math.log(aspect / targetAspect));
    if (diff < bestDiff - 1e-9) {
      bestDiff = diff;
      bestCols = c;
    }
  }
  return bestCols;
}

/**
 * Computes world-space rectangles for every page of a worksheet background.
 * Unknown layout values (from older snapshots) fall back to `'row'`.
 */
export function layoutPages(
  bg: Pick<RoomBackground, 'pages' | 'x' | 'y' | 'scale' | 'layout'>,
  gap = DEFAULT_PAGE_GAP
): PageRect[] {
  const pages = bg.pages || [];
  if (pages.length === 0) return [];

  const sc = bg.scale || 1;
  const startX = bg.x || 0;
  const startY = bg.y || 0;
  const scaledGap = gap * sc;

  if (bg.layout === 'stack') {
    let offsetY = startY;
    return pages.map((p) => {
      const width = p.width * sc;
      const height = p.height * sc;
      const rect: PageRect = { x: startX, y: offsetY, width, height };
      offsetY += height + scaledGap;
      return rect;
    });
  }

  if (bg.layout === 'grid') {
    const cols = gridColumns(pages);
    const rowCount = Math.ceil(pages.length / cols);
    const colWidths = new Array<number>(cols).fill(0);
    const rowHeights = new Array<number>(rowCount).fill(0);

    pages.forEach((p, idx) => {
      const c = idx % cols;
      const r = Math.floor(idx / cols);
      colWidths[c] = Math.max(colWidths[c], p.width * sc);
      rowHeights[r] = Math.max(rowHeights[r], p.height * sc);
    });

    const colOffsets: number[] = [];
    let cx = startX;
    for (let c = 0; c < cols; c++) {
      colOffsets.push(cx);
      cx += colWidths[c] + scaledGap;
    }

    const rowOffsets: number[] = [];
    let ry = startY;
    for (let r = 0; r < rowCount; r++) {
      rowOffsets.push(ry);
      ry += rowHeights[r] + scaledGap;
    }

    return pages.map((p, idx) => {
      const c = idx % cols;
      const r = Math.floor(idx / cols);
      return {
        x: colOffsets[c],
        y: rowOffsets[r],
        width: p.width * sc,
        height: p.height * sc,
      };
    });
  }

  // 'row' and any unknown legacy layout fall back to side-by-side row placement.
  let offsetX = startX;
  return pages.map((p) => {
    const width = p.width * sc;
    const height = p.height * sc;
    const rect: PageRect = { x: offsetX, y: startY, width, height };
    offsetX += width + scaledGap;
    return rect;
  });
}
