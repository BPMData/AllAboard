import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  CanvasElement,
  ChatMessage,
  User,
  RoomSettings,
  RoomBackground,
  RemoteCursor,
  ImportRestoreMode,
  SubBoardData,
  BreakoutConfig,
  ConfigureBreakoutPayload,
  TimerControlPayload,
} from './types';
import { findStudentBoardId } from './lib/breakoutRounds';
import {
  DEFAULT_CHAT_WIDTH,
  CHAT_STORAGE_KEYS,
  clampChatWidth,
  readStoredChatWidth,
  readStoredChatHidden,
} from './lib/chatSidebar';
import Chat, { getUserColor } from './components/Chat';
import Canvas from './components/Canvas';
import { motion } from 'motion/react';
import { LogIn, Users, KeyRound, PlusCircle } from 'lucide-react';

const STORAGE_KEYS = {
  USER_ID: 'drawchat_user_id',
  USER_NAME: 'drawchat_user_name',
  IS_JOINED: 'drawchat_is_joined',
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

function getInitialRoomId(): string {
  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('room');
    if (fromUrl && fromUrl.trim()) {
      return fromUrl.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
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
  const [socket, setSocket] = useState<Socket | null>(null);
  const [userId] = useState<string>(() => getOrCreatePersistentUserId());
  const [userColor] = useState<string>(() => getUserColor(getOrCreatePersistentUserId()));
  const [roomId, setRoomId] = useState<string>(() => getInitialRoomId());

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

  const [isJoined, setIsJoined] = useState<boolean>(() => {
    try {
      const savedName = localStorage.getItem(STORAGE_KEYS.USER_NAME);
      const savedJoined = localStorage.getItem(STORAGE_KEYS.IS_JOINED) === 'true';
      return Boolean(savedName && savedName.trim() && savedJoined);
    } catch {
      return false;
    }
  });

  const userNameRef = useRef<string>(userName);
  const isJoinedRef = useRef<boolean>(isJoined);
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
      return readStoredChatHidden(typeof window !== 'undefined' ? window.localStorage : null);
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
    try {
      localStorage.setItem(CHAT_STORAGE_KEYS.HIDDEN, isChatHidden ? 'true' : 'false');
    } catch {
      // Ignore
    }
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
  const [teacherSelectedBoardId, setTeacherSelectedBoardId] = useState<string>('main');

  const [users, setUsers] = useState<User[]>([]);
  const [roomSettings, setRoomSettings] = useState<RoomSettings>({
    roomId: getInitialRoomId(),
    isCanvasLocked: false,
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

  const effectiveRoomId = roomId.trim() || 'main';

  useEffect(() => {
    document.title = effectiveRoomId !== 'main' ? `AllAboard — #${effectiveRoomId}` : 'AllAboard';
    try {
      const url = new URL(window.location.href);
      if (effectiveRoomId === 'main') {
        url.searchParams.delete('room');
      } else {
        url.searchParams.set('room', effectiveRoomId);
      }
      window.history.replaceState({}, '', url.toString());
    } catch {
      // Ignore
    }
  }, [effectiveRoomId]);

  useEffect(() => {
    const newSocket = io({
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    setSocket(newSocket);

    newSocket.on('connect', () => {
      let savedName = userNameRef.current;
      let savedJoined = isJoinedRef.current;
      let savedPin: string | undefined;

      try {
        savedName = localStorage.getItem(STORAGE_KEYS.USER_NAME) || savedName;
        savedJoined = localStorage.getItem(STORAGE_KEYS.IS_JOINED) === 'true' || savedJoined;
        savedPin = localStorage.getItem(STORAGE_KEYS.TEACHER_PIN_PREFIX + effectiveRoomId) || undefined;
      } catch {
        // Ignore storage errors
      }

      if (savedName && savedName.trim() && savedJoined) {
        newSocket.emit('join-room', {
          roomId: effectiveRoomId,
          userId,
          name: savedName.trim(),
          color: userColor,
          teacherPin: savedPin,
        });
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
        assignedName,
        isNameLocked: initNameLocked,
      }) => {
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
        setKickNotice(null);
      }
    );

    newSocket.on(
      'breakout-sync',
      ({
        breakoutConfig: syncedConfig,
        subBoards: syncedSubBoards,
      }: {
        breakoutConfig: BreakoutConfig;
        subBoards: Record<string, SubBoardData>;
      }) => {
        setRoomSettings((prev) => ({ ...prev, breakoutConfig: syncedConfig }));
        if (syncedSubBoards) setSubBoards(syncedSubBoards);
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

    newSocket.on('roster-sync', (rosterList: User[]) => {
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

    newSocket.on('room-settings', (settings: RoomSettings) => {
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

    newSocket.on(
      'room-kicked',
      ({ reason, roomId: kickedRoom }: { reason: 'kicked' | 'banned'; roomId?: string }) => {
        setIsJoined(false);
        setIsTeacher(false);
        try {
          localStorage.removeItem(STORAGE_KEYS.IS_JOINED);
        } catch {
          // Ignore
        }
        const targetRoom = kickedRoom || roomId;
        setKickNotice(
          reason === 'banned'
            ? `You have been banned from room #${targetRoom} by the teacher.`
            : `You were removed from room #${targetRoom} by the teacher.`
        );
      }
    );

    newSocket.on('chat-message', (msg: ChatMessage) => {
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

    newSocket.on('element-start', (element: CanvasElement) => {
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
        if (boardId === 'main') {
          setElements((prev) =>
            prev.map((el) =>
              el.id === id && Array.isArray(el.points)
                ? { ...el, points: [...el.points, ...newPoints] }
                : el
            )
          );
        } else {
          setSubBoards((prev) => {
            const sb = prev[boardId];
            if (!sb) return prev;
            return {
              ...prev,
              [boardId]: {
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
      ({ boardId = 'main', elements: syncedElements }: { boardId?: string; elements: CanvasElement[] }) => {
        if (!Array.isArray(syncedElements)) return;
        if (boardId === 'main') {
          setElements(syncedElements);
        } else {
          setSubBoards((prev) => {
            const sb = prev[boardId];
            if (!sb) return prev;
            return {
              ...prev,
              [boardId]: { ...sb, elements: syncedElements },
            };
          });
        }
      }
    );

    newSocket.on('cursor-move', (cursor: Omit<RemoteCursor, 'updatedAt'>) => {
      setRemoteCursors((prev) => ({
        ...prev,
        [cursor.userId]: { ...cursor, updatedAt: Date.now() },
      }));
    });

    newSocket.on('cursor-leave', ({ userId: leftUserId }: { userId: string }) => {
      setRemoteCursors((prev) => {
        const next = { ...prev };
        delete next[leftUserId];
        return next;
      });
    });

    return () => {
      newSocket.close();
    };
  }, [userId, userColor, effectiveRoomId]);

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
    (payload: ConfigureBreakoutPayload): Promise<{ ok: boolean; error?: string }> => {
      return new Promise((resolve) => {
        if (!socket) {
          resolve({ ok: false, error: 'Not connected to server.' });
          return;
        }
        socket.emit('teacher:configure-breakout', payload, (res: { ok: boolean; error?: string }) => {
          if (res?.ok && (payload.action === 'return-to-main' || payload.mode === 'main')) {
            setTeacherSelectedBoardId('main');
          }
          resolve(res || { ok: false, error: 'No response from server.' });
        });
      });
    },
    [socket]
  );

  const handleAssignUserToBoard = useCallback(
    (targetBoardId: string, targetUserId?: string) => {
      if (socket) {
        socket.emit('breakout:join-board', { targetBoardId, targetUserId });
      }
    },
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

  const handleTeacherImportRoom = useCallback(
    (
      snapshot: {
        elements: CanvasElement[];
        messages: ChatMessage[];
        background?: RoomBackground | null;
        subBoards?: Record<string, SubBoardData>;
        breakoutConfig?: BreakoutConfig;
      },
      mode: ImportRestoreMode
    ): Promise<{ ok: boolean; error?: string }> => {
      return new Promise((resolve) => {
        if (!socket) {
          resolve({ ok: false, error: 'Not connected to server.' });
          return;
        }
        socket.emit(
          'teacher:import-room',
          {
            elements: snapshot.elements,
            messages: snapshot.messages,
            background: snapshot.background,
            subBoards: snapshot.subBoards,
            breakoutConfig: snapshot.breakoutConfig,
            mode,
          },
          (response: { ok: boolean; error?: string }) => {
            resolve(response || { ok: false, error: 'No response from server.' });
          }
        );
      });
    },
    [socket]
  );

  const handleSwitchRoom = useCallback((nextRoomRaw: string) => {
    const cleaned =
      nextRoomRaw
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-_]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || 'main';
    setRemoteCursors({});
    setIsTeacher(false);
    setIsNameLocked(false);
    setKickNotice(null);
    setTeacherSelectedBoardId('main');
    setRoomId(cleaned);
  }, []);

  const handleCreateNewRoom = useCallback(() => {
    const freshRoom = generateFreshRoomCode();
    setRemoteCursors({});
    setIsTeacher(false);
    setIsNameLocked(false);
    setKickNotice(null);
    setTeacherSelectedBoardId('main');
    setRoomId(freshRoom);
  }, []);

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = userName.trim();
    if (trimmed && socket) {
      setKickNotice(null);
      const targetRoomId = effectiveRoomId;
      if (roomId !== targetRoomId) {
        setRoomId(targetRoomId);
      }
      const cleanPin = initialTeacherPin.trim();
      try {
        localStorage.setItem(STORAGE_KEYS.USER_NAME, trimmed);
        localStorage.setItem(STORAGE_KEYS.IS_JOINED, 'true');
        if (cleanPin.length >= 3) {
          localStorage.setItem(STORAGE_KEYS.TEACHER_PIN_PREFIX + targetRoomId, cleanPin);
        }
      } catch {
        // Ignore
      }
      setUserName(trimmed);
      socket.emit('join-room', {
        roomId: targetRoomId,
        userId,
        name: trimmed,
        color: userColor,
        teacherPin: cleanPin.length >= 3 ? cleanPin : undefined,
      });

      if (cleanPin.length >= 3) {
        socket.emit('teacher:auth', { pin: cleanPin }, (res: { ok: boolean }) => {
          if (res?.ok) setIsTeacher(true);
        });
      }

      setIsJoined(true);
    }
  };

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
      socket.emit('teacher:kick-user', { targetUserId, mode, targetName });
    },
    [socket]
  );

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
        socket.emit('element-start', withBoard);
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
        socket.emit('element-append-points', { id, boardId: activeBoardId, newPoints });
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
        socket.emit('element-update', {
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
        socket.emit('elements-batch-update', { boardId: activeBoardId, updates, bringToFront });
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
        socket.emit('elements-batch-add', { boardId: destBoardId, elements: normalized });
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
        socket.emit('elements-batch-remove', { boardId: activeBoardId, ids });
      }
    },
    [socket, activeBoardId, updateActiveBoardElements]
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
        socket.emit('element-remove', { id, boardId: activeBoardId });
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
      socket.emit('undo', { userId, boardId: activeBoardId });
    }
  }, [socket, userId, activeBoardId]);

  const handleClearMine = useCallback(() => {
    if (socket) {
      socket.emit('clear-user-drawings', { targetUserId: userId, boardId: activeBoardId });
    }
  }, [socket, userId, activeBoardId]);

  const handleClearUserDrawings = useCallback(
    (targetUserId: string) => {
      if (socket) {
        socket.emit('clear-user-drawings', { targetUserId, boardId: activeBoardId });
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

  const handleTeacherClearAll = useCallback(() => {
    if (socket) {
      socket.emit('teacher:clear-all', { boardId: activeBoardId });
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
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.16 }}
          className="bg-slate-900 border border-slate-800 p-8 rounded-2xl shadow-xl w-full max-w-md"
        >
          <div className="flex justify-center mb-5">
            <div className="w-14 h-14 bg-blue-600 rounded-xl flex items-center justify-center">
              <Users className="text-white" size={28} />
            </div>
          </div>

          <h1 className="font-display text-2xl font-bold text-white text-center mb-1.5 text-balance">
            Welcome to AllAboard
          </h1>
          <p className="text-slate-400 text-center mb-6 text-sm">
            Enter your name to join room <span className="font-mono text-slate-200">#{effectiveRoomId}</span>
          </p>

          {kickNotice && (
            <div className="mb-4 p-3 rounded-xl bg-red-950/70 border border-red-800/80 text-xs text-red-200 leading-relaxed text-center">
              {kickNotice}
            </div>
          )}

          <form onSubmit={handleJoin} className="space-y-4">
            <div>
              <label
                htmlFor="display-name-input"
                className="block text-xs font-medium text-slate-300 mb-1.5"
              >
                Your Display Name
              </label>
              <input
                id="display-name-input"
                type="text"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                placeholder="e.g. Alex"
                autoFocus
                maxLength={28}
                className="w-full px-4 py-3 bg-slate-800 border border-slate-700 rounded-xl text-white placeholder:text-slate-500 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors outline-none"
              />
            </div>

            <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-slate-800/50 border border-slate-800 text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-slate-400">Room Code:</span>
                <input
                  type="text"
                  value={roomId}
                  placeholder="main"
                  onChange={(e) => {
                    setKickNotice(null);
                    setRoomId(
                      e.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9-_]/g, '-')
                        .replace(/-+/g, '-')
                    );
                  }}
                  maxLength={24}
                  className="bg-slate-900 border border-slate-700 px-2 py-1 rounded font-mono text-xs text-white placeholder:text-slate-500 w-28 focus:outline-none focus:border-blue-500"
                />
              </div>
              <button
                type="button"
                onClick={handleCreateNewRoom}
                className="flex items-center gap-1 text-blue-400 hover:text-blue-300 font-medium whitespace-nowrap cursor-pointer"
                title="Generate a brand new room code"
              >
                <PlusCircle size={13} />
                <span>New Room</span>
              </button>
            </div>

            {showTeacherSetupOnJoin ? (
              <div className="p-3.5 rounded-xl bg-slate-800/80 border border-slate-700 space-y-2">
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="teacher-pin-input"
                    className="text-xs font-medium text-amber-400 flex items-center gap-1.5"
                  >
                    <KeyRound size={13} />
                    <span>Set or Enter Room Teacher PIN</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setShowTeacherSetupOnJoin(false);
                      setInitialTeacherPin('');
                    }}
                    className="text-[11px] text-slate-400 hover:text-slate-200 cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
                <input
                  id="teacher-pin-input"
                  type="password"
                  value={initialTeacherPin}
                  onChange={(e) => setInitialTeacherPin(e.target.value)}
                  placeholder="Choose a 4+ digit PIN (e.g. 4829)"
                  maxLength={16}
                  className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white font-mono placeholder:text-slate-500 focus:outline-none focus:border-amber-500"
                />
                <p className="text-[11px] text-slate-400 leading-snug">
                  The first person to set a PIN in a room locks Teacher Mode so students cannot click it.
                </p>
              </div>
            ) : (
              <div className="flex justify-center pt-1">
                <button
                  type="button"
                  onClick={() => setShowTeacherSetupOnJoin(true)}
                  className="text-xs text-slate-500 hover:text-slate-300 flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <KeyRound size={12} />
                  <span>Instructor? Set or enter a room Teacher PIN</span>
                </button>
              </div>
            )}

            <button
              type="submit"
              disabled={!userName.trim()}
              className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-600 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2 cursor-pointer"
            >
              <LogIn size={18} />
              <span>Join Classroom</span>
            </button>
          </form>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-slate-100 overflow-hidden font-sans">
      {!isChatHidden && (
        <Chat
          roomId={roomId}
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
          onUpdateName={handleUpdateName}
          onClearUserDrawings={handleClearUserDrawings}
          onTeacherRenameUser={handleTeacherRenameUser}
          onTeacherDeleteMessage={handleTeacherDeleteMessage}
          onTeacherKickUser={handleTeacherKickUser}
          onTeacherUnbanUser={handleTeacherUnbanUser}
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
          onHideChat={() => setIsChatHidden(true)}
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
          users={users}
          remoteCursors={remoteCursors}
          isCanvasLocked={roomSettings.isCanvasLocked}
          isTeacher={isTeacher}
          userId={userId}
          userName={userName}
          userColor={userColor}
          onSelectBoard={setTeacherSelectedBoardId}
          onConfigureBreakout={handleConfigureBreakout}
          onAssignUserToBoard={handleAssignUserToBoard}
          onElementStart={handleElementStart}
          onElementAppendPoints={handleElementAppendPoints}
          onElementUpdate={handleElementUpdate}
          onElementRemove={handleElementRemove}
          onElementsBatchUpdate={handleElementsBatchUpdate}
          onElementsBatchAdd={handleElementsBatchAdd}
          onElementsBatchRemove={handleElementsBatchRemove}
          onCursorMove={handleCursorMove}
          onUndo={handleUndo}
          onClearMine={handleClearMine}
          onTeacherToggleLock={handleTeacherToggleLock}
          onTeacherClearAll={handleTeacherClearAll}
          onTeacherSetBackground={handleTeacherSetBackground}
          onTeacherUpdateBackground={handleTeacherUpdateBackground}
          onTeacherImportRoom={handleTeacherImportRoom}
          timer={roomSettings.timer}
          onTeacherTimerControl={handleTeacherTimerControl}
          fullMainElements={elements}
          fullMainMessages={messages}
          fullMainBackground={background}
          isChatHidden={isChatHidden}
          unreadChatCount={unreadChatCount}
          onShowChat={() => setIsChatHidden(false)}
        />
      </div>
    </div>
  );
}
