import React, { useCallback, useMemo, useState } from 'react';
import type { LessonResponse } from '../components/LessonPackModals';
import { STORAGE_KEYS, generateFreshRoomCode } from '../lib/identity';
import type { LessonRequestEvent } from '../lib/lessonPack';
import { describeUserAgent, type ReportDiagnostics } from '../lib/problemReport';
import { normalizeRoomCode } from '../lib/roomCode';
import { recordRoomHistory } from '../lib/roomHistory';
import type { ClientToServerEvents } from '../lib/socketContract';
import { MIN_TEACHER_PIN_LENGTH } from '../lib/teacherPin';
import {
  BreakoutConfig,
  CanvasElement,
  ChatMessage,
  ConfigureBreakoutPayload,
  RemoteCursor,
  RoomAvailability,
  RoomBackground,
  RoomSettings,
  SpotlightPayload,
  StudentStatus,
  SubBoardData,
  TimerControlPayload,
  User,
  type RestoreClassWork,
} from '../types';

import type { useRoomSocket } from './useRoomSocket';
type Setter<T> = React.Dispatch<React.SetStateAction<T>>;
type RoomPrompt = {
  source: 'lobby' | 'switch';
  availability: RoomAvailability;
  userName?: string;
  teacherPin?: string;
};
type PurgePrompt = { targetUserId: string; targetName: string; mode: 'kick' | 'ban' };

/** The live socket and the drawing emitter from `useRoomSocket`. */
export interface ClassroomConnection {
  socket: ReturnType<typeof useRoomSocket>['socket'];
  emitDrawing: ReturnType<typeof useRoomSocket>['emitDrawing'];
}

/** Room and user values the actions read. */
export interface ClassroomRoomState {
  activeBoardId: string;
  userId: string;
  roomId: string;
  effectiveRoomId: string;
  isJoined: boolean;
  isTeacher: boolean;
  breakoutConfig: BreakoutConfig;
  subBoards: Record<string, SubBoardData>;
  activeBackground: RoomBackground | null;
  activeElements: CanvasElement[];
  users: User[];
  roomSettings: RoomSettings;
  isChatHidden: boolean;
  userName: string;
  liveRoomId: string;
  userKey: string;
  userColor: string;
  isNameLocked: boolean;
  elements: CanvasElement[];
  messages: ChatMessage[];
}

/** `App` state setters the actions write. */
export interface ClassroomRoomSetters {
  setSubBoards: Setter<Record<string, SubBoardData>>;
  setIsTeacher: Setter<boolean>;
  setTeacherSelectedBoardId: Setter<string>;
  setBackground: Setter<RoomBackground | null>;
  setRemoteCursors: Setter<Record<string, RemoteCursor>>;
  setIsNameLocked: Setter<boolean>;
  setKickNotice: Setter<string | null>;
  setPendingPurgePrompt: Setter<PurgePrompt | null>;
  setIsPurgingContributions: Setter<boolean>;
  setRoomId: Setter<string>;
  setIsJoined: Setter<boolean>;
  setUserName: Setter<string>;
  setHasEditedLobbyRoom: Setter<boolean>;
  setIsCheckingRoom: Setter<boolean>;
  setPendingRoomPrompt: Setter<RoomPrompt | null>;
}

/** Lobby form values, refs and pending prompts. */
export interface ClassroomLobby {
  initialTeacherPin: string;
  hasEditedLobbyRoom: boolean;
  isCheckingRoom: boolean;
  pendingRoomPrompt: RoomPrompt | null;
  hadInitialUrlRoom: boolean;
  showTeacherSetupOnJoin: boolean;
  displayNameInputRef: React.RefObject<HTMLInputElement | null>;
  isJoinedRef: React.RefObject<boolean>;
  pendingPurgePrompt: PurgePrompt | null;
  isPurgingContributions: boolean;
}

