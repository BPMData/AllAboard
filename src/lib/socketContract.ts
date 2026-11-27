/** Compile-time description of the Socket.IO wire protocol. Runtime validation remains on the server. */
import type {
  BreakoutAction, BreakoutConfig, BreakoutMode, CanvasElement, ChatMessage, ClassWorkData, ClassroomTimerState, ConfigureBreakoutPayload,
  ImportRestoreMode, RemoteCursor, RoomAvailability, RoomBackground, RoomSettings,
  SpotlightPayload, StudentStatus, SubBoardData, TimerControlPayload, User,
} from '../types.ts';
import type { BoardDigest } from './boardDigest.ts';
import type { ElementGroup } from './elementGroups.ts';
import type { LessonPack } from './lessonPack.ts';
import type { RoundVariants } from './roundVariants.ts';

export interface BasicAck { ok: boolean; error?: string }
export interface AuthAck extends BasicAck { mode?: 'claimed' | 'verified'; pin?: string }
export interface BreakoutAck extends BasicAck { roundId?: string; action?: BreakoutAction; activeRoundId?: string; mode?: BreakoutMode }
export interface MultiBgAck extends BasicAck { updated?: number; skipped?: string[] }
export interface ImportRoomAck extends BasicAck { connectionError?: boolean; elementsCount?: number; messagesCount?: number }
export interface LessonExportAck extends BasicAck { lesson?: LessonPack; inkCounts?: { teacher: number; all: number } }
export interface LessonHasAssetsAck extends BasicAck { missing?: string[] }
export interface LessonUploadAssetAck extends BasicAck { url?: string }
export interface LessonLoadAck extends BasicAck { roomId?: string; rounds?: number }

type Ack<T> = (response: T) => void;
type ElementPatch = Partial<CanvasElement> & { id: string };
type BoardElements = { boardId?: string; elements: CanvasElement[] };
type BatchUpdates = { boardId?: string; updates: ElementPatch[]; bringToFront?: boolean };
type BatchIds = { boardId?: string; ids: string[] };
type Replacements = { boardId?: string; groups: ElementGroup<CanvasElement>[] };
type Cursor = Omit<RemoteCursor, 'updatedAt'>;
type LaserPulse = { boardId: string; x: number; y: number; strokeId: string };

export interface ClientToServerEvents {
  'check-room': (payload: { roomId?: string } | undefined, callback?: Ack<RoomAvailability>) => void;
  'join-room': (payload: { roomId?: string; userId: string; userKey?: string; name: string; color: string; teacherPin?: string }) => void;
  'teacher:auth': (payload: { pin: string }, callback?: Ack<AuthAck>) => void;
  'user:set-status': (payload: { status?: StudentStatus } | undefined) => void;
  'teacher:clear-status': (payload: { targetUserId?: string } | undefined) => void;
  'teacher:step-down': () => void;
  'teacher:configure-breakout': (payload: ConfigureBreakoutPayload, callback?: Ack<BreakoutAck>) => void;
  'teacher:spotlight-board': (payload: SpotlightPayload, callback?: Ack<BasicAck>) => void;
  'teacher:view-board': (payload: { boardId?: string } | undefined) => void;
  'breakout:join-board': (payload: { targetBoardId: string; targetUserId?: string }) => void;
  'teacher:set-background': (payload: { boardId?: string; background: RoomBackground | null }, callback?: Ack<BasicAck>) => void;
  'teacher:set-background-multi': (payload: { boardIds: string[]; background: RoomBackground | null; roundTemplateFor?: string }, callback?: Ack<MultiBgAck>) => void;
  'teacher:set-round-variants': (payload: { roundId: string; variants: RoundVariants | null }, callback?: Ack<BasicAck>) => void;
  'teacher:update-background': (payload: { boardId?: string; patch: Partial<RoomBackground> }) => void;
  'teacher:import-room': (payload: ClassWorkData & { mode: ImportRestoreMode }, callback?: Ack<ImportRoomAck>) => void;
  'teacher:export-lesson': (payload: Record<string, unknown>, callback?: Ack<LessonExportAck>) => void;
  'teacher:has-assets': (payload: { urls: string[] }, callback?: Ack<LessonHasAssetsAck>) => void;
  'teacher:upload-asset': (payload: { url?: string; dataUrl: string }, callback?: Ack<LessonUploadAssetAck>) => void;
  'teacher:load-lesson': (payload: { lesson: LessonPack; target: 'new' | 'current'; newRoomId?: string; pin?: string }, callback?: Ack<LessonLoadAck>) => void;
  'update-profile': (payload: { name?: string; color?: string }) => void;
  'teacher:rename-user': (payload: { targetUserId: string; newName: string }, callback?: Ack<BasicAck & { newName?: string }>) => void;
  'teacher:delete-message': (payload: { messageId: string; boardId?: string }, callback?: Ack<BasicAck>) => void;
  'teacher:kick-user': (payload: { targetUserId: string; mode?: 'kick' | 'ban'; targetName?: string }, callback?: Ack<BasicAck>) => void;
  'teacher:unban-user': (payload: { targetUserId: string }, callback?: Ack<BasicAck>) => void;
  'teacher:purge-user-contributions': (payload: { targetUserId?: string }, callback?: Ack<BasicAck & { removedElements?: number; removedMessages?: number }>) => void;
  'chat-message': (payload: Partial<ChatMessage> & { text: string }) => void;
  'element-start': (element: CanvasElement) => void;
  'element-append-points': (payload: { id: string; boardId?: string; newPoints: number[] }) => void;
  'element-update': (patch: ElementPatch & { boardId?: string; bringToFront?: boolean }) => void;
  'elements-batch-update': (payload: BatchUpdates) => void;
  'elements-batch-add': (payload: BoardElements) => void;
  'elements-batch-remove': (payload: BatchIds) => void;
  'elements-replace': (payload: Replacements) => void;
  'element-remove': (payload: { id: string; boardId?: string }) => void;
  'laser-pulse': (payload: LaserPulse) => void;
  'cursor-move': (cursor: Cursor) => void;
  'undo': (payload: string | { userId?: string; boardId?: string } | undefined) => void;
  'clear-user-drawings': (payload: string | { targetUserId?: string; boardId?: string } | undefined) => void;
  'teacher:set-hide-cursors': (hide: boolean) => void;
  'teacher:set-one-name-stamp': (enabled: boolean) => void;
  'teacher:set-lock': (isLocked: boolean) => void;
  'teacher:timer-control': (payload: TimerControlPayload, callback?: Ack<BasicAck & { timer?: ClassroomTimerState }>) => void;
  'teacher:clear-all': (payload: { boardId?: string } | undefined) => void;
}

