import React, { useCallback, useMemo, useState } from 'react';
import { getNoteFontSize, getPaletteColors, hlInk, isSeeThroughHighlight, noteSize } from '../../lib/inkCore';
import type { CanvasElement, HollowShapeKind, StampKind, ToolType } from '../../types';
import {
  TEXT_SIZE_DROPDOWN_PRESETS,
  readLocalColor,
  readLocalHollowShape,
  readLocalNum,
  saveLocal,
} from './canvasHelpers';
import type { useCanvasHistory } from './useCanvasHistory';
import type { useCanvasInteractionState } from './useCanvasInteractionState';

type Interaction = ReturnType<typeof useCanvasInteractionState>;

/** The active tool, as `Canvas` owns it. */
export interface ToolState {
  tool: ToolType;
  effectiveTool: ToolType;
  setTool: React.Dispatch<React.SetStateAction<ToolType>>;
}

interface Options {
  tool: ToolType;
  setTool: React.Dispatch<React.SetStateAction<ToolType>>;
  editingNote: Interaction['editingNote'];
  setEditingNote: Interaction['setEditingNote'];
  noteTextareaRef: Interaction['noteTextareaRef'];
  selectedElements: CanvasElement[];
  selectedTextElements: CanvasElement[];
  canDraw: boolean;
  recordUndo: ReturnType<typeof useCanvasHistory>['recordUndo'];
  onElementsBatchUpdate: (updates: Array<Partial<CanvasElement> & { id: string }>, bringToFront?: boolean) => void;
}

/**
 * Per-tool settings (OverBoard-style separate memory per tool), most of them remembered in `localStorage`, plus the
 * `handleSelect*` setters that also restyle the open note or the selection.
 */
