import React, { useCallback, useEffect } from 'react';
import {
  NOTE_LH,
  expandElementVisiblePieces,
  getNoteFontSize,
  getSelectionBounds,
  hitEditableNote,
  noteSize,
  translateElement,
} from '../../lib/inkCore';
import { CanvasElement, SubBoardData } from '../../types';
import { saveLocal } from './canvasHelpers';

import type { HistoryAction } from './canvasHelpers';

interface Options {
  noteTextareaRef: React.RefObject<HTMLTextAreaElement>;
  editingNote: {
    existingId: string | null;
    worldX: number;
    worldY: number;
    value: string;
    color: string;
    strokeWidth: number;
    fontSize: number;
    openedAt: number;
  };
  stageScale: number;
  stagePos: { x: number; y: number };
  selectedElements: CanvasElement[];
  elements: CanvasElement[];
  setClipboardElements: React.Dispatch<React.SetStateAction<CanvasElement[]>>;
  canDraw: boolean;
  clipboardElements: CanvasElement[];
  activeBoardId: string;
  userId: string;
  userName: string;
  recordUndo: (action: HistoryAction, boardId?: string) => void;
  onElementsBatchAdd: (elements: CanvasElement[], targetBoardId?: string) => void;
  setSelectedIds: React.Dispatch<React.SetStateAction<string[]>>;
  setPastePrompt: React.Dispatch<React.SetStateAction<{ worldX: number; worldY: number }>>;
  onElementsBatchRemove: (ids: string[]) => void;
  isTeacher: boolean;
  subBoards: Record<string, SubBoardData>;
  setSentFeedback: React.Dispatch<React.SetStateAction<string>>;
  setEditingNote: React.Dispatch<
    React.SetStateAction<{
      existingId: string | null;
      worldX: number;
      worldY: number;
      value: string;
      color: string;
      strokeWidth: number;
      fontSize: number;
      openedAt: number;
    }>
  >;
  noteClosedAtRef: React.RefObject<number>;
  onElementRemove: (id: string) => void;
  onElementUpdate: (patch: Partial<CanvasElement> & { id: string; bringToFront?: boolean }) => void;
  onElementStart: (element: CanvasElement) => void;
  allGoneNoteIds: Set<string>;
  penColor: string;
  setTextFontSize: React.Dispatch<React.SetStateAction<number>>;
  penWidth: number;
  textFontSize: number;
}
export function useCanvasNoteSelection({
  noteTextareaRef,
  editingNote,
  stageScale,
  stagePos,
  selectedElements,
  elements,
  setClipboardElements,
  canDraw,
  clipboardElements,
  activeBoardId,
  userId,
  userName,
  recordUndo,
  onElementsBatchAdd,
  setSelectedIds,
  setPastePrompt,
  onElementsBatchRemove,
  isTeacher,
  subBoards,
  setSentFeedback,
  setEditingNote,
  noteClosedAtRef,
  onElementRemove,
  onElementUpdate,
  onElementStart,
  allGoneNoteIds,
  penColor,
  setTextFontSize,
  penWidth,
  textFontSize,
}: Options) {
  const resizeNoteTextarea = useCallback(() => {
    const el = noteTextareaRef.current;
    if (!el || !editingNote) return;
    const scaledFont = editingNote.fontSize * stageScale;
    el.style.width = '1px';
    el.style.height = '1px';
    el.style.width = `${Math.max(el.scrollWidth + 6, scaledFont * 3)}px`;
    el.style.height = `${Math.max(el.scrollHeight, Math.round(scaledFont * NOTE_LH))}px`;
  }, [editingNote, stageScale, noteTextareaRef]);

  useEffect(() => {
    if (editingNote) {
      resizeNoteTextarea();
    }
  }, [editingNote, stageScale, stagePos.x, stagePos.y, resizeNoteTextarea]);

  useEffect(() => {
    if (!editingNote) return;
    const id = requestAnimationFrame(() => {
      const ta = noteTextareaRef.current;
      if (ta) {
        ta.focus();
        const len = ta.value.length;
        ta.setSelectionRange(len, len);
        resizeNoteTextarea();
      }
    });
    return () => cancelAnimationFrame(id);
    // Only run when opening a note or switching which note is being edited
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingNote?.openedAt, editingNote?.existingId]);

  const handleCopySelection = useCallback(() => {
    if (selectedElements.length === 0) return;
    const pieces = selectedElements.flatMap((el) => expandElementVisiblePieces(el, elements));
    if (pieces.length === 0) return;
    setClipboardElements(pieces.map((el) => ({ ...el, points: el.points ? [...el.points] : undefined })));
  }, [selectedElements, elements, setClipboardElements]);

  const handlePasteElements = useCallback(
    (targetWorldPos?: { x: number; y: number } | null) => {
      if (!canDraw || clipboardElements.length === 0) return;
      const box = getSelectionBounds(clipboardElements);
      let dx = 28;
      let dy = 28;
      if (box && targetWorldPos) {
        const cx = (box[0] + box[2]) / 2;
        const cy = (box[1] + box[3]) / 2;
        dx = targetWorldPos.x - cx;
        dy = targetWorldPos.y - cy;
      }
      const now = Date.now();
      const clones: CanvasElement[] = clipboardElements.map((el, idx) => {
        const shifted = translateElement(el, dx, dy);
        return {
          ...shifted,
          id: `${Math.random().toString(36).substring(2, 9)}_${idx}`,
          boardId: activeBoardId,
          userId,
          userName,
          timestamp: now + idx,
        };
      });
      recordUndo({ kind: 'add', items: clones });
      onElementsBatchAdd(clones, activeBoardId);
      setSelectedIds(clones.map((c) => c.id));
      setPastePrompt(null);
    },
    [
      canDraw,
      clipboardElements,
      activeBoardId,
      userId,
      userName,
      recordUndo,
      onElementsBatchAdd,
      setSelectedIds,
      setPastePrompt,
    ]
  );

  const handleDuplicateSelection = useCallback(() => {
    if (!canDraw || selectedElements.length === 0) return;
    const pieces = selectedElements.flatMap((el) => expandElementVisiblePieces(el, elements));
    if (pieces.length === 0) return;
    const now = Date.now();
    const clones: CanvasElement[] = pieces.map((el, idx) => {
      const shifted = translateElement(el, 28, 28);
      return {
        ...shifted,
        id: `${Math.random().toString(36).substring(2, 9)}_${idx}`,
        boardId: activeBoardId,
        userId,
        userName,
        timestamp: now + idx,
      };
    });
    recordUndo({ kind: 'add', items: clones });
    onElementsBatchAdd(clones, activeBoardId);
    setSelectedIds(clones.map((c) => c.id));
  }, [
    canDraw,
    selectedElements,
    elements,
    activeBoardId,
    userId,
    userName,
    recordUndo,
    onElementsBatchAdd,
    setSelectedIds,
  ]);

  const handleDeleteSelection = useCallback(() => {
    if (!canDraw || selectedElements.length === 0) return;
    recordUndo({ kind: 'remove', items: selectedElements });
    onElementsBatchRemove(selectedElements.map((el) => el.id));
    setSelectedIds([]);
  }, [canDraw, selectedElements, recordUndo, onElementsBatchRemove, setSelectedIds]);

  const handleSendSelectionToBoard = useCallback(
    (targetBoardId: string) => {
      if (!isTeacher || selectedElements.length === 0) return;
      const pieces = selectedElements.flatMap((el) => expandElementVisiblePieces(el, elements));
      if (pieces.length === 0) return;
      const now = Date.now();
      const clones: CanvasElement[] = pieces.map((el, idx) => ({
        ...el,
        points: el.points ? [...el.points] : undefined,
        id: `${Math.random().toString(36).substring(2, 9)}_${idx}`,
        boardId: targetBoardId === 'ALL_SUBBOARDS' ? activeBoardId : targetBoardId,
        timestamp: now + idx,
      }));
      onElementsBatchAdd(clones, targetBoardId);
      const label =
        targetBoardId === 'ALL_SUBBOARDS'
          ? 'All Boards in Current Round'
          : targetBoardId === 'main'
            ? 'Main Class Board'
            : subBoards[targetBoardId]?.title || 'Target Board';
      setSentFeedback(`Sent to ${label}`);
      setTimeout(() => setSentFeedback(null), 2200);
    },
    [isTeacher, selectedElements, elements, activeBoardId, subBoards, onElementsBatchAdd, setSentFeedback]
  );

  const commitEditingNote = useCallback(() => {
    if (!editingNote) return;
    const note = editingNote;
    setEditingNote(null);
    noteClosedAtRef.current = Date.now();

    if (!canDraw) return;
    const trimmed = note.value.replace(/\s+$/, '');

    if (note.existingId) {
      const existing = elements.find((el) => el.id === note.existingId);
      if (!existing) return; // Removed meanwhile (e.g. Undo or Clear)
      if (!trimmed.trim()) {
        recordUndo({ kind: 'remove', items: [existing] });
        onElementRemove(note.existingId);
        return;
      }
      const existingFont = getNoteFontSize(existing);
      const moved = note.worldX !== (existing.x || 0) || note.worldY !== (existing.y || 0);
      if (trimmed === existing.text && note.color === existing.color && note.fontSize === existingFont && !moved) {
        return;
      }
      const [w, h] = noteSize(trimmed, note.fontSize);
      const afterEl: CanvasElement = {
        ...existing,
        text: trimmed,
        color: note.color,
        strokeWidth: note.strokeWidth,
        fontSize: note.fontSize,
        x: note.worldX,
        y: note.worldY,
        width: w,
        height: h,
      };
      recordUndo({ kind: 'update', before: [existing], after: [afterEl], bringToFront: moved });
      onElementUpdate({
        id: note.existingId,
        text: trimmed,
        color: note.color,
        strokeWidth: note.strokeWidth,
        fontSize: note.fontSize,
        x: note.worldX,
        y: note.worldY,
        width: w,
        height: h,
        bringToFront: moved,
      });
      return;
    }

    if (!trimmed.trim()) return;
    const [w, h] = noteSize(trimmed, note.fontSize);
    const id = Math.random().toString(36).substring(2, 11);
    const newElement: CanvasElement = {
      id,
      boardId: activeBoardId,
      userId,
      userName,
      tool: 'text',
      color: note.color,
      strokeWidth: note.strokeWidth,
      fontSize: note.fontSize,
      x: note.worldX,
      y: note.worldY,
      width: w,
      height: h,
      text: trimmed,
      timestamp: Date.now(),
    };
    recordUndo({ kind: 'add', items: [newElement] });
    onElementStart(newElement);
  }, [
    editingNote,
    canDraw,
    elements,
    onElementRemove,
    onElementUpdate,
    recordUndo,
    activeBoardId,
    userId,
    userName,
    onElementStart,
    setEditingNote,
    noteClosedAtRef,
  ]);

  const openOrTapNoteAt = useCallback(
    (worldX: number, worldY: number, forceExisting?: CanvasElement | null) => {
      if (!canDraw) return;
      const tol = 8 / stageScale;
      const targetNote =
        forceExisting !== undefined
          ? forceExisting
          : hitEditableNote(elements, allGoneNoteIds, worldX, worldY, tol, userId, isTeacher);
      if (editingNote) {
        const editingSameNote = Boolean(targetNote && editingNote.existingId === targetNote.id);
        commitEditingNote();
        if (!targetNote || editingSameNote) {
          return;
        }
      }
      if (!targetNote && !forceExisting && Date.now() - noteClosedAtRef.current < 450) {
        return;
      }

      const safePenColor = penColor === '#ffffff' ? '#0f172a' : penColor;

      if (targetNote) {
        const f = getNoteFontSize(targetNote);
        setTextFontSize(f);
        saveLocal('allaboard-text-size', String(f));
        setEditingNote({
          existingId: targetNote.id,
          worldX: targetNote.x || 0,
          worldY: targetNote.y || 0,
          value: targetNote.text || '',
          color: targetNote.color || safePenColor,
          strokeWidth: targetNote.strokeWidth || penWidth,
          fontSize: f,
          openedAt: Date.now(),
        });
      } else {
        // Lift a new note by half a line height so the tap lands in the middle of its first line (OverBoard `makeTyping.open`)
        const liftedY = Math.round((worldY - (textFontSize * NOTE_LH) / 2) * 10) / 10;
        setEditingNote({
          existingId: null,
          worldX,
          worldY: liftedY,
          value: '',
          color: safePenColor,
          strokeWidth: penWidth,
          fontSize: textFontSize,
          openedAt: Date.now(),
        });
      }
    },
    [
      canDraw,
      editingNote,
      commitEditingNote,
      stageScale,
      elements,
      allGoneNoteIds,
      userId,
      isTeacher,
      penWidth,
      penColor,
      textFontSize,
      setEditingNote,
      setTextFontSize,
      noteClosedAtRef,
    ]
  );
  return {
    handleCopySelection,
    handlePasteElements,
    handleDuplicateSelection,
    handleDeleteSelection,
    handleSendSelectionToBoard,
    commitEditingNote,
    openOrTapNoteAt,
  };
}
