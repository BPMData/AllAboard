import { CanvasElement, RoomBackground, SubBoardData, User } from '../types';
import {
  NOTE_FONT,
  NOTE_LH,
  traceSmoothStrokePath,
  drawHollowElementOnCtx,
  getNoteFontSize,
  getNoteBox,
  computeNotesGone,
} from './inkCore';

const PAGE_GAP = 32;

const STAMP_SYMBOLS: Record<string, string> = {
  check: '✓',
  question: '?',
  star: '★',
  thumbsup: '👍',
  heart: '♥',
};

export interface BoardExportEntry {
  boardId: string;
  title: string;
  subtitle: string;
  elements: CanvasElement[];
  background: RoomBackground | null;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function computeBoardWorldBounds(
  elements: CanvasElement[],
  background: RoomBackground | null
): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const expand = (x0: number, y0: number, x1: number, y1: number) => {
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) {
      return;
    }
    minX = Math.min(minX, x0, x1);
    minY = Math.min(minY, y0, y1);
    maxX = Math.max(maxX, x0, x1);
    maxY = Math.max(maxY, y0, y1);
  };

  if (background && background.pages && background.pages.length > 0) {
    const scale = background.scale || 1;
    let offsetX = background.x || 0;
    let offsetY = background.y || 0;
    for (const page of background.pages) {
      const w = page.width * scale;
      const h = page.height * scale;
      expand(offsetX, offsetY, offsetX + w, offsetY + h);
      if (background.layout === 'row') {
        offsetX += w + PAGE_GAP * scale;
      } else {
        offsetY += h + PAGE_GAP * scale;
      }
    }
  }

  for (const el of elements) {
    if (el.tool === 'eraser') continue;
    const pad = Math.max(12, (el.strokeWidth || 4) * 2);
    if (el.tool === 'rect' || el.tool === 'circle') {
      const x0 = el.x || 0;
      const y0 = el.y || 0;
      expand(x0 - pad, y0 - pad, x0 + (el.width || 0) + pad, y0 + (el.height || 0) + pad);
    } else if (el.tool === 'text') {
      const [bx0, by0, bx1, by1] = getNoteBox(el);
      expand(bx0 - pad, by0 - pad, bx1 + pad, by1 + pad);
    } else if (el.tool === 'stamp') {
      const sx = el.x || 0;
      const sy = el.y || 0;
      expand(sx - 90, sy - 45, sx + 90, sy + 45);
    } else if (el.points && el.points.length >= 2) {
      for (let i = 0; i < el.points.length; i += 2) {
        expand(
          el.points[i] - pad,
          el.points[i + 1] - pad,
          el.points[i] + pad,
          el.points[i + 1] + pad
        );
      }
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { minX: 40, minY: 40, maxX: 1140, maxY: 790 };
  }

  return {
    minX: minX - 36,
    minY: minY - 36,
    maxX: Math.max(minX + 400, maxX + 36),
    maxY: Math.max(minY + 280, maxY + 36),
  };
}