interface Options {
  connection: ClassroomConnection;
  roomState: ClassroomRoomState;
  roomSetters: ClassroomRoomSetters;
  lobby: ClassroomLobby;
}
export function useClassroomActions({ connection, roomState, roomSetters, lobby }: Options) {
  // Destructured once so every useCallback below lists fields, not the (new-every-render) group objects.
  const { socket, emitDrawing } = connection;
  const {
    activeBoardId,
    userId,
    roomId,
    effectiveRoomId,
    isJoined,
    isTeacher,
    breakoutConfig,
    subBoards,
    activeBackground,
    activeElements,
    users,
    roomSettings,
    isChatHidden,
    userName,
    liveRoomId,
    userKey,
    userColor,
    isNameLocked,
    elements,
    messages,
  } = roomState;
  const {
    setSubBoards,
    setIsTeacher,
    setTeacherSelectedBoardId,
    setBackground,
    setRemoteCursors,
    setIsNameLocked,
    setKickNotice,
    setPendingPurgePrompt,
    setIsPurgingContributions,
    setRoomId,
    setIsJoined,
    setUserName,
    setHasEditedLobbyRoom,
    setIsCheckingRoom,
    setPendingRoomPrompt,
  } = roomSetters;
  const {
    initialTeacherPin,
    hasEditedLobbyRoom,
    isCheckingRoom,
    pendingRoomPrompt,
    hadInitialUrlRoom,
    showTeacherSetupOnJoin,
    displayNameInputRef,
    isJoinedRef,
    pendingPurgePrompt,
    isPurgingContributions,
  } = lobby;
  const handleAuthenticateTeacher = useCallback(
    (pin: string): Promise<{ ok: boolean; error?: string; mode?: string }> => {
      return new Promise((resolve) => {
        if (!socket) {
          resolve({ ok: false, error: 'Not connected to server.' });
          return;
        }
        socket.emit(
          'teacher:auth',
          { pin },
          (response: { ok: boolean; error?: string; mode?: string; pin?: string }) => {
            if (response?.ok) {
              setIsTeacher(true);
              try {
                localStorage.setItem(STORAGE_KEYS.TEACHER_PIN_PREFIX + roomId, pin);
              } catch {
                // Ignore
              }
            }
            resolve(response || { ok: false, error: 'No response from server.' });
          }
        );
      });
    },
    [socket, roomId, setIsTeacher]
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
  }, [socket, roomId, setIsTeacher]);

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
    [socket, setTeacherSelectedBoardId]
  );

  const handleSpotlightBoard = useCallback(
    (payload: SpotlightPayload): Promise<{ ok: boolean; error?: string }> => {
      return new Promise((resolve) => {
        if (!socket) return resolve({ ok: false, error: 'Not connected to server.' });
        socket.emit('teacher:spotlight-board', payload, (result: { ok: boolean; error?: string }) => {
          if (result?.ok) setTeacherSelectedBoardId('main');
          resolve(result || { ok: false, error: 'No response from server.' });
        });
      });
    },
    [socket, setTeacherSelectedBoardId]
  );

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
        socket.emit('teacher:set-background-multi', { boardIds, background: bg, roundTemplateFor }, (res) =>
          resolve(res || { ok: false, error: 'No response from server.' })
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
    [socket, activeBoardId, setBackground, setSubBoards]
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
    [socket, activeBoardId, setSubBoards, setBackground]
  );

  const handleTeacherImportRoom = useCallback<RestoreClassWork>(
    async (snapshot, mode) => {
      if (!socket?.connected) {
        return {
          ok: false,
          connectionError: true,
          error: 'Reconnect to send the restore. Your selected file is ready.',
        };
      }
      try {
        const response = await socket.timeout(60_000).emitWithAck('teacher:import-room', { ...snapshot, mode });
        if (response && typeof response.ok === 'boolean') return response;
      } catch {
        // The server may have applied the snapshot before its acknowledgment was lost.
      }
      return {
        ok: false,
        connectionError: true,
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
    <E extends LessonRequestEvent>(
      event: E,
      payload: Parameters<ClientToServerEvents[E]>[0],
      timeoutMs = 60_000
    ): Promise<LessonResponse<E>> =>
      new Promise((resolve) => {
        if (!socket || !socket.connected) {
          resolve({
            ok: false,
            error: 'Not connected to the server. Check your connection and try again.',
          } as LessonResponse<E>);
          return;
        }
        const timer = setTimeout(
          () => resolve({ ok: false, error: 'The server took too long to answer. Try again.' } as LessonResponse<E>),
          timeoutMs
        );
        const emit = socket.emit as (
          event: E,
          payload: Parameters<ClientToServerEvents[E]>[0],
          callback: (res: LessonResponse<E>) => void
        ) => unknown;
        emit.call(socket, event, payload, (res) => {
          clearTimeout(timer);
          resolve(
            res && typeof res === 'object'
              ? res
              : ({ ok: false, error: 'No answer from the server.' } as LessonResponse<E>)
          );
        });
      }),
    [socket]
  );

  const performSwitchRoom = useCallback(
    (cleanedRoomId: string) => {
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
    },
    [
      setRemoteCursors,
      isJoinedRef,
      setIsTeacher,
      setKickNotice,
      setIsNameLocked,
      setIsPurgingContributions,
      setRoomId,
      setTeacherSelectedBoardId,
      setPendingPurgePrompt,
    ]
  );

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

  /** App renders `<ProblemReportModal>` from this while `isOpen`. */
  const problemReport = {
    isOpen: showProblemReport,
    open: openProblemReport,
    close: closeProblemReport,
    diagnostics: getReportDiagnostics,
    redact: reportRedactions,
  };

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
  }, [setIsJoined, setIsTeacher, setPendingPurgePrompt]);

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
    [
      roomId,
      liveRoomId,
      socket,
      userId,
      userKey,
      userColor,
      setKickNotice,
      setUserName,
      setIsTeacher,
      setHasEditedLobbyRoom,
      setIsJoined,
      setRoomId,
    ]
  );

  const handleSwitchRoom = useCallback(
    async (nextRoomRaw: string) => {
      const cleaned = normalizeRoomCode(nextRoomRaw);
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
    [effectiveRoomId, isCheckingRoom, checkRoomAvailability, performSwitchRoom, setIsCheckingRoom, setPendingRoomPrompt]
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
  }, [isCheckingRoom, generateUnusedRoomCode, performSwitchRoom, setHasEditedLobbyRoom, setIsCheckingRoom]);

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
  }, [isCheckingRoom, setPendingRoomPrompt]);

  const handleConfirmJoinAnyway = useCallback(() => {
    if (!pendingRoomPrompt || isCheckingRoom) return;
    const prompt = pendingRoomPrompt;
    setPendingRoomPrompt(null);
    if (prompt.source === 'switch') {
      performSwitchRoom(prompt.availability.roomId);
    } else {
      performLobbyJoin(prompt.availability.roomId, prompt.userName || userName.trim(), prompt.teacherPin || '');
    }
  }, [pendingRoomPrompt, isCheckingRoom, performSwitchRoom, performLobbyJoin, userName, setPendingRoomPrompt]);

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
  }, [
    pendingRoomPrompt,
    isCheckingRoom,
    generateUnusedRoomCode,
    performSwitchRoom,
    performLobbyJoin,
    userName,
    setHasEditedLobbyRoom,
    setIsCheckingRoom,
    setPendingRoomPrompt,
  ]);

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
    [
      pendingRoomPrompt,
      isCheckingRoom,
      checkRoomAvailability,
      performSwitchRoom,
      performLobbyJoin,
      userName,
      setPendingRoomPrompt,
      setHasEditedLobbyRoom,
      setIsCheckingRoom,
    ]
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
    [socket, userId, userColor, isNameLocked, isTeacher, setUserName]
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
      const targetBoardId = breakoutConfig.chatScope === 'board' ? activeBoardId : 'main';
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
      socket.emit('teacher:kick-user', { targetUserId, mode, targetName }, (res?: { ok?: boolean }) => {
        if (res && res.ok === false) {
          setPendingPurgePrompt((prev) => (prev?.targetUserId === targetUserId ? null : prev));
        }
      });
    },
    [socket, setPendingPurgePrompt]
  );

  const handleCancelPurgeContributions = useCallback(() => {
    if (!isPurgingContributions) {
      setPendingPurgePrompt(null);
    }
  }, [isPurgingContributions, setPendingPurgePrompt]);

  const handleConfirmPurgeContributions = useCallback(() => {
    if (!socket || !pendingPurgePrompt || isPurgingContributions) return;
    const { targetUserId } = pendingPurgePrompt;
    if (!socket.connected) {
      setPendingPurgePrompt(null);
      return;
    }
    setIsPurgingContributions(true);
    emitDrawing(socket, 'teacher:purge-user-contributions', { targetUserId }, () => {
      setIsPurgingContributions(false);
      setPendingPurgePrompt(null);
    });
  }, [
    socket,
    pendingPurgePrompt,
    isPurgingContributions,
    setIsPurgingContributions,
    emitDrawing,
    setPendingPurgePrompt,
  ]);

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
        const targetBoardId = breakoutConfig.chatScope === 'board' ? activeBoardId : 'main';
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

  const handleTeacherToggleLock = useCallback(
    (locked: boolean) => {
      if (socket) {
        socket.emit('teacher:set-lock', locked);
      }
    },
    [socket]
  );

  const handleTeacherToggleHideCursors = useCallback(
    (hide: boolean) => {
      socket?.emit('teacher:set-hide-cursors', hide);
    },
    [socket]
  );

  const handleTeacherToggleOneNameStamp = useCallback(
    (enabled: boolean) => {
      socket?.emit('teacher:set-one-name-stamp', enabled);
    },
    [socket]
  );

  const handleSetStatus = useCallback(
    (status: StudentStatus) => {
      socket?.emit('user:set-status', { status });
    },
    [socket]
  );

  const handleClearStatus = useCallback(
    (targetUserId?: string) => {
      socket?.emit('teacher:clear-status', { targetUserId });
    },
    [socket]
  );

  const handleTeacherClearAll = useCallback(() => {
    if (socket) {
      emitDrawing(socket, 'teacher:clear-all', { boardId: activeBoardId });
    }
  }, [socket, activeBoardId, emitDrawing]);

  const handleTeacherTimerControl = useCallback(
    (payload: TimerControlPayload) => {
      if (socket) {
        socket.emit('teacher:timer-control', payload);
      }
    },
    [socket]
  );
  /** Handed to `Canvas` whole (`CanvasTeacherActions`). */
  const teacherActions = {
    onConfigureBreakout: handleConfigureBreakout,
    onSpotlightBoard: handleSpotlightBoard,
    onAssignUserToBoard: handleAssignUserToBoard,
    onTeacherToggleLock: handleTeacherToggleLock,
    onTeacherToggleHideCursors: handleTeacherToggleHideCursors,
    onTeacherToggleOneNameStamp: handleTeacherToggleOneNameStamp,
    onTeacherClearAll: handleTeacherClearAll,
    onTeacherSetBackground: handleTeacherSetBackground,
    onTeacherSendWorksheet: handleTeacherSendWorksheet,
    onTeacherUpdateBackground: handleTeacherUpdateBackground,
    onTeacherImportRoom: handleTeacherImportRoom,
    onTeacherLessonRequest: handleTeacherLessonRequest,
    onOpenLoadedLessonRoom: handleOpenLoadedLessonRoom,
    getSavedTeacherPin,
    generateUnusedRoomCode,
    onTeacherTimerControl: handleTeacherTimerControl,
    onTeacherClearStatus: handleClearStatus,
  };

  return {
    teacherActions,
    handleAuthenticateTeacher,
    handleStepDownTeacher,
    problemReport,
    handleLeaveRoom,
    handleSwitchRoom,
    handleCreateNewRoom,
    handleJoin,
    handleLobbyNewRoom,
    handleCancelRoomPrompt,
    handleConfirmJoinAnyway,
    handleConfirmCreateFreshRoom,
    handleCustomRoomFromModal,
    handleUpdateName,
    handleTeacherRenameUser,
    handleTeacherDeleteMessage,
    handleTeacherKickUser,
    handleCancelPurgeContributions,
    handleConfirmPurgeContributions,
    purgeContributionCounts,
    handleTeacherUnbanUser,
    sendMessage,
    handleSetStatus,
    handleClearStatus,
  };
}
