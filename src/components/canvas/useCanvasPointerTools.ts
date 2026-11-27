import React, { useEffect, useRef } from 'react';
import { CURSOR_EMIT_MS } from '../../lib/drawThrottle';
import type { ElementGroup } from '../../lib/elementGroups';
import { eraseGroups, eraseWithStroke } from '../../lib/eraserEdits';
import {
  LiveSmoothState,
  expandElementVisiblePieces,
  hasSubsequentOverlappingEraser,
  hitEditableNote,
  hitElementAtPoint,
  hlInk,
  lassoSelectElements,
  liveAddPoint,
  liveLiftPoint,
  liveStart,
  pointerKind,
  stampsHitByEraser,
  translateElement,
} from '../../lib/inkCore';
import { getTeacherStampAppearance, isTeacherStampKind } from '../../lib/stamps';
import {
  CanvasElement,
  HollowShapeKind,
  RemoteCursor,
  RoomBackground,
  StampKind,
  SubBoardData,
  ToolType,
} from '../../types';
import { PALM_ERASER_SCREEN_PX } from './canvasHelpers';
import { useCanvasNoteSelection } from './useCanvasNoteSelection';

import type { HistoryAction } from './canvasHelpers';
interface Options {
  onCursorMove: (cursor: Omit<RemoteCursor, 'updatedAt'>) => void;
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
  setStagePos: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  setIsSpacePressed: React.Dispatch<React.SetStateAction<boolean>>;
  performRedo: () => void;
  performUndo: () => void;
  pastePrompt: { worldX: number; worldY: number };
  worldPos: { x: number; y: number };
  setShowHotkeysModal: React.Dispatch<React.SetStateAction<boolean>>;
  setShowHollowMenu: React.Dispatch<React.SetStateAction<boolean>>;
  setShowHlMenu: React.Dispatch<React.SetStateAction<boolean>>;
  setTool: React.Dispatch<React.SetStateAction<ToolType>>;
  fitElementsAndBackgroundInView: (targetElements: CanvasElement[], targetBg: RoomBackground | null) => void;
  background: RoomBackground;
  resetView: () => void;
  setIsPanning: React.Dispatch<React.SetStateAction<boolean>>;
  activePointerIdRef: React.RefObject<number>;
  showHollowMenu: boolean;
  showHlMenu: boolean;
  showGridMenu: boolean;
  setShowGridMenu: React.Dispatch<React.SetStateAction<boolean>>;
  showStatusMenu: boolean;
  setShowStatusMenu: React.Dispatch<React.SetStateAction<boolean>>;
  showTextSizeMenu: boolean;
  setShowTextSizeMenu: React.Dispatch<React.SetStateAction<boolean>>;
  getLocalPosFromEvent: (clientX: number, clientY: number) => { x: number; y: number };
  screenToWorld: (sx: number, sy: number) => { x: number; y: number };
  fingerScrolls: boolean;
  effectiveTool: ToolType;
  containerRef: React.RefObject<HTMLDivElement>;
  laserStrokeRef: React.RefObject<string>;
  sendLaserPoint: (world: { x: number; y: number }, force?: boolean) => void;
  setIsMovingBg: React.Dispatch<React.SetStateAction<boolean>>;
  selectionBounds: [number, number, number, number];
  selectedIds: string[];
  setLassoPoints: React.Dispatch<React.SetStateAction<number[]>>;
  stampKind: StampKind;
  nameStampTaken: boolean;
  customTeacherStampText: string;
  color: string;
  userColor: string;
  strokeWidth: number;
  setCurrentElementId: React.Dispatch<React.SetStateAction<string>>;
  setIsDrawing: React.Dispatch<React.SetStateAction<boolean>>;
  isCoverMode: boolean;
  coverColor: string;
  hlColor: string;
  hlStrength: number;
  hollowShape: HollowShapeKind;
  hollowWeight: number;
  setScreenPos: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  setWorldPos: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  pointerOverCanvas: boolean;
  setPointerOverCanvas: React.Dispatch<React.SetStateAction<boolean>>;
  isDrawing: boolean;
  isPanning: boolean;
  setHoveredNoteId: React.Dispatch<React.SetStateAction<string>>;
  hoveredNoteId: string;
  setDraggingNotePreview: React.Dispatch<React.SetStateAction<{ id: string; dx: number; dy: number }>>;
  setSelectionDragOffset: React.Dispatch<React.SetStateAction<{ dx: number; dy: number }>>;
  isMovingBg: boolean;
  onTeacherUpdateBackground: (patch: Partial<RoomBackground>) => void;
  currentElementId: string;
  smoothLevel: number;
  onElementAppendPoints: (id: string, newPoints: number[]) => void;
  onElementsBatchUpdate: (updates: Array<Partial<CanvasElement> & { id: string }>, bringToFront?: boolean) => void;
  onElementsReplace: (groups: ElementGroup<CanvasElement>[]) => void;
}
export function useCanvasPointerTools({
  onCursorMove,
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
  setStagePos,
  setIsSpacePressed,
  performRedo,
  performUndo,
  pastePrompt,
  worldPos,
  setShowHotkeysModal,
  setShowHollowMenu,
  setShowHlMenu,
  setTool,
  fitElementsAndBackgroundInView,
  background,
  resetView,
  setIsPanning,
  activePointerIdRef,
  showHollowMenu,
  showHlMenu,
  showGridMenu,
  setShowGridMenu,
  showStatusMenu,
  setShowStatusMenu,
  showTextSizeMenu,
  setShowTextSizeMenu,
  getLocalPosFromEvent,
  screenToWorld,
  fingerScrolls,
  effectiveTool,
  containerRef,
  laserStrokeRef,
  sendLaserPoint,
  setIsMovingBg,
  selectionBounds,
  selectedIds,
  setLassoPoints,
  stampKind,
  nameStampTaken,
  customTeacherStampText,
  color,
  userColor,
  strokeWidth,
  setCurrentElementId,
  setIsDrawing,
  isCoverMode,
  coverColor,
  hlColor,
  hlStrength,
  hollowShape,
  hollowWeight,
  setScreenPos,
  setWorldPos,
  pointerOverCanvas,
  setPointerOverCanvas,
  isDrawing,
  isPanning,
  setHoveredNoteId,
  hoveredNoteId,
  setDraggingNotePreview,
  setSelectionDragOffset,
  isMovingBg,
  onTeacherUpdateBackground,
  currentElementId,
  smoothLevel,
  onElementAppendPoints,
  onElementsBatchUpdate,
  onElementsReplace,
}: Options) {
  const panStartRef = useRef<{
    x: number;
    y: number;
    stageX: number;
    stageY: number;
    tapForNote?: boolean;
  } | null>(null);
  const bgMoveStartRef = useRef<{ worldX: number; worldY: number; origX: number; origY: number } | null>(null);
  const activeStrokeToolRef = useRef<Exclude<ToolType, 'pan' | 'select' | 'move-bg' | 'laser'> | null>(null);
  const activeStrokePointsRef = useRef<number[]>([]);
  const liveSmoothRef = useRef<LiveSmoothState | null>(null);
  const downAtRef = useRef<number>(0);
  const shapeOriginRef = useRef<{ x: number; y: number } | null>(null);
  const pendingStrokeRef = useRef<CanvasElement | null>(null);
  const draggingNoteRef = useRef<{
    note: CanvasElement;
    startClientX: number;
    startClientY: number;
    startWorldX: number;
    startWorldY: number;
    moved: boolean;
  } | null>(null);
  const selectGestureRef = useRef<{
    mode: 'drag-selection' | 'drag-single' | 'lasso';
    startClientX: number;
    startClientY: number;
    startWorldX: number;
    startWorldY: number;
    targetIds: string[];
    prevSelectedIds: string[];
    singleEl?: CanvasElement;
    shiftKey: boolean;
    moved: boolean;
    loopPoints: number[];
  } | null>(null);
  useEffect(() => {
    setSelectedIds([]);
    setLassoPoints([]);
    setSelectionDragOffset(null);
    setDraggingNotePreview(null);
    setPastePrompt(null);
    setEditingNote(null);
    draggingNoteRef.current = null;
    selectGestureRef.current = null;
  }, [activeBoardId]);

  const lastCursorEmitRef = useRef<number>(0);

  const pendingCursorRef = useRef<Parameters<typeof onCursorMove>[0] | null>(null);

  const cursorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onCursorMoveRef = useRef(onCursorMove);

  onCursorMoveRef.current = onCursorMove;

  useEffect(
    () => () => {
      if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current);
    },
    []
  );

  const {
    handleCopySelection,
    handlePasteElements,
    handleDuplicateSelection,
    handleDeleteSelection,
    handleSendSelectionToBoard,
    commitEditingNote,
    openOrTapNoteAt,
  } = useCanvasNoteSelection({
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
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      const keyLower = e.key.toLowerCase();

      // Arrow keys always pan the board (Unity / Unreal style camera movement)
      if (
        !mod &&
        !e.altKey &&
        !editingNote &&
        (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      ) {
        e.preventDefault();
        const panStep = e.shiftKey ? 200 : 72;
        const dx = e.key === 'ArrowLeft' ? panStep : e.key === 'ArrowRight' ? -panStep : 0;
        const dy = e.key === 'ArrowUp' ? panStep : e.key === 'ArrowDown' ? -panStep : 0;
        setStagePos((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
        return;
      }

      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        setIsSpacePressed(true);
      } else if (mod && keyLower === 'z' && e.shiftKey) {
        e.preventDefault();
        if (editingNote) commitEditingNote();
        performRedo();
      } else if (mod && keyLower === 'y') {
        e.preventDefault();
        if (editingNote) commitEditingNote();
        performRedo();
      } else if (mod && keyLower === 'z') {
        e.preventDefault();
        if (editingNote) commitEditingNote();
        performUndo();
      } else if (mod && keyLower === 'c' && selectedElements.length > 0) {
        e.preventDefault();
        handleCopySelection();
      } else if (mod && keyLower === 'v' && clipboardElements.length > 0 && canDraw) {
        e.preventDefault();
        handlePasteElements(pastePrompt ? { x: pastePrompt.worldX, y: pastePrompt.worldY } : worldPos);
      } else if (mod && keyLower === 'd' && selectedElements.length > 0 && canDraw) {
        e.preventDefault();
        handleDuplicateSelection();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedElements.length > 0 && canDraw) {
        e.preventDefault();
        handleDeleteSelection();
      } else if (e.key === 'Escape') {
        setSelectedIds([]);
        setPastePrompt(null);
        setShowHotkeysModal(false);
        setShowHollowMenu(false);
        setShowHlMenu(false);
      } else if (!mod && !e.altKey && !editingNote) {
        if (e.key === '?') {
          e.preventDefault();
          setShowHotkeysModal((prev) => !prev);
        } else if (keyLower === 'h') {
          e.preventDefault();
          setTool('pan');
        } else if ((keyLower === 'p' || keyLower === 'b') && canDraw) {
          e.preventDefault();
          setTool('solid');
        } else if (keyLower === 'e' && canDraw) {
          e.preventDefault();
          setTool('eraser');
        } else if (keyLower === 'v' && canDraw) {
          e.preventDefault();
          setTool('select');
        } else if (keyLower === 'm' && canDraw) {
          e.preventDefault();
          setTool('highlighter');
        } else if (keyLower === 't' && canDraw) {
          e.preventDefault();
          setTool('text');
        } else if (keyLower === 'l' && canDraw) {
          e.preventDefault();
          setTool('line');
        } else if (keyLower === 'r' && canDraw) {
          e.preventDefault();
          setTool('rect');
        } else if (keyLower === 'c' && canDraw) {
          e.preventDefault();
          setTool('circle');
        } else if (keyLower === 's' && canDraw) {
          e.preventDefault();
          setTool('stamp');
        } else if (keyLower === 'f') {
          e.preventDefault();
          fitElementsAndBackgroundInView(elements, background);
        } else if (e.key === '0') {
          e.preventDefault();
          resetView();
        }
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setIsSpacePressed(false);
        setIsPanning(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [
    canDraw,
    editingNote,
    commitEditingNote,
    performUndo,
    performRedo,
    selectedElements.length,
    clipboardElements.length,
    handleCopySelection,
    handlePasteElements,
    handleDuplicateSelection,
    handleDeleteSelection,
    pastePrompt,
    worldPos,
    elements,
    background,
    fitElementsAndBackgroundInView,
    resetView,
  ]);

  const handleViewportPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const targetEl = e.target as HTMLElement | null;
    if (targetEl && targetEl.closest && targetEl.closest('[data-hud="true"], button, input, textarea, select')) {
      return;
    }
    if (activePointerIdRef.current !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;

    if (showHollowMenu) {
      setShowHollowMenu(false);
    }
    if (showHlMenu) {
      setShowHlMenu(false);
    }
    if (showGridMenu) {
      setShowGridMenu(false);
    }
    if (showStatusMenu) {
      setShowStatusMenu(false);
    }
    if (showTextSizeMenu) {
      setShowTextSizeMenu(false);
    }

    const pos = getLocalPosFromEvent(e.clientX, e.clientY);
    const world = screenToWorld(pos.x, pos.y);
    const kind = pointerKind(e);
    const isMiddleClick = e.pointerType === 'mouse' && e.button === 1;

    // In OverBoard, when "Finger: pans" is enabled, a finger drag pans cleanly
    const shouldFingerPan = kind === 'finger' && fingerScrolls && !isMiddleClick;

    if (effectiveTool === 'pan' || isMiddleClick || shouldFingerPan) {
      activePointerIdRef.current = e.pointerId;
      try {
        containerRef.current?.setPointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
      setIsPanning(true);
      panStartRef.current = {
        x: pos.x,
        y: pos.y,
        stageX: stagePos.x,
        stageY: stagePos.y,
        tapForNote: false,
      };
      e.preventDefault();
      return;
    }

    if (effectiveTool === 'laser' && isTeacher) {
      activePointerIdRef.current = e.pointerId;
      laserStrokeRef.current = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      try {
        containerRef.current?.setPointerCapture(e.pointerId);
      } catch {
        /* Capture may fail if pointer ended. */
      }
      sendLaserPoint(world, true);
      e.preventDefault();
      return;
    }

    // Teacher dragging background worksheet
    if (effectiveTool === 'move-bg') {
      if (isTeacher && background) {
        activePointerIdRef.current = e.pointerId;
        try {
          containerRef.current?.setPointerCapture(e.pointerId);
        } catch {
          // Ignore
        }
        setIsMovingBg(true);
        bgMoveStartRef.current = {
          worldX: world.x,
          worldY: world.y,
          origX: background.x || 0,
          origY: background.y || 0,
        };
      }
      return;
    }

    if (!canDraw) return;

    // OverBoard `makeSelect`: tap or drag existing element/selection box, or draw lasso loop to multi-select
    if (effectiveTool === 'select' && kind !== 'palm') {
      if (editingNote) {
        commitEditingNote();
      }
      setPastePrompt(null);
      activePointerIdRef.current = e.pointerId;
      try {
        containerRef.current?.setPointerCapture(e.pointerId);
      } catch {
        // Ignore
      }

      const boxPad = 8 / stageScale;
      const hitInsideBox =
        selectionBounds &&
        selectedElements.length > 0 &&
        world.x >= selectionBounds[0] - boxPad &&
        world.x <= selectionBounds[2] + boxPad &&
        world.y >= selectionBounds[1] - boxPad &&
        world.y <= selectionBounds[3] + boxPad;

      if (!e.shiftKey && hitInsideBox) {
        selectGestureRef.current = {
          mode: 'drag-selection',
          startClientX: e.clientX,
          startClientY: e.clientY,
          startWorldX: world.x,
          startWorldY: world.y,
          targetIds: selectedElements.map((el) => el.id),
          prevSelectedIds: [...selectedIds],
          shiftKey: false,
          moved: false,
          loopPoints: [],
        };
      } else {
        const hitEl = hitElementAtPoint(elements, allGoneNoteIds, world.x, world.y, 10 / stageScale, userId, isTeacher);
        if (hitEl) {
          const prevIds = [...selectedIds];
          const combinedShiftIds = prevIds.includes(hitEl.id) ? prevIds : [...prevIds, hitEl.id];
          if (!e.shiftKey) {
            setSelectedIds([hitEl.id]);
          }
          selectGestureRef.current = {
            mode: 'drag-single',
            startClientX: e.clientX,
            startClientY: e.clientY,
            startWorldX: world.x,
            startWorldY: world.y,
            targetIds: e.shiftKey ? combinedShiftIds : [hitEl.id],
            prevSelectedIds: prevIds,
            singleEl: hitEl,
            shiftKey: e.shiftKey,
            moved: false,
            loopPoints: [],
          };
        } else {
          if (!e.shiftKey) {
            setSelectedIds([]);
          }
          setLassoPoints([world.x, world.y]);
          selectGestureRef.current = {
            mode: 'lasso',
            startClientX: e.clientX,
            startClientY: e.clientY,
            startWorldX: world.x,
            startWorldY: world.y,
            targetIds: [],
            prevSelectedIds: [...selectedIds],
            shiftKey: e.shiftKey,
            moved: false,
            loopPoints: [world.x, world.y],
          };
        }
      }
      e.preventDefault();
      return;
    }

    // Type tool: drag existing note directly (>= 6px moves it, tap < 6px edits), or drag/tap empty canvas
    if (effectiveTool === 'text' && kind !== 'palm') {
      const hitNote = hitEditableNote(elements, allGoneNoteIds, world.x, world.y, 10 / stageScale, userId, isTeacher);
      if (hitNote && hitNote.id !== editingNote?.existingId) {
        if (editingNote) {
          commitEditingNote();
        }
        activePointerIdRef.current = e.pointerId;
        try {
          containerRef.current?.setPointerCapture(e.pointerId);
        } catch {
          // Ignore
        }
        draggingNoteRef.current = {
          note: hitNote,
          startClientX: e.clientX,
          startClientY: e.clientY,
          startWorldX: world.x,
          startWorldY: world.y,
          moved: false,
        };
        e.preventDefault();
        return;
      }

      activePointerIdRef.current = e.pointerId;
      try {
        containerRef.current?.setPointerCapture(e.pointerId);
      } catch {
        // Ignore
      }
      setIsPanning(true);
      panStartRef.current = {
        x: pos.x,
        y: pos.y,
        stageX: stagePos.x,
        stageY: stagePos.y,
        tapForNote: true,
      };
      e.preventDefault();
      return;
    }

    // If a note was open and the user started drawing with another tool, commit the note first
    if (editingNote) {
      commitEditingNote();
    }

    const id = Math.random().toString(36).substring(2, 11);

    // SMART Board palm / pen-eraser automatically erases regardless of selected tool (OverBoard `pointerKind(e) === 'palm'`)
    const strokeTool: Exclude<ToolType, 'pan' | 'select' | 'move-bg' | 'laser'> =
      kind === 'palm' ? 'eraser' : (effectiveTool as Exclude<ToolType, 'pan' | 'select' | 'move-bg' | 'laser'>);

    // One-click Stamp placement (when not using palm eraser)
    if (strokeTool === 'stamp') {
      const effectiveStampKind: StampKind = !isTeacher && isTeacherStampKind(stampKind) ? 'check' : stampKind;
      if (effectiveStampKind === 'username' && nameStampTaken) {
        setTool('select'); // Their stamp is already down, so let them drag it instead
        return;
      }
      const customText =
        effectiveStampKind === 'teacher-custom' ? customTeacherStampText.trim().slice(0, 24) || 'FEEDBACK' : undefined;
      const teacherMeta = getTeacherStampAppearance(
        effectiveStampKind,
        customText,
        color === '#ffffff' ? '#7c3aed' : color
      );
      const stampElement: CanvasElement = {
        id,
        boardId: activeBoardId,
        userId,
        userName,
        tool: 'stamp',
        stamp: effectiveStampKind,
        ...(customText ? { text: customText } : {}),
        color: teacherMeta ? teacherMeta.color : color === '#ffffff' ? userColor : color,
        strokeWidth,
        x: world.x,
        y: world.y,
        timestamp: Date.now(),
      };
      recordUndo({ kind: 'add', items: [stampElement] });
      onElementStart(stampElement);
      return;
    }

    activePointerIdRef.current = e.pointerId;
    try {
      containerRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // Ignore
    }

    setCurrentElementId(id);
    setIsDrawing(true);
    activeStrokeToolRef.current = strokeTool;
    downAtRef.current = performance.now();

    if (strokeTool === 'rect' || strokeTool === 'circle') {
      shapeOriginRef.current = { x: world.x, y: world.y };
      const newElement: CanvasElement = {
        id,
        boardId: activeBoardId,
        userId,
        userName,
        tool: strokeTool,
        color,
        strokeWidth,
        x: world.x,
        y: world.y,
        width: 0,
        height: 0,
        timestamp: Date.now(),
      };
      pendingStrokeRef.current = newElement;
      onElementStart(newElement);
    } else if (strokeTool === 'line') {
      shapeOriginRef.current = { x: world.x, y: world.y };
      const newElement: CanvasElement = {
        id,
        boardId: activeBoardId,
        userId,
        userName,
        tool: 'line',
        color,
        strokeWidth,
        points: [world.x, world.y, world.x, world.y],
        timestamp: Date.now(),
      };
      pendingStrokeRef.current = newElement;
      onElementStart(newElement);
    } else {
      // Freehand stroke: solid, hollow, spray, highlighter (see-through or cover), or eraser (personal or palm)
      const effectiveStrokeWidth =
        kind === 'palm' ? Math.max(12, Math.round((PALM_ERASER_SCREEN_PX / stageScale) * 10) / 10) : strokeWidth;

      const isHlCover = strokeTool === 'highlighter' && isCoverMode;
      const strokeColor = strokeTool === 'highlighter' ? (isHlCover ? coverColor : hlInk(hlColor, hlStrength)) : color;

      activeStrokePointsRef.current = [world.x, world.y];
      liveSmoothRef.current = liveStart(world.x, world.y);

      const newElement: CanvasElement = {
        id,
        boardId: activeBoardId,
        userId,
        userName,
        tool: strokeTool,
        color: strokeColor,
        strokeWidth: effectiveStrokeWidth,
        hollowShape: strokeTool === 'hollow' ? hollowShape : undefined,
        hollowWeight: strokeTool === 'hollow' ? hollowWeight : undefined,
        hlStrength: strokeTool === 'highlighter' && !isHlCover ? hlStrength : undefined,
        isCover: isHlCover ? true : undefined,
        points: [world.x, world.y],
        timestamp: Date.now(),
      };
      pendingStrokeRef.current = newElement;
      onElementStart(newElement);
    }
    e.preventDefault();
  };

  const handleViewportPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const pos = getLocalPosFromEvent(e.clientX, e.clientY);
    setScreenPos(pos);
    const world = screenToWorld(pos.x, pos.y);
    setWorldPos(world);
    if (!pointerOverCanvas) setPointerOverCanvas(true);

    // Highlight hover state when over an editable text note in Type mode or selectable item in Select mode
    if (!isDrawing && !isPanning && !draggingNoteRef.current && !selectGestureRef.current && canDraw) {
      if (effectiveTool === 'text') {
        const hit = hitEditableNote(elements, allGoneNoteIds, world.x, world.y, 8 / stageScale, userId, isTeacher);
        setHoveredNoteId(hit ? hit.id : null);
      } else if (effectiveTool === 'select') {
        const hit = hitElementAtPoint(elements, allGoneNoteIds, world.x, world.y, 10 / stageScale, userId, isTeacher);
        if (hit) {
          setHoveredNoteId(hit.id);
        } else if (selectionBounds) {
          const pad = 8 / stageScale;
          const [sx1, sy1, sx2, sy2] = selectionBounds;
          const insideBox =
            world.x >= sx1 - pad && world.x <= sx2 + pad && world.y >= sy1 - pad && world.y <= sy2 + pad;
          setHoveredNoteId(insideBox ? '__selection_box__' : null);
        } else {
          setHoveredNoteId(null);
        }
      } else if (hoveredNoteId !== null) {
        setHoveredNoteId(null);
      }
    }

    const cursor = {
      userId,
      userName,
      color: userColor,
      boardId: activeBoardId,
      x: world.x,
      y: world.y,
      tool: effectiveTool,
      isDrawing,
    };
    const wait = CURSOR_EMIT_MS - (Date.now() - lastCursorEmitRef.current);
    if (wait <= 0) {
      if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current);
      cursorTimerRef.current = null;
      pendingCursorRef.current = null;
      lastCursorEmitRef.current = Date.now();
      onCursorMove(cursor);
    } else {
      pendingCursorRef.current = cursor;
      if (!cursorTimerRef.current) {
        cursorTimerRef.current = setTimeout(() => {
          cursorTimerRef.current = null;
          const latest = pendingCursorRef.current;
          pendingCursorRef.current = null;
          if (!latest) return;
          lastCursorEmitRef.current = Date.now();
          onCursorMoveRef.current(latest);
        }, wait);
      }
    }

    if (e.pointerId !== activePointerIdRef.current) return;

    if (laserStrokeRef.current) {
      sendLaserPoint(world);
      return;
    }

    // Direct text note drag preview in Type mode
    if (draggingNoteRef.current) {
      const drag = draggingNoteRef.current;
      const distClient = Math.hypot(e.clientX - drag.startClientX, e.clientY - drag.startClientY);
      if (!drag.moved && distClient >= 6) {
        drag.moved = true;
      }
      if (drag.moved) {
        setDraggingNotePreview({
          id: drag.note.id,
          dx: world.x - drag.startWorldX,
          dy: world.y - drag.startWorldY,
        });
      }
      return;
    }

    // Select / Lasso gesture move
    if (selectGestureRef.current) {
      const g = selectGestureRef.current;
      const distClient = Math.hypot(e.clientX - g.startClientX, e.clientY - g.startClientY);
      if (g.mode === 'drag-selection' || g.mode === 'drag-single') {
        if (!g.moved && distClient >= 6) {
          g.moved = true;
          if (g.mode === 'drag-single' && g.shiftKey && g.singleEl && !g.prevSelectedIds.includes(g.singleEl.id)) {
            setSelectedIds(g.targetIds);
          }
        }
        if (g.moved) {
          setSelectionDragOffset({
            dx: world.x - g.startWorldX,
            dy: world.y - g.startWorldY,
          });
        }
      } else if (g.mode === 'lasso') {
        if (!g.moved && distClient >= 6) {
          g.moved = true;
        }
        const pts = g.loopPoints;
        const lastX = pts[pts.length - 2];
        const lastY = pts[pts.length - 1];
        if (Math.hypot(world.x - lastX, world.y - lastY) >= 3 / stageScale) {
          pts.push(world.x, world.y);
          setLassoPoints([...pts]);
        }
      }
      return;
    }

    if (isPanning && panStartRef.current) {
      const dx = pos.x - panStartRef.current.x;
      const dy = pos.y - panStartRef.current.y;
      // In Type mode, require 8px drag threshold before panning so a tap cleanly opens/edits a note (OverBoard v45)
      if (panStartRef.current.tapForNote && Math.abs(dx) + Math.abs(dy) < 8) {
        return;
      }
      panStartRef.current.tapForNote = false;
      setStagePos({
        x: panStartRef.current.stageX + dx,
        y: panStartRef.current.stageY + dy,
      });
      return;
    }

    if (isMovingBg && bgMoveStartRef.current && isTeacher && background) {
      const dx = world.x - bgMoveStartRef.current.worldX;
      const dy = world.y - bgMoveStartRef.current.worldY;
      onTeacherUpdateBackground({
        x: Math.round(bgMoveStartRef.current.origX + dx),
        y: Math.round(bgMoveStartRef.current.origY + dy),
      });
      return;
    }

    if (!isDrawing || !currentElementId) return;
    const strokeTool = activeStrokeToolRef.current || effectiveTool;

    if (strokeTool === 'rect' || strokeTool === 'circle') {
      const origin = shapeOriginRef.current;
      if (!origin) return;
      const width = Number((world.x - origin.x).toFixed(1));
      const height = Number((world.y - origin.y).toFixed(1));
      if (pendingStrokeRef.current) {
        pendingStrokeRef.current = { ...pendingStrokeRef.current, width, height };
      }
      onElementUpdate({
        id: currentElementId,
        x: origin.x,
        y: origin.y,
        width,
        height,
      });
    } else if (strokeTool === 'line') {
      const origin = shapeOriginRef.current;
      if (!origin) return;
      const nextPts = [origin.x, origin.y, world.x, world.y];
      if (pendingStrokeRef.current) {
        pendingStrokeRef.current = { ...pendingStrokeRef.current, points: nextPts };
      }
      onElementUpdate({
        id: currentElementId,
        points: nextPts,
      });
    } else if (liveSmoothRef.current) {
      // Only unpack getCoalescedEvents() when smoothing > 0; at smoothLevel === 0 (default for Chromebooks),
      // sample the frame pointer event directly with a larger step threshold so React/Konva isn't flooded.
      const rawEvt = e.nativeEvent;
      const coalesced: PointerEvent[] =
        smoothLevel > 0 && typeof rawEvt.getCoalescedEvents === 'function' && rawEvt.getCoalescedEvents().length > 0
          ? rawEvt.getCoalescedEvents()
          : [rawEvt];

      const appended: number[] = [];
      const minDist = smoothLevel === 0 ? Math.max(1.2, 1.5 / stageScale) : Math.max(0.4, 0.7 / stageScale);
      for (const ev of coalesced) {
        const evPos = getLocalPosFromEvent(ev.clientX, ev.clientY);
        const evWorld = screenToWorld(evPos.x, evPos.y);
        const pt = liveAddPoint(
          activeStrokePointsRef.current,
          liveSmoothRef.current,
          evWorld.x,
          evWorld.y,
          smoothLevel,
          minDist
        );
        if (pt) {
          appended.push(pt[0], pt[1]);
        }
      }
      if (appended.length > 0) {
        onElementAppendPoints(currentElementId, appended);
      }
    }
  };

  const handleViewportPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== activePointerIdRef.current) return;
    activePointerIdRef.current = null;
    if (laserStrokeRef.current) {
      if (e.type === 'pointerup') {
        const pos = getLocalPosFromEvent(e.clientX, e.clientY);
        sendLaserPoint(screenToWorld(pos.x, pos.y), true);
      }
      laserStrokeRef.current = null;
      return;
    }

    const pos = getLocalPosFromEvent(e.clientX, e.clientY);
    const world = screenToWorld(pos.x, pos.y);

    if (draggingNoteRef.current) {
      const drag = draggingNoteRef.current;
      draggingNoteRef.current = null;
      setDraggingNotePreview(null);
      if (e.type === 'pointerup') {
        if (drag.moved) {
          const dx = Math.round((world.x - drag.startWorldX) * 10) / 10;
          const dy = Math.round((world.y - drag.startWorldY) * 10) / 10;
          if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
            const movedNote = translateElement(drag.note, dx, dy);
            recordUndo({
              kind: 'update',
              before: [drag.note],
              after: [movedNote],
              bringToFront: true,
            });
            onElementUpdate({
              id: drag.note.id,
              x: movedNote.x,
              y: movedNote.y,
              bringToFront: true,
            });
          }
        } else {
          openOrTapNoteAt(world.x, world.y, drag.note);
        }
      }
      return;
    }

    if (selectGestureRef.current) {
      const g = selectGestureRef.current;
      selectGestureRef.current = null;
      setSelectionDragOffset(null);
      setLassoPoints([]);

      if (e.type !== 'pointerup') return;

      if (g.mode === 'drag-selection' || g.mode === 'drag-single') {
        if (g.moved) {
          const dx = Math.round((world.x - g.startWorldX) * 10) / 10;
          const dy = Math.round((world.y - g.startWorldY) * 10) / 10;
          const idSet = new Set(g.targetIds);
          const beforeItems = elements.filter((el) => idSet.has(el.id));
          if (beforeItems.length > 0 && (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1)) {
            const expandedBefore: CanvasElement[] = [];
            let hadPartialErase = false;
            for (const el of beforeItems) {
              const pieces = expandElementVisiblePieces(el, elements);
              if (pieces.length !== 1 || pieces[0] !== el) {
                hadPartialErase = true;
              }
              expandedBefore.push(...pieces);
            }
            if (expandedBefore.length === 0) return;

            if (hadPartialErase) {
              const now = Date.now();
              const addedItems: CanvasElement[] = expandedBefore.map((piece, idx) => {
                const shifted = translateElement(piece, dx, dy);
                return {
                  ...shifted,
                  id: `${Math.random().toString(36).substring(2, 9)}_${idx}`,
                  timestamp: now + idx,
                };
              });
              const removedIds = beforeItems.map((el) => el.id);
              recordUndo({
                kind: 'replace',
                removed: beforeItems,
                added: addedItems,
              });
              onElementsBatchRemove(removedIds);
              onElementsBatchAdd(addedItems, activeBoardId);
              setSelectedIds(addedItems.map((el) => el.id));
            } else {
              const afterItems = beforeItems.map((el) => translateElement(el, dx, dy));
              const updates = afterItems.map((a) =>
                a.points ? { id: a.id, points: a.points } : { id: a.id, x: a.x, y: a.y }
              );
              const bringToFront = !beforeItems.some((el) => hasSubsequentOverlappingEraser(el, elements));
              recordUndo({
                kind: 'update',
                before: beforeItems,
                after: afterItems,
                bringToFront,
              });
              onElementsBatchUpdate(updates, bringToFront);
            }
          }
        } else if (g.singleEl && g.shiftKey) {
          const hitId = g.singleEl.id;
          const prev = g.prevSelectedIds;
          setSelectedIds(prev.includes(hitId) ? prev.filter((id) => id !== hitId) : [...prev, hitId]);
        }
      } else if (g.mode === 'lasso') {
        if (g.moved && g.loopPoints.length >= 6) {
          const picked = lassoSelectElements(elements, allGoneNoteIds, g.loopPoints, userId, isTeacher);
          const pickedIds = picked.map((el) => el.id);
          if (g.shiftKey) {
            const merged = new Set([...g.prevSelectedIds, ...pickedIds]);
            setSelectedIds(Array.from(merged));
          } else {
            setSelectedIds(pickedIds);
          }
        } else {
          if (!g.shiftKey) setSelectedIds([]);
          if (clipboardElements.length > 0) {
            setPastePrompt({ worldX: world.x, worldY: world.y });
          }
        }
      }
      return;
    }

    if (isPanning) {
      const panInfo = panStartRef.current;
      setIsPanning(false);
      panStartRef.current = null;
      // OverBoard v45 Type tool: a tap (< 8px movement) creates a note or opens the clicked note for re-typing!
      if (
        e.type === 'pointerup' &&
        panInfo?.tapForNote &&
        Math.abs(pos.x - panInfo.x) + Math.abs(pos.y - panInfo.y) < 8
      ) {
        openOrTapNoteAt(world.x, world.y);
      }
      return;
    }

    if (isMovingBg) {
      setIsMovingBg(false);
      bgMoveStartRef.current = null;
      return;
    }

    if (isDrawing && currentElementId) {
      const id = currentElementId;
      const strokeTool = activeStrokeToolRef.current;
      const pts = activeStrokePointsRef.current;
      const pending = pendingStrokeRef.current;
      pendingStrokeRef.current = null;

      setIsDrawing(false);
      setCurrentElementId(null);
      activeStrokeToolRef.current = null;
      shapeOriginRef.current = null;
      liveSmoothRef.current = null;

      // OverBoard hardware blip filter: drop accidental <15ms pen/hand switch blips
      if (
        strokeTool !== 'rect' &&
        strokeTool !== 'circle' &&
        strokeTool !== 'line' &&
        performance.now() - downAtRef.current < 15 &&
        pts.length <= 4
      ) {
        onElementRemove(id);
        return;
      }

      // Catch up smoothed stroke to exact pen-lift point (`liveLiftPoint`)
      if (e.type === 'pointerup' && strokeTool !== 'rect' && strokeTool !== 'circle' && strokeTool !== 'line') {
        const liftPt = liveLiftPoint(pts, world.x, world.y, Math.max(0.2, 0.5 / stageScale));
        if (liftPt) {
          pts.push(liftPt[0], liftPt[1]);
          onElementAppendPoints(id, [liftPt[0], liftPt[1]]);
        }
      }

      if (pending) {
        const completed: CanvasElement =
          strokeTool === 'rect' || strokeTool === 'circle' || strokeTool === 'line'
            ? pending
            : { ...pending, points: [...pts] };
        if (strokeTool === 'eraser' && onElementsReplace) {
          // The real eraser: on pen-up the stroke becomes edits (ink split or removed, notes and stamps removed)
          // and the eraser stroke itself goes away, except over rectangles/circles it only partly covers.
          // One undo step puts everything back where it was in the stacking order.
          const board = elements.map((el) => (el.id === completed.id ? completed : el));
          if (!board.some((el) => el.id === completed.id)) board.push(completed);
          const result = eraseWithStroke(board, completed, () => Math.random().toString(36).substring(2, 11));
          const { forward, backward } = eraseGroups(result, completed.id);
          onElementsReplace(forward);
          if (result.edits.length > 0 || result.keptEraser.length > 0) {
            recordUndo({ kind: 'groups', forward, backward });
          }
          return;
        }
        // Erasing a stamp deletes it (one undo step brings both back), so one-name-stamp mode frees the name stamp.
        const erasedStamps = strokeTool === 'eraser' ? stampsHitByEraser(elements, completed) : [];
        if (erasedStamps.length > 0) {
          onElementsBatchRemove(erasedStamps.map((el) => el.id));
          recordUndo({ kind: 'replace', removed: erasedStamps, added: [completed] });
        } else {
          recordUndo({ kind: 'add', items: [completed] });
        }
      }
    }
  };

  const handleViewportDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canDraw) return;
    const pos = getLocalPosFromEvent(e.clientX, e.clientY);
    const world = screenToWorld(pos.x, pos.y);
    const hit = hitEditableNote(elements, allGoneNoteIds, world.x, world.y, 10 / stageScale, userId, isTeacher);
    if (hit) {
      e.preventDefault();
      openOrTapNoteAt(world.x, world.y, hit);
    }
  };
  return {
    commitEditingNote,
    openOrTapNoteAt,
    handleCopySelection,
    handlePasteElements,
    handleDuplicateSelection,
    handleDeleteSelection,
    handleSendSelectionToBoard,
    handleViewportPointerDown,
    handleViewportPointerMove,
    handleViewportPointerUp,
    handleViewportDoubleClick,
  };
}
