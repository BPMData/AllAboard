import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from './lib/socketContract';
import {
  CanvasElement,
  ChatMessage,
  User,
  RoomSettings,
  StudentStatus,
  SpotlightPayload,
  RoomBackground,
  RemoteCursor,
  type RestoreClassWork,
  SubBoardData,
  BreakoutConfig,
  ConfigureBreakoutPayload,
  TimerControlPayload,
  RoomAvailability,
} from './types';
import { findStudentBoardId } from './lib/breakoutRounds';
import {
  DEFAULT_CHAT_WIDTH,
  CHAT_STORAGE_KEYS,
  clampChatWidth,
  readStoredChatWidth,
  readStoredChatHidden,
  storeChatHiddenChoice,
} from './lib/chatSidebar';
import Chat, { getUserColor } from './components/Chat';
import Canvas from './components/Canvas';
import RoomExistsModal from './components/RoomExistsModal';
import PurgeContributionsModal from './components/PurgeContributionsModal';
import ProblemReportModal from './components/ProblemReportModal';
import { describeUserAgent, type ReportDiagnostics } from './lib/problemReport';
import RoomHistoryDropdown from './components/RoomHistoryDropdown';
import { normalizeRoomCode, sanitizeRoomCodeDraft } from './lib/roomCode';
import { recordRoomHistory } from './lib/roomHistory';
import type { LessonRequestEvent } from './lib/lessonPack';
import type { LessonResponse } from './components/LessonPackModals';
import type { RoundVariants } from './lib/roundVariants';
import { motion } from 'motion/react';
import { LogIn, Users, KeyRound, PlusCircle, Shuffle, Eye, EyeOff, LifeBuoy } from 'lucide-react';
import { POINT_FLUSH_MS } from './lib/drawThrottle';
import { MIN_TEACHER_PIN_LENGTH } from './lib/teacherPin';
import { applyDigest, type BoardDigest } from './lib/boardDigest';
import { applyElementGroups, type ElementGroup } from './lib/elementGroups';
import {
  appendPointBatches,
  createPointQueue,
  frameScheduler,
  timeoutScheduler,
  type PointBatch,
  type PointQueue,
} from './lib/pointBatcher';

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const STORAGE_KEYS = {
  USER_ID: 'drawchat_user_id',
  USER_KEY: 'drawchat_user_key',
  USER_NAME: 'drawchat_user_name',
  IS_JOINED: 'drawchat_is_joined',
  JOINED_ROOM_SESSION: 'drawchat_joined_room_session',
  TEACHER_PIN_PREFIX: 'drawchat_teacher_pin_',
};

function getOrCreatePersistentUserId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEYS.USER_ID);
    if (existing) return existing;
    const created = 'usr_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now().toString(36);
    localStorage.setItem(STORAGE_KEYS.USER_ID, created);
    return created;
  } catch {
    return 'usr_' + Math.random().toString(36).substring(2, 11);
  }
}

/** Private proof that this browser owns its userId. Unlike the userId, it is never shown to other users. */
function getOrCreatePersistentUserKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const created = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    const existing = localStorage.getItem(STORAGE_KEYS.USER_KEY);
    if (existing) return existing;
    localStorage.setItem(STORAGE_KEYS.USER_KEY, created);
  } catch {
    // Storage blocked: the userId is per-page-load too, so a per-page-load key still matches it
  }
  return created;
}

function normalizeClientRoomId(raw?: string): string {
  return normalizeRoomCode(raw);
}

function hasInitialUrlRoomParam(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return Boolean(params.get('room')?.trim());
  } catch {
    return false;
  }
}

function getInitialRoomId(): string {
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('room');
    if (fromUrl && fromUrl.trim()) {
      return normalizeClientRoomId(fromUrl);
    }
  } catch {
    // Ignore
  }
  return 'main';
}

function generateFreshRoomCode(): string {
  const num = Math.floor(100 + Math.random() * 900);
  const suffix = Math.random().toString(36).substring(2, 4);
  return `class-${num}${suffix}`;
}

