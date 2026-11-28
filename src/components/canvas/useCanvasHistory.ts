import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getNoteFontSize, noteSize } from '../../lib/inkCore';
import { CanvasElement } from '../../types';
import type { HistoryAction } from './canvasHelpers';

import type { Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../../lib/socketContract';
import type { CanvasActiveBoard, CanvasDrawingActions } from '../Canvas';
type Options = {
  laserSocket: Socket<ServerToClientEvents, ClientToServerEvents> | null;
  activeBoardId: CanvasActiveBoard['activeBoardId'];
} & Pick<
  CanvasDrawingActions,
  'onUndo' | 'onElementsBatchRemove' | 'onElementsBatchAdd' | 'onElementsBatchUpdate' | 'onElementsReplace'
> & {
    canDraw: boolean;
    setSelectedIds: React.Dispatch<React.SetStateAction<string[]>>;
    setEditingNote: (value: null) => void;
  };
export function useCanvasHistory({
  laserSocket,
  activeBoardId,
  onUndo,
  onElementsBatchRemove,
  onElementsBatchAdd,
  onElementsBatchUpdate,
  onElementsReplace,
  canDraw,
  setSelectedIds,
  setEditingNote,
}: Options) {
  const historyByBoardRef = useRef<Record<string, { undo: HistoryAction[]; redo: HistoryAction[] }>>({});

  const [historyTick, setHistoryTick] = useState(0);

  useEffect(() => {
    if (!laserSocket) return;
    const resetHistory = ({ boardId }: { boardId: string }) => {
      delete historyByBoardRef.current[boardId];
      setHistoryTick((tick) => tick + 1);
      if (boardId === activeBoardId) {
        setSelectedIds([]);
        setEditingNote(null);
      }
    };
    laserSocket.on('board-replaced', resetHistory);
    return () => {
      laserSocket.off('board-replaced', resetHistory);
    };
  }, [laserSocket, activeBoardId, setEditingNote, setSelectedIds]);

  const getBoardHistory = useCallback((boardId: string) => {
    if (!historyByBoardRef.current[boardId]) {
      historyByBoardRef.current[boardId] = { undo: [], redo: [] };
    }
    return historyByBoardRef.current[boardId];
  }, []);

  const recordUndo = useCallback(
    (action: HistoryAction, boardId = activeBoardId) => {
      const h = getBoardHistory(boardId);
      h.undo.push(action);
      if (h.undo.length > 80) h.undo.shift();
      h.redo = [];
      setHistoryTick((t) => t + 1);
    },
    [activeBoardId, getBoardHistory]
  );

  const currentBoardHistory = historyByBoardRef.current[activeBoardId];

  const canLocalUndo = Boolean(currentBoardHistory && currentBoardHistory.undo.length > 0);

  const canRedo = Boolean(currentBoardHistory && currentBoardHistory.redo.length > 0);

  void historyTick;

  const buildElementUpdatePatch = useCallback((el: CanvasElement) => {
    let fontSize = el.fontSize;
    let width = el.width;
    let height = el.height;
    if (el.tool === 'text') {
      const resolvedFont = getNoteFontSize(el);
      const [fallbackW, fallbackH] = noteSize(el.text || '', resolvedFont);
      fontSize = resolvedFont;
      if (typeof width !== 'number') width = fallbackW;
      if (typeof height !== 'number') height = fallbackH;
    }
    return {
      id: el.id,
      x: el.x,
      y: el.y,
      width,
      height,
      points: el.points,
      text: el.text,
      color: el.color,
      strokeWidth: el.strokeWidth,
      hollowShape: el.hollowShape,
      hollowWeight: el.hollowWeight,
      fontSize,
    };
  }, []);

  const performUndo = useCallback(() => {
    if (!canDraw) return;
    const h = getBoardHistory(activeBoardId);
    const action = h.undo.pop();
    if (!action) {
      onUndo();
      return;
    }
    h.redo.push(action);
    setHistoryTick((t) => t + 1);

    if (action.kind === 'add') {
      const ids = action.items.map((el) => el.id);
      onElementsBatchRemove(ids);
      setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)));
    } else if (action.kind === 'remove') {
      onElementsBatchAdd(action.items, activeBoardId);
      setSelectedIds(action.items.map((el) => el.id));
    } else if (action.kind === 'update') {
      onElementsBatchUpdate(action.before.map(buildElementUpdatePatch), false);
    } else if (action.kind === 'replace') {
      const addedIds = action.added.map((el) => el.id);
      onElementsBatchRemove(addedIds);
      onElementsBatchAdd(action.removed, activeBoardId);
      setSelectedIds(action.removed.map((el) => el.id));
    } else if (action.kind === 'groups') {
      onElementsReplace?.(action.backward);
    }
  }, [
    onElementsReplace,
    canDraw,
    activeBoardId,
    getBoardHistory,
    onUndo,
    onElementsBatchRemove,
    onElementsBatchAdd,
    onElementsBatchUpdate,
    buildElementUpdatePatch,
    setSelectedIds,
  ]);

  const performRedo = useCallback(() => {
    if (!canDraw) return;
    const h = getBoardHistory(activeBoardId);
    const action = h.redo.pop();
    if (!action) return;
    h.undo.push(action);
    setHistoryTick((t) => t + 1);

    if (action.kind === 'add') {
      onElementsBatchAdd(action.items, activeBoardId);
      setSelectedIds(action.items.map((el) => el.id));
    } else if (action.kind === 'remove') {
      const ids = action.items.map((el) => el.id);
      onElementsBatchRemove(ids);
      setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)));
    } else if (action.kind === 'update') {
      onElementsBatchUpdate(action.after.map(buildElementUpdatePatch), Boolean(action.bringToFront));
    } else if (action.kind === 'replace') {
      const removedIds = action.removed.map((el) => el.id);
      onElementsBatchRemove(removedIds);
      onElementsBatchAdd(action.added, activeBoardId);
      setSelectedIds(action.added.map((el) => el.id));
    } else if (action.kind === 'groups') {
      onElementsReplace?.(action.forward);
    }
  }, [
    onElementsReplace,
    canDraw,
    activeBoardId,
    getBoardHistory,
    onElementsBatchAdd,
    onElementsBatchRemove,
    onElementsBatchUpdate,
    buildElementUpdatePatch,
    setSelectedIds,
  ]);
  return { recordUndo, canLocalUndo, canRedo, performUndo, performRedo };
}
