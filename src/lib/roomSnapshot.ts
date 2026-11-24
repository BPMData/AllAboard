import type { CanvasElement, ChatMessage, PendingSnapshotData, RoomBackground } from '../types';
import { looksLikeLesson } from './lessonPack.ts';

export function snapshotFileName(roomId: string, date: Date = new Date()): string {
  return `allaboard-room-${roomId}-${date.toISOString().slice(0, 10)}.json`;
}

export interface ParsedSnapshot {
  pending: PendingSnapshotData;
  error: string | null;
}

/** Shared by local "Import .JSON" and "Open from Drive". Never throws. */
export function parseSnapshotText(fileName: string, text: string, fallbackRoomId: string): ParsedSnapshot {
  const empty: PendingSnapshotData = { fileName, roomId: fallbackRoomId, elements: [], messages: [], background: null };
  let parsed: any;
  try {
    parsed = JSON.parse(text || '{}');
  } catch {
    return { pending: empty, error: 'Could not parse JSON file. Make sure it is a valid .json room snapshot.' };
  }
  if (looksLikeLesson(parsed)) {
    return { pending: empty, error: 'This is a lesson pack. Use Load lesson… instead.' };
  }
  if (
    !parsed ||
    (!Array.isArray(parsed.elements) && !Array.isArray(parsed.messages) && !parsed.background && !parsed.subBoards)
  ) {
    return { pending: empty, error: 'This JSON file does not contain valid AllAboard room data.' };
  }
  const elements: CanvasElement[] = Array.isArray(parsed.elements)
    ? parsed.elements.filter((el: any) => el && typeof el.id === 'string' && typeof el.tool === 'string')
    : [];
  const messages: ChatMessage[] = Array.isArray(parsed.messages)
    ? parsed.messages.filter((m: any) => m && typeof m.id === 'string' && typeof m.text === 'string')
    : [];
  return {
    error: null,
    pending: {
      fileName,
      roomId: parsed.roomId || fallbackRoomId,
      exportedAt: parsed.exportedAt,
      exportedBy: parsed.exportedBy,
      elements,
      messages,
      background: parsed.background || null,
      subBoards: parsed.subBoards,
      breakoutConfig: parsed.breakoutConfig,
      assets: parsed.assets && typeof parsed.assets === 'object' ? parsed.assets : undefined,
      roundTemplates:
        parsed.roundTemplates && typeof parsed.roundTemplates === 'object' ? parsed.roundTemplates : undefined,
    },
  };
}

/** Every `/api/assets/<hash>` page URL in these backgrounds, each once, in order. */
export function backgroundAssetUrls(backgrounds: (RoomBackground | null | undefined)[]): string[] {
  const urls = new Set<string>();
  for (const bg of backgrounds) {
    for (const p of bg?.pages || []) {
      if (typeof p?.dataUrl === 'string' && p.dataUrl.startsWith('/api/assets/')) urls.add(p.dataUrl);
    }
  }
  return [...urls];
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export interface EmbeddedAssets {
  /** `/api/assets/<hash>` → base64 data URL. */
  assets: Record<string, string>;
  /** URLs that could not be downloaded. */
  failed: string[];
}

/**
 * Downloads each asset URL and returns it as a data URL, so an exported file carries its own images.
 * Never throws: failures are listed in `failed` (room saves log them; lesson saves stop and say so).
 */
export async function embedAssets(
  urls: string[],
  fetcher: (url: string) => Promise<Response> = (url) => fetch(url)
): Promise<EmbeddedAssets> {
  const assets: Record<string, string> = {};
  const failed: string[] = [];
  for (const url of urls) {
    try {
      const res = await fetcher(url);
      if (!res.ok) throw new Error(`Asset request failed: ${res.status}`);
      const type = res.headers.get('content-type')?.split(';')[0].trim() || 'application/octet-stream';
      const bytes = new Uint8Array(await res.arrayBuffer());
      assets[url] = `data:${type};base64,${bytesToBase64(bytes)}`;
    } catch (err) {
      console.error('Could not embed worksheet asset:', url, err);
      failed.push(url);
    }
  }
  return { assets, failed };
}