function drawElementOnContext(
  ctx: CanvasRenderingContext2D,
  el: CanvasElement,
  goneNoteIds: Set<string>
) {
  ctx.save();

  if (el.tool === 'eraser') {
    const pts = el.points || [];
    if (pts.length >= 2) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = '#000000';
      ctx.fillStyle = '#000000';
      ctx.lineWidth = Math.max(8, el.strokeWidth * 1.5);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const kind = traceSmoothStrokePath(ctx, pts, ctx.lineWidth);
      if (kind === 'dot') ctx.fill();
      else if (kind === 'stroke') ctx.stroke();
    }
    ctx.restore();
    return;
  }

  if (el.tool === 'stamp') {
    const cx = el.x || 0;
    const cy = el.y || 0;
    if (el.stamp === 'username') {
      const label = el.userName || 'Student';
      const fontSize = Math.max(13, Math.round(el.strokeWidth * 1.1 + 10));
      const padX = Math.round(fontSize * 0.85);
      const badgeW = Math.max(64, Math.round(label.length * (fontSize * 0.62) + padX * 2));
      const badgeH = Math.round(fontSize * 1.85);
      const r = badgeH / 2;

      ctx.beginPath();
      ctx.roundRect(cx - badgeW / 2, cy - badgeH / 2, badgeW, badgeH, r);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = Math.max(2, fontSize * 0.14);
      ctx.strokeStyle = el.color;
      ctx.stroke();

      ctx.fillStyle = el.color;
      ctx.font = `700 ${fontSize}px "Plus Jakarta Sans", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, cx, cy);
    } else {
      const symbol = STAMP_SYMBOLS[el.stamp || 'check'] || '✓';
      const radius = Math.max(16, el.strokeWidth * 1.8 + 10);
      const fontSize = Math.round(radius * 1.15);

      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = Math.max(2.5, radius * 0.14);
      ctx.strokeStyle = el.color;
      ctx.stroke();

      ctx.fillStyle = el.color;
      ctx.font = `700 ${fontSize}px "Plus Jakarta Sans", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(symbol, cx, cy);
    }
    ctx.restore();
    return;
  }

  if (el.tool === 'rect') {
    const x = (el.width || 0) < 0 ? (el.x || 0) + (el.width || 0) : el.x || 0;
    const y = (el.height || 0) < 0 ? (el.y || 0) + (el.height || 0) : el.y || 0;
    ctx.strokeStyle = el.color;
    ctx.lineWidth = el.strokeWidth;
    ctx.beginPath();
    ctx.roundRect(x, y, Math.abs(el.width || 0), Math.abs(el.height || 0), 2);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (el.tool === 'circle') {
    const radiusX = Math.abs(el.width || 0) / 2;
    const radiusY = Math.abs(el.height || 0) / 2;
    const radius = Math.max(radiusX, radiusY);
    const centerX = (el.x || 0) + (el.width || 0) / 2;
    const centerY = (el.y || 0) + (el.height || 0) / 2;
    ctx.strokeStyle = el.color;
    ctx.lineWidth = el.strokeWidth;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (el.tool === 'text') {
    if (goneNoteIds.has(el.id)) {
      ctx.restore();
      return;
    }
    const fontSize = getNoteFontSize(el);
    const lines = (el.text || '').split('\n');
    ctx.fillStyle = el.color;
    ctx.font = `600 ${fontSize}px ${NOTE_FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const x0 = el.x || 0;
    const y0 = el.y || 0;
    const lineStep = fontSize * NOTE_LH;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], x0, y0 + i * lineStep);
    }
    ctx.restore();
    return;
  }

  const pts = el.points || [];
  if (pts.length < 2) {
    ctx.restore();
    return;
  }

  if (el.tool === 'line') {
    ctx.strokeStyle = el.color;
    ctx.lineWidth = el.strokeWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) {
      ctx.lineTo(pts[i], pts[i + 1]);
    }
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (el.tool === 'spray') {
    ctx.strokeStyle = el.color;
    ctx.lineWidth = el.strokeWidth * 1.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 0.45;
    ctx.setLineDash([1, Math.max(6, Math.round(el.strokeWidth * 0.9))]);
    const kind = traceSmoothStrokePath(ctx, pts, ctx.lineWidth);
    if (kind === 'dot') ctx.fill();
    else if (kind === 'stroke') ctx.stroke();
    ctx.restore();
    return;
  }

  if (el.tool === 'hollow') {
    drawHollowElementOnCtx(
      ctx,
      pts,
      el.strokeWidth,
      el.hollowWeight || 2,
      el.color,
      el.hollowShape || 'circle'
    );
    ctx.restore();
    return;
  }

  // Default: 'solid' or 'highlighter' (both see-through and cover)
  ctx.strokeStyle = el.color;
  ctx.fillStyle = el.color;
  ctx.lineWidth = el.strokeWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const kind = traceSmoothStrokePath(ctx, pts, el.strokeWidth);
  if (kind === 'dot') ctx.fill();
  else if (kind === 'stroke') ctx.stroke();
  ctx.restore();
}

async function renderBoardPageJpeg(
  entry: BoardExportEntry,
  roomId: string,
  pageIndex: number,
  totalPages: number
): Promise<{ jpegBytes: Uint8Array; widthPx: number; heightPx: number }> {
  const widthPx = 1684; // 2x Landscape A4 (842pt x 595pt)
  const heightPx = 1190;
  const headerH = 68;

  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext('2d')!;

  // 1. Crisp white background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, widthPx, heightPx);

  // 2. Compute world bounding box and transform into canvas body area
  const bounds = computeBoardWorldBounds(entry.elements, entry.background);
  const worldW = Math.max(200, bounds.maxX - bounds.minX);
  const worldH = Math.max(150, bounds.maxY - bounds.minY);
  const availW = widthPx - 64;
  const availH = heightPx - headerH - 48;
  const scale = Math.min(availW / worldW, availH / worldH, 2.0);
  const offsetX = 32 + (availW - worldW * scale) / 2 - bounds.minX * scale;
  const offsetY = headerH + 24 + (availH - worldH * scale) / 2 - bounds.minY * scale;

  // 3. Draw Background Worksheet Pages
  if (entry.background && entry.background.pages?.length > 0) {
    const bgScale = entry.background.scale || 1;
    let curX = entry.background.x || 0;
    let curY = entry.background.y || 0;

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    ctx.globalAlpha = entry.background.opacity ?? 1;

    for (const page of entry.background.pages) {
      const pw = page.width * bgScale;
      const ph = page.height * bgScale;
      const img = await loadImage(page.dataUrl);
      if (img) {
        ctx.drawImage(img, curX, curY, pw, ph);
      }
      if (entry.background.layout === 'row') {
        curX += pw + PAGE_GAP * bgScale;
      } else {
        curY += ph + PAGE_GAP * bgScale;
      }
    }
    ctx.restore();
  }

  // Group elements by userId so each student's eraser only erases their own work
  const byUser = new Map<string, CanvasElement[]>();
  for (const el of entry.elements) {
    const uid = el.userId || 'anon';
    const arr = byUser.get(uid) || [];
    arr.push(el);
    byUser.set(uid, arr);
  }

  // 4. Render Multiply Highlighter Layer (per user)
  const hlLayerCanvas = document.createElement('canvas');
  hlLayerCanvas.width = widthPx;
  hlLayerCanvas.height = heightPx;
  const hlLayerCtx = hlLayerCanvas.getContext('2d')!;

  const userCanvas = document.createElement('canvas');
  userCanvas.width = widthPx;
  userCanvas.height = heightPx;
  const userCtx = userCanvas.getContext('2d')!;

  for (const [, userEls] of byUser.entries()) {
    const hasHl = userEls.some((e) => e.tool === 'highlighter' && !e.isCover);
    if (!hasHl) continue;
    userCtx.clearRect(0, 0, widthPx, heightPx);
    userCtx.save();
    userCtx.translate(offsetX, offsetY);
    userCtx.scale(scale, scale);
    const emptyGone = new Set<string>();
    for (const el of userEls) {
      if ((el.tool === 'highlighter' && !el.isCover) || el.tool === 'eraser') {
        drawElementOnContext(userCtx, el, emptyGone);
      }
    }
    userCtx.restore();
    hlLayerCtx.drawImage(userCanvas, 0, 0);
  }

  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(hlLayerCanvas, 0, 0);
  ctx.restore();

  // 5. Render Main Ink / Cover / Shapes / Notes / Stamps Layer (per user)
  for (const [, userEls] of byUser.entries()) {
    const goneNotes = computeNotesGone(userEls);
    userCtx.clearRect(0, 0, widthPx, heightPx);
    userCtx.save();
    userCtx.translate(offsetX, offsetY);
    userCtx.scale(scale, scale);
    for (const el of userEls) {
      if (el.tool === 'highlighter' && !el.isCover) continue;
      drawElementOnContext(userCtx, el, goneNotes);
    }
    userCtx.restore();
    ctx.drawImage(userCanvas, 0, 0);
  }

  // 6. Top Header Banner for Grading & Portfolios
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, widthPx, headerH);

  ctx.fillStyle = '#ffffff';
  ctx.font = '700 24px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${entry.title}`, 28, headerH / 2 - 9);

  ctx.fillStyle = '#94a3b8';
  ctx.font = '500 15px "DM Sans", sans-serif';
  ctx.fillText(entry.subtitle, 28, headerH / 2 + 15);

  const rightMeta = `AllAboard #${roomId}  ·  ${new Date().toLocaleDateString()}  ·  Page ${pageIndex + 1} of ${totalPages}`;
  ctx.fillStyle = '#cbd5e1';
  ctx.font = '500 15px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  ctx.fillText(rightMeta, widthPx - 28, headerH / 2);

  // Encode as high-quality JPEG
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  const base64 = dataUrl.split(',')[1] || '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return { jpegBytes: bytes, widthPx, heightPx };
}

/**
 * Assemble a standard PDF 1.4 document with one landscape page (842 x 595 pt) per board JPEG.
 */
function buildMultiPagePdfFromJpegs(
  pages: Array<{ jpegBytes: Uint8Array; widthPx: number; heightPx: number }>
): Blob {
  const pageWidthPt = 842;
  const pageHeightPt = 595;

  const chunks: Uint8Array[] = [];
  const offsets: number[] = [0]; // 1-indexed object byte offsets
  let byteLength = 0;

  const encoder = new TextEncoder();
  const pushStr = (str: string) => {
    const arr = encoder.encode(str);
    chunks.push(arr);
    byteLength += arr.length;
  };
  const pushBytes = (arr: Uint8Array) => {
    chunks.push(arr);
    byteLength += arr.length;
  };
  const markObj = (id: number) => {
    offsets[id] = byteLength;
  };

  pushStr('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');

  // Object 1: Catalog
  markObj(1);
  pushStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  // Object 2: Pages Kid List
  const pageObjIds = pages.map((_, idx) => 3 + idx * 3);
  markObj(2);
  pushStr(
    `2 0 obj\n<< /Type /Pages /Kids [ ${pageObjIds.map((id) => `${id} 0 R`).join(' ')} ] /Count ${pages.length} >>\nendobj\n`
  );

  // Each page uses 3 objects: Page (3 + i*3), ContentStream (4 + i*3), ImageXObject (5 + i*3)
  pages.forEach((p, idx) => {
    const pageObjId = 3 + idx * 3;
    const contentObjId = 4 + idx * 3;
    const imgObjId = 5 + idx * 3;
    const imgName = `/Im${idx}`;

    markObj(pageObjId);
    pushStr(
      `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidthPt} ${pageHeightPt}] /Resources << /XObject << ${imgName} ${imgObjId} 0 R >> >> /Contents ${contentObjId} 0 R >>\nendobj\n`
    );

    const contentStream = `q\n${pageWidthPt} 0 0 ${pageHeightPt} 0 0 cm\n${imgName} Do\nQ\n`;
    markObj(contentObjId);
    pushStr(
      `${contentObjId} 0 obj\n<< /Length ${contentStream.length} >>\nstream\n${contentStream}endstream\nendobj\n`
    );

    markObj(imgObjId);
    pushStr(
      `${imgObjId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.widthPx} /Height ${p.heightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpegBytes.length} >>\nstream\n`
    );
    pushBytes(p.jpegBytes);
    pushStr('\nendstream\nendobj\n');
  });

  const totalObjects = 2 + pages.length * 3;
  const xrefOffset = byteLength;

  pushStr(`xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`);
  for (let id = 1; id <= totalObjects; id++) {
    const off = String(offsets[id] || 0).padStart(10, '0');
    pushStr(`${off} 00000 n \n`);
  }

  pushStr(
    `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  );

  return new Blob(chunks, { type: 'application/pdf' });
}

export async function exportAllBoardsToPdf(params: {
  roomId: string;
  mainElements: CanvasElement[];
  mainBackground: RoomBackground | null;
  subBoards: SubBoardData[];
  users: User[];
  onProgress?: (current: number, total: number) => void;
  fileLabel?: string;
}): Promise<void> {
  const { roomId, mainElements, mainBackground, subBoards, users, onProgress, fileLabel } = params;

  const entries: BoardExportEntry[] = [];

  // Include Main Class Board if it has a worksheet or drawings, or if there are no subBoards
  if (mainElements.length > 0 || mainBackground !== null || subBoards.length === 0) {
    entries.push({
      boardId: 'main',
      title: 'Main Class Board',
      subtitle: `Shared Classroom Stage · ${mainElements.length} item(s)`,
      elements: mainElements,
      background: mainBackground,
    });
  }

  for (const sb of subBoards) {
    const assignedNames = sb.assignedUserIds
      .map((uid) => users.find((u) => u.userId === uid)?.name || 'Student')
      .join(', ');
    entries.push({
      boardId: sb.id,
      title: sb.title,
      subtitle: `${assignedNames ? `Students: ${assignedNames}` : 'Breakout / Individual Board'} · ${sb.elements.length} stroke(s)`,
      elements: sb.elements,
      background: sb.background,
    });
  }

  const renderedPages: Array<{ jpegBytes: Uint8Array; widthPx: number; heightPx: number }> = [];
  for (let i = 0; i < entries.length; i++) {
    onProgress?.(i + 1, entries.length);
    const pageData = await renderBoardPageJpeg(entries[i], roomId, i, entries.length);
    renderedPages.push(pageData);
  }

  const pdfBlob = buildMultiPagePdfFromJpegs(renderedPages);
  const url = URL.createObjectURL(pdfBlob);
  const link = document.createElement('a');
  link.download = `allaboard-${roomId}-${fileLabel || 'boards'}-${new Date().toISOString().slice(0, 10)}.pdf`;
  link.href = url;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
