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
} from './types';
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
      allowSelfSelect: false,
      chatScope: 'unified',
    },
  });
  const [remoteCursors, setRemoteCursors] = useState<Record<string, RemoteCursor>>({});

  const breakoutConfig: BreakoutConfig = roomSettings.breakoutConfig || {
    mode: 'main',
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
    if (breakoutConfig.mode === 'individual') {
      const myIndId = `ind_${userId}`;
      if (subBoards[myIndId]) return myIndId;
    } else if (breakoutConfig.mode === 'groups') {
      const assignedGroup = (Object.values(subBoards) as SubBoardData[]).find(
        (sb) => sb.id.startsWith('grp_') && sb.assignedUserIds.includes(userId)
      );
      if (assignedGroup) return assignedGroup.id;
      const firstGroup = (Object.values(subBoards) as SubBoardData[]).find((sb) =>
        sb.id.startsWith('grp_')
      );
      if (firstGroup) return firstGroup.id;
    }
    return 'main';
  }, [isTeacher, teacherSelectedBoardId, breakoutConfig.mode, subBoards, userId]);

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

  useEffect(() => {
    document.title = roomId && roomId !== 'main' ? `AllAboard — #${roomId}` : 'AllAboard';
    try {
      const url = new URL(window.location.href);
      if (roomId === 'main') {
        url.searchParams.delete('room');
      } else {
        url.searchParams.set('room', roomId);
      }
      window.history.replaceState({}, '', url.toString());
    } catch {
      // Ignore
    }
  }, [roomId]);

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
        savedPin = localStorage.getItem(STORAGE_KEYS.TEACHER_PIN_PREFIX + roomId) || undefined;
      } catch {
        // Ignore storage errors
      }

      if (savedName && savedName.trim() && savedJoined) {
        newSocket.emit('join-room', {
          roomId,
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
      }) => {
        if (Array.isArray(initMsgs)) setMessages(initMsgs);
        if (Array.isArray(initEls)) setElements(initEls);
        setBackground(initBg || null);
        if (initSubBoards && typeof initSubBoards === 'object') {
          setSubBoards(initSubBoards);
        } else {
          setSubBoards({});
        }
        if (Array.isArray(initUsers)) setUsers(initUsers);
        if (initRoom) setRoomSettings(initRoom);
        if (typeof verifiedTeacher === 'boolean') setIsTeacher(verifiedTeacher);
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
      }
    });

    newSocket.on('room-settings', (settings: RoomSettings) => {
      setRoomSettings(settings);
    });

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

    newSocket.on('element-update', (patch: Partial<CanvasElement> & { id: string; boardId?: string }) => {
      const bId = patch.boardId || 'main';
      if (bId === 'main') {
        setElements((prev) =>
          prev.map((el) => (el.id === patch.id ? { ...el, ...patch } : el))
        );
      } else {
        setSubBoards((prev) => {
          const sb = prev[bId];
          if (!sb) return prev;
          return {
            ...prev,
            [bId]: {
              ...sb,
              elements: sb.elements.map((el) => (el.id === patch.id ? { ...el, ...patch } : el)),
            },
          };
        });
      }
    });

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
  }, [userId, userColor, roomId]);

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
    (payload: {
      mode: 'main' | 'individual' | 'groups';
      allowSelfSelect: boolean;
      chatScope: 'unified' | 'board';
      copyWorksheet: boolean;
      customBackground?: RoomBackground | null;
      groups?: Array<{ id: string; title: string; assignedUserIds: string[] }>;
    }): Promise<{ ok: boolean; error?: string }> => {
      return new Promise((resolve) => {
        if (!socket) {
          resolve({ ok: false, error: 'Not connected to server.' });
          return;
        }
        socket.emit('teacher:configure-breakout', payload, (res: { ok: boolean; error?: string }) => {
          if (res?.ok && payload.mode === 'main') {
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
    setTeacherSelectedBoardId('main');
    setRoomId(cleaned);
  }, []);

  const handleCreateNewRoom = useCallback(() => {
    const freshRoom = generateFreshRoomCode();
    setRemoteCursors({});
    setIsTeacher(false);
    setTeacherSelectedBoardId('main');
    setRoomId(freshRoom);
  }, []);

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = userName.trim();
    if (trimmed && socket) {
      const cleanPin = initialTeacherPin.trim();
      try {
        localStorage.setItem(STORAGE_KEYS.USER_NAME, trimmed);
        localStorage.setItem(STORAGE_KEYS.IS_JOINED, 'true');
        if (cleanPin.length >= 3) {
          localStorage.setItem(STORAGE_KEYS.TEACHER_PIN_PREFIX + roomId, cleanPin);
        }
      } catch {
        // Ignore
      }
      setUserName(trimmed);
      socket.emit('join-room', {
        roomId,
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
    [socket, userId, userColor]
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

  const handleElementUpdate = useCallback(
    (patch: Partial<CanvasElement> & { id: string }) => {
      if (activeBoardId === 'main') {
        setElements((prev) =>
          prev.map((el) => (el.id === patch.id ? { ...el, ...patch } : el))
        );
      } else {
        setSubBoards((prev) => {
          const sb = prev[activeBoardId];
          if (!sb) return prev;
          return {
            ...prev,
            [activeBoardId]: {
              ...sb,
              elements: sb.elements.map((el) => (el.id === patch.id ? { ...el, ...patch } : el)),
            },
          };
        });
      }
      if (socket) {
        socket.emit('element-update', { ...patch, boardId: activeBoardId });
      }
    },
    [socket, activeBoardId]
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
            Enter your name to join room <span className="font-mono text-slate-200">#{roomId}</span>
          </p>

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
                  onChange={(e) =>
                    setRoomId(
                      e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, '-') || 'main'
                    )
                  }
                  maxLength={24}
                  className="bg-slate-900 border border-slate-700 px-2 py-1 rounded font-mono text-xs text-white w-28 focus:outline-none focus:border-blue-500"
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
        onAuthenticateTeacher={handleAuthenticateTeacher}
        onStepDownTeacher={handleStepDownTeacher}
        onCreateNewRoom={handleCreateNewRoom}
        onSwitchRoom={handleSwitchRoom}
        onUpdateName={handleUpdateName}
        onClearUserDrawings={handleClearUserDrawings}
      />

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
          onCursorMove={handleCursorMove}
          onUndo={handleUndo}
          onClearMine={handleClearMine}
          onTeacherToggleLock={handleTeacherToggleLock}
          onTeacherClearAll={handleTeacherClearAll}
          onTeacherSetBackground={handleTeacherSetBackground}
          onTeacherUpdateBackground={handleTeacherUpdateBackground}
          onTeacherImportRoom={handleTeacherImportRoom}
          fullMainElements={elements}
          fullMainMessages={messages}
          fullMainBackground={background}
        />
      </div>
    </div>
  );
}