export default function App() {
  const [socket, setSocket] = useState<AppSocket | null>(null);
  /** Our own streaming ink, sent every POINT_FLUSH_MS instead of on every pointer move. */
  const outgoingInkRef = useRef<PointQueue | null>(null);
  const [userId] = useState<string>(() => getOrCreatePersistentUserId());
  const [userKey] = useState<string>(() => getOrCreatePersistentUserKey());
  const [userColor] = useState<string>(() => getUserColor(getOrCreatePersistentUserId()));
  const [roomId, setRoomId] = useState<string>(() => getInitialRoomId());
  const [hadInitialUrlRoom] = useState<boolean>(() => hasInitialUrlRoomParam());
  const [hasEditedLobbyRoom, setHasEditedLobbyRoom] = useState<boolean>(false);
  const [pendingRoomPrompt, setPendingRoomPrompt] = useState<{
    source: 'lobby' | 'switch';
    availability: RoomAvailability;
    userName?: string;
    teacherPin?: string;
  } | null>(null);
  const [isCheckingRoom, setIsCheckingRoom] = useState<boolean>(false);
  const [pendingPurgePrompt, setPendingPurgePrompt] = useState<{
    targetUserId: string;
    targetName: string;
    mode: 'kick' | 'ban';
  } | null>(null);
  const [isPurgingContributions, setIsPurgingContributions] = useState<boolean>(false);

  const [userName, setUserName] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEYS.USER_NAME) || '';
    } catch {
      return '';
    }
  });

  const [isTeacher, setIsTeacher] = useState<boolean>(false);
  const [isNameLocked, setIsNameLocked] = useState<boolean>(false);
  const [kickNotice, setKickNotice] = useState<string | null>(null);
  const [showTeacherSetupOnJoin, setShowTeacherSetupOnJoin] = useState<boolean>(false);
  const [initialTeacherPin, setInitialTeacherPin] = useState<string>('');
  const [showInitialTeacherPin, setShowInitialTeacherPin] = useState<boolean>(false);
  const [historyVersion, setHistoryVersion] = useState<number>(0);

  const [isJoined, setIsJoined] = useState<boolean>(() => {
    try {
      if (!hasInitialUrlRoomParam()) return false;
      const savedName = localStorage.getItem(STORAGE_KEYS.USER_NAME);
      const savedJoined = localStorage.getItem(STORAGE_KEYS.IS_JOINED) === 'true';
      const sessionRoom = sessionStorage.getItem(STORAGE_KEYS.JOINED_ROOM_SESSION);
      return Boolean(
        savedName &&
          savedName.trim() &&
          savedJoined &&
          sessionRoom === getInitialRoomId()
      );
    } catch {
      return false;
    }
  });

  const userNameRef = useRef<string>(userName);
  const isJoinedRef = useRef<boolean>(isJoined);
  const roomCodeInputRef = useRef<HTMLInputElement | null>(null);
  const displayNameInputRef = useRef<HTMLInputElement | null>(null);
  const teacherPinInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    userNameRef.current = userName;
  }, [userName]);
  useEffect(() => {
    isJoinedRef.current = isJoined;
  }, [isJoined]);

  // Resizable & Collapsible Chat Sidebar State
  const [chatWidth, setChatWidth] = useState<number>(() => {
    try {
      return readStoredChatWidth(
        typeof window !== 'undefined' ? window.localStorage : null,
        typeof window !== 'undefined' ? window.innerWidth : undefined
      );
    } catch {
      return DEFAULT_CHAT_WIDTH;
    }
  });
  const [isChatHidden, setIsChatHidden] = useState<boolean>(() => {
    try {
      return typeof window !== 'undefined' ? readStoredChatHidden(window.localStorage, window.innerWidth) : false;
    } catch {
      return false;
    }
  });
  const [unreadChatCount, setUnreadChatCount] = useState<number>(0);

  const isChatHiddenRef = useRef<boolean>(isChatHidden);
  const seenChatIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    isChatHiddenRef.current = isChatHidden;
    if (!isChatHidden) {
      setUnreadChatCount(0);
    }
    // Not saved here: only a click on hide/show is saved (storeChatHiddenChoice), so the narrow-screen default
    // keeps applying until someone actually chooses.
  }, [isChatHidden]);

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_STORAGE_KEYS.WIDTH, String(chatWidth));
    } catch {
      // Ignore
    }
  }, [chatWidth]);

  useEffect(() => {
    const handleViewportResize = () => {
      setChatWidth((prev) => clampChatWidth(prev, window.innerWidth));
    };
    window.addEventListener('resize', handleViewportResize);
    return () => window.removeEventListener('resize', handleViewportResize);
  }, []);

  // Main Board State + Sub-Boards State
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [elements, setElements] = useState<CanvasElement[]>([]);
  const [background, setBackground] = useState<RoomBackground | null>(null);
  const [subBoards, setSubBoards] = useState<Record<string, SubBoardData>>({});
  /** Teacher-only: each round's starting worksheet (server `roundTemplates`). Empty for students. */
  const [roundTemplates, setRoundTemplates] = useState<Record<string, RoomBackground | null>>({});
  /** Teacher-only: ink each round copies onto its boards (server `roundTemplateInk`). Empty for students. */
  const [roundTemplateInk, setRoundTemplateInk] = useState<Record<string, CanvasElement[]>>({});
  /** Teacher-only: worksheet variants B–D and who gets which, per individual round (server `roundVariants`). */
  const [roundVariants, setRoundVariants] = useState<Record<string, RoundVariants>>({});
  const [teacherSelectedBoardId, setTeacherSelectedBoardId] = useState<string>('main');

  const [users, setUsers] = useState<User[]>([]);
  const [roomSettings, setRoomSettings] = useState<RoomSettings>({
    roomId: getInitialRoomId(),
    isCanvasLocked: false,
    hideStudentCursors: false,
    hasTeacherPin: false,
    breakoutConfig: {
      mode: 'main',
      rounds: [],
      allowSelfSelect: false,
      chatScope: 'unified',
    },
  });
  const [remoteCursors, setRemoteCursors] = useState<Record<string, RemoteCursor>>({});

  const breakoutConfig: BreakoutConfig = roomSettings.breakoutConfig || {
    mode: 'main',
    rounds: [],
    allowSelfSelect: false,
    chatScope: 'unified',
  };

  // Determine which boardId the current user should be viewing/drawing on
  const activeBoardId = useMemo(() => {
    if (isTeacher) {
      if (teacherSelectedBoardId !== 'main' && !subBoards[teacherSelectedBoardId]) {
        return 'main';
      }
      return teacherSelectedBoardId;
    }
    return findStudentBoardId(subBoards, breakoutConfig, userId);
  }, [isTeacher, teacherSelectedBoardId, roomSettings.breakoutConfig, subBoards, userId]);

  const activeBoardIdRef = useRef<string>(activeBoardId);
  const chatScopeRef = useRef<'unified' | 'board'>(breakoutConfig.chatScope || 'unified');
  useEffect(() => {
    activeBoardIdRef.current = activeBoardId;
  }, [activeBoardId]);
  useEffect(() => {
    chatScopeRef.current = breakoutConfig.chatScope || 'unified';
  }, [breakoutConfig.chatScope]);

  const activeBoardTitle = useMemo(() => {
    if (activeBoardId === 'main') return 'Main Class Board';
    return subBoards[activeBoardId]?.title || activeBoardId;
  }, [activeBoardId, subBoards]);

  const activeElements = useMemo(() => {
    if (activeBoardId === 'main') return elements;
    return subBoards[activeBoardId]?.elements || [];
  }, [activeBoardId, elements, subBoards]);

  const activeBackground = useMemo(() => {
    if (activeBoardId === 'main') return background;
    return subBoards[activeBoardId]?.background || null;
  }, [activeBoardId, background, subBoards]);

  const activeMessages = useMemo(() => {
    if (breakoutConfig.chatScope === 'board' && activeBoardId !== 'main') {
      return subBoards[activeBoardId]?.messages || [];
    }
    return messages;
  }, [breakoutConfig.chatScope, activeBoardId, subBoards, messages]);

  const effectiveRoomId = normalizeRoomCode(roomId);
  /**
   * The room the socket, the address bar and the tab title follow: the room you're in. In the lobby it holds still
   * while the Room Code box is typed in. Following the box made a new server connection, and (with the title) a
   * browser-history entry, for every letter typed.
   */
  const [liveRoomId, setLiveRoomId] = useState<string>(effectiveRoomId);
  useEffect(() => {
    if (isJoined) setLiveRoomId(effectiveRoomId);
  }, [isJoined, effectiveRoomId]);

  useEffect(() => {
    document.title = liveRoomId !== 'main' ? `#${liveRoomId} · AllAboard` : 'AllAboard';
    try {
      const url = new URL(window.location.href);
      if (liveRoomId === 'main') {
        url.searchParams.delete('room');
      } else {
        url.searchParams.set('room', liveRoomId);
      }
      if (url.toString() !== window.location.href) window.history.replaceState({}, '', url.toString());
    } catch {
      // Ignore
    }
  }, [liveRoomId]);

  useEffect(() => {
    const newSocket: AppSocket = io({
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    setSocket(newSocket);

    const outgoingInk = createPointQueue((batches) => {
      for (const b of batches) {
        newSocket.emit('element-append-points', { id: b.id, boardId: b.boardId, newPoints: b.points });
      }
    }, timeoutScheduler(POINT_FLUSH_MS));
    outgoingInkRef.current = outgoingInk;

    // Other people's streaming ink: apply once per frame (one state update) instead of once per message.
    const applyIncomingInk = (batches: PointBatch[]) => {
      const byBoard = new Map<string, PointBatch[]>();
      for (const b of batches) {
        const list = byBoard.get(b.boardId);
        if (list) list.push(b);
        else byBoard.set(b.boardId, [b]);
      }
      const mainBatches = byBoard.get('main');
      byBoard.delete('main');
      if (mainBatches) setElements((prev) => appendPointBatches(prev, mainBatches));
      if (byBoard.size > 0) {
        setSubBoards((prev) => {
          let next = prev;
          for (const [bId, list] of byBoard) {
            const sb = next[bId];
            if (!sb) continue;
            const elementsNext = appendPointBatches(sb.elements, list);
            if (elementsNext !== sb.elements) next = { ...next, [bId]: { ...sb, elements: elementsNext } };
          }
          return next;
        });
      }
    };
    const incomingInk = createPointQueue(applyIncomingInk, frameScheduler());
    // Any other event may touch the same elements (update, remove, state-sync, breakout-sync…), so apply queued
    // ink first to keep arrival order. onAny listeners run before the event's own handler.
    newSocket.onAny((event: string) => {
      if (event !== 'element-append-points' && event !== 'cursors-batch') incomingInk.flush();
    });

    newSocket.on('connect', () => {
      let savedName = userNameRef.current;
      let savedJoined = isJoinedRef.current;
      let savedPin: string | undefined;

      try {
        savedName = localStorage.getItem(STORAGE_KEYS.USER_NAME) || savedName;
        savedPin = localStorage.getItem(STORAGE_KEYS.TEACHER_PIN_PREFIX + liveRoomId) || undefined;
      } catch {
        // Ignore storage errors
      }

      if (savedName && savedName.trim() && savedJoined) {
        const cleanSavedPin = savedPin && savedPin.trim().length >= 3 ? savedPin.trim() : undefined;
        newSocket.emit('join-room', {
          roomId: liveRoomId,
          userId,
          userKey,
          name: savedName.trim(),
          color: userColor,
          teacherPin: cleanSavedPin,
        });
        if (cleanSavedPin) {
          newSocket.emit('teacher:auth', { pin: cleanSavedPin }, (res) => {
            if (res?.ok) setIsTeacher(true);
          });
        }
      }
    });

    newSocket.on(
      'init',
      ({
        messages: initMsgs,
        elements: initEls,
        background: initBg,
        subBoards: initSubBoards,
        users: initUsers,
        roomSettings: initRoom,
        isTeacher: verifiedTeacher,
        roundTemplates: initRoundTemplates,
        roundTemplateInk: initRoundTemplateInk,
        roundVariants: initRoundVariants,
        assignedName,
        isNameLocked: initNameLocked,
      }) => {
        setRoundTemplates(initRoundTemplates && typeof initRoundTemplates === 'object' ? initRoundTemplates : {});
        setRoundTemplateInk(initRoundTemplateInk && typeof initRoundTemplateInk === 'object' ? initRoundTemplateInk : {});
        setRoundVariants(initRoundVariants && typeof initRoundVariants === 'object' ? initRoundVariants : {});
        const nextSeen = new Set<string>();
        if (Array.isArray(initMsgs)) {
          setMessages(initMsgs);
          for (const m of initMsgs) nextSeen.add(m.id);
        }
        if (Array.isArray(initEls)) setElements(initEls);
        setBackground(initBg || null);
        if (initSubBoards && typeof initSubBoards === 'object') {
          setSubBoards(initSubBoards);
          for (const sb of Object.values(initSubBoards) as SubBoardData[]) {
            if (Array.isArray(sb?.messages)) {
              for (const m of sb.messages) nextSeen.add(m.id);
            }
          }
        } else {
          setSubBoards({});
        }
        seenChatIdsRef.current = nextSeen;
        setUnreadChatCount(0);
        if (Array.isArray(initUsers)) setUsers(initUsers);
        if (initRoom) setRoomSettings(initRoom);
        if (typeof verifiedTeacher === 'boolean') setIsTeacher(verifiedTeacher);
        if (typeof initNameLocked === 'boolean') setIsNameLocked(initNameLocked);
        if (assignedName && typeof assignedName === 'string') {
          setUserName(assignedName);
          try {
            localStorage.setItem(STORAGE_KEYS.USER_NAME, assignedName);
          } catch {
            // Ignore
          }
        }
        recordRoomHistory(initRoom?.roomId || liveRoomId);
        setHistoryVersion((v) => v + 1);
        setKickNotice(null);
      }
    );

    newSocket.on(
      'breakout-sync',
      ({
        breakoutConfig: syncedConfig,
        subBoards: syncedSubBoards,
        roundTemplates: syncedRoundTemplates,
        roundTemplateInk: syncedTemplateInk,
        roundVariants: syncedVariants,
      }: {
        breakoutConfig: BreakoutConfig;
        subBoards: Record<string, SubBoardData>;
        roundTemplates?: Record<string, RoomBackground | null>;
        roundTemplateInk?: Record<string, CanvasElement[]>;
        roundVariants?: Record<string, RoundVariants>;
      }) => {
        setRoomSettings((prev) => ({ ...prev, breakoutConfig: syncedConfig }));
        if (syncedSubBoards) setSubBoards(syncedSubBoards);
        if (syncedRoundTemplates && typeof syncedRoundTemplates === 'object') setRoundTemplates(syncedRoundTemplates);
        if (syncedTemplateInk && typeof syncedTemplateInk === 'object') setRoundTemplateInk(syncedTemplateInk);
        if (syncedVariants && typeof syncedVariants === 'object') setRoundVariants(syncedVariants);
      }
    );

    newSocket.on(
      'round-templates-sync',
      ({
        roundTemplates: synced,
        roundTemplateInk: syncedInk,
        roundVariants: syncedVariants,
      }: {
        roundTemplates?: Record<string, RoomBackground | null>;
        roundTemplateInk?: Record<string, CanvasElement[]>;
        roundVariants?: Record<string, RoundVariants>;
      }) => {
        if (synced && typeof synced === 'object') setRoundTemplates(synced);
        if (syncedInk && typeof syncedInk === 'object') setRoundTemplateInk(syncedInk);
        if (syncedVariants && typeof syncedVariants === 'object') setRoundVariants(syncedVariants);
      }
    );

    newSocket.on(
      'background-sync',
      (payload: RoomBackground | null | { boardId: string; background: RoomBackground | null }) => {
        if (payload && typeof payload === 'object' && 'boardId' in payload) {
          const { boardId, background: syncedBg } = payload;
          if (boardId === 'main') {
            setBackground(syncedBg || null);
          } else {
            setSubBoards((prev) => {
              const sb = prev[boardId];
              if (!sb) return prev;
              return { ...prev, [boardId]: { ...sb, background: syncedBg || null } };
            });
          }
        } else {
          setBackground((payload as RoomBackground | null) || null);
        }
      }
    );

    newSocket.on(
      'room-restored',
      ({
        elements: restoredEls,
        messages: restoredMsgs,
        background: restoredBg,
        subBoards: restoredSubBoards,
        roomSettings: restoredRoom,
      }: {
        elements: CanvasElement[];
        messages: ChatMessage[];
        background?: RoomBackground | null;
        subBoards?: Record<string, SubBoardData>;
        roomSettings: RoomSettings;
      }) => {
        if (Array.isArray(restoredEls)) setElements(restoredEls);
        if (Array.isArray(restoredMsgs)) setMessages(restoredMsgs);
        if (restoredBg !== undefined) setBackground(restoredBg || null);
        if (restoredSubBoards !== undefined) setSubBoards(restoredSubBoards || {});
        if (restoredRoom) setRoomSettings(restoredRoom);
      }
    );

    newSocket.on('roster-sync', (rosterList) => {
      setUsers(rosterList);
      const myRecord = rosterList.find((u) => u.userId === userId);
      if (myRecord) {
        setIsTeacher(Boolean(myRecord.isTeacher));
        setIsNameLocked(Boolean(myRecord.isNameLocked));
        if (myRecord.name && myRecord.name !== userNameRef.current) {
          setUserName(myRecord.name);
          try {
            localStorage.setItem(STORAGE_KEYS.USER_NAME, myRecord.name);
          } catch {
            // Ignore
          }
        }
      }
    });

    newSocket.on('room-settings', (settings) => {
      setRoomSettings(settings);
    });

    newSocket.on(
      'user-renamed',
      ({
        userId: renamedUserId,
        newName,
        isNameLocked: lockedFlag,
      }: {
        userId: string;
        newName: string;
        isNameLocked?: boolean;
      }) => {
        if (!renamedUserId || !newName) return;
        setMessages((prev) =>
          prev.map((m) => (m.userId === renamedUserId ? { ...m, userName: newName } : m))
        );
        setElements((prev) =>
          prev.map((el) => (el.userId === renamedUserId ? { ...el, userName: newName } : el))
        );
        setSubBoards((prev) => {
          const next: Record<string, SubBoardData> = {};
          for (const [k, sb] of Object.entries(prev) as Array<[string, SubBoardData]>) {
            next[k] = {
              ...sb,
              title: sb.kind === 'individual' && sb.assignedUserIds[0] === renamedUserId ? `${newName}'s Board` : sb.title,
              messages: sb.messages.map((m) =>
                m.userId === renamedUserId ? { ...m, userName: newName } : m
              ),
              elements: sb.elements.map((el) =>
                el.userId === renamedUserId ? { ...el, userName: newName } : el
              ),
            };
          }
          return next;
        });
        if (renamedUserId === userId) {
          setUserName(newName);
          if (typeof lockedFlag === 'boolean') setIsNameLocked(lockedFlag);
          try {
            localStorage.setItem(STORAGE_KEYS.USER_NAME, newName);
          } catch {
            // Ignore
          }
        }
      }
    );

    newSocket.on('message-deleted', ({ messageId }: { messageId: string; boardId?: string }) => {
      if (!messageId) return;
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
      setSubBoards((prev) => {
        const next: Record<string, SubBoardData> = {};
        for (const [k, sb] of Object.entries(prev) as Array<[string, SubBoardData]>) {
          next[k] = {
            ...sb,
            messages: sb.messages.filter((m) => m.id !== messageId),
          };
        }
        return next;
      });
    });

    newSocket.on('user-contributions-purged', ({ targetUserId }: { targetUserId: string }) => {
      if (!targetUserId) return;
      setElements((prev) => prev.filter((el) => el.userId !== targetUserId));
      setMessages((prev) => prev.filter((m) => m.userId !== targetUserId));
      setSubBoards((prev) => {
        const next: Record<string, SubBoardData> = {};
        for (const [k, sb] of Object.entries(prev) as Array<[string, SubBoardData]>) {
          next[k] = {
            ...sb,
            elements: sb.elements.filter((el) => el.userId !== targetUserId),
            messages: sb.messages.filter((m) => m.userId !== targetUserId),
          };
        }
        return next;
      });
    });

    newSocket.on(
      'room-kicked',
      ({ reason, roomId: kickedRoom }: { reason: 'kicked' | 'banned' | 'identity'; roomId?: string }) => {
        setIsJoined(false);
        setIsTeacher(false);
        setPendingPurgePrompt(null);
        try {
          localStorage.removeItem(STORAGE_KEYS.IS_JOINED);
          sessionStorage.removeItem(STORAGE_KEYS.JOINED_ROOM_SESSION);
          if (reason === 'identity') {
            // This id belongs to another browser. Drop it so the next page load starts with a fresh identity.
            localStorage.removeItem(STORAGE_KEYS.USER_ID);
            localStorage.removeItem(STORAGE_KEYS.USER_KEY);
          }
        } catch {
          // Ignore
        }
        const targetRoom = kickedRoom || roomId;
        setKickNotice(
          reason === 'identity'
            ? `This browser couldn't be verified for room #${targetRoom}. Refresh the page to join again.`
            : reason === 'banned'
            ? `You have been banned from room #${targetRoom} by the teacher.`
            : `You were removed from room #${targetRoom} by the teacher.`
        );
      }
    );

    newSocket.on('chat-message', (msg) => {
      const targetBoardId = msg.boardId || 'main';
      if (targetBoardId !== 'main') {
        setSubBoards((prev) => {
          const sb = prev[targetBoardId];
          if (!sb) return prev;
          if (sb.messages.some((m) => m.id === msg.id)) return prev;
          return {
            ...prev,
            [targetBoardId]: { ...sb, messages: [...sb.messages, msg] },
          };
        });
      } else {
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, msg];
        });
      }

      if (!seenChatIdsRef.current.has(msg.id)) {
        seenChatIdsRef.current.add(msg.id);
        const isCurrentChatStream =
          chatScopeRef.current === 'board' && activeBoardIdRef.current !== 'main'
            ? targetBoardId === activeBoardIdRef.current
            : targetBoardId === 'main';
        if (isChatHiddenRef.current && msg.userId !== userId && isCurrentChatStream) {
          setUnreadChatCount((c) => c + 1);
        }
      }
    });

    newSocket.on('element-start', (element) => {
      const bId = element.boardId || 'main';
      if (bId === 'main') {
        setElements((prev) => {
          if (prev.some((el) => el.id === element.id)) return prev;
          return [...prev, element];
        });
      } else {
        setSubBoards((prev) => {
          const sb = prev[bId];
          if (!sb || sb.elements.some((el) => el.id === element.id)) return prev;
          return {
            ...prev,
            [bId]: { ...sb, elements: [...sb.elements, element] },
          };
        });
      }
    });

    newSocket.on(
      'element-append-points',
      ({ id, boardId = 'main', newPoints }: { id: string; boardId?: string; newPoints: number[] }) => {
        incomingInk.add(boardId, id, newPoints);
      }
    );

    const applyBoardElementsTransform = (
      boardId: string,
      transform: (list: CanvasElement[]) => CanvasElement[]
    ) => {
      if (boardId === 'main') {
        setElements(transform);
      } else {
        setSubBoards((prev) => {
          const sb = prev[boardId];
          if (!sb) return prev;
          return {
            ...prev,
            [boardId]: { ...sb, elements: transform(sb.elements) },
          };
        });
      }
    };

    newSocket.on(
      'element-update',
      (patch: Partial<CanvasElement> & { id: string; boardId?: string; bringToFront?: boolean }) => {
        const bId = patch.boardId || 'main';
        const { bringToFront, ...cleanPatch } = patch;
        applyBoardElementsTransform(bId, (list) => {
          if (!bringToFront) {
            return list.map((el) => (el.id === cleanPatch.id ? { ...el, ...cleanPatch } : el));
          }
          const idx = list.findIndex((el) => el.id === cleanPatch.id);
          if (idx === -1) return list;
          const updated = { ...list[idx], ...cleanPatch };
          return [...list.slice(0, idx), ...list.slice(idx + 1), updated];
        });
      }
    );

    newSocket.on(
      'elements-batch-updated',
      ({
        boardId = 'main',
        updates,
        bringToFront = false,
      }: {
        boardId?: string;
        updates: Array<Partial<CanvasElement> & { id: string }>;
        bringToFront?: boolean;
      }) => {
        if (!Array.isArray(updates) || updates.length === 0) return;
        const map = new Map(updates.map((u) => [u.id, u]));
        applyBoardElementsTransform(boardId, (list) => {
          if (!bringToFront) {
            return list.map((el) => {
              const patch = map.get(el.id);
              return patch ? { ...el, ...patch } : el;
            });
          }
          const remaining: CanvasElement[] = [];
          const front: CanvasElement[] = [];
          for (const el of list) {
            const patch = map.get(el.id);
            if (patch) {
              front.push({ ...el, ...patch });
            } else {
              remaining.push(el);
            }
          }
          return [...remaining, ...front];
        });
      }
    );

    newSocket.on(
      'elements-batch-added',
      ({ boardId = 'main', elements: added }: { boardId?: string; elements: CanvasElement[] }) => {
        if (!Array.isArray(added) || added.length === 0) return;
        applyBoardElementsTransform(boardId, (list) => {
          const existingIds = new Set(list.map((e) => e.id));
          const toAppend = added.filter((e) => e && e.id && !existingIds.has(e.id));
          return toAppend.length > 0 ? [...list, ...toAppend] : list;
        });
      }
    );

    newSocket.on(
      'elements-batch-removed',
      ({ boardId = 'main', ids }: { boardId?: string; ids: string[] }) => {
        if (!Array.isArray(ids) || ids.length === 0) return;
        const idSet = new Set(ids);
        applyBoardElementsTransform(boardId, (list) => list.filter((el) => !idSet.has(el.id)));
      }
    );

    newSocket.on(
      'elements-replaced',
      ({ boardId = 'main', groups }: { boardId?: string; groups: ElementGroup<CanvasElement>[] }) => {
        if (!Array.isArray(groups) || groups.length === 0) return;
        applyBoardElementsTransform(boardId, (list) => applyElementGroups(list, groups));
      }
    );

    newSocket.on('element-removed', ({ id, boardId = 'main' }: { id: string; boardId?: string }) => {
      if (boardId === 'main') {
        setElements((prev) => prev.filter((el) => el.id !== id));
      } else {
        setSubBoards((prev) => {
          const sb = prev[boardId];
          if (!sb) return prev;
          return {
            ...prev,
            [boardId]: {
              ...sb,
              elements: sb.elements.filter((el) => el.id !== id),
            },
          };
        });
      }
    });

    newSocket.on(
      'state-sync',
      ({
        boardId = 'main',
        elements: syncedElements,
        messages: syncedMessages,
      }: { boardId?: string; elements: CanvasElement[]; messages?: ChatMessage[] }) => {
        if (!Array.isArray(syncedElements)) return;
        if (boardId === 'main') {
          setElements(syncedElements);
        } else {
          // Students only get a board's chat when they arrive on it (the server strips other boards' chat).
          setSubBoards((prev) => {
            const sb = prev[boardId];
            if (!sb) return prev;
            return {
              ...prev,
              [boardId]: {
                ...sb,
                elements: syncedElements,
                ...(Array.isArray(syncedMessages) ? { messages: syncedMessages } : {}),
              },
            };
          });
        }
      }
    );

    newSocket.on('board-full', ({ max }) => {
      window.alert(`This board is full (${max.toLocaleString()} items). Erase or clear some work to keep drawing.`);
    });

    // Teachers: boards we aren't viewing arrive as periodic digests of changed elements (see boardDigest.ts).
    newSocket.on('boards-digest', ({ boards }: { boards: BoardDigest<CanvasElement>[] }) => {
      if (!Array.isArray(boards) || boards.length === 0) return;
      const mainDigest = boards.find((d) => d.boardId === 'main');
      if (mainDigest) setElements((prev) => applyDigest(prev, mainDigest));
      const subDigests = boards.filter((d) => d.boardId !== 'main');
      if (subDigests.length > 0) {
        setSubBoards((prev) => {
          let next = prev;
          for (const d of subDigests) {
            const sb = next[d.boardId];
            if (!sb) continue;
            const elementsNext = applyDigest(sb.elements, d);
            if (elementsNext !== sb.elements) next = { ...next, [d.boardId]: { ...sb, elements: elementsNext } };
          }
          return next;
        });
      }
    });

    // The server sends each board's cursors as one batch every CURSOR_EMIT_MS, including our own (skipped here).
    newSocket.on('cursors-batch', ({ cursors }: { cursors: Omit<RemoteCursor, 'updatedAt'>[] }) => {
      const others = (cursors || []).filter((c) => c && c.userId && c.userId !== userId);
      if (others.length === 0) return;
      const now = Date.now();
      setRemoteCursors((prev) => {
        const next = { ...prev };
        for (const c of others) next[c.userId] = { ...c, updatedAt: now };
        return next;
      });
    });

    newSocket.on('cursor-leave', ({ userId: leftUserId }) => {
      setRemoteCursors((prev) => {
        const next = { ...prev };
        delete next[leftUserId];
        return next;
      });
    });

    return () => {
      outgoingInk.flush();
      if (outgoingInkRef.current === outgoingInk) outgoingInkRef.current = null;
      incomingInk.clear();
      newSocket.close();
    };
  }, [userId, userColor, liveRoomId]);

  // Teachers get live traffic only for the board they're looking at; tell the server whenever that changes
  // (and after every reconnect, since the server forgets per-socket state).
  useEffect(() => {
    if (!socket || !isTeacher) return;
    const announce = () => socket.emit('teacher:view-board', { boardId: activeBoardId });
    announce();
    socket.on('init', announce);
    return () => {
      socket.off('init', announce);
    };
  }, [socket, isTeacher, activeBoardId]);

  /** Emit a drawing event after any of our queued ink, so the server sees our actions in order. */
  const emitDrawing = useCallback(<E extends keyof ClientToServerEvents>(target: AppSocket, event: E, ...args: Parameters<ClientToServerEvents[E]>) => {
    outgoingInkRef.current?.flush();
    target.emit(event, ...args);
  }, []);

  const handleAuthenticateTeacher = useCallback(
    (pin: string): Promise<{ ok: boolean; error?: string; mode?: string }> => {
      return new Promise((resolve) => {
        if (!socket) {
          resolve({ ok: false, error: 'Not connected to server.' });
          return;
        }
        socket.emit('teacher:auth', { pin }, (response: { ok: boolean; error?: string; mode?: string; pin?: string }) => {
          if (response?.ok) {
            setIsTeacher(true);
            try {
              localStorage.setItem(STORAGE_KEYS.TEACHER_PIN_PREFIX + roomId, pin);
            } catch {
              // Ignore
            }
          }
          resolve(response || { ok: false, error: 'No response from server.' });
        });
      });
    },
    [socket, roomId]
  );

  const handleStepDownTeacher = useCallback(() => {
    setIsTeacher(false);
    try {
      localStorage.removeItem(STORAGE_KEYS.TEACHER_PIN_PREFIX + roomId);
    } catch {
      // Ignore
    }
    if (socket) {
      socket.emit('teacher:step-down');
    }
  }, [socket, roomId]);

  const handleConfigureBreakout = useCallback(
    (payload: ConfigureBreakoutPayload): Promise<{ ok: boolean; error?: string; roundId?: string }> => {
      return new Promise((resolve) => {
        if (!socket) {
          resolve({ ok: false, error: 'Not connected to server.' });
          return;
        }
        socket.emit('teacher:configure-breakout', payload, (res: { ok: boolean; error?: string; roundId?: string }) => {
          if (res?.ok && (payload.action === 'return-to-main' || payload.mode === 'main')) {
            setTeacherSelectedBoardId('main');
          }
          resolve(res || { ok: false, error: 'No response from server.' });
        });
      });
    },
    [socket]
  );

  const handleSpotlightBoard = useCallback((payload: SpotlightPayload): Promise<{ ok: boolean; error?: string }> => {
    return new Promise((resolve) => {
      if (!socket) return resolve({ ok: false, error: 'Not connected to server.' });
      socket.emit('teacher:spotlight-board', payload, (result: { ok: boolean; error?: string }) => {
        if (result?.ok) setTeacherSelectedBoardId('main');
        resolve(result || { ok: false, error: 'No response from server.' });
      });
    });
  }, [socket]);

  const handleAssignUserToBoard = useCallback(
    (targetBoardId: string, targetUserId?: string) => {
      if (socket) {
        socket.emit('breakout:join-board', { targetBoardId, targetUserId });
      }
    },
    [socket]
  );

  // Live Grid "Send worksheet…": one emit per variant; background-sync events update each board.
  const handleTeacherSendWorksheet = useCallback(
    (boardIds: string[], bg: RoomBackground | null, roundTemplateFor?: string) =>
      new Promise<{ ok: boolean; updated?: number; skipped?: string[]; error?: string }>((resolve) => {
        if (!socket) return resolve({ ok: false, error: 'Not connected to server.' });
        socket.emit(
          'teacher:set-background-multi',
          { boardIds, background: bg, roundTemplateFor },
          (res) => resolve(res || { ok: false, error: 'No response from server.' })
        );
      }),
    [socket]
  );

  const handleTeacherSetBackground = useCallback(
    (bg: RoomBackground | null): Promise<{ ok: boolean; error?: string }> => {
      return new Promise((resolve) => {
        if (!socket) {
          resolve({ ok: false, error: 'Not connected to server.' });
          return;
        }
        if (activeBoardId === 'main') {
          setBackground(bg);
        } else {
          setSubBoards((prev) => {
            const sb = prev[activeBoardId];
            if (!sb) return prev;
            return { ...prev, [activeBoardId]: { ...sb, background: bg } };
          });
        }
        socket.emit(
          'teacher:set-background',
          { boardId: activeBoardId, background: bg },
          (response: { ok: boolean; error?: string }) => {
            resolve(response || { ok: false, error: 'No response from server.' });
          }
        );
      });
    },
    [socket, activeBoardId]
  );

  const handleTeacherUpdateBackground = useCallback(
    (patch: Partial<RoomBackground>) => {
      if (activeBoardId === 'main') {
        setBackground((prev) => (prev ? { ...prev, ...patch } : prev));
      } else {
        setSubBoards((prev) => {
          const sb = prev[activeBoardId];
          if (!sb || !sb.background) return prev;
          return {
            ...prev,
            [activeBoardId]: { ...sb, background: { ...sb.background, ...patch } },
          };
        });
      }
      if (socket) {
        socket.emit('teacher:update-background', { boardId: activeBoardId, patch });
      }
    },
    [socket, activeBoardId]
  );

  const handleTeacherImportRoom = useCallback<RestoreClassWork>(
    async (snapshot, mode) => {
      if (!socket?.connected) {
        return { ok: false, connectionError: true, error: 'Reconnect to send the restore. Your selected file is ready.' };
      }
      try {
        const response = await socket.timeout(60_000).emitWithAck('teacher:import-room', { ...snapshot, mode });
        if (response && typeof response.ok === 'boolean') return response;
      } catch {
        // The server may have applied the snapshot before its acknowledgment was lost.
      }
      return {
        ok: false, connectionError: true,
        error: 'Restore unconfirmed. Check the board after reconnecting before you retry.',
      };
    },
    [socket]
  );

  const checkRoomAvailability = useCallback(
    (targetRoomId: string): Promise<RoomAvailability | null> => {
      return new Promise((resolve) => {
        if (!socket) {
          resolve(null);
          return;
        }
        let settled = false;
        let onConnect: (() => void) | undefined;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            if (onConnect) socket.off('connect', onConnect);
            resolve(null);
          }
        }, 2500);
        const emitCheck = () => {
          if (settled) return;
          socket.emit('check-room', { roomId: targetRoomId }, (res: RoomAvailability) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(res || null);
            }
          });
        };
        if (socket.connected) {
          emitCheck();
        } else {
          onConnect = emitCheck;
          socket.once('connect', emitCheck);
        }
      });
    },
    [socket]
  );

  const generateUnusedRoomCode = useCallback(async (): Promise<string> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateFreshRoomCode();
      const avail = await checkRoomAvailability(candidate);
      if (!avail || !avail.exists) {
        return candidate;
      }
    }
    return generateFreshRoomCode();
  }, [checkRoomAvailability]);

  /** Lesson packs: one ack-style wrapper for lesson and worksheet variant requests. */
  const handleTeacherLessonRequest = useCallback(
    <E extends LessonRequestEvent>(event: E, payload: Parameters<ClientToServerEvents[E]>[0], timeoutMs = 60_000): Promise<LessonResponse<E>> =>
      new Promise((resolve) => {
        if (!socket || !socket.connected) {
          resolve({ ok: false, error: 'Not connected to the server. Check your connection and try again.' } as LessonResponse<E>);
          return;
        }
        const timer = setTimeout(
          () => resolve({ ok: false, error: 'The server took too long to answer. Try again.' } as LessonResponse<E>),
          timeoutMs
        );
        const emit = socket.emit as (event: E, payload: Parameters<ClientToServerEvents[E]>[0], callback: (res: LessonResponse<E>) => void) => unknown;
        emit.call(socket, event, payload, (res) => {
          clearTimeout(timer);
          resolve(res && typeof res === 'object' ? res : { ok: false, error: 'No answer from the server.' } as LessonResponse<E>);
        });
      }),
    [socket]
  );

  const performSwitchRoom = useCallback((cleanedRoomId: string) => {
    setRemoteCursors({});
    setIsTeacher(false);
    setIsNameLocked(false);
    setKickNotice(null);
    setPendingPurgePrompt(null);
    setIsPurgingContributions(false);
    setTeacherSelectedBoardId('main');
    setRoomId(cleanedRoomId);
    try {
      if (isJoinedRef.current) {
        sessionStorage.setItem(STORAGE_KEYS.JOINED_ROOM_SESSION, cleanedRoomId);
      }
    } catch {
      // Ignore
    }
  }, []);

  /** This room's Teacher PIN as this browser saved it, to prefill the PIN for a new room. */
  const getSavedTeacherPin = useCallback((): string => {
    try {
      return localStorage.getItem(STORAGE_KEYS.TEACHER_PIN_PREFIX + effectiveRoomId) || '';
    } catch {
      return '';
    }
  }, [effectiveRoomId]);

  // "Something not working?" (issue #57, docs/REPORTS.md). Purely local until the reporter presses Send: it emits
  // nothing on the socket and changes no room state, so a class keeps going while someone fills it in.
  const [showProblemReport, setShowProblemReport] = useState<boolean>(false);
  const openProblemReport = useCallback(() => setShowProblemReport(true), []);
  const closeProblemReport = useCallback(() => setShowProblemReport(false), []);

  /** Only facts about the app and this device. Never names, room codes, PINs, chat, ink or worksheets. */
  const getReportDiagnostics = useCallback((): ReportDiagnostics => {
    const { browser, os } = describeUserAgent(typeof navigator !== 'undefined' ? navigator.userAgent : '');
    const diag: ReportDiagnostics = {
      browser,
      os,
      screen: typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : undefined,
      language: typeof navigator !== 'undefined' ? navigator.language : undefined,
      touch: typeof navigator !== 'undefined' ? navigator.maxTouchPoints > 0 : undefined,
      online: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
      page: isJoined ? 'room' : 'lobby',
      connection: !socket ? 'not started' : socket.connected ? 'connected' : 'disconnected',
      transport: socket?.io?.engine?.transport?.name,
    };
    if (isJoined) {
      diag.role = isTeacher ? 'teacher' : 'student';
      diag.breakoutMode = breakoutConfig.mode;
      diag.boardKind = activeBoardId === 'main' ? 'main' : subBoards[activeBoardId]?.kind || 'breakout';
      diag.worksheetPages = activeBackground?.pages?.length ?? 0;
      diag.itemsOnBoard = activeElements.length;
      diag.peopleInRoom = users.length;
      diag.canvasLocked = Boolean(roomSettings.isCanvasLocked);
      diag.chatHidden = isChatHidden;
    }
    return diag;
  }, [
    isJoined,
    socket,
    isTeacher,
    breakoutConfig.mode,
    activeBoardId,
    subBoards,
    activeBackground,
    activeElements,
    users,
    roomSettings.isCanvasLocked,
    isChatHidden,
  ]);

  /** Scrubbed out of the description before it's previewed or sent. The values themselves never leave the browser. */
  const reportRedactions = useMemo(() => {
    let savedPin = '';
    try {
      savedPin = localStorage.getItem(STORAGE_KEYS.TEACHER_PIN_PREFIX + effectiveRoomId) || '';
    } catch {
      savedPin = '';
    }
    return [
      // "main" is the default room and an everyday word, so it stays.
      effectiveRoomId === 'main' ? '' : roomId,
      effectiveRoomId === 'main' ? '' : effectiveRoomId,
      userName,
      savedPin,
      initialTeacherPin,
      ...users.map((u) => u.name),
      ...(roomSettings.bannedUsers || []).map((u) => u.name),
    ].filter((v): v is string => typeof v === 'string' && v.trim().length >= 2);
    // Recomputed when the dialog opens (showProblemReport), so a PIN saved since then is included.
  }, [roomId, effectiveRoomId, userName, initialTeacherPin, users, roomSettings.bannedUsers, showProblemReport]);

  const problemReportModal = showProblemReport ? (
    <ProblemReportModal
      getDiagnostics={getReportDiagnostics}
      redact={reportRedactions}
      onClose={closeProblemReport}
    />
  ) : null;

  /** After a lesson loads into a new room: remember its PIN (so the join makes us teacher there) and go there. */
  const handleOpenLoadedLessonRoom = useCallback(
    (newRoomId: string, pin: string) => {
      try {
        localStorage.setItem(STORAGE_KEYS.TEACHER_PIN_PREFIX + newRoomId, pin);
      } catch {
        // Ignore storage errors; the teacher can still enter the PIN.
      }
      recordRoomHistory(newRoomId);
      performSwitchRoom(newRoomId);
    },
    [performSwitchRoom]
  );

  const handleLeaveRoom = useCallback(() => {
    setIsJoined(false);
    setIsTeacher(false);
    setPendingPurgePrompt(null);
    try {
      localStorage.removeItem(STORAGE_KEYS.IS_JOINED);
      sessionStorage.removeItem(STORAGE_KEYS.JOINED_ROOM_SESSION);
    } catch {
      // Ignore
    }
  }, []);

  const performLobbyJoin = useCallback(
    (targetRoomId: string, trimmedName: string, cleanPin: string) => {
      setKickNotice(null);
      if (roomId !== targetRoomId) {
        setRoomId(targetRoomId);
      }
      try {
        localStorage.setItem(STORAGE_KEYS.USER_NAME, trimmedName);
        localStorage.setItem(STORAGE_KEYS.IS_JOINED, 'true');
        sessionStorage.setItem(STORAGE_KEYS.JOINED_ROOM_SESSION, targetRoomId);
        if (cleanPin.length >= 3) {
          localStorage.setItem(STORAGE_KEYS.TEACHER_PIN_PREFIX + targetRoomId, cleanPin);
        }
      } catch {
        // Ignore
      }
      setUserName(trimmedName);
      // Same room the socket is on: join now. Otherwise the socket reconnects for the new room and joins on connect.
      if (socket && targetRoomId === liveRoomId) {
        socket.emit('join-room', {
          roomId: targetRoomId,
          userId,
          userKey,
          name: trimmedName,
          color: userColor,
          teacherPin: cleanPin.length >= 3 ? cleanPin : undefined,
        });

        if (cleanPin.length >= 3) {
          socket.emit('teacher:auth', { pin: cleanPin }, (res) => {
            if (res?.ok) setIsTeacher(true);
          });
        }
      }
      setHasEditedLobbyRoom(false);
      setIsJoined(true);
    },
    [roomId, liveRoomId, socket, userId, userKey, userColor]
  );

  const handleSwitchRoom = useCallback(
    async (nextRoomRaw: string) => {
      const cleaned = normalizeClientRoomId(nextRoomRaw);
      if (cleaned === effectiveRoomId || isCheckingRoom) {
        return;
      }
      setIsCheckingRoom(true);
      try {
        const availability = await checkRoomAvailability(cleaned);
        if (availability?.exists) {
          setPendingRoomPrompt({
            source: 'switch',
            availability,
          });
          return;
        }
        performSwitchRoom(cleaned);
      } finally {
        setIsCheckingRoom(false);
      }
    },
    [effectiveRoomId, isCheckingRoom, checkRoomAvailability, performSwitchRoom]
  );

  const handleCreateNewRoom = useCallback(async () => {
    if (isCheckingRoom) return;
    setIsCheckingRoom(true);
    try {
      const freshRoom = await generateUnusedRoomCode();
      setHasEditedLobbyRoom(false);
      performSwitchRoom(freshRoom);
    } finally {
      setIsCheckingRoom(false);
    }
  }, [isCheckingRoom, generateUnusedRoomCode, performSwitchRoom]);

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = userName.trim();
    if (!trimmed || !socket || isCheckingRoom) return;

    const targetRoomId = effectiveRoomId;
    const cleanPin = initialTeacherPin.trim();
    if (cleanPin && cleanPin.length < MIN_TEACHER_PIN_LENGTH) {
      setKickNotice(`Teacher PIN must be at least ${MIN_TEACHER_PIN_LENGTH} characters.`);
      return;
    }
    const shouldWarnIfExists = hasEditedLobbyRoom || (!hadInitialUrlRoom && showTeacherSetupOnJoin);

    if (shouldWarnIfExists) {
      setIsCheckingRoom(true);
      try {
        const availability = await checkRoomAvailability(targetRoomId);
        if (availability?.exists) {
          setPendingRoomPrompt({
            source: 'lobby',
            availability,
            userName: trimmed,
            teacherPin: cleanPin,
          });
          return;
        }
      } finally {
        setIsCheckingRoom(false);
      }
    }

    performLobbyJoin(targetRoomId, trimmed, cleanPin);
  };

  /**
   * Lobby "New Room": make the room typed in the Room Code box (a random unused code when it's empty) and join it.
   * When a room with that code already exists, the same "room already exists" choice as Join comes up, so a
   * "new" room never quietly lands you in someone else's.
   */
  const handleLobbyNewRoom = async () => {
    if (!socket || isCheckingRoom) return;
    const trimmed = userName.trim();
    if (!trimmed) {
      setKickNotice('Type your name first, then press New Room.');
      displayNameInputRef.current?.focus();
      return;
    }
    const cleanPin = initialTeacherPin.trim();
    if (cleanPin && cleanPin.length < MIN_TEACHER_PIN_LENGTH) {
      setKickNotice(`Teacher PIN must be at least ${MIN_TEACHER_PIN_LENGTH} characters.`);
      return;
    }
    const typed = roomId.replace(/^-|-$/g, '').trim();
    setIsCheckingRoom(true);
    try {
      if (!typed) {
        performLobbyJoin(await generateUnusedRoomCode(), trimmed, cleanPin);
        return;
      }
      const target = normalizeRoomCode(typed);
      const availability = await checkRoomAvailability(target);
      if (availability?.exists) {
        setPendingRoomPrompt({ source: 'lobby', availability, userName: trimmed, teacherPin: cleanPin });
        return;
      }
      performLobbyJoin(target, trimmed, cleanPin);
    } finally {
      setIsCheckingRoom(false);
    }
  };

  const handleCancelRoomPrompt = useCallback(() => {
    if (!isCheckingRoom) {
      setPendingRoomPrompt(null);
    }
  }, [isCheckingRoom]);

  const handleConfirmJoinAnyway = useCallback(() => {
    if (!pendingRoomPrompt || isCheckingRoom) return;
    const prompt = pendingRoomPrompt;
    setPendingRoomPrompt(null);
    if (prompt.source === 'switch') {
      performSwitchRoom(prompt.availability.roomId);
    } else {
      performLobbyJoin(
        prompt.availability.roomId,
        prompt.userName || userName.trim(),
        prompt.teacherPin || ''
      );
    }
  }, [pendingRoomPrompt, isCheckingRoom, performSwitchRoom, performLobbyJoin, userName]);

  const handleConfirmCreateFreshRoom = useCallback(async () => {
    if (!pendingRoomPrompt || isCheckingRoom) return;
    const prompt = pendingRoomPrompt;
    setIsCheckingRoom(true);
    try {
      const freshRoom = await generateUnusedRoomCode();
      setPendingRoomPrompt(null);
      if (prompt.source === 'switch') {
        setHasEditedLobbyRoom(false);
        performSwitchRoom(freshRoom);
      } else {
        performLobbyJoin(freshRoom, prompt.userName || userName.trim(), prompt.teacherPin || '');
      }
    } finally {
      setIsCheckingRoom(false);
    }
  }, [pendingRoomPrompt, isCheckingRoom, generateUnusedRoomCode, performSwitchRoom, performLobbyJoin, userName]);

  const handleCustomRoomFromModal = useCallback(
    async (customRoomRaw: string) => {
      if (!pendingRoomPrompt || isCheckingRoom) return;
      const cleaned = normalizeRoomCode(customRoomRaw);
      const prompt = pendingRoomPrompt;
      setIsCheckingRoom(true);
      try {
        const availability = await checkRoomAvailability(cleaned);
        if (availability?.exists) {
          setPendingRoomPrompt({
            ...prompt,
            availability,
          });
          return;
        }
        setPendingRoomPrompt(null);
        if (prompt.source === 'switch') {
          setHasEditedLobbyRoom(false);
          performSwitchRoom(cleaned);
        } else {
          performLobbyJoin(cleaned, prompt.userName || userName.trim(), prompt.teacherPin || '');
        }
      } finally {
        setIsCheckingRoom(false);
      }
    },
    [pendingRoomPrompt, isCheckingRoom, checkRoomAvailability, performSwitchRoom, performLobbyJoin, userName]
  );

  const handleUpdateName = useCallback(
    (newName: string) => {
      if (isNameLocked && !isTeacher) return;
      setUserName(newName);
      try {
        localStorage.setItem(STORAGE_KEYS.USER_NAME, newName);
      } catch {
        // Ignore
      }
      if (socket) {
        socket.emit('update-profile', {
          userId,
          name: newName,
          color: userColor,
        });
      }
    },
    [socket, userId, userColor, isNameLocked, isTeacher]
  );

  const handleTeacherRenameUser = useCallback(
    (targetUserId: string, newName: string) => {
      const cleanName = newName.trim();
      if (!socket || !targetUserId || !cleanName) return;
      socket.emit('teacher:rename-user', { targetUserId, newName: cleanName });
    },
    [socket]
  );

  const handleTeacherDeleteMessage = useCallback(
    (messageId: string) => {
      if (!socket || !messageId) return;
      const targetBoardId =
        breakoutConfig.chatScope === 'board' ? activeBoardId : 'main';
      socket.emit('teacher:delete-message', { messageId, boardId: targetBoardId });
    },
    [socket, breakoutConfig.chatScope, activeBoardId]
  );

  const handleTeacherKickUser = useCallback(
    (targetUserId: string, mode: 'kick' | 'ban', targetName?: string) => {
      if (!socket || !targetUserId) return;
      setPendingPurgePrompt({
        targetUserId,
        targetName: targetName || 'Student',
        mode,
      });
      socket.emit(
        'teacher:kick-user',
        { targetUserId, mode, targetName },
        (res?: { ok?: boolean }) => {
          if (res && res.ok === false) {
            setPendingPurgePrompt((prev) =>
              prev?.targetUserId === targetUserId ? null : prev
            );
          }
        }
      );
    },
    [socket]
  );

  const handleCancelPurgeContributions = useCallback(() => {
    if (!isPurgingContributions) {
      setPendingPurgePrompt(null);
    }
  }, [isPurgingContributions]);

  const handleConfirmPurgeContributions = useCallback(() => {
    if (!socket || !pendingPurgePrompt || isPurgingContributions) return;
    const { targetUserId } = pendingPurgePrompt;
    if (!socket.connected) {
      setPendingPurgePrompt(null);
      return;
    }
    setIsPurgingContributions(true);
    emitDrawing(
      socket,
      'teacher:purge-user-contributions',
      { targetUserId },
      () => {
        setIsPurgingContributions(false);
        setPendingPurgePrompt(null);
      }
    );
  }, [socket, pendingPurgePrompt, isPurgingContributions]);

  const purgeContributionCounts = useMemo(() => {
    if (!pendingPurgePrompt) {
      return { drawingCount: 0, messageCount: 0 };
    }
    const uid = pendingPurgePrompt.targetUserId;
    let drawingCount = elements.filter((el) => el.userId === uid).length;
    let messageCount = messages.filter((m) => m.userId === uid).length;
    for (const sb of Object.values(subBoards) as SubBoardData[]) {
      drawingCount += sb.elements.filter((el) => el.userId === uid).length;
      messageCount += sb.messages.filter((m) => m.userId === uid).length;
    }
    return { drawingCount, messageCount };
  }, [pendingPurgePrompt, elements, messages, subBoards]);

  const handleTeacherUnbanUser = useCallback(
    (targetUserId: string) => {
      if (!socket || !targetUserId) return;
      socket.emit('teacher:unban-user', { targetUserId });
    },
    [socket]
  );

  const sendMessage = useCallback(
    (text: string) => {
      if (socket) {
        const targetBoardId =
          breakoutConfig.chatScope === 'board' ? activeBoardId : 'main';
        socket.emit('chat-message', {
          boardId: targetBoardId,
          userId,
          userName,
          userColor,
          isTeacher,
          text,
        });
      }
    },
    [socket, breakoutConfig.chatScope, activeBoardId, userId, userName, userColor, isTeacher]
  );

  const handleElementStart = useCallback(
    (element: CanvasElement) => {
      const withBoard = { ...element, boardId: activeBoardId };
      if (activeBoardId === 'main') {
        setElements((prev) => [...prev, withBoard]);
      } else {
        setSubBoards((prev) => {
          const sb = prev[activeBoardId];
          if (!sb) return prev;
          return {
            ...prev,
            [activeBoardId]: { ...sb, elements: [...sb.elements, withBoard] },
          };
        });
      }
      if (socket) {
        emitDrawing(socket, 'element-start', withBoard);
      }
    },
    [socket, activeBoardId]
  );

  const handleElementAppendPoints = useCallback(
    (id: string, newPoints: number[]) => {
      if (activeBoardId === 'main') {
        setElements((prev) =>
          prev.map((el) =>
            el.id === id && Array.isArray(el.points)
              ? { ...el, points: [...el.points, ...newPoints] }
              : el
          )
        );
      } else {
        setSubBoards((prev) => {
          const sb = prev[activeBoardId];
          if (!sb) return prev;
          return {
            ...prev,
            [activeBoardId]: {
              ...sb,
              elements: sb.elements.map((el) =>
                el.id === id && Array.isArray(el.points)
                  ? { ...el, points: [...el.points, ...newPoints] }
                  : el
              ),
            },
          };
        });
      }
      if (socket) {
        outgoingInkRef.current?.add(activeBoardId, id, newPoints);
      }
    },
    [socket, activeBoardId]
  );

  const updateActiveBoardElements = useCallback(
    (transform: (list: CanvasElement[]) => CanvasElement[]) => {
      if (activeBoardId === 'main') {
        setElements(transform);
      } else {
        setSubBoards((prev) => {
          const sb = prev[activeBoardId];
          if (!sb) return prev;
          return {
            ...prev,
            [activeBoardId]: { ...sb, elements: transform(sb.elements) },
          };
        });
      }
    },
    [activeBoardId]
  );

  const handleElementUpdate = useCallback(
    (patch: Partial<CanvasElement> & { id: string; bringToFront?: boolean }) => {
      const { bringToFront, ...cleanPatch } = patch;
      updateActiveBoardElements((list) => {
        if (!bringToFront) {
          return list.map((el) => (el.id === cleanPatch.id ? { ...el, ...cleanPatch } : el));
        }
        const idx = list.findIndex((el) => el.id === cleanPatch.id);
        if (idx === -1) return list;
        const updated = { ...list[idx], ...cleanPatch };
        return [...list.slice(0, idx), ...list.slice(idx + 1), updated];
      });
      if (socket) {
        emitDrawing(socket, 'element-update', {
          ...cleanPatch,
          boardId: activeBoardId,
          bringToFront: Boolean(bringToFront),
        });
      }
    },
    [socket, activeBoardId, updateActiveBoardElements]
  );

  const handleElementsBatchUpdate = useCallback(
    (updates: Array<Partial<CanvasElement> & { id: string }>, bringToFront = false) => {
      if (!updates || updates.length === 0) return;
      const map = new Map(updates.map((u) => [u.id, u]));
      updateActiveBoardElements((list) => {
        if (!bringToFront) {
          return list.map((el) => {
            const patch = map.get(el.id);
            return patch ? { ...el, ...patch } : el;
          });
        }
        const remaining: CanvasElement[] = [];
        const front: CanvasElement[] = [];
        for (const el of list) {
          const patch = map.get(el.id);
          if (patch) {
            front.push({ ...el, ...patch });
          } else {
            remaining.push(el);
          }
        }
        return [...remaining, ...front];
      });
      if (socket) {
        emitDrawing(socket, 'elements-batch-update', { boardId: activeBoardId, updates, bringToFront });
      }
    },
    [socket, activeBoardId, updateActiveBoardElements]
  );

  const handleElementsBatchAdd = useCallback(
    (newElements: CanvasElement[], targetBoardId?: string) => {
      if (!newElements || newElements.length === 0) return;
      const destBoardId = targetBoardId || activeBoardId;
      const normalized = newElements.map((el) => ({
        ...el,
        boardId: destBoardId === 'ALL_SUBBOARDS' ? el.boardId : destBoardId,
      }));
      if (destBoardId === activeBoardId) {
        updateActiveBoardElements((list) => {
          const existingIds = new Set(list.map((e) => e.id));
          const toAppend = normalized.filter((e) => !existingIds.has(e.id));
          return toAppend.length > 0 ? [...list, ...toAppend] : list;
        });
      } else if (destBoardId !== 'ALL_SUBBOARDS') {
        if (destBoardId === 'main') {
          setElements((list) => {
            const existingIds = new Set(list.map((e) => e.id));
            const toAppend = normalized.filter((e) => !existingIds.has(e.id));
            return toAppend.length > 0 ? [...list, ...toAppend] : list;
          });
        } else {
          setSubBoards((prev) => {
            const sb = prev[destBoardId];
            if (!sb) return prev;
            const existingIds = new Set(sb.elements.map((e) => e.id));
            const toAppend = normalized.filter((e) => !existingIds.has(e.id));
            return toAppend.length > 0
              ? { ...prev, [destBoardId]: { ...sb, elements: [...sb.elements, ...toAppend] } }
              : prev;
          });
        }
      }
      if (socket) {
        emitDrawing(socket, 'elements-batch-add', { boardId: destBoardId, elements: normalized });
      }
    },
    [socket, activeBoardId, updateActiveBoardElements]
  );

  const handleElementsBatchRemove = useCallback(
    (ids: string[]) => {
      if (!ids || ids.length === 0) return;
      const idSet = new Set(ids);
      updateActiveBoardElements((list) => list.filter((el) => !idSet.has(el.id)));
      if (socket) {
        emitDrawing(socket, 'elements-batch-remove', { boardId: activeBoardId, ids });
      }
    },
    [socket, activeBoardId, updateActiveBoardElements]
  );

  /** Edits that keep stacking order (eraser split/remove and its undo). See src/lib/elementGroups.ts. */
  const handleElementsReplace = useCallback(
    (groups: ElementGroup<CanvasElement>[]) => {
      if (!groups || groups.length === 0) return;
      const normalized = groups.map((g) => ({
        ...g,
        elements: g.elements.map((el) => ({ ...el, boardId: activeBoardId })),
      }));
      updateActiveBoardElements((list) => applyElementGroups(list, normalized));
      if (socket) {
        emitDrawing(socket, 'elements-replace', { boardId: activeBoardId, groups: normalized });
      }
    },
    [socket, activeBoardId, updateActiveBoardElements, emitDrawing]
  );

  const handleElementRemove = useCallback(
    (id: string) => {
      if (activeBoardId === 'main') {
        setElements((prev) => prev.filter((el) => el.id !== id));
      } else {
        setSubBoards((prev) => {
          const sb = prev[activeBoardId];
          if (!sb) return prev;
          return {
            ...prev,
            [activeBoardId]: {
              ...sb,
              elements: sb.elements.filter((el) => el.id !== id),
            },
          };
        });
      }
      if (socket) {
        emitDrawing(socket, 'element-remove', { id, boardId: activeBoardId });
      }
    },
    [socket, activeBoardId]
  );

  const handleCursorMove = useCallback(
    (cursor: Omit<RemoteCursor, 'updatedAt'>) => {
      if (socket) {
        socket.emit('cursor-move', cursor);
      }
    },
    [socket]
  );

  const handleUndo = useCallback(() => {
    if (socket) {
      emitDrawing(socket, 'undo', { userId, boardId: activeBoardId });
    }
  }, [socket, userId, activeBoardId]);

  const handleClearMine = useCallback(() => {
    if (socket) {
      emitDrawing(socket, 'clear-user-drawings', { targetUserId: userId, boardId: activeBoardId });
    }
  }, [socket, userId, activeBoardId]);

  const handleClearUserDrawings = useCallback(
    (targetUserId: string) => {
      if (socket) {
        emitDrawing(socket, 'clear-user-drawings', { targetUserId, boardId: activeBoardId });
      }
    },
    [socket, activeBoardId]
  );

  const handleTeacherToggleLock = useCallback(
    (locked: boolean) => {
      if (socket) {
        socket.emit('teacher:set-lock', locked);
      }
    },
    [socket]
  );

  const handleTeacherToggleHideCursors = useCallback((hide: boolean) => {
    socket?.emit('teacher:set-hide-cursors', hide);
  }, [socket]);

  const handleTeacherToggleOneNameStamp = useCallback((enabled: boolean) => {
    socket?.emit('teacher:set-one-name-stamp', enabled);
  }, [socket]);

  const handleSetStatus = useCallback((status: StudentStatus) => {
    socket?.emit('user:set-status', { status });
  }, [socket]);
  const handleClearStatus = useCallback((targetUserId?: string) => {
    socket?.emit('teacher:clear-status', { targetUserId });
  }, [socket]);

  const handleTeacherClearAll = useCallback(() => {
    if (socket) {
      emitDrawing(socket, 'teacher:clear-all', { boardId: activeBoardId });
    }
  }, [socket, activeBoardId]);

  const handleTeacherTimerControl = useCallback(
    (payload: TimerControlPayload) => {
      if (socket) {
        socket.emit('teacher:timer-control', payload);
      }
    },
    [socket]
  );

  if (!isJoined) {
    return (
      <div
        className="min-h-screen flex items-center justify-center p-4"
        style={{
          backgroundColor: '#f8fafc',
          backgroundImage: 'radial-gradient(#cbd5e1 1.25px, transparent 1.25px)',
          backgroundSize: '28px 28px',
        }}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.14 }}
          className="bg-white border-2 border-[#CBD5E1] rounded-[3px] w-full max-w-md"
        >
          <div className="oh-panel-header px-5 py-3 border-b border-[#CBD5E1] flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <img
                src="/assets/aistudio/favicon_68cc1684.svg"
                alt="AllAboard"
                referrerPolicy="no-referrer"
                className="w-6 h-6 rounded-[2px] border border-[#CBD5E1] shrink-0 object-contain"
              />
              <h1 className="font-display text-base font-bold tracking-tight text-slate-900 truncate">
                AllAboard
              </h1>
            </div>
            <span className="px-2 py-0.5 rounded-[2px] bg-brand-50 border border-brand-200 font-mono text-xs font-semibold text-brand-800 truncate max-w-[12rem]">
              #{effectiveRoomId}
            </span>
          </div>

          <form onSubmit={handleJoin} autoComplete="off">
            <div className="p-5 space-y-4">
              {kickNotice && (
                <div className="p-3 rounded-[3px] bg-red-50 border border-red-200 text-xs text-red-800 leading-relaxed">
                  {kickNotice}
                </div>
              )}

              <div>
                <label
                  htmlFor="display-name-input"
                  className="block text-xs font-semibold text-slate-700 mb-1.5"
                >
                  Your Display Name
                </label>
                <input
                  ref={displayNameInputRef}
                  id="display-name-input"
                  type="text"
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  placeholder="e.g. Alex"
                  autoFocus
                  maxLength={28}
                  className="w-full px-3 py-2 bg-white border border-[#CBD5E1] rounded-[2px] text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none transition-colors"
                />
              </div>

              <div>
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <label
                    htmlFor="lobby-room-code-input"
                    className="text-xs font-semibold text-slate-700"
                  >
                    Room Code
                  </label>
                  <RoomHistoryDropdown
                    theme="light"
                    align="right"
                    disabled={isCheckingRoom}
                    historyVersion={historyVersion}
                    hintText="Click a room to fill its code, then join."
                    onSelectRoom={(code) => {
                      setKickNotice(null);
                      setHasEditedLobbyRoom(true);
                      setRoomId(code);
                      if (showTeacherSetupOnJoin) {
                        teacherPinInputRef.current?.focus();
                      } else if (!userName.trim()) {
                        displayNameInputRef.current?.focus();
                      }
                    }}
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    ref={roomCodeInputRef}
                    id="lobby-room-code-input"
                    aria-label="Room Code"
                    type="text"
                    value={roomId}
                    placeholder="main"
                    onChange={(e) => {
                      setKickNotice(null);
                      setHasEditedLobbyRoom(true);
                      setRoomId(sanitizeRoomCodeDraft(e.target.value));
                    }}
                    onBlur={() => {
                      setRoomId((prev) => prev.replace(/^-|-$/g, ''));
                    }}
                    maxLength={24}
                    className="flex-1 min-w-0 px-3 py-1.5 bg-white border border-[#CBD5E1] rounded-[2px] font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-brand-600"
                  />
                  <button
                    type="button"
                    disabled={isCheckingRoom}
                    onClick={handleLobbyNewRoom}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-[2px] border oh-btn text-brand-700 text-xs font-medium whitespace-nowrap cursor-pointer disabled:opacity-50 transition-colors shrink-0"
                    title="Make a new room with the code you typed (a random one if the box is empty) and go in"
                  >
                    <PlusCircle size={13} />
                    <span>New Room</span>
                  </button>
                  <button
                    type="button"
                    disabled={isCheckingRoom}
                    onClick={handleCreateNewRoom}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-[2px] border oh-btn text-slate-700 text-xs font-medium whitespace-nowrap cursor-pointer disabled:opacity-50 transition-colors shrink-0"
                    title="Fill the box with a random unused room code"
                  >
                    <Shuffle size={12} />
                    <span>Random</span>
                  </button>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-200">
                {showTeacherSetupOnJoin ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label
                        htmlFor="teacher-pin-input"
                        className="text-xs font-semibold text-amber-800 flex items-center gap-1.5"
                      >
                        <KeyRound size={13} className="text-amber-600" />
                        <span>Set or Enter Room Teacher PIN</span>
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          setShowTeacherSetupOnJoin(false);
                          setInitialTeacherPin('');
                          setShowInitialTeacherPin(false);
                        }}
                        className="text-[11px] text-slate-500 hover:text-slate-800 cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                    <div className="relative">
                      <input
                        ref={teacherPinInputRef}
                        id="teacher-pin-input"
                        type="text"
                        value={initialTeacherPin}
                        onChange={(e) => setInitialTeacherPin(e.target.value)}
                        placeholder="Choose a 4+ digit PIN (e.g. 4829)"
                        maxLength={16}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        data-lpignore="true"
                        data-1p-ignore="true"
                        className={`w-full pl-3 pr-9 py-1.5 bg-slate-50 border border-[#CBD5E1] rounded-[2px] text-xs text-slate-900 font-mono placeholder:text-slate-400 focus:bg-white focus:outline-none focus:border-amber-500${
                          showInitialTeacherPin ? '' : ' pin-masked'
                        }`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowInitialTeacherPin((v) => !v)}
                        aria-label={showInitialTeacherPin ? 'Hide Teacher PIN' : 'Show Teacher PIN'}
                        title={showInitialTeacherPin ? 'Hide PIN' : 'Show PIN'}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
                      >
                        {showInitialTeacherPin ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                    <p className="text-[11px] text-slate-500 leading-snug">
                      The first person to set a PIN in a room locks Teacher Mode so students cannot click it.
                    </p>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowTeacherSetupOnJoin(true)}
                    className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <KeyRound size={12} />
                    <span>Instructor? Set or enter a room Teacher PIN</span>
                  </button>
                )}
              </div>
            </div>

            <div className="oh-panel-header px-5 py-3 border-t border-[#CBD5E1]">
              <button
                type="submit"
                disabled={!userName.trim() || isCheckingRoom}
                className={`w-full py-2 px-4 text-sm font-semibold rounded-[2px] border transition-colors flex items-center justify-center gap-2 ${
                  !userName.trim() || isCheckingRoom
                    ? 'bg-slate-100 border-[#CBD5E1] text-slate-400 cursor-not-allowed'
                    : 'oh-btn-primary text-white cursor-pointer'
                }`}
              >
                <LogIn size={16} />
                <span>{isCheckingRoom ? 'Checking Room...' : 'Join Classroom'}</span>
              </button>
            </div>
          </form>
        </motion.div>

        <button
          type="button"
          onClick={openProblemReport}
          className="fixed bottom-3 right-3 flex items-center gap-1.5 px-2.5 py-1.5 rounded-[2px] border oh-btn bg-white text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
        >
          <LifeBuoy size={13} />
          <span>Something not working?</span>
        </button>

        {pendingRoomPrompt && (
          <RoomExistsModal
            availability={pendingRoomPrompt.availability}
            isJoiningAsTeacher={Boolean(
              pendingRoomPrompt.teacherPin && pendingRoomPrompt.teacherPin.length >= 3
            )}
            isBusy={isCheckingRoom}
            onJoinAnyway={handleConfirmJoinAnyway}
            onCreateFreshRoom={handleConfirmCreateFreshRoom}
            onSwitchToCustomRoom={handleCustomRoomFromModal}
            onCancel={handleCancelRoomPrompt}
          />
        )}

        {problemReportModal}
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-slate-100 overflow-hidden font-sans">
      {!isChatHidden && (
        <Chat
          roomId={roomId}
          historyVersion={historyVersion}
          hasTeacherPin={roomSettings.hasTeacherPin}
          messages={activeMessages}
          users={users}
          elements={activeElements}
          onSendMessage={sendMessage}
          userId={userId}
          userName={userName}
          userColor={userColor}
          isTeacher={isTeacher}
          isNameLocked={isNameLocked}
          bannedUsers={roomSettings.bannedUsers || []}
          onAuthenticateTeacher={handleAuthenticateTeacher}
          onStepDownTeacher={handleStepDownTeacher}
          onCreateNewRoom={handleCreateNewRoom}
          onSwitchRoom={handleSwitchRoom}
          onLeaveRoom={handleLeaveRoom}
          onUpdateName={handleUpdateName}
          onClearUserDrawings={handleClearUserDrawings}
          onTeacherRenameUser={handleTeacherRenameUser}
          onTeacherDeleteMessage={handleTeacherDeleteMessage}
          onTeacherKickUser={handleTeacherKickUser}
          onTeacherUnbanUser={handleTeacherUnbanUser}
          onTeacherClearStatus={handleClearStatus}
          onReportProblem={openProblemReport}
          width={chatWidth}
          onWidthChange={setChatWidth}
          onResetWidth={() =>
            setChatWidth(
              clampChatWidth(
                DEFAULT_CHAT_WIDTH,
                typeof window !== 'undefined' ? window.innerWidth : undefined
              )
            )
          }
          onHideChat={() => {
            setIsChatHidden(true);
            storeChatHiddenChoice(window.localStorage, true);
          }}
        />
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <Canvas
          roomId={roomId}
          activeBoardId={activeBoardId}
          activeBoardTitle={activeBoardTitle}
          elements={activeElements}
          messages={activeMessages}
          background={activeBackground}
          subBoards={subBoards}
          breakoutConfig={breakoutConfig}
          roundTemplates={roundTemplates}
          roundTemplateInk={roundTemplateInk}
          roundVariants={roundVariants}
          users={users}
          remoteCursors={remoteCursors}
          laserSocket={socket}
          onSetStatus={handleSetStatus}
          onTeacherClearStatus={handleClearStatus}
          isCanvasLocked={roomSettings.isCanvasLocked}
          hideStudentCursors={Boolean(roomSettings.hideStudentCursors)}
          oneNameStamp={Boolean(roomSettings.oneNameStamp)}
          hasTeacherPin={roomSettings.hasTeacherPin}
          isTeacher={isTeacher}
          userId={userId}
          userName={userName}
          userColor={userColor}
          onSelectBoard={setTeacherSelectedBoardId}
          onConfigureBreakout={handleConfigureBreakout}
          onSpotlightBoard={handleSpotlightBoard}
          onAssignUserToBoard={handleAssignUserToBoard}
          onElementStart={handleElementStart}
          onElementAppendPoints={handleElementAppendPoints}
          onElementUpdate={handleElementUpdate}
          onElementRemove={handleElementRemove}
          onElementsBatchUpdate={handleElementsBatchUpdate}
          onElementsBatchAdd={handleElementsBatchAdd}
          onElementsBatchRemove={handleElementsBatchRemove}
          onElementsReplace={handleElementsReplace}
          onCursorMove={handleCursorMove}
          onUndo={handleUndo}
          onClearMine={handleClearMine}
          onTeacherToggleLock={handleTeacherToggleLock}
          onTeacherToggleHideCursors={handleTeacherToggleHideCursors}
          onTeacherToggleOneNameStamp={handleTeacherToggleOneNameStamp}
          onTeacherClearAll={handleTeacherClearAll}
          onTeacherSetBackground={handleTeacherSetBackground}
          onTeacherSendWorksheet={handleTeacherSendWorksheet}
          onTeacherUpdateBackground={handleTeacherUpdateBackground}
          onTeacherImportRoom={handleTeacherImportRoom}
          onTeacherLessonRequest={handleTeacherLessonRequest}
          onOpenLoadedLessonRoom={handleOpenLoadedLessonRoom}
          getSavedTeacherPin={getSavedTeacherPin}
          generateUnusedRoomCode={generateUnusedRoomCode}
          timer={roomSettings.timer}
          onTeacherTimerControl={handleTeacherTimerControl}
          fullMainElements={elements}
          fullMainMessages={messages}
          fullMainBackground={background}
          isChatHidden={isChatHidden}
          onReportProblem={openProblemReport}
          unreadChatCount={unreadChatCount}
          onShowChat={() => {
            setIsChatHidden(false);
            storeChatHiddenChoice(window.localStorage, false);
          }}
        />
      </div>

      {pendingRoomPrompt && (
        <RoomExistsModal
          availability={pendingRoomPrompt.availability}
          isJoiningAsTeacher={Boolean(
            pendingRoomPrompt.teacherPin && pendingRoomPrompt.teacherPin.length >= 3
          )}
          isBusy={isCheckingRoom}
          onJoinAnyway={handleConfirmJoinAnyway}
          onCreateFreshRoom={handleConfirmCreateFreshRoom}
          onSwitchToCustomRoom={handleCustomRoomFromModal}
          onCancel={handleCancelRoomPrompt}
        />
      )}

      {pendingPurgePrompt && (
        <PurgeContributionsModal
          targetName={pendingPurgePrompt.targetName}
          actionMode={pendingPurgePrompt.mode}
          drawingCount={purgeContributionCounts.drawingCount}
          messageCount={purgeContributionCounts.messageCount}
          isBusy={isPurgingContributions}
          onConfirmDelete={handleConfirmPurgeContributions}
          onCancel={handleCancelPurgeContributions}
        />
      )}

      {problemReportModal}
    </div>
  );
}
