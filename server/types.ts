import type { Server, Socket } from 'socket.io';
import type { BackupBackend } from '../backupMirror.ts';
import type { BreakoutConfigLike } from '../src/lib/breakoutRounds.ts';
import type { RoundVariants } from '../src/lib/roundVariants.ts';
import type { ClientToServerEvents, ServerToClientEvents } from '../src/lib/socketContract.ts';
import type { StudentStatus, SubBoardKind } from '../src/types.ts';

export type UserKeyCheck = 'matched' | 'claimed' | 'keyless' | 'rejected';

export interface StartServerOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  backupDir?: string;
  /** Tests only: use this backup backend instead of picking one from the environment. */
  backupBackend?: BackupBackend;
  skipVite?: boolean;
  /** Tests only: how often teachers get digests of boards they aren't viewing (default OVERVIEW_SYNC_MS). */
  overviewSyncMs?: number;
  /** Problem reports (docs/REPORTS.md). Default: REPORT_RELAY_URL / REPORT_RELAY_TOKEN from the environment. */
  reportRelayUrl?: string;
  reportRelayToken?: string;
  /** Tests only: stands in for fetch when calling the report relay. */
  reportFetch?: typeof fetch;
}

export interface ServerUserRecord {
  userId: string;
  name: string;
  color: string;
  isTeacher: boolean;
  isNameLocked?: boolean;
  status?: StudentStatus;
  statusUpdatedAt?: number;
  sockets: Set<string>;
}

export interface BannedUserRecord {
  userId: string;
  name: string;
  bannedAt: number;
}

export interface SubBoardState {
  id: string;
  roundId?: string;
  kind?: SubBoardKind;
  title: string;
  assignedUserIds: string[];
  elements: any[];
  background: any | null;
  messages: any[];
}

export type BreakoutConfigState = BreakoutConfigLike;

export interface TimerState {
  isRunning: boolean;
  durationMs: number;
  remainingMs: number;
  endsAt: number | null;
  autoLockOnExpire: boolean;
}

export interface RoomState {
  id: string;
  messages: any[];
  elements: any[];
  background: any | null;
  subBoards: Map<string, SubBoardState>;
  breakoutConfig: BreakoutConfigState;
  /** Worksheet background each round was launched with, used to provision late-joining students. Server-only; not broadcast. */
  roundTemplates: Record<string, any | null>;
  /** Teacher ink copied onto every board of a round when it's made (template ink). Server ids; teacher-authored. */
  roundTemplateInk: Record<string, any[]>;
  /** Worksheets B–D and the rule for who gets which, per individual round (A is the round template). Teacher-only. */
  roundVariants: Record<string, RoundVariants>;
  timer: TimerState;
  usersByUserId: Map<string, ServerUserRecord>;
  /** userId → SHA-256 of that browser's private key. Server-only; never broadcast. */
  userKeyHashes: Map<string, string>;
  lockedNames: Record<string, string>;
  bannedUsers: Record<string, BannedUserRecord>;
  isCanvasLocked: boolean;
  hideStudentCursors: boolean;
  oneNameStamp: boolean;
  /** `scrypt:<salt>:<hash>` (socketGuards.ts), never the PIN itself. */
  teacherPinHash: string | null;
  lastActiveAt: number;
}

export interface SerializedRoom {
  id: string;
  messages: any[];
  elements: any[];
  background?: any | null;
  subBoards?: Record<string, SubBoardState>;
  breakoutConfig?: BreakoutConfigState;
  roundTemplates?: Record<string, any | null>;
  roundTemplateInk?: Record<string, any[]>;
  roundVariants?: Record<string, RoundVariants>;
  timer?: TimerState;
  userKeyHashes?: Record<string, string>;
  lockedNames?: Record<string, string>;
  bannedUsers?: Record<string, BannedUserRecord>;
  isCanvasLocked: boolean;
  hideStudentCursors?: boolean;
  oneNameStamp?: boolean;
  teacherPinHash?: string | null;
  /** Legacy: plain-text PIN from before hashing. Read on load and hashed; never written. */
  teacherPin?: string | null;
  lastActiveAt: number;
}

export type TypedIo = Server<ClientToServerEvents, ServerToClientEvents>;
export type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
export interface SocketMeta {
  roomId: string;
  userId: string;
  channel?: string;
  viewBoardId?: string;
  inTeachers?: boolean;
}

export type ServerContext = {
  io: TypedIo;
  store: import('../roomStore.ts').RoomStore;
  backup: import('../backupMirror.ts').BackupMirror | null;
  rooms: Map<string, RoomState>;
  socketMeta: Map<string, SocketMeta>;
  pinFailures: ReturnType<typeof import('../socketGuards.ts').createFailureLimiter>;
} & ReturnType<typeof import('./roomSerialization.ts').createRoomSerialization> &
  ReturnType<typeof import('./roomPersistence.ts').createRoomPersistence> &
  ReturnType<typeof import('./boardChannels.ts').createBoardChannels> &
  ReturnType<typeof import('./breakoutHelpers.ts').createBreakoutHelpers> &
  ReturnType<typeof import('./lessonPackHelpers.ts').createLessonPackHelpers>;