interface TeacherTemplates {
  roundTemplates?: Record<string, RoomBackground | null>;
  roundTemplateInk?: Record<string, CanvasElement[]>;
  roundVariants?: Record<string, RoundVariants>;
}
interface RoomContents {
  elements: CanvasElement[];
  messages: ChatMessage[];
  background: RoomBackground | null;
  subBoards: Record<string, SubBoardData>;
  roomSettings: RoomSettings;
}

export interface ServerToClientEvents {
  'init': (payload: RoomContents & TeacherTemplates & { users: User[]; isTeacher: boolean; assignedName?: string; isNameLocked: boolean }) => void;
  'state-sync': (payload: BoardElements & { messages?: ChatMessage[] }) => void;
  'breakout-sync': (payload: TeacherTemplates & { breakoutConfig: BreakoutConfig; subBoards: Record<string, SubBoardData> }) => void;
  'round-templates-sync': (payload: TeacherTemplates) => void;
  'background-sync': (payload: { boardId: string; background: RoomBackground | null }) => void;
  'board-replaced': (payload: { boardId: string }) => void;
  'room-restored': (payload: RoomContents) => void;
  'roster-sync': (users: User[]) => void;
  'room-settings': (settings: RoomSettings) => void;
  'user-renamed': (payload: { userId: string; newName: string; isNameLocked?: boolean }) => void;
  'message-deleted': (payload: { messageId: string; boardId: string }) => void;
  'user-contributions-purged': (payload: { targetUserId: string }) => void;
  'room-kicked': (payload: { reason: 'kicked' | 'banned' | 'identity'; roomId: string }) => void;
  'chat-message': (message: ChatMessage) => void;
  'element-start': (element: CanvasElement) => void;
  'element-append-points': (payload: { id: string; boardId?: string; newPoints: number[] }) => void;
  'element-update': (patch: ElementPatch & { boardId?: string; bringToFront?: boolean }) => void;
  'elements-batch-updated': (payload: BatchUpdates) => void;
  'elements-batch-added': (payload: BoardElements) => void;
  'elements-batch-removed': (payload: BatchIds) => void;
  'elements-replaced': (payload: Replacements) => void;
  'element-removed': (payload: { id: string; boardId?: string }) => void;
  'board-full': (payload: { boardId: string; max: number }) => void;
  'boards-digest': (payload: { boards: BoardDigest<CanvasElement>[] }) => void;
  'cursors-batch': (payload: { cursors: Cursor[] }) => void;
  'cursor-leave': (payload: { userId: string }) => void;
  'laser-pulse': (payload: LaserPulse & { userId: string }) => void;
}
