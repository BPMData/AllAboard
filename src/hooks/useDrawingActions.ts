import React, { useCallback } from 'react';
import { applyElementGroups, type ElementGroup } from '../lib/elementGroups';
import {
  CanvasElement,
  RemoteCursor,
  RoomAvailability,
  SubBoardData
} from '../types';


import type { useRoomSocket } from './useRoomSocket';
type Setter<T> = React.Dispatch<React.SetStateAction<T>>;
type RoomPrompt = { source: 'lobby' | 'switch'; availability: RoomAvailability; userName?: string; teacherPin?: string };
type PurgePrompt = { targetUserId: string; targetName: string; mode: 'kick' | 'ban' };

interface Options {
  socket: ReturnType<typeof useRoomSocket>['socket'];
  activeBoardId: string;
  setSubBoards: Setter<Record<string, SubBoardData>>;
  emitDrawing: ReturnType<typeof useRoomSocket>['emitDrawing'];
  userId: string;
  setElements: Setter<CanvasElement[]>;
  enqueueOutgoingPoints: ReturnType<typeof useRoomSocket>['enqueueOutgoingPoints'];
}
export function useDrawingActions({
  socket,
  activeBoardId,
  setSubBoards,
  emitDrawing,
  userId,
  setElements,
  enqueueOutgoingPoints
}: Options) {


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
        enqueueOutgoingPoints(activeBoardId, id, newPoints);
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
  return {
    handleElementStart,
    handleElementAppendPoints,
    handleElementUpdate,
    handleElementsBatchUpdate,
    handleElementsBatchAdd,
    handleElementsBatchRemove,
    handleElementsReplace,
    handleElementRemove,
    handleCursorMove,
    handleUndo,
    handleClearMine,
    handleClearUserDrawings
  };
}