export function useToolSettings({
  tool,
  setTool,
  editingNote,
  setEditingNote,
  noteTextareaRef,
  selectedElements,
  selectedTextElements,
  canDraw,
  recordUndo,
  onElementsBatchUpdate,
}: Options) {
  const [penColor, setPenColor] = useState<string>(() => readLocalColor('allaboard-pen-color', '#111111'));
  const [penWidth, setPenWidth] = useState<number>(() => readLocalNum('allaboard-pen-width', 6, 1, 50));
  const [hollowShape, setHollowShape] = useState<HollowShapeKind>(() =>
    readLocalHollowShape('allaboard-hollow-shape', 'circle')
  );
  const [hollowWidth, setHollowWidth] = useState<number>(() => readLocalNum('allaboard-hollow-width', 36, 4, 120));
  const [hollowWeight, setHollowWeight] = useState<number>(() => readLocalNum('allaboard-hollow-weight', 3, 1, 25));

  const [hlColor, setHlColor] = useState<string>(() => readLocalColor('allaboard-hl-color', '#fdd835'));
  const [hlWidth, setHlWidth] = useState<number>(() => readLocalNum('allaboard-hl-width', 22, 4, 60));
  const [hlStrength, setHlStrength] = useState<number>(() => readLocalNum('allaboard-hl-strength', 45, 10, 100));
  const [eraserWidth, setEraserWidth] = useState<number>(() => readLocalNum('allaboard-eraser-width', 60, 8, 400));
  const [isCoverMode, setIsCoverMode] = useState<boolean>(false);
  const [coverColor, setCoverColor] = useState<string>(() => readLocalColor('allaboard-cover-color', '#111111'));
  const [textFontSize, setTextFontSize] = useState<number>(() => readLocalNum('allaboard-text-size', 26, 12, 96));
  const [smoothLevel, setSmoothLevel] = useState<number>(() => readLocalNum('allaboard-smooth-v2', 0, 0, 8));
  const [fingerScrolls, setFingerScrolls] = useState<boolean>(() => {
    try {
      return localStorage.getItem('allaboard-finger-scrolls') === '1';
    } catch {
      return false;
    }
  });

  const [stampKind, setStampKind] = useState<StampKind>('check');
  const [customTeacherStampText, setCustomTeacherStampText] = useState<string>('CHECK THIS');

  // Derived active color & width based on whether Highlighter (See-Through or Cover), Eraser, Hollow, or Pen is active
  const paletteMode: 'pen' | 'hl' | 'cover' = tool === 'highlighter' ? (isCoverMode ? 'cover' : 'hl') : 'pen';
  const color = tool === 'highlighter' ? (isCoverMode ? coverColor : hlColor) : penColor;
  const strokeWidth =
    tool === 'highlighter' ? hlWidth : tool === 'eraser' ? eraserWidth : tool === 'hollow' ? hollowWidth : penWidth;

  const activeTextSize = editingNote
    ? editingNote.fontSize
    : selectedTextElements.length > 0
      ? getNoteFontSize(selectedTextElements[0])
      : textFontSize;

  // Helper to update active color, open note, or selected elements (`restyle`)
  const handleSelectColor = useCallback(
    (nextColor: string) => {
      if (tool === 'highlighter') {
        if (isCoverMode) {
          setCoverColor(nextColor);
          saveLocal('allaboard-cover-color', nextColor);
        } else {
          setHlColor(nextColor);
          saveLocal('allaboard-hl-color', nextColor);
        }
      } else {
        setPenColor(nextColor);
        saveLocal('allaboard-pen-color', nextColor);
        if (tool === 'eraser' || tool === 'pan' || tool === 'move-bg') {
          setTool('solid');
        }
      }
      if (editingNote) {
        setEditingNote((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            color: nextColor === '#ffffff' ? '#0f172a' : nextColor,
          };
        });
        requestAnimationFrame(() => noteTextareaRef.current?.focus());
        return;
      }
      if (selectedElements.length > 0 && canDraw) {
        const before = selectedElements;
        const updates: Array<Partial<CanvasElement> & { id: string }> = [];
        const after: CanvasElement[] = [];
        for (const el of before) {
          let resolvedColor = nextColor;
          if (el.tool === 'text' && nextColor === '#ffffff') {
            resolvedColor = '#0f172a';
          } else if (el.tool === 'highlighter' && isSeeThroughHighlight(el)) {
            resolvedColor = hlInk(nextColor, el.hlStrength ?? hlStrength);
          }
          updates.push({ id: el.id, color: resolvedColor });
          after.push({ ...el, color: resolvedColor });
        }
        recordUndo({ kind: 'update', before, after, bringToFront: false });
        onElementsBatchUpdate(updates, false);
      }
    },
    [tool, setTool, isCoverMode, editingNote, selectedElements, canDraw, hlStrength, recordUndo, onElementsBatchUpdate]
  );

  // Brush / highlight / eraser / hollow stroke width (each persisted independently)
  const handleSelectStrokeWidth = useCallback(
    (nextWidth: number) => {
      if (tool === 'eraser') {
        const clamped = Math.max(8, Math.min(400, nextWidth));
        setEraserWidth(clamped);
        saveLocal('allaboard-eraser-width', String(clamped));
      } else if (tool === 'highlighter') {
        const clamped = Math.max(4, Math.min(60, nextWidth));
        setHlWidth(clamped);
        saveLocal('allaboard-hl-width', String(clamped));
      } else if (tool === 'hollow') {
        const clamped = Math.max(4, Math.min(120, nextWidth));
        setHollowWidth(clamped);
        saveLocal('allaboard-hollow-width', String(clamped));
      } else {
        const clamped = Math.max(1, Math.min(50, nextWidth));
        setPenWidth(clamped);
        saveLocal('allaboard-pen-width', String(clamped));
      }
      if (editingNote) {
        requestAnimationFrame(() => noteTextareaRef.current?.focus());
      }
    },
    [tool, editingNote]
  );

  // Dedicated Line Weight setter for the Hollow Shape Brush (1..25)
  const handleSelectHollowWeight = useCallback((nextWeight: number) => {
    const clamped = Math.max(1, Math.min(25, nextWeight));
    setHollowWeight(clamped);
    saveLocal('allaboard-hollow-weight', String(clamped));
  }, []);

  // Dedicated independent Text Size setter (S/M/L/XL presets, +/- buttons, slider, live note, selected notes)
  const handleSelectTextFontSize = useCallback(
    (nextSize: number, applyToSelection = true) => {
      const clamped = Math.max(12, Math.min(96, Math.round(nextSize)));
      setTextFontSize(clamped);
      saveLocal('allaboard-text-size', String(clamped));
      if (editingNote) {
        setEditingNote((prev) => (prev ? { ...prev, fontSize: clamped } : null));
        requestAnimationFrame(() => noteTextareaRef.current?.focus());
        return;
      }
      if (applyToSelection && selectedTextElements.length > 0 && canDraw) {
        const before = selectedTextElements;
        const updates: Array<Partial<CanvasElement> & { id: string }> = [];
        const after: CanvasElement[] = [];
        for (const el of before) {
          const [w, h] = noteSize(el.text || '', clamped);
          updates.push({ id: el.id, fontSize: clamped, width: w, height: h });
          after.push({ ...el, fontSize: clamped, width: w, height: h });
        }
        recordUndo({ kind: 'update', before, after, bringToFront: false });
        onElementsBatchUpdate(updates, false);
      }
    },
    [editingNote, selectedTextElements, canDraw, recordUndo, onElementsBatchUpdate]
  );

  const activeSwatches = useMemo(() => getPaletteColors(paletteMode), [paletteMode]);
  const activeTextPreset = TEXT_SIZE_DROPDOWN_PRESETS.find((preset) => preset.size === activeTextSize);

  return {
    penColor,
    penWidth,
    hollowShape,
    setHollowShape,
    hollowWidth,
    hollowWeight,
    hlColor,
    hlWidth,
    hlStrength,
    setHlStrength,
    eraserWidth,
    isCoverMode,
    setIsCoverMode,
    coverColor,
    setCoverColor,
    textFontSize,
    setTextFontSize,
    smoothLevel,
    setSmoothLevel,
    fingerScrolls,
    setFingerScrolls,
    stampKind,
    setStampKind,
    customTeacherStampText,
    setCustomTeacherStampText,
    paletteMode,
    color,
    strokeWidth,
    activeSwatches,
    activeTextSize,
    activeTextPreset,
    handleSelectColor,
    handleSelectStrokeWidth,
    handleSelectHollowWeight,
    handleSelectTextFontSize,
  };
}

export type ToolSettings = ReturnType<typeof useToolSettings>;
