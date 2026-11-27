import { useRef, useState } from 'react';
import type { CanvasElement } from '../../types';

export function useCanvasInteractionState() {
  const [isSpacePressed, setIsSpacePressed] = useState(false);

  const [isPanning, setIsPanning] = useState(false);

  const [isMovingBg, setIsMovingBg] = useState(false);

  const [isDrawing, setIsDrawing] = useState(false);

  const [currentElementId, setCurrentElementId] = useState<string | null>(null);

  const activePointerIdRef = useRef<number | null>(null);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const [lassoPoints, setLassoPoints] = useState<number[]>([]);

  const [selectionDragOffset, setSelectionDragOffset] = useState<{ dx: number; dy: number } | null>(null);

  const [draggingNotePreview, setDraggingNotePreview] = useState<{ id: string; dx: number; dy: number } | null>(null);

  const [clipboardElements, setClipboardElements] = useState<CanvasElement[]>([]);

  const [pastePrompt, setPastePrompt] = useState<{ worldX: number; worldY: number } | null>(null);

  const [sendToBoardTarget, setSendToBoardTarget] = useState<string>('ALL_SUBBOARDS');

  const [sentFeedback, setSentFeedback] = useState<string | null>(null);

  const [screenPos, setScreenPos] = useState({ x: -100, y: -100 });

  const [worldPos, setWorldPos] = useState({ x: 0, y: 0 });

  // Avoid drawing the pointer preview at world (0,0) before the pointer enters the canvas.
  const [pointerOverCanvas, setPointerOverCanvas] = useState(false);

  const [hoveredNoteId, setHoveredNoteId] = useState<string | null>(null);

  const [editingNote, setEditingNote] = useState<{
    existingId: string | null;
    worldX: number;
    worldY: number;
    value: string;
    color: string;
    strokeWidth: number;
    fontSize: number;
    openedAt: number;
  } | null>(null);

  const noteTextareaRef = useRef<HTMLTextAreaElement>(null);

  const noteClosedAtRef = useRef<number>(0);
  return {
    isSpacePressed,
    setIsSpacePressed,
    isPanning,
    setIsPanning,
    isMovingBg,
    setIsMovingBg,
    isDrawing,
    setIsDrawing,
    currentElementId,
    setCurrentElementId,
    activePointerIdRef,
    selectedIds,
    setSelectedIds,
    lassoPoints,
    setLassoPoints,
    selectionDragOffset,
    setSelectionDragOffset,
    draggingNotePreview,
    setDraggingNotePreview,
    clipboardElements,
    setClipboardElements,
    pastePrompt,
    setPastePrompt,
    sendToBoardTarget,
    setSendToBoardTarget,
    sentFeedback,
    setSentFeedback,
    screenPos,
    setScreenPos,
    worldPos,
    setWorldPos,
    pointerOverCanvas,
    setPointerOverCanvas,
    hoveredNoteId,
    setHoveredNoteId,
    editingNote,
    setEditingNote,
    noteTextareaRef,
    noteClosedAtRef,
  };
}
