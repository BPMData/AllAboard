import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { applyDigest, type BoardDigest } from '../lib/boardDigest';
import { POINT_FLUSH_MS } from '../lib/drawThrottle';
import { applyElementGroups, type ElementGroup } from '../lib/elementGroups';
import { STORAGE_KEYS } from '../lib/identity';
import {
  appendPointBatches,
  createPointQueue,
  frameScheduler,
  timeoutScheduler,
  type PointBatch,
  type PointQueue,
} from '../lib/pointBatcher';
import { recordRoomHistory } from '../lib/roomHistory';
import type { RoundVariants } from '../lib/roundVariants';
import type { ClientToServerEvents, ServerToClientEvents } from '../lib/socketContract';
import type {
  BreakoutConfig,
  CanvasElement,
  ChatMessage,
  RemoteCursor,
  RoomBackground,
  RoomSettings,
  SubBoardData,
  User,
} from '../types';

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type Setter<T> = React.Dispatch<React.SetStateAction<T>>;
interface RoomSocketOptions {
  userId: string;
  userKey: string;
  userColor: string;
  liveRoomId: string;
  roomId: string;
  isTeacher: boolean;
  activeBoardId: string;
  userNameRef: React.RefObject<string>;
  isJoinedRef: React.RefObject<boolean>;
  isChatHiddenRef: React.RefObject<boolean>;
  activeBoardIdRef: React.RefObject<string>;
  chatScopeRef: React.RefObject<'unified' | 'board'>;
  setElements: Setter<CanvasElement[]>;
  setSubBoards: Setter<Record<string, SubBoardData>>;
  setIsTeacher: Setter<boolean>;
  setRoundTemplates: Setter<Record<string, RoomBackground | null>>;
  setRoundTemplateInk: Setter<Record<string, CanvasElement[]>>;
  setRoundVariants: Setter<Record<string, RoundVariants>>;
  setMessages: Setter<ChatMessage[]>;
  setBackground: Setter<RoomBackground | null>;
  setUnreadChatCount: Setter<number>;
  setUsers: Setter<User[]>;
  setRoomSettings: Setter<RoomSettings>;
  setIsNameLocked: Setter<boolean>;
  setUserName: Setter<string>;
  setHistoryVersion: Setter<number>;
  setKickNotice: Setter<string | null>;
  setIsJoined: Setter<boolean>;
  setPendingPurgePrompt: Setter<{ targetUserId: string; targetName: string; mode: 'kick' | 'ban' } | null>;
  setRemoteCursors: Setter<Record<string, RemoteCursor>>;
}

export function useRoomSocket({
  userId,
  userKey,
  userColor,
  liveRoomId,
  roomId,
  isTeacher,
  activeBoardId,
  userNameRef,
  isJoinedRef,
  isChatHiddenRef,
  activeBoardIdRef,
  chatScopeRef,
  setElements,
  setSubBoards,
  setIsTeacher,
  setRoundTemplates,
  setRoundTemplateInk,
  setRoundVariants,
  setMessages,
  setBackground,
  setUnreadChatCount,
  setUsers,
  setRoomSettings,
  setIsNameLocked,
  setUserName,
  setHistoryVersion,
  setKickNotice,
  setIsJoined,
  setPendingPurgePrompt,
  setRemoteCursors,
}: RoomSocketOptions) {
  const [socket, setSocket] = useState<AppSocket | null>(null);
  const outgoingInkRef = useRef<PointQueue | null>(null);
  const seenChatIdsRef = useRef<Set<string>>(new Set());
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
        setRoundTemplateInk(
          initRoundTemplateInk && typeof initRoundTemplateInk === 'object' ? initRoundTemplateInk : {}
        );
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
        setMessages((prev) => prev.map((m) => (m.userId === renamedUserId ? { ...m, userName: newName } : m)));
        setElements((prev) => prev.map((el) => (el.userId === renamedUserId ? { ...el, userName: newName } : el)));
        setSubBoards((prev) => {
          const next: Record<string, SubBoardData> = {};
          for (const [k, sb] of Object.entries(prev) as Array<[string, SubBoardData]>) {
            next[k] = {
              ...sb,
              title:
                sb.kind === 'individual' && sb.assignedUserIds[0] === renamedUserId ? `${newName}'s Board` : sb.title,
              messages: sb.messages.map((m) => (m.userId === renamedUserId ? { ...m, userName: newName } : m)),
              elements: sb.elements.map((el) => (el.userId === renamedUserId ? { ...el, userName: newName } : el)),
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

    const applyBoardElementsTransform = (boardId: string, transform: (list: CanvasElement[]) => CanvasElement[]) => {
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

    newSocket.on('elements-batch-removed', ({ boardId = 'main', ids }: { boardId?: string; ids: string[] }) => {
      if (!Array.isArray(ids) || ids.length === 0) return;
      const idSet = new Set(ids);
      applyBoardElementsTransform(boardId, (list) => list.filter((el) => !idSet.has(el.id)));
    });

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
      }: {
        boardId?: string;
        elements: CanvasElement[];
        messages?: ChatMessage[];
      }) => {
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
  const emitDrawing = useCallback(
    <E extends keyof ClientToServerEvents>(
      target: AppSocket,
      event: E,
      ...args: Parameters<ClientToServerEvents[E]>
    ) => {
      outgoingInkRef.current?.flush();
      target.emit(event, ...args);
    },
    []
  );

  const enqueueOutgoingPoints = useCallback((boardId: string, id: string, points: number[]) => {
    outgoingInkRef.current?.add(boardId, id, points);
  }, []);
  const flushOutgoingPoints = useCallback(() => outgoingInkRef.current?.flush(), []);
  return { socket, emitDrawing, enqueueOutgoingPoints, flushOutgoingPoints };
}
