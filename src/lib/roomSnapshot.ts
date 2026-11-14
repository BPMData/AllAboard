import type { CanvasElement, ChatMessage, PendingSnapshotData } from '../types';

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
    },
  };
}
