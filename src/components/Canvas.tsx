import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Stage, Layer, Line, Circle, Rect, Text as KonvaText, Group, Image as KonvaImage, Shape } from 'react-konva';
import {
  CanvasElement,
  ChatMessage,
  ToolType,
  StampKind,
  HollowShapeKind,
  GridMode,
  RoomBackground,
  RemoteCursor,
  ImportRestoreMode,
  RoomSnapshot,
  BreakoutConfig,
  SubBoardData,
  User,
  ClassroomTimerState,
  TimerControlPayload,
} from '../types';
import {
  processWorksheetFile,
  BUILT_IN_TEMPLATES,
  BuiltInTemplateId,
} from '../lib/worksheetLoader';
import { exportAllBoardsToPdf } from '../lib/batchPdfExport';
import {
  LiveGridOverview,
  BreakoutManagerModal,
  WorksheetTemplateModal,
  RestoreSnapshotModal,
} from './CanvasModals';
import {
  NOTE_FONT,
  NOTE_LH,
  LiveSmoothState,
  hlInk,
  isSeeThroughHighlight,
  getPaletteColors,
  pointerKind,
  liveStart,
  liveAddPoint,
  liveLiftPoint,
  traceSmoothStrokePath,
  traceHollowTipShape,
  drawHollowElementOnCtx,
  getNoteFontSize,
  noteSize,
  computeNotesGone,
  TEXT_SIZE_PRESETS,
  hitEditableNote,
  getElementBounds,
  getSelectionBounds,
  canUserModifyElement,
  expandElementVisiblePieces,
  hasSubsequentOverlappingEraser,
  hitElementAtPoint,
  lassoSelectElements,
  translateElement,
} from '../lib/inkCore';
import {
  Eraser,
  Undo2,
  Redo2,
  MousePointer2,
  Paintbrush,
  SprayCan,
  Circle as CircleIcon,
  Highlighter,
  Square,
  Triangle,
  Diamond,
  Star,
  Minus,
  Type,
  Hand,
  Lasso,
  Copy,
  Edit3,
  Download,
  FileJson,
  Upload,
  Lock,
  Unlock,
  Trash2,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Grid,
  X,
  Check,
  Stamp,
  ImagePlus,
  LayoutTemplate,
  Move,
  Columns,
  Rows,
  Users,
  LayoutGrid,
  ChevronDown,
  Timer,
  Play,
  Pause,
  RotateCcw,
  FileSpreadsheet,
} from 'lucide-react';
import { cn } from '../lib/utils';

type HistoryAction =
  | { kind: 'add'; items: CanvasElement[] }
  | { kind: 'remove'; items: CanvasElement[] }
  | { kind: 'update'; before: CanvasElement[]; after: CanvasElement[]; bringToFront?: boolean }
  | { kind: 'replace'; removed: CanvasElement[]; added: CanvasElement[] };

interface CanvasProps {
  roomId: string;
  activeBoardId: string;
  activeBoardTitle: string;
  elements: CanvasElement[];
  messages: ChatMessage[];
  background: RoomBackground | null;
  subBoards: Record<string, SubBoardData>;
  breakoutConfig: BreakoutConfig;
  users: User[];
  remoteCursors: Record<string, RemoteCursor>;
  isCanvasLocked: boolean;
  isTeacher: boolean;
  userId: string;
  userName: string;
  userColor: string;
  onSelectBoard: (boardId: string) => void;
  onConfigureBreakout: (payload: {
    mode: 'main' | 'individual' | 'groups';
    allowSelfSelect: boolean;
    chatScope: 'unified' | 'board';
    copyWorksheet: boolean;
    customBackground?: RoomBackground | null;
    groups?: Array<{ id: string; title: string; assignedUserIds: string[] }>;
  }) => Promise<{ ok: boolean; error?: string }>;
  onAssignUserToBoard: (targetBoardId: string, targetUserId?: string) => void;
  onElementStart: (element: CanvasElement) => void;
  onElementAppendPoints: (id: string, newPoints: number[]) => void;
  onElementUpdate: (patch: Partial<CanvasElement> & { id: string; bringToFront?: boolean }) => void;
  onElementRemove: (id: string) => void;
  onElementsBatchUpdate: (updates: Array<Partial<CanvasElement> & { id: string }>, bringToFront?: boolean) => void;
  onElementsBatchAdd: (elements: CanvasElement[], targetBoardId?: string) => void;
  onElementsBatchRemove: (ids: string[]) => void;
  onCursorMove: (cursor: Omit<RemoteCursor, 'updatedAt'>) => void;
  onUndo: () => void;
  onClearMine: () => void;
  onTeacherToggleLock: (locked: boolean) => void;
  onTeacherClearAll: () => void;
  onTeacherSetBackground: (bg: RoomBackground | null) => Promise<{ ok: boolean; error?: string }>;
  onTeacherUpdateBackground: (patch: Partial<RoomBackground>) => void;
  onTeacherImportRoom: (
    snapshot: {
      elements: CanvasElement[];
      messages: ChatMessage[];
      background?: RoomBackground | null;
      subBoards?: Record<string, SubBoardData>;
      breakoutConfig?: BreakoutConfig;
    },
    mode: ImportRestoreMode
  ) => Promise<{ ok: boolean; error?: string }>;
  timer?: ClassroomTimerState;
  onTeacherTimerControl: (payload: TimerControlPayload) => void;
  fullMainElements: CanvasElement[];
  fullMainMessages: ChatMessage[];
  fullMainBackground: RoomBackground | null;
}

const STAMP_OPTIONS: Array<{ kind: StampKind; symbol: string; label: string }> = [
  { kind: 'check', symbol: '✓', label: 'Got It (Check)' },
  { kind: 'question', symbol: '?', label: 'Confused (Question)' },
  { kind: 'star', symbol: '★', label: 'Star' },
  { kind: 'thumbsup', symbol: '👍', label: 'Thumbs Up' },
  { kind: 'heart', symbol: '♥', label: 'Heart' },
  { kind: 'username', symbol: 'ID', label: 'Stamp Your Username Badge' },
];

const MIN_SCALE = 0.1;
const MAX_SCALE = 5.0;
const PAGE_GAP = 32;
const PALM_ERASER_SCREEN_PX = 56;

function readLocalNum(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
  } catch {
    return fallback;
  }
}

function readLocalColor(key: string, fallback: string): string {
  try {
    const raw = localStorage.getItem(key);
    return raw && /^#[0-9a-f]{6}$/i.test(raw) ? raw : fallback;
  } catch {
    return fallback;
  }
}

function saveLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage errors
  }
}

const HOLLOW_SHAPE_OPTIONS: Array<{
  kind: HollowShapeKind;
  label: string;
  dx: number;
  dy: number;
}> = [
  { kind: 'circle', label: 'Circle', dx: -62, dy: 26 },
  { kind: 'square', label: 'Square', dx: -35, dy: 50 },
  { kind: 'triangle', label: 'Triangle', dx: 0, dy: 60 },
  { kind: 'diamond', label: 'Diamond', dx: 35, dy: 50 },
  { kind: 'star', label: 'Star', dx: 62, dy: 26 },
];

function readLocalHollowShape(key: string, fallback: HollowShapeKind): HollowShapeKind {
  try {
    const raw = localStorage.getItem(key);
    if (
      raw === 'circle' ||
      raw === 'square' ||
      raw === 'triangle' ||
      raw === 'diamond' ||
      raw === 'star'
    ) {
      return raw;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function HollowShapeIcon({ kind, size = 17 }: { kind: HollowShapeKind; size?: number }) {
  if (kind === 'square') return <Square size={size} />;
  if (kind === 'triangle') return <Triangle size={size} />;
  if (kind === 'diamond') return <Diamond size={size} />;
  if (kind === 'star') return <Star size={size} />;
  return <CircleIcon size={size} />;
}

const GRID_MODE_OPTIONS: Array<{
  mode: GridMode;
  label: string;
  dx: number;
  dy: number;
}> = [
  { mode: 'blank', label: 'Blank', dx: -54, dy: -26 },
  { mode: 'dots', label: 'Dot Grid', dx: -20, dy: -54 },
  { mode: 'graph', label: 'Graph Paper (90°)', dx: 20, dy: -54 },
  { mode: 'isometric', label: 'Isometric (3D)', dx: 54, dy: -26 },
];

function readLocalGridMode(key: string, fallback: GridMode): GridMode {
  try {
    const raw = localStorage.getItem(key);
    if (raw === 'blank' || raw === 'dots' || raw === 'graph' || raw === 'isometric') {
      return raw;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function GridModeIcon({ mode, size = 15 }: { mode: GridMode; size?: number }) {
  if (mode === 'blank') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2" strokeDasharray="2.5 2" />
      </svg>
    );
  }
  if (mode === 'dots') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
        <circle cx="3.5" cy="3.5" r="1.3" />
        <circle cx="8" cy="3.5" r="1.3" />
        <circle cx="12.5" cy="3.5" r="1.3" />
        <circle cx="3.5" cy="8" r="1.3" />
        <circle cx="8" cy="8" r="1.3" />
        <circle cx="12.5" cy="8" r="1.3" />
        <circle cx="3.5" cy="12.5" r="1.3" />
        <circle cx="8" cy="12.5" r="1.3" />
        <circle cx="12.5" cy="12.5" r="1.3" />
      </svg>
    );
  }
  if (mode === 'graph') {
    return <Grid size={size} />;
  }
  // Isometric 3D lattice icon
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.75L13.75 5V11L8 14.25L2.25 11V5L8 1.75Z" />
      <path d="M2.25 5L8 8.25L13.75 5" />
      <path d="M8 8.25V14.25" />
    </svg>
  );
}

function getCanvasGridStyle(
  gridMode: GridMode,
  gridSpacing: number,
  stagePos: { x: number; y: number }
): React.CSSProperties {
  if (gridMode === 'blank') {
    return { backgroundColor: '#ffffff' };
  }
  if (gridMode === 'dots') {
    return {
      backgroundColor: '#ffffff',
      backgroundImage: `radial-gradient(#cbd5e1 1.25px, transparent 1.25px)`,
      backgroundSize: `${gridSpacing}px ${gridSpacing}px`,
      backgroundPosition: `${stagePos.x}px ${stagePos.y}px`,
    };
  }
  if (gridMode === 'graph') {
    return {
      backgroundColor: '#ffffff',
      backgroundImage: `linear-gradient(to right, #e2e8f0 1px, transparent 1px), linear-gradient(to bottom, #e2e8f0 1px, transparent 1px)`,
      backgroundSize: `${gridSpacing}px ${gridSpacing}px`,
      backgroundPosition: `${stagePos.x}px ${stagePos.y}px`,
    };
  }
  // Isometric 3D lattice (vertical lines + ±30° isometric axes meeting at every vertex)
  const isoH = Math.max(24, gridSpacing);
  const isoW = Math.round(isoH * Math.sqrt(3) * 100) / 100;
  const halfW = Math.round((isoW / 2) * 100) / 100;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${isoW}" height="${isoH}" viewBox="0 0 ${isoW} ${isoH}"><path d="M 0 0 L ${isoW} ${isoH} M 0 ${isoH} L ${isoW} 0 M 0 0 L 0 ${isoH} M ${halfW} 0 L ${halfW} ${isoH}" stroke="#dbe4f0" stroke-width="1" fill="none"/></svg>`;
  return {
    backgroundColor: '#ffffff',
    backgroundImage: `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`,
    backgroundSize: `${isoW}px ${isoH}px`,
    backgroundPosition: `${stagePos.x}px ${stagePos.y}px`,
  };
}

/**
 * OverBoard-style Midpoint Quadratic Curve + Single-Tap Dot Shape for Konva.
 */
function SmoothStrokeShape({
  points,
  color,
  strokeWidth,
  globalCompositeOperation = 'source-over',
  opacity = 1,
}: {
  points: number[];
  color: string;
  strokeWidth: number;
  globalCompositeOperation?: GlobalCompositeOperation;
  opacity?: number;
}) {
  return (
    <Shape
      opacity={opacity}
      globalCompositeOperation={globalCompositeOperation}
      listening={false}
      perfectDrawEnabled={false}
      sceneFunc={(ctx) => {
        const rawCtx = (ctx as any)._context as CanvasRenderingContext2D;
        if (!rawCtx || !points || points.length < 2) return;
        rawCtx.save();
        rawCtx.strokeStyle = color;
        rawCtx.fillStyle = color;
        rawCtx.lineWidth = strokeWidth;
        rawCtx.lineCap = 'round';
        rawCtx.lineJoin = 'round';
        const kind = traceSmoothStrokePath(rawCtx, points, strokeWidth);
        if (kind === 'dot') {
          rawCtx.fill();
        } else if (kind === 'stroke') {
          rawCtx.stroke();
        }
        rawCtx.restore();
      }}
    />
  );
}

/**
 * Multi-shape Hollow Stamp & Extruded Stroke Shape for Konva (Circle, Square, Triangle, Diamond, Star).
 */
function HollowStrokeShape({
  points,
  color,
  strokeWidth,
  hollowWeight = 2,
  hollowShape = 'circle',
}: {
  points: number[];
  color: string;
  strokeWidth: number;
  hollowWeight?: number;
  hollowShape?: HollowShapeKind;
}) {
  return (
    <Shape
      listening={false}
      perfectDrawEnabled={false}
      sceneFunc={(ctx) => {
        const rawCtx = (ctx as any)._context as CanvasRenderingContext2D;
        if (!rawCtx || !points || points.length < 2) return;
        drawHollowElementOnCtx(rawCtx, points, strokeWidth, hollowWeight, color, hollowShape);
      }}
    />
  );
}

/**
 * Dedicated Konva Layer whose underlying HTML5 canvas uses `mix-blend-mode: multiply`,
 * matching OverBoard's `#ink-hl` multiply highlighter layer so printed worksheet text stays crisp black.
 */
function MultiplyHighlightLayer({
  x,
  y,
  scaleX,
  scaleY,
  children,
}: {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  children: React.ReactNode;
}) {
  const layerRef = useRef<any>(null);

  useEffect(() => {
    const domCanvas: HTMLCanvasElement | undefined = layerRef.current?.getCanvas?.()?._canvas;
    if (domCanvas) {
      domCanvas.style.mixBlendMode = 'multiply';
    }
  }, []);

  return (
    <Layer ref={layerRef} x={x} y={y} scaleX={scaleX} scaleY={scaleY} listening={false}>
      {children}
    </Layer>
  );
}

// Subcomponent to load and render a single background worksheet page image
function WorksheetPageNode({
  dataUrl,
  x,
  y,
  width,
  height,
  opacity,
}: {
  dataUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    let active = true;
    const imageObj = new window.Image();
    imageObj.onload = () => {
      if (active) setImg(imageObj);
    };
    imageObj.src = dataUrl;
    return () => {
      active = false;
    };
  }, [dataUrl]);

  if (!img) return null;

  return (
    <Group x={x} y={y}>
      <Rect
        x={0}
        y={0}
        width={width}
        height={height}
        fill="#ffffff"
        stroke="#cbd5e1"
        strokeWidth={1.5}
        shadowColor="#0f172a"
        shadowBlur={12}
        shadowOpacity={0.08}
        shadowOffsetY={4}
      />
      <KonvaImage image={img} x={0} y={0} width={width} height={height} opacity={opacity} />
    </Group>
  );
}

export default function Canvas({
  roomId,
  activeBoardId,
  activeBoardTitle,
  elements,
  messages,
  background,
  subBoards,
  breakoutConfig,
  users,
  remoteCursors,
  isCanvasLocked,
  isTeacher,
  userId,
  userName,
  userColor,
  onSelectBoard,
  onConfigureBreakout,
  onAssignUserToBoard,
  onElementStart,
  onElementAppendPoints,
  onElementUpdate,
  onElementRemove,
  onElementsBatchUpdate,
  onElementsBatchAdd,
  onElementsBatchRemove,
  onCursorMove,
  onUndo,
  onClearMine,
  onTeacherToggleLock,
  onTeacherClearAll,
  onTeacherSetBackground,
  onTeacherUpdateBackground,
  onTeacherImportRoom,
  timer,
  onTeacherTimerControl,
  fullMainElements,
  fullMainMessages,
  fullMainBackground,
}: CanvasProps) {
  // OverBoard-style Separate Tool Settings & Memory
  const [penColor, setPenColor] = useState<string>(() => readLocalColor('allaboard-pen-color', '#111111'));
  const [penWidth, setPenWidth] = useState<number>(() => readLocalNum('allaboard-pen-width', 6, 1, 50));
  const [hollowShape, setHollowShape] = useState<HollowShapeKind>(() =>
    readLocalHollowShape('allaboard-hollow-shape', 'circle')
  );
  const [hollowWidth, setHollowWidth] = useState<number>(() =>
    readLocalNum('allaboard-hollow-width', 36, 4, 120)
  );
  const [hollowWeight, setHollowWeight] = useState<number>(() =>
    readLocalNum('allaboard-hollow-weight', 3, 1, 25)
  );
  const [showHollowMenu, setShowHollowMenu] = useState<boolean>(false);
  const hollowMenuRef = useRef<HTMLDivElement>(null);

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
  const [showHlMenu, setShowHlMenu] = useState<boolean>(false);
  const hlMenuRef = useRef<HTMLDivElement>(null);
  const customColorInputRef = useRef<HTMLInputElement>(null);

  const [tool, setTool] = useState<ToolType>('solid');
  const [stampKind, setStampKind] = useState<StampKind>('check');
  const [gridMode, setGridMode] = useState<GridMode>(() =>
    readLocalGridMode('allaboard-grid-mode', 'dots')
  );
  const [showGridMenu, setShowGridMenu] = useState<boolean>(false);
  const gridMenuRef = useRef<HTMLDivElement>(null);

  // Derived active color & width based on whether Highlighter (See-Through or Cover), Eraser, Hollow, or Pen is active
  const paletteMode: 'pen' | 'hl' | 'cover' =
    tool === 'highlighter' ? (isCoverMode ? 'cover' : 'hl') : 'pen';
  const color =
    tool === 'highlighter' ? (isCoverMode ? coverColor : hlColor) : penColor;
  const strokeWidth =
    tool === 'highlighter'
      ? hlWidth
      : tool === 'eraser'
      ? eraserWidth
      : tool === 'hollow'
      ? hollowWidth
      : penWidth;

  // Infinite Canvas Viewport Transform
  const [stageScale, setStageScale] = useState(1);
  const [stagePos, setStagePos] = useState({ x: 0, y: 0 });
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{
    x: number;
    y: number;
    stageX: number;
    stageY: number;
    tapForNote?: boolean;
  } | null>(null);

  // Teacher dragging worksheet state
  const [isMovingBg, setIsMovingBg] = useState(false);
  const bgMoveStartRef = useRef<{ worldX: number; worldY: number; origX: number; origY: number } | null>(null);

  // Active Drawing / Shape / Smoothing State
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentElementId, setCurrentElementId] = useState<string | null>(null);
  const activeStrokeToolRef = useRef<Exclude<ToolType, 'pan' | 'select' | 'move-bg'> | null>(null);
  const activeStrokePointsRef = useRef<number[]>([]);
  const liveSmoothRef = useRef<LiveSmoothState | null>(null);
  const downAtRef = useRef<number>(0);
  const activePointerIdRef = useRef<number | null>(null);
  const shapeOriginRef = useRef<{ x: number; y: number } | null>(null);
  const pendingStrokeRef = useRef<CanvasElement | null>(null);

  // Selection / Lasso / Clipboard / Action-Aware History State (OverBoard `makeSelect` + Undo/Redo)
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [lassoPoints, setLassoPoints] = useState<number[]>([]);
  const [selectionDragOffset, setSelectionDragOffset] = useState<{ dx: number; dy: number } | null>(null);
  const [draggingNotePreview, setDraggingNotePreview] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const [clipboardElements, setClipboardElements] = useState<CanvasElement[]>([]);
  const [pastePrompt, setPastePrompt] = useState<{ worldX: number; worldY: number } | null>(null);
  const [sendToBoardTarget, setSendToBoardTarget] = useState<string>('ALL_SUBBOARDS');
  const [sentFeedback, setSentFeedback] = useState<string | null>(null);

  const elementsRef = useRef<CanvasElement[]>(elements);
  elementsRef.current = elements;

  const historyByBoardRef = useRef<Record<string, { undo: HistoryAction[]; redo: HistoryAction[] }>>({});
  const [historyTick, setHistoryTick] = useState(0);

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

  // Pointer position in screen and world coordinates
  const [screenPos, setScreenPos] = useState({ x: -100, y: -100 });
  const [worldPos, setWorldPos] = useState({ x: 0, y: 0 });
  const [hoveredNoteId, setHoveredNoteId] = useState<string | null>(null);

  // OverBoard v45 Editable Multiline Text Note State (`makeTyping`)
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

  // Confirmation States
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [confirmClearMine, setConfirmClearMine] = useState(false);

  // Worksheet Upload & Built-In Templates State (Teacher Only)
  const worksheetInputRef = useRef<HTMLInputElement>(null);
  const [isUploadingWorksheet, setIsUploadingWorksheet] = useState(false);
  const [worksheetError, setWorksheetError] = useState<string | null>(null);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<BuiltInTemplateId>('checkin-columns');
  const [templatePromptText, setTemplatePromptText] = useState(
    BUILT_IN_TEMPLATES[0].defaultPrompt
  );

  // Breakout & Individual Assignment Manager Modal State (Teacher Only)
  const [showBreakoutModal, setShowBreakoutModal] = useState(false);
  const [draftBreakoutMode, setDraftBreakoutMode] = useState<'main' | 'individual' | 'groups'>(
    breakoutConfig.mode
  );
  const [draftGroupCount, setDraftGroupCount] = useState<number>(4);
  const [draftGroups, setDraftGroups] = useState<
    Array<{ id: string; title: string; assignedUserIds: string[] }>
  >([]);
  const [draftAllowSelfSelect, setDraftAllowSelfSelect] = useState<boolean>(
    breakoutConfig.allowSelfSelect
  );
  const [draftChatScope, setDraftChatScope] = useState<'unified' | 'board'>(
    breakoutConfig.chatScope
  );
  const [draftWorksheetChoice, setDraftWorksheetChoice] = useState<
    'current' | 'frayer' | 'checkin' | 'corners' | 'none'
  >('current');
  const [draftWorksheetTopic, setDraftWorksheetTopic] = useState<string>(
    "Today's Core Concept: Photosynthesis"
  );
  const [showLiveGridOverview, setShowLiveGridOverview] = useState<boolean>(false);

  // Classroom Countdown Timer & Batch Multi-Page PDF Export States
  const [showTimerMenu, setShowTimerMenu] = useState<boolean>(false);
  const [customTimeInput, setCustomTimeInput] = useState<string>('7:00');
  const [displayRemainingMs, setDisplayRemainingMs] = useState<number>(0);
  const timerMenuRef = useRef<HTMLDivElement>(null);
  const [pdfExportProgress, setPdfExportProgress] = useState<{ current: number; total: number } | null>(
    null
  );

  useEffect(() => {
    const updateRemaining = () => {
      if (!timer) {
        setDisplayRemainingMs(0);
        return;
      }
      if (timer.isRunning && timer.endsAt !== null) {
        setDisplayRemainingMs(Math.max(0, timer.endsAt - Date.now()));
      } else {
        setDisplayRemainingMs(Math.max(0, timer.remainingMs || 0));
      }
    };
    updateRemaining();
    if (timer?.isRunning && timer?.endsAt !== null) {
      const interval = setInterval(updateRemaining, 250);
      return () => clearInterval(interval);
    }
  }, [timer]);

  useEffect(() => {
    if (!showTimerMenu) return;
    const onDocDown = (e: MouseEvent) => {
      if (timerMenuRef.current && !timerMenuRef.current.contains(e.target as Node)) {
        setShowTimerMenu(false);
      }
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [showTimerMenu]);

  const formatTimerMs = (ms: number): string => {
    const totalSecs = Math.max(0, Math.ceil(ms / 1000));
    const hrs = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    if (hrs > 0) {
      return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const parseCustomTimeSeconds = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.includes(':')) {
      const parts = trimmed.split(':').map((p) => Number(p.trim()));
      if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
      if (parts.length === 2) {
        return Math.round(parts[0] * 60 + parts[1]);
      }
      if (parts.length === 3) {
        return Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2]);
      }
      return null;
    }
    const mins = Number(trimmed);
    if (!Number.isFinite(mins) || mins <= 0) return null;
    return Math.round(mins * 60);
  };

  const handleBatchExportAllPdf = async () => {
    if (pdfExportProgress) return;
    const allSubBoards = Object.values(subBoards) as SubBoardData[];
    try {
      setPdfExportProgress({ current: 1, total: Math.max(1, allSubBoards.length + 1) });
      await exportAllBoardsToPdf({
        roomId,
        mainElements: fullMainElements,
        mainBackground: fullMainBackground,
        subBoards: allSubBoards,
        users,
        onProgress: (current, total) => setPdfExportProgress({ current, total }),
      });
    } finally {
      setPdfExportProgress(null);
    }
  };

  // JSON Import Modal States (Teacher Only)
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingSnapshot, setPendingSnapshot] = useState<{
    fileName: string;
    roomId: string;
    exportedAt?: number;
    exportedBy?: string;
    elements: CanvasElement[];
    messages: ChatMessage[];
    background?: RoomBackground | null;
    subBoards?: Record<string, SubBoardData>;
    breakoutConfig?: BreakoutConfig;
  } | null>(null);
  const [importMode, setImportMode] = useState<ImportRestoreMode>('replace');
  const [importError, setImportError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  const stageRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastCursorEmitRef = useRef<number>(0);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  const canDraw = !isCanvasLocked || isTeacher;
  const effectiveTool: ToolType = !canDraw
    ? 'pan'
    : isSpacePressed
    ? 'pan'
    : tool === 'move-bg' && (!isTeacher || !background)
    ? 'pan'
    : tool;

  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.offsetWidth,
          height: containerRef.current.offsetHeight,
        });
      }
    };
    window.addEventListener('resize', updateSize);
    updateSize();
    return () => window.removeEventListener('resize', updateSize);
  }, []);

  // Close Highlighter/Cover, Hollow, or Grid radial popout menu when clicking outside or pressing Escape
  useEffect(() => {
    if (!showHlMenu && !showHollowMenu && !showGridMenu) return;
    const handlePointerDownOutside = (e: PointerEvent) => {
      if (showHlMenu && hlMenuRef.current && !hlMenuRef.current.contains(e.target as Node)) {
        setShowHlMenu(false);
      }
      if (showHollowMenu && hollowMenuRef.current && !hollowMenuRef.current.contains(e.target as Node)) {
        setShowHollowMenu(false);
      }
      if (showGridMenu && gridMenuRef.current && !gridMenuRef.current.contains(e.target as Node)) {
        setShowGridMenu(false);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowHlMenu(false);
        setShowHollowMenu(false);
        setShowGridMenu(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDownOutside, true);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDownOutside, true);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [showHlMenu, showHollowMenu, showGridMenu]);

  // Auto-focus and auto-size the multiline note textarea (OverBoard `makeTyping.place` + `open`)
  const resizeNoteTextarea = useCallback(() => {
    const el = noteTextareaRef.current;
    if (!el || !editingNote) return;
    const scaledFont = editingNote.fontSize * stageScale;
    el.style.width = '1px';
    el.style.height = '1px';
    el.style.width = `${Math.max(el.scrollWidth + 6, scaledFont * 3)}px`;
    el.style.height = `${Math.max(el.scrollHeight, Math.round(scaledFont * NOTE_LH))}px`;
  }, [editingNote, stageScale]);

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

  // Color / stroke / text-size helpers are defined below `allGoneNoteIds` & `selectedElements`

  // Helper to initialize draft groups in the Breakout Modal
  const initializeDraftGroups = useCallback(
    (count: number, randomize = true) => {
      const students = users.filter((u) => !u.isTeacher);
      const shuffled = randomize
        ? [...students].sort(() => Math.random() - 0.5)
        : [...students];

      const nextGroups: Array<{ id: string; title: string; assignedUserIds: string[] }> = [];
      for (let i = 0; i < count; i++) {
        nextGroups.push({
          id: `grp_${i + 1}`,
          title: `Group ${i + 1}`,
          assignedUserIds: [],
        });
      }
      shuffled.forEach((student, idx) => {
        nextGroups[idx % count].assignedUserIds.push(student.userId);
      });
      setDraftGroups(nextGroups);
    },
    [users]
  );

  // Open Breakout Modal and sync current config
  const handleOpenBreakoutModal = () => {
    setDraftBreakoutMode(breakoutConfig.mode === 'main' ? 'individual' : breakoutConfig.mode);
    setDraftAllowSelfSelect(breakoutConfig.allowSelfSelect);
    setDraftChatScope(breakoutConfig.chatScope);
    const existingGroupBoards = (Object.values(subBoards) as SubBoardData[]).filter((sb) =>
      sb.id.startsWith('grp_')
    );
    if (existingGroupBoards.length > 0) {
      setDraftGroupCount(existingGroupBoards.length);
      setDraftGroups(
        existingGroupBoards.map((sb) => ({
          id: sb.id,
          title: sb.title,
          assignedUserIds: [...sb.assignedUserIds],
        }))
      );
    } else {
      initializeDraftGroups(draftGroupCount, true);
    }
    setShowBreakoutModal(true);
  };

  // Group all elements on the current board by userId so each student's elements live on their own isolated Konva Layer,
  // and compute OverBoard's `notesGone` set per user so erasers remove whole text notes cleanly (and Undo brings them back!).
  const elementsGroupedByUser = useMemo(() => {
    const groups = new Map<string, CanvasElement[]>();
    for (const el of elements) {
      const uid = el.userId || 'anon';
      const list = groups.get(uid);
      if (list) {
        list.push(el);
      } else {
        groups.set(uid, [el]);
      }
    }
    return Array.from(groups.entries()).map(([uid, userElements]) => ({
      userId: uid,
      userElements,
      goneNoteIds: computeNotesGone(userElements),
      hasSeeThroughHighlights: userElements.some(isSeeThroughHighlight),
    }));
  }, [elements]);

  const allGoneNoteIds = useMemo(() => {
    const combined = new Set<string>();
    for (const g of elementsGroupedByUser) {
      for (const id of g.goneNoteIds) {
        combined.add(id);
      }
    }
    return combined;
  }, [elementsGroupedByUser]);

  // Clear transient selection/lasso/drag/note states when switching breakout boards
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

  const selectedElements = useMemo(() => {
    if (selectedIds.length === 0) return [];
    const idSet = new Set(selectedIds);
    return elements.filter((el) => idSet.has(el.id) && !allGoneNoteIds.has(el.id));
  }, [elements, selectedIds, allGoneNoteIds]);

  const selectedTextElements = useMemo(
    () => selectedElements.filter((el) => el.tool === 'text'),
    [selectedElements]
  );

  const selectionBounds = useMemo(() => {
    if (selectedElements.length === 0) return null;
    const base = getSelectionBounds(selectedElements);
    if (!base) return null;
    const dx = selectionDragOffset?.dx || 0;
    const dy = selectionDragOffset?.dy || 0;
    return [base[0] + dx, base[1] + dy, base[2] + dx, base[3] + dy] as [
      number,
      number,
      number,
      number,
    ];
  }, [selectedElements, selectionDragOffset]);

  const activeTextSize = editingNote
    ? editingNote.fontSize
    : selectedTextElements.length > 0
    ? getNoteFontSize(selectedTextElements[0])
    : textFontSize;

  // Per-board action-aware Undo & Redo history helpers
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
    }
  }, [
    canDraw,
    activeBoardId,
    getBoardHistory,
    onUndo,
    onElementsBatchRemove,
    onElementsBatchAdd,
    onElementsBatchUpdate,
    buildElementUpdatePatch,
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
    }
  }, [
    canDraw,
    activeBoardId,
    getBoardHistory,
    onElementsBatchAdd,
    onElementsBatchRemove,
    onElementsBatchUpdate,
    buildElementUpdatePatch,
  ]);

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
    [
      tool,
      isCoverMode,
      editingNote,
      selectedElements,
      canDraw,
      hlStrength,
      recordUndo,
      onElementsBatchUpdate,
    ]
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

  const handleCopySelection = useCallback(() => {
    if (selectedElements.length === 0) return;
    const pieces = selectedElements.flatMap((el) => expandElementVisiblePieces(el, elements));
    if (pieces.length === 0) return;
    setClipboardElements(pieces.map((el) => ({ ...el, points: el.points ? [...el.points] : undefined })));
  }, [selectedElements, elements]);

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
    [canDraw, clipboardElements, activeBoardId, userId, userName, recordUndo, onElementsBatchAdd]
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
  }, [canDraw, selectedElements, elements, activeBoardId, userId, userName, recordUndo, onElementsBatchAdd]);

  const handleDeleteSelection = useCallback(() => {
    if (!canDraw || selectedElements.length === 0) return;
    recordUndo({ kind: 'remove', items: selectedElements });
    onElementsBatchRemove(selectedElements.map((el) => el.id));
    setSelectedIds([]);
  }, [canDraw, selectedElements, recordUndo, onElementsBatchRemove]);

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
          ? 'All Breakout Boards'
          : targetBoardId === 'main'
          ? 'Main Class Board'
          : subBoards[targetBoardId]?.title || 'Target Board';
      setSentFeedback(`Sent to ${label}`);
      setTimeout(() => setSentFeedback(null), 2200);
    },
    [isTeacher, selectedElements, elements, activeBoardId, subBoards, onElementsBatchAdd]
  );

  // Compute positioned geometry for each page of the background worksheet
  const computedBackgroundPages = useMemo(() => {
    if (!background || !Array.isArray(background.pages) || background.pages.length === 0) {
      return [];
    }
    const sc = background.scale || 1;
    let offsetX = background.x || 0;
    let offsetY = background.y || 0;

    return background.pages.map((p, index) => {
      const w = p.width * sc;
      const h = p.height * sc;
      const pageX = offsetX;
      const pageY = offsetY;

      if (background.layout === 'row') {
        offsetX += w + PAGE_GAP * sc;
      } else {
        offsetY += h + PAGE_GAP * sc;
      }

      return {
        key: `${background.id}_page_${index}`,
        dataUrl: p.dataUrl,
        x: pageX,
        y: pageY,
        width: w,
        height: h,
        opacity: background.opacity ?? 1,
      };
    });
  }, [background]);

  const screenToWorld = useCallback(
    (sx: number, sy: number) => ({
      x: Number(((sx - stagePos.x) / stageScale).toFixed(1)),
      y: Number(((sy - stagePos.y) / stageScale).toFixed(1)),
    }),
    [stagePos.x, stagePos.y, stageScale]
  );

  // OverBoard `makeTyping.close()`: commits a new or edited multiline note (or deletes it if emptied)
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
      if (
        trimmed === existing.text &&
        note.color === existing.color &&
        note.fontSize === existingFont &&
        !moved
      ) {
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
  ]);

  // Open an existing note for re-typing, or start a new note at (worldX, worldY) (OverBoard `makeTyping.open` / `tap`)
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
    ]
  );

  // Keyboard shortcuts: Space (pan), Ctrl+Z (undo), Ctrl+Y/Shift+Z (redo), Ctrl+C/V/D, Delete/Backspace, Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      const keyLower = e.key.toLowerCase();

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
  ]);

  const handleWheel = (e: any) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;

    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const scaleBy = 1.1;
    const oldScale = stageScale;

    const mousePointTo = {
      x: (pointer.x - stagePos.x) / oldScale,
      y: (pointer.y - stagePos.y) / oldScale,
    };

    const direction = e.evt.deltaY > 0 ? -1 : 1;
    const unclampedScale = direction > 0 ? oldScale * scaleBy : oldScale / scaleBy;
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, unclampedScale));

    const newPos = {
      x: pointer.x - mousePointTo.x * newScale,
      y: pointer.y - mousePointTo.y * newScale,
    };

    setStageScale(newScale);
    setStagePos(newPos);
  };

  const zoomStep = (multiplier: number) => {
    const oldScale = stageScale;
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * multiplier));
    const centerScreen = { x: dimensions.width / 2, y: dimensions.height / 2 };
    const centerWorld = {
      x: (centerScreen.x - stagePos.x) / oldScale,
      y: (centerScreen.y - stagePos.y) / oldScale,
    };
    setStageScale(newScale);
    setStagePos({
      x: centerScreen.x - centerWorld.x * newScale,
      y: centerScreen.y - centerWorld.y * newScale,
    });
  };

  const resetView = useCallback(() => {
    setStageScale(1);
    setStagePos({ x: 0, y: 0 });
  }, []);

  const fitElementsAndBackgroundInView = useCallback(
    (targetElements: CanvasElement[], targetBg: RoomBackground | null) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      if (targetBg && Array.isArray(targetBg.pages) && targetBg.pages.length > 0) {
        const sc = targetBg.scale || 1;
        let ox = targetBg.x || 0;
        let oy = targetBg.y || 0;
        for (const p of targetBg.pages) {
          const w = p.width * sc;
          const h = p.height * sc;
          if (ox < minX) minX = ox;
          if (oy < minY) minY = oy;
          if (ox + w > maxX) maxX = ox + w;
          if (oy + h > maxY) maxY = oy + h;
          if (targetBg.layout === 'row') {
            ox += w + PAGE_GAP * sc;
          } else {
            oy += h + PAGE_GAP * sc;
          }
        }
      }

      for (const el of targetElements) {
        if (el.tool === 'eraser' || allGoneNoteIds.has(el.id)) continue;
        const b = getElementBounds(el);
        if (!b) continue;
        const [bx1, by1, bx2, by2] = b;
        if (bx1 < minX) minX = bx1;
        if (by1 < minY) minY = by1;
        if (bx2 > maxX) maxX = bx2;
        if (by2 > maxY) maxY = by2;
      }

      if (!isFinite(minX) || !isFinite(minY)) {
        resetView();
        return;
      }

      const contentW = Math.max(100, maxX - minX);
      const contentH = Math.max(100, maxY - minY);
      const margin = 56;
      const scaleX = (dimensions.width - margin * 2) / contentW;
      const scaleY = (dimensions.height - margin * 2) / contentH;
      const nextScale = Math.min(2.0, Math.max(MIN_SCALE, Math.min(scaleX, scaleY)));

      const centerX = minX + contentW / 2;
      const centerY = minY + contentH / 2;

      setStageScale(nextScale);
      setStagePos({
        x: dimensions.width / 2 - centerX * nextScale,
        y: dimensions.height / 2 - centerY * nextScale,
      });
    },
    [dimensions.width, dimensions.height, resetView, allGoneNoteIds]
  );

  const fitAllContent = () => {
    fitElementsAndBackgroundInView(elements, background);
  };

  // Auto-fit when switching between sub-boards
  useEffect(() => {
    if (editingNote) {
      commitEditingNote();
    }
    if (elements.length > 0 || background) {
      const id = setTimeout(() => {
        fitElementsAndBackgroundInView(elements, background);
      }, 60);
      return () => clearTimeout(id);
    } else {
      resetView();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBoardId]);

  const handleWorksheetFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    setIsUploadingWorksheet(true);
    setWorksheetError(null);

    try {
      const pages = await processWorksheetFile(file);
      const firstPage = pages[0];
      const startX = firstPage ? Math.round(-firstPage.width / 2) : -400;
      const startY = firstPage ? Math.round(-firstPage.height / 2) : -300;

      const newBg: RoomBackground = {
        id: 'bg_' + Math.random().toString(36).substring(2, 10),
        fileName: file.name,
        pages,
        x: startX,
        y: startY,
        scale: 1,
        layout: pages.length > 1 ? 'row' : 'stack',
        opacity: 1,
      };

      const res = await onTeacherSetBackground(newBg);
      if (res.ok) {
        setTimeout(() => fitElementsAndBackgroundInView(elements, newBg), 100);
      } else {
        setWorksheetError(res.error || 'Failed to upload worksheet.');
      }
    } catch (err: any) {
      setWorksheetError(err?.message || 'Could not process worksheet file.');
    } finally {
      setIsUploadingWorksheet(false);
    }
  };

  const handleExportPNG = () => {
    const stage = stageRef.current;
    if (!stage) return;

    // Composite the Konva stage onto a solid white (#ffffff) canvas so exported PNGs are never transparent or gray
    const stageCanvas: HTMLCanvasElement = stage.toCanvas({ pixelRatio: 2 });
    const outCanvas = document.createElement('canvas');
    outCanvas.width = stageCanvas.width;
    outCanvas.height = stageCanvas.height;
    const outCtx = outCanvas.getContext('2d');
    if (outCtx) {
      outCtx.fillStyle = '#ffffff';
      outCtx.fillRect(0, 0, outCanvas.width, outCanvas.height);
      outCtx.drawImage(stageCanvas, 0, 0);
    }

    const dataUrl = outCtx
      ? outCanvas.toDataURL('image/png')
      : stage.toDataURL({ pixelRatio: 2, mimeType: 'image/png' });

    const link = document.createElement('a');
    link.download = `allaboard-${roomId}-${activeBoardId}-${new Date().toISOString().slice(0, 10)}.png`;
    link.href = dataUrl;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Export complete Room Snapshot (.json) including main board + all breakout/individual subBoards
  const handleExportJSON = () => {
    const snapshot: RoomSnapshot = {
      version: 1,
      roomId,
      exportedAt: Date.now(),
      exportedBy: userName,
      elements: fullMainElements,
      messages: fullMainMessages,
      background: fullMainBackground,
      subBoards,
      breakoutConfig,
    };

    const jsonString = JSON.stringify(snapshot, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.download = `allaboard-room-${roomId}-${new Date().toISOString().slice(0, 10)}.json`;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImportError(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || '{}'));
        if (
          !parsed ||
          (!Array.isArray(parsed.elements) &&
            !Array.isArray(parsed.messages) &&
            !parsed.background &&
            !parsed.subBoards)
        ) {
          setImportError(
            'This JSON file does not contain valid AllAboard room data.'
          );
          setPendingSnapshot({
            fileName: file.name,
            roomId: roomId,
            elements: [],
            messages: [],
            background: null,
          });
          return;
        }

        const safeElements: CanvasElement[] = Array.isArray(parsed.elements)
          ? parsed.elements.filter(
              (el: any) => el && typeof el.id === 'string' && typeof el.tool === 'string'
            )
          : [];
        const safeMessages: ChatMessage[] = Array.isArray(parsed.messages)
          ? parsed.messages.filter(
              (m: any) => m && typeof m.id === 'string' && typeof m.text === 'string'
            )
          : [];

        setPendingSnapshot({
          fileName: file.name,
          roomId: parsed.roomId || roomId,
          exportedAt: parsed.exportedAt,
          exportedBy: parsed.exportedBy,
          elements: safeElements,
          messages: safeMessages,
          background: parsed.background || null,
          subBoards: parsed.subBoards,
          breakoutConfig: parsed.breakoutConfig,
        });
        setImportMode('replace');
      } catch {
        setImportError('Could not parse JSON file. Make sure it is a valid .json room snapshot.');
        setPendingSnapshot({
          fileName: file.name,
          roomId: roomId,
          elements: [],
          messages: [],
          background: null,
        });
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleConfirmImport = async () => {
    if (!pendingSnapshot || importError || isImporting) return;
    setIsImporting(true);
    const res = await onTeacherImportRoom(
      {
        elements: pendingSnapshot.elements,
        messages: pendingSnapshot.messages,
        background: pendingSnapshot.background,
        subBoards: pendingSnapshot.subBoards,
        breakoutConfig: pendingSnapshot.breakoutConfig,
      },
      importMode
    );
    setIsImporting(false);
    if (res.ok) {
      const importedEls = pendingSnapshot.elements;
      const importedBg = pendingSnapshot.background || background;
      setPendingSnapshot(null);
      setImportError(null);
      if (importedEls.length > 0 || importedBg) {
        setTimeout(() => fitElementsAndBackgroundInView(importedEls, importedBg), 80);
      }
    } else {
      setImportError(res.error || 'Failed to restore room snapshot.');
    }
  };

  // Get local container coordinates from a native PointerEvent or MouseEvent
  const getLocalPosFromEvent = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: clientX, y: clientY };
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }, []);

  // OverBoard-powered PointerDown handler (supports SMART Board palm eraser, finger-scrolls mode, and click-to-edit notes)
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
        const hitEl = hitElementAtPoint(
          elements,
          allGoneNoteIds,
          world.x,
          world.y,
          10 / stageScale,
          userId,
          isTeacher
        );
        if (hitEl) {
          const prevIds = [...selectedIds];
          const combinedShiftIds = prevIds.includes(hitEl.id)
            ? prevIds
            : [...prevIds, hitEl.id];
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
      const hitNote = hitEditableNote(
        elements,
        allGoneNoteIds,
        world.x,
        world.y,
        10 / stageScale,
        userId,
        isTeacher
      );
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
    const strokeTool: Exclude<ToolType, 'pan' | 'select' | 'move-bg'> =
      kind === 'palm' ? 'eraser' : (effectiveTool as Exclude<ToolType, 'pan' | 'select' | 'move-bg'>);

    // One-click Stamp placement (when not using palm eraser)
    if (strokeTool === 'stamp') {
      const stampElement: CanvasElement = {
        id,
        boardId: activeBoardId,
        userId,
        userName,
        tool: 'stamp',
        stamp: stampKind,
        color: color === '#ffffff' ? userColor : color,
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
        kind === 'palm'
          ? Math.max(12, Math.round((PALM_ERASER_SCREEN_PX / stageScale) * 10) / 10)
          : strokeWidth;

      const isHlCover = strokeTool === 'highlighter' && isCoverMode;
      const strokeColor =
        strokeTool === 'highlighter'
          ? isHlCover
            ? coverColor
            : hlInk(hlColor, hlStrength)
          : color;

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

    // Highlight hover state when over an editable text note in Type mode or selectable item in Select mode
    if (!isDrawing && !isPanning && !draggingNoteRef.current && !selectGestureRef.current && canDraw) {
      if (effectiveTool === 'text') {
        const hit = hitEditableNote(
          elements,
          allGoneNoteIds,
          world.x,
          world.y,
          8 / stageScale,
          userId,
          isTeacher
        );
        setHoveredNoteId(hit ? hit.id : null);
      } else if (effectiveTool === 'select') {
        const hit = hitElementAtPoint(
          elements,
          allGoneNoteIds,
          world.x,
          world.y,
          10 / stageScale,
          userId,
          isTeacher
        );
        if (hit) {
          setHoveredNoteId(hit.id);
        } else if (selectionBounds) {
          const pad = 8 / stageScale;
          const [sx1, sy1, sx2, sy2] = selectionBounds;
          const insideBox =
            world.x >= sx1 - pad &&
            world.x <= sx2 + pad &&
            world.y >= sy1 - pad &&
            world.y <= sy2 + pad;
          setHoveredNoteId(insideBox ? '__selection_box__' : null);
        } else {
          setHoveredNoteId(null);
        }
      } else if (hoveredNoteId !== null) {
        setHoveredNoteId(null);
      }
    }

    const now = Date.now();
    if (now - lastCursorEmitRef.current > 50) {
      lastCursorEmitRef.current = now;
      onCursorMove({
        userId,
        userName,
        color: userColor,
        boardId: activeBoardId,
        x: world.x,
        y: world.y,
        tool: effectiveTool,
        isDrawing,
      });
    }

    if (e.pointerId !== activePointerIdRef.current) return;

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
          if (
            g.mode === 'drag-single' &&
            g.shiftKey &&
            g.singleEl &&
            !g.prevSelectedIds.includes(g.singleEl.id)
          ) {
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
        smoothLevel > 0 &&
        typeof rawEvt.getCoalescedEvents === 'function' &&
        rawEvt.getCoalescedEvents().length > 0
          ? rawEvt.getCoalescedEvents()
          : [rawEvt];

      const appended: number[] = [];
      const minDist =
        smoothLevel === 0
          ? Math.max(1.2, 1.5 / stageScale)
          : Math.max(0.4, 0.7 / stageScale);
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
              const bringToFront = !beforeItems.some((el) =>
                hasSubsequentOverlappingEraser(el, elements)
              );
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
          setSelectedIds(
            prev.includes(hitId) ? prev.filter((id) => id !== hitId) : [...prev, hitId]
          );
        }
      } else if (g.mode === 'lasso') {
        if (g.moved && g.loopPoints.length >= 6) {
          const picked = lassoSelectElements(
            elements,
            allGoneNoteIds,
            g.loopPoints,
            userId,
            isTeacher
          );
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
      if (
        e.type === 'pointerup' &&
        strokeTool !== 'rect' &&
        strokeTool !== 'circle' &&
        strokeTool !== 'line'
      ) {
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
        recordUndo({ kind: 'add', items: [completed] });
      }
    }
  };

  // Double-clicking any editable note on the canvas (even while using a pen/shape tool) opens it for re-typing!
  const handleViewportDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canDraw) return;
    const pos = getLocalPosFromEvent(e.clientX, e.clientY);
    const world = screenToWorld(pos.x, pos.y);
    const hit = hitEditableNote(
      elements,
      allGoneNoteIds,
      world.x,
      world.y,
      10 / stageScale,
      userId,
      isTeacher
    );
    if (hit) {
      e.preventDefault();
      openOrTapNoteAt(world.x, world.y, hit);
    }
  };

  const renderElement = (el: CanvasElement, goneNoteIds?: Set<string>) => {
    if (el.tool === 'text') {
      // Hide note if an eraser stroke touched it (`notesGone`) or if it is currently open in the inline note editor
      if (goneNoteIds?.has(el.id)) return null;
      if (editingNote?.existingId === el.id) return null;
    }

    const dragDx =
      selectionDragOffset && selectedIds.includes(el.id)
        ? selectionDragOffset.dx
        : draggingNotePreview && draggingNotePreview.id === el.id
        ? draggingNotePreview.dx
        : 0;
    const dragDy =
      selectionDragOffset && selectedIds.includes(el.id)
        ? selectionDragOffset.dy
        : draggingNotePreview && draggingNotePreview.id === el.id
        ? draggingNotePreview.dy
        : 0;

    const renderBase = () => {
      if (el.tool === 'stamp') {
        if (el.stamp === 'username') {
          const label = el.userName || 'Student';
          const fontSize = Math.max(13, Math.round(el.strokeWidth * 1.1 + 10));
          const padX = Math.round(fontSize * 0.85);
          const badgeW = Math.max(64, Math.round(label.length * (fontSize * 0.62) + padX * 2));
          const badgeH = Math.round(fontSize * 1.85);
          return (
            <Group x={el.x || 0} y={el.y || 0}>
              <Rect
                x={-badgeW / 2}
                y={-badgeH / 2}
                width={badgeW}
                height={badgeH}
                cornerRadius={badgeH / 2}
                fill="#ffffff"
                stroke={el.color}
                strokeWidth={Math.max(2, fontSize * 0.14)}
                shadowColor="#0f172a"
                shadowBlur={4}
                shadowOpacity={0.12}
                shadowOffsetY={1}
              />
              <KonvaText
                x={-badgeW / 2}
                y={-fontSize * 0.48}
                width={badgeW}
                align="center"
                text={label}
                fill={el.color}
                fontSize={fontSize}
                fontFamily="Plus Jakarta Sans, sans-serif"
                fontStyle="700"
              />
            </Group>
          );
        }

        const stampDef = STAMP_OPTIONS.find((s) => s.kind === el.stamp) || STAMP_OPTIONS[0];
        const radius = Math.max(16, el.strokeWidth * 1.8 + 10);
        const fontSize = Math.round(radius * 1.15);
        return (
          <Group x={el.x || 0} y={el.y || 0}>
            <Circle
              radius={radius}
              fill="#ffffff"
              stroke={el.color}
              strokeWidth={Math.max(2.5, radius * 0.14)}
              shadowColor="#0f172a"
              shadowBlur={4}
              shadowOpacity={0.12}
              shadowOffsetY={1}
            />
            <KonvaText
              x={-radius}
              y={-fontSize * 0.52}
              width={radius * 2}
              align="center"
              text={stampDef.symbol}
              fill={el.color}
              fontSize={fontSize}
              fontFamily="Plus Jakarta Sans, sans-serif"
              fontStyle="700"
            />
          </Group>
        );
      }

      if (el.tool === 'rect') {
        const x = (el.width || 0) < 0 ? (el.x || 0) + (el.width || 0) : el.x || 0;
        const y = (el.height || 0) < 0 ? (el.y || 0) + (el.height || 0) : el.y || 0;
        return (
          <Rect
            x={x}
            y={y}
            width={Math.abs(el.width || 0)}
            height={Math.abs(el.height || 0)}
            stroke={el.color}
            strokeWidth={el.strokeWidth}
            cornerRadius={2}
          />
        );
      }

      if (el.tool === 'circle') {
        const radiusX = Math.abs(el.width || 0) / 2;
        const radiusY = Math.abs(el.height || 0) / 2;
        const radius = Math.max(radiusX, radiusY);
        const centerX = (el.x || 0) + (el.width || 0) / 2;
        const centerY = (el.y || 0) + (el.height || 0) / 2;
        return (
          <Circle
            x={centerX}
            y={centerY}
            radius={radius}
            stroke={el.color}
            strokeWidth={el.strokeWidth}
          />
        );
      }

      if (el.tool === 'text') {
        const fontSize = getNoteFontSize(el);
        return (
          <KonvaText
            x={el.x || 0}
            y={el.y || 0}
            text={el.text || ''}
            fill={el.color}
            fontSize={fontSize}
            lineHeight={NOTE_LH}
            fontFamily={NOTE_FONT}
            fontStyle="600"
          />
        );
      }

      const pts = el.points || [];
      if (pts.length < 2) return null;

      if (el.tool === 'eraser') {
        return (
          <SmoothStrokeShape
            points={pts}
            color="#000000"
            strokeWidth={Math.max(8, el.strokeWidth * 1.5)}
            globalCompositeOperation="destination-out"
          />
        );
      }

      if (el.tool === 'spray') {
        return (
          <Line
            points={pts}
            stroke={el.color}
            strokeWidth={el.strokeWidth * 1.4}
            tension={0.4}
            lineCap="round"
            lineJoin="round"
            opacity={0.45}
            dash={[1, Math.max(6, Math.round(el.strokeWidth * 0.9))]}
          />
        );
      }

      if (el.tool === 'highlighter') {
        return (
          <SmoothStrokeShape
            points={pts}
            color={el.color}
            strokeWidth={el.strokeWidth}
            opacity={1}
          />
        );
      }

      if (el.tool === 'hollow') {
        return (
          <HollowStrokeShape
            points={pts}
            color={el.color}
            strokeWidth={el.strokeWidth}
            hollowWeight={el.hollowWeight || 2}
            hollowShape={el.hollowShape || 'circle'}
          />
        );
      }

      if (el.tool === 'line') {
        return (
          <Line
            points={pts}
            stroke={el.color}
            strokeWidth={el.strokeWidth}
            lineCap="round"
            lineJoin="round"
          />
        );
      }

      return (
        <SmoothStrokeShape
          points={pts}
          color={el.color}
          strokeWidth={el.strokeWidth}
        />
      );
    };

    const node = renderBase();
    if (!node) return null;
    return (
      <Group key={el.id} x={dragDx} y={dragDy}>
        {node}
      </Group>
    );
  };

  // List of relevant sub-boards for current mode
  const activeSubBoardList = useMemo(() => {
    const all = Object.values(subBoards) as SubBoardData[];
    if (breakoutConfig.mode === 'individual') {
      return all.filter((sb) => sb.id.startsWith('ind_'));
    }
    if (breakoutConfig.mode === 'groups') {
      return all.filter((sb) => sb.id.startsWith('grp_'));
    }
    return all;
  }, [subBoards, breakoutConfig.mode]);

  const gridSpacing = Math.max(20, Math.round(40 * stageScale));
  const activeSwatches = useMemo(() => getPaletteColors(paletteMode), [paletteMode]);

  return (
    <div className="flex flex-col h-full bg-white select-none relative">
      {/* Hidden File Inputs for Teacher JSON Import and Worksheet Upload */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        onChange={handleFileChange}
        className="hidden"
      />
      <input
        ref={worksheetInputRef}
        type="file"
        accept=".png,.jpg,.jpeg,.webp,.pdf,image/png,image/jpeg,image/webp,application/pdf"
        onChange={handleWorksheetFileChange}
        className="hidden"
      />

      {/* Primary Drawing & Studio Toolbar (`data-keep-note` lets users restyle an open note without closing it) */}
      <div
        data-keep-note="true"
        className="px-4 py-2 border-b border-slate-200 flex flex-wrap items-center gap-2.5 bg-white z-20"
      >
        {/* Navigation & Brush Tools */}
        <div className="flex items-center gap-0.5 bg-slate-100 p-1 rounded-lg border border-slate-200/80">
          <button
            type="button"
            onClick={() => setTool('pan')}
            className={cn(
              "p-1.5 rounded-md transition-colors cursor-pointer",
              effectiveTool === 'pan'
                ? "bg-white text-blue-600 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            )}
            title="Pan Tool (or hold Spacebar + Drag)"
          >
            <Hand size={17} />
          </button>

          <button
            type="button"
            disabled={!canDraw}
            onClick={() => setTool('select')}
            className={cn(
              "px-2 py-1.5 rounded-md transition-colors cursor-pointer disabled:opacity-40 flex items-center gap-1 text-xs font-semibold",
              effectiveTool === 'select'
                ? "bg-white text-indigo-600 shadow-xs ring-1 ring-indigo-200"
                : "text-slate-600 hover:text-slate-900"
            )}
            title="Select & Lasso Tool: Tap or circle annotations and text to move, resize, restyle, copy, duplicate, or delete"
          >
            <Lasso size={16} />
            <span className="hidden md:inline">Select</span>
          </button>

          <div className="h-4 w-px bg-slate-300 mx-0.5" />

          <button
            type="button"
            disabled={!canDraw}
            onClick={() => setTool('solid')}
            className={cn(
              "p-1.5 rounded-md transition-colors cursor-pointer disabled:opacity-40",
              tool === 'solid' && effectiveTool !== 'pan'
                ? "bg-white text-blue-600 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            )}
            title="Solid Pen"
          >
            <Paintbrush size={17} />
          </button>
          {/* Hollow Outline Shape Brush with Curved Radial Shape Selector (Circle, Square, Triangle, Diamond, Star) */}
          <div ref={hollowMenuRef} className="relative flex items-center">
            <button
              type="button"
              disabled={!canDraw}
              onClick={() => {
                setTool('hollow');
                setShowHollowMenu((prev) => (tool === 'hollow' ? !prev : true));
              }}
              aria-haspopup="true"
              aria-expanded={showHollowMenu}
              className={cn(
                "p-1.5 rounded-md transition-colors cursor-pointer disabled:opacity-40 flex items-center justify-center",
                tool === 'hollow' && effectiveTool !== 'pan'
                  ? "bg-white text-blue-600 shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
              )}
              title={`Hollow ${hollowShape.charAt(0).toUpperCase() + hollowShape.slice(1)} Brush (Click to stamp, drag to draw hollow stroke — click to pick shape)`}
            >
              <HollowShapeIcon kind={hollowShape} size={17} />
            </button>

            {showHollowMenu && (
              <div
                role="menu"
                aria-label="Hollow brush shapes"
                className="absolute left-1/2 top-full z-50 pointer-events-none"
                style={{ width: 0, height: 0 }}
              >
                {/* Subtle curved guide arc connecting the 5 radial options */}
                <svg
                  width="168"
                  height="88"
                  viewBox="-84 0 168 88"
                  className="overflow-visible pointer-events-none drop-shadow-xs"
                  style={{ position: 'absolute', left: -84, top: 0 }}
                >
                  <path
                    d="M -62 26 Q 0 88 62 26"
                    fill="none"
                    stroke="#0f172a"
                    strokeWidth="26"
                    strokeLinecap="round"
                    opacity="0.92"
                  />
                  <path
                    d="M -62 26 Q 0 88 62 26"
                    fill="none"
                    stroke="#334155"
                    strokeWidth="1.5"
                    strokeDasharray="3 3"
                  />
                </svg>

                {HOLLOW_SHAPE_OPTIONS.map((opt) => {
                  const isActive = hollowShape === opt.kind;
                  return (
                    <button
                      key={opt.kind}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setHollowShape(opt.kind);
                        saveLocal('allaboard-hollow-shape', opt.kind);
                        setTool('hollow');
                        setShowHollowMenu(false);
                      }}
                      style={{
                        position: 'absolute',
                        left: opt.dx,
                        top: opt.dy,
                        transform: 'translate(-50%, -50%)',
                      }}
                      className={cn(
                        "pointer-events-auto w-8 h-8 rounded-full flex items-center justify-center transition-all cursor-pointer shadow-md border",
                        isActive
                          ? "bg-blue-600 text-white border-white scale-110 ring-2 ring-blue-300"
                          : "bg-slate-900 text-slate-200 border-slate-600 hover:bg-slate-800 hover:text-white hover:scale-110"
                      )}
                      title={`Hollow ${opt.label}`}
                    >
                      <HollowShapeIcon kind={opt.kind} size={15} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <button
            type="button"
            disabled={!canDraw}
            onClick={() => setTool('spray')}
            className={cn(
              "p-1.5 rounded-md transition-colors cursor-pointer disabled:opacity-40",
              tool === 'spray' && effectiveTool !== 'pan'
                ? "bg-white text-blue-600 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            )}
            title="Spray Paint"
          >
            <SprayCan size={17} />
          </button>

          {/* OverBoard Split See-Through Highlighter & Cover Mode Popout Menu */}
          <div ref={hlMenuRef} className="relative flex items-center">
            <button
              type="button"
              disabled={!canDraw}
              onClick={() => setTool('highlighter')}
              className={cn(
                "px-2 py-1.5 rounded-l-md transition-colors cursor-pointer disabled:opacity-40 flex items-center gap-1 text-xs font-semibold",
                tool === 'highlighter' && effectiveTool !== 'pan'
                  ? isCoverMode
                    ? "bg-slate-800 text-white shadow-xs"
                    : "bg-amber-200 text-slate-900 shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
              )}
              title={
                isCoverMode
                  ? "Cover Mode: opaque cover bar that hides text/answers until erased"
                  : "Highlighter Mode: see-through multiply highlight under pen ink (never dulls black worksheet text)"
              }
            >
              <Highlighter size={16} />
              <span className="hidden sm:inline">{isCoverMode ? 'Cover' : 'Highlight'}</span>
            </button>
            <button
              type="button"
              disabled={!canDraw}
              onClick={() => {
                setTool('highlighter');
                setShowHlMenu((prev) => !prev);
              }}
              aria-haspopup="true"
              aria-expanded={showHlMenu}
              className={cn(
                "px-1 py-1.5 rounded-r-md border-l border-slate-300/70 transition-colors cursor-pointer disabled:opacity-40",
                showHlMenu || (tool === 'highlighter' && effectiveTool !== 'pan')
                  ? isCoverMode
                    ? "bg-slate-700 text-white"
                    : "bg-amber-300/80 text-slate-900"
                  : "text-slate-500 hover:text-slate-900"
              )}
              title="Switch between See-Through Highlight & Opaque Cover Mode"
            >
              <ChevronDown size={13} />
            </button>

            {/* OverBoard Highlighter Strength / Cover Mode Popout Menu */}
            {showHlMenu && (
              <div
                role="menu"
                aria-label="Highlighter options"
                className="absolute left-0 top-full mt-1.5 z-50 w-64 p-3 rounded-xl bg-slate-900 text-white shadow-xl border border-slate-700 space-y-2.5"
              >
                <div className="grid grid-cols-2 gap-1 bg-slate-800 p-1 rounded-lg">
                  <button
                    type="button"
                    onClick={() => {
                      setIsCoverMode(false);
                      setTool('highlighter');
                    }}
                    className={cn(
                      "px-2 py-1.5 rounded-md text-xs font-semibold transition-colors cursor-pointer",
                      !isCoverMode
                        ? "bg-amber-400 text-slate-950 shadow-xs"
                        : "text-slate-300 hover:text-white"
                    )}
                  >
                    Highlight
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsCoverMode(true);
                      setTool('highlighter');
                    }}
                    className={cn(
                      "px-2 py-1.5 rounded-md text-xs font-semibold transition-colors cursor-pointer",
                      isCoverMode
                        ? "bg-white text-slate-950 shadow-xs"
                        : "text-slate-300 hover:text-white"
                    )}
                  >
                    Cover (Opaque)
                  </button>
                </div>

                {!isCoverMode ? (
                  <>
                    <div className="flex items-center gap-2.5">
                      <span
                        className="w-6 h-6 rounded border-2 border-white shrink-0"
                        style={{ backgroundColor: hlInk(hlColor, hlStrength) }}
                      />
                      <div>
                        <div className="text-xs font-bold text-white">See-Through Highlight</div>
                        <div className="text-[11px] text-slate-300">Multiplies cleanly under dark ink</div>
                      </div>
                    </div>

                    <label className="block space-y-1.5 pt-1 border-t border-slate-800">
                      <div className="flex items-center justify-between text-xs font-semibold text-slate-200">
                        <span>Highlight strength</span>
                        <span className="font-mono text-amber-400">{hlStrength}%</span>
                      </div>
                      <input
                        type="range"
                        min="10"
                        max="100"
                        step="5"
                        value={hlStrength}
                        onChange={(e) => {
                          const next = parseInt(e.target.value, 10);
                          setHlStrength(next);
                          saveLocal('allaboard-hl-strength', String(next));
                          setTool('highlighter');
                        }}
                        className="w-full h-2 rounded-lg appearance-none cursor-pointer accent-amber-400"
                        style={{
                          background: `linear-gradient(90deg, #ffffff, ${hlInk(hlColor, hlStrength)})`,
                        }}
                      />
                    </label>
                  </>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2.5">
                      <span
                        className="w-6 h-6 rounded border-2 border-white shrink-0"
                        style={{ backgroundColor: coverColor }}
                      />
                      <div>
                        <div className="text-xs font-bold text-white">Opaque Cover Bar</div>
                        <div className="text-[11px] text-slate-300">Hides answers &amp; text underneath</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 pt-1 border-t border-slate-800">
                      {getPaletteColors('cover').map((sw) => (
                        <button
                          key={sw.color}
                          type="button"
                          onClick={() => {
                            setCoverColor(sw.color);
                            saveLocal('allaboard-cover-color', sw.color);
                            setTool('highlighter');
                          }}
                          className={cn(
                            "w-5 h-5 rounded-full border border-slate-500 cursor-pointer transition-transform hover:scale-110",
                            coverColor.toLowerCase() === sw.color.toLowerCase() &&
                              "ring-2 ring-amber-400 ring-offset-1 ring-offset-slate-900 scale-110"
                          )}
                          style={{ backgroundColor: sw.color }}
                          title={sw.label}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <button
            type="button"
            disabled={!canDraw}
            onClick={() => setTool('eraser')}
            className={cn(
              "p-1.5 rounded-md transition-colors cursor-pointer disabled:opacity-40",
              tool === 'eraser' && effectiveTool !== 'pan'
                ? "bg-white text-blue-600 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            )}
            title="Personal Eraser (Erases your own ink, highlights, and whole text notes — SMART Board palm always erases)"
          >
            <Eraser size={17} />
          </button>

          <div className="h-4 w-px bg-slate-300 mx-0.5" />

          {/* Geometric Shapes, Editable Text Notes & Quick Stamp */}
          <button
            type="button"
            disabled={!canDraw}
            onClick={() => setTool('line')}
            className={cn(
              "p-1.5 rounded-md transition-colors cursor-pointer disabled:opacity-40",
              tool === 'line' && effectiveTool !== 'pan'
                ? "bg-white text-blue-600 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            )}
            title="Straight Line"
          >
            <Minus size={17} />
          </button>
          <button
            type="button"
            disabled={!canDraw}
            onClick={() => setTool('rect')}
            className={cn(
              "p-1.5 rounded-md transition-colors cursor-pointer disabled:opacity-40",
              tool === 'rect' && effectiveTool !== 'pan'
                ? "bg-white text-blue-600 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            )}
            title="Rectangle"
          >
            <Square size={17} />
          </button>
          <button
            type="button"
            disabled={!canDraw}
            onClick={() => setTool('circle')}
            className={cn(
              "p-1.5 rounded-md transition-colors cursor-pointer disabled:opacity-40",
              tool === 'circle' && effectiveTool !== 'pan'
                ? "bg-white text-blue-600 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            )}
            title="Circle"
          >
            <CircleIcon size={17} className="stroke-[2.5]" />
          </button>
          <button
            type="button"
            disabled={!canDraw}
            onClick={() => setTool('text')}
            className={cn(
              "px-2 py-1.5 rounded-md transition-colors cursor-pointer disabled:opacity-40 flex items-center gap-1 text-xs font-semibold",
              tool === 'text' && effectiveTool !== 'pan'
                ? "bg-white text-blue-600 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            )}
            title="Type Note: Tap canvas to type, drag any note to move it, or tap/double-click a note to re-type it"
          >
            <Type size={16} />
            <span className="hidden md:inline">Type</span>
          </button>
          <button
            type="button"
            disabled={!canDraw}
            onClick={() => setTool('stamp')}
            className={cn(
              "p-1.5 rounded-md transition-colors cursor-pointer disabled:opacity-40",
              tool === 'stamp' && effectiveTool !== 'pan'
                ? "bg-white text-blue-600 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            )}
            title="Quick Stamp Tool (Checkmark, Question Mark, Star, Thumbs Up, Heart, or Your Username)"
          >
            <Stamp size={17} />
          </button>
        </div>

        {/* Inline Stamp Selector when Stamp Tool is Active */}
        {tool === 'stamp' && canDraw && (
          <div className="flex items-center gap-1 bg-blue-50/80 px-2 py-1 rounded-lg border border-blue-200/80">
            <span className="text-[11px] font-medium text-blue-800 mr-1">Stamp:</span>
            {STAMP_OPTIONS.map((st) => (
              <button
                key={st.kind}
                type="button"
                onClick={() => setStampKind(st.kind)}
                className={cn(
                  "px-2 h-6 rounded flex items-center justify-center text-xs font-bold transition-colors cursor-pointer whitespace-nowrap",
                  stampKind === st.kind
                    ? "bg-blue-600 text-white shadow-xs"
                    : "bg-white text-slate-700 hover:bg-blue-100"
                )}
                title={st.label}
              >
                {st.kind === 'username' ? `[ ${userName} ]` : st.symbol}
              </button>
            ))}
          </div>
        )}

        {/* OverBoard Mode-Aware Color Swatches + Custom Color Picker */}
        <div className="flex items-center gap-1.5">
          {activeSwatches.map((sw) => {
            const activeTargetColor = editingNote ? editingNote.color : color;
            const isSelected =
              activeTargetColor.toLowerCase() === sw.color.toLowerCase() && tool !== 'eraser';
            return (
              <button
                key={`${paletteMode}_${sw.color}`}
                type="button"
                onClick={() => handleSelectColor(sw.color)}
                className={cn(
                  "w-5 h-5 rounded-full border border-slate-300 transition-transform hover:scale-110 cursor-pointer",
                  isSelected && "ring-2 ring-blue-600 ring-offset-2 scale-110"
                )}
                style={{ backgroundColor: sw.color }}
                title={sw.label}
              />
            );
          })}

          {/* Custom Color Wheel Picker (OverBoard `#ink-picker`) */}
          <div className="relative flex items-center">
            <button
              type="button"
              onClick={() => customColorInputRef.current?.click()}
              className="w-5 h-5 rounded-full border border-slate-300 flex items-center justify-center transition-transform hover:scale-110 cursor-pointer"
              style={{
                background:
                  'conic-gradient(#f44336,#ffeb3b,#4caf50,#00bcd4,#3f51b5,#e91e63,#f44336)',
              }}
              title="Pick any custom color"
            >
              <span
                className="w-2.5 h-2.5 rounded-full border border-white"
                style={{ backgroundColor: editingNote ? editingNote.color : color }}
              />
            </button>
            <input
              ref={customColorInputRef}
              type="color"
              value={editingNote ? editingNote.color : color}
              onChange={(e) => handleSelectColor(e.target.value)}
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
            />
          </div>
        </div>

        <div className="h-5 w-px bg-slate-200" />

        {/* Labeled Brush / Highlight / Eraser / Hollow Size Slider */}
        <div className="flex items-center gap-1.5">
          <label htmlFor="brush-size-slider" className="text-xs font-medium text-slate-600 whitespace-nowrap">
            {tool === 'eraser'
              ? 'Eraser:'
              : tool === 'highlighter'
              ? isCoverMode
                ? 'Cover:'
                : 'Highlight:'
              : 'Size:'}
          </label>
          <input
            id="brush-size-slider"
            type="range"
            min={tool === 'eraser' ? 8 : tool === 'highlighter' || tool === 'hollow' ? 4 : 1}
            max={
              tool === 'eraser'
                ? 400
                : tool === 'hollow'
                ? 120
                : tool === 'highlighter'
                ? 60
                : 50
            }
            value={strokeWidth}
            onChange={(e) => handleSelectStrokeWidth(parseInt(e.target.value, 10))}
            className="w-24 h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
          />
          <span className="text-xs font-mono tabular-nums text-slate-600 w-8">
            {strokeWidth}
          </span>
        </div>

        {/* Dedicated Line Weight Slider when Hollow Shape Brush is Active */}
        {tool === 'hollow' && (
          <div className="flex items-center gap-1.5 bg-blue-50/80 px-2 py-0.5 rounded-lg border border-blue-200/80">
            <label
              htmlFor="hollow-weight-slider"
              className="text-xs font-medium text-blue-900 whitespace-nowrap"
              title="Border line weight of the hollow shape"
            >
              Line Weight:
            </label>
            <input
              id="hollow-weight-slider"
              type="range"
              min={1}
              max={Math.max(2, Math.min(25, Math.floor(hollowWidth / 2) - 1))}
              value={Math.min(hollowWeight, Math.max(1, Math.floor(hollowWidth / 2) - 1))}
              onChange={(e) => handleSelectHollowWeight(parseInt(e.target.value, 10))}
              className="w-20 h-1.5 bg-blue-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
            />
            <span className="text-xs font-mono tabular-nums text-blue-900 w-6">
              {Math.min(hollowWeight, Math.max(1, Math.floor(hollowWidth / 2) - 1))}
            </span>
          </div>
        )}

        {/* Dedicated Independent Text Size Controls */}
        <div
          className={cn(
            "flex items-center gap-1 px-2 py-0.5 rounded-lg border text-xs transition-colors",
            tool === 'text' || Boolean(editingNote) || selectedTextElements.length > 0
              ? "bg-blue-50/90 border-blue-200"
              : "bg-slate-100 border-slate-200/80"
          )}
          title="Text font size in pixels (independent of brush stroke width)"
        >
          <span className="text-[11px] font-semibold text-slate-600 whitespace-nowrap">Text:</span>
          <div className="flex items-center gap-0.5">
            {TEXT_SIZE_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                disabled={!canDraw}
                onClick={() => handleSelectTextFontSize(preset.size)}
                className={cn(
                  "px-1.5 py-0.5 rounded text-[11px] font-bold transition-colors cursor-pointer disabled:opacity-40",
                  activeTextSize === preset.size
                    ? "bg-blue-600 text-white shadow-xs"
                    : "text-slate-700 hover:bg-white"
                )}
                title={preset.title}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={!canDraw || activeTextSize <= 12}
            onClick={() => handleSelectTextFontSize(activeTextSize - 2)}
            className="w-5 h-5 rounded hover:bg-white text-slate-700 font-bold disabled:opacity-35 cursor-pointer"
            title="Decrease text size"
          >
            &minus;
          </button>
          <input
            aria-label="Text size"
            type="range"
            min={12}
            max={96}
            value={activeTextSize}
            onChange={(e) => handleSelectTextFontSize(parseInt(e.target.value, 10))}
            className="w-16 h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600 hidden sm:block"
          />
          <button
            type="button"
            disabled={!canDraw || activeTextSize >= 96}
            onClick={() => handleSelectTextFontSize(activeTextSize + 2)}
            className="w-5 h-5 rounded hover:bg-white text-slate-700 font-bold disabled:opacity-35 cursor-pointer"
            title="Increase text size"
          >
            +
          </button>
          <span className="text-[11px] font-mono tabular-nums text-slate-700 w-9 text-right">
            {activeTextSize}px
          </span>
        </div>

        {/* OverBoard Smoothing Control (0..8) & Smartboard Finger Mode Toggle */}
        <div className="flex items-center gap-1 bg-slate-100 px-1.5 py-0.5 rounded-lg border border-slate-200/80 text-xs">
          <span className="text-[11px] text-slate-500 font-medium" title="OverBoard exponential stroke smoothing (0 = off, 8 = max)">
            Smooth:
          </span>
          <button
            type="button"
            disabled={smoothLevel <= 0}
            onClick={() => {
              const next = Math.max(0, smoothLevel - 1);
              setSmoothLevel(next);
              saveLocal('allaboard-smooth-v2', String(next));
            }}
            className="w-5 h-5 rounded hover:bg-white text-slate-700 font-bold disabled:opacity-35 cursor-pointer"
            title="Less smoothing"
          >
            &minus;
          </button>
          <span className="font-mono font-semibold text-slate-700 w-5 text-center">
            {smoothLevel === 0 ? 'Off' : smoothLevel}
          </span>
          <button
            type="button"
            disabled={smoothLevel >= 8}
            onClick={() => {
              const next = Math.min(8, smoothLevel + 1);
              setSmoothLevel(next);
              saveLocal('allaboard-smooth-v2', String(next));
            }}
            className="w-5 h-5 rounded hover:bg-white text-slate-700 font-bold disabled:opacity-35 cursor-pointer"
            title="More smoothing"
          >
            +
          </button>
        </div>

        <button
          type="button"
          onClick={() => {
            const next = !fingerScrolls;
            setFingerScrolls(next);
            saveLocal('allaboard-finger-scrolls', next ? '1' : '0');
          }}
          className={cn(
            "px-2 py-1 rounded-lg text-[11px] font-medium border transition-colors cursor-pointer whitespace-nowrap",
            fingerScrolls
              ? "bg-amber-50 text-amber-900 border-amber-300"
              : "bg-slate-100 text-slate-600 border-slate-200/80 hover:text-slate-900"
          )}
          title="Smartboard / Tablet mode: Choose whether finger/mouse drags pan the board (while stylus writes & palm erases) or draw directly"
        >
          Finger: {fingerScrolls ? 'pans' : 'draws'}
        </button>

        <div className="flex-1" />

        {/* Personal Actions, JSON Room Save & PNG Export */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={!canDraw}
            onClick={() => {
              if (editingNote) commitEditingNote();
              performUndo();
            }}
            className="flex items-center gap-1 px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40"
            title={canLocalUndo ? "Undo last action (Ctrl+Z)" : "Undo last stroke (Ctrl+Z)"}
          >
            <Undo2 size={15} />
            <span>Undo</span>
          </button>

          <button
            type="button"
            disabled={!canDraw || !canRedo}
            onClick={() => {
              if (editingNote) commitEditingNote();
              performRedo();
            }}
            className="flex items-center gap-1 px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40"
            title="Redo (Ctrl+Y / Ctrl+Shift+Z)"
          >
            <Redo2 size={15} />
            <span>Redo</span>
          </button>

          {confirmClearMine ? (
            <div className="flex items-center gap-1 bg-red-50 px-2 py-1 rounded-lg border border-red-200">
              <span className="text-xs text-red-800 font-medium whitespace-nowrap">Erase yours?</span>
              <button
                type="button"
                onClick={() => {
                  if (editingNote) setEditingNote(null);
                  const myItems = elements.filter(
                    (el) => el.userId === userId && !allGoneNoteIds.has(el.id)
                  );
                  if (myItems.length > 0) {
                    recordUndo({ kind: 'remove', items: myItems });
                  }
                  setSelectedIds([]);
                  onClearMine();
                  setConfirmClearMine(false);
                }}
                className="px-2 py-0.5 text-xs font-medium bg-red-600 text-white rounded hover:bg-red-700 cursor-pointer whitespace-nowrap"
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() => setConfirmClearMine(false)}
                className="px-1.5 py-0.5 text-xs text-slate-600 hover:text-slate-900 cursor-pointer"
              >
                No
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={!canDraw}
              onClick={() => setConfirmClearMine(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40"
              title="Erase only your own drawings"
            >
              <Eraser size={15} />
              <span>Clear Mine</span>
            </button>
          )}

          <div className="h-4 w-px bg-slate-200 mx-0.5" />

          <button
            type="button"
            onClick={handleExportJSON}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200/80 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            title="Save room drawings, breakout boards, worksheet, and chat log as a portable .json snapshot"
          >
            <FileJson size={14} />
            <span>Save .JSON</span>
          </button>

          <button
            type="button"
            onClick={handleExportPNG}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-900 text-white hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            title="Download current canvas view as PNG"
          >
            <Download size={14} />
            <span>Export PNG</span>
          </button>
        </div>
      </div>

      {/* Teacher Classroom Moderation, Breakout Switchboard & Worksheet Deck OR Student Sub-Board Bar */}
      {isTeacher ? (
        <div className="px-4 py-2 bg-amber-50/90 border-b border-amber-200/80 flex flex-wrap items-center justify-between gap-3 z-10">
          <div className="flex flex-wrap items-center gap-2 text-xs text-amber-900">
            <span className="font-display font-semibold">Teacher</span>

            {/* Breakout / Individual Mode Launcher */}
            <button
              type="button"
              onClick={handleOpenBreakoutModal}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer",
                breakoutConfig.mode !== 'main'
                  ? "bg-blue-600 text-white hover:bg-blue-700"
                  : "bg-white text-slate-800 border border-amber-300 hover:bg-amber-100/60"
              )}
              title="Assign individual student boards or breakout group rooms"
            >
              <Users size={13} />
              <span>
                {breakoutConfig.mode === 'individual'
                  ? `Individual Boards (${activeSubBoardList.length})`
                  : breakoutConfig.mode === 'groups'
                  ? `Breakout Groups (${activeSubBoardList.length})`
                  : 'Breakouts / Individual'}
              </span>
            </button>

            {/* Teacher Board Switcher Dropdown + Live Grid Overview Button */}
            {Object.keys(subBoards).length > 0 && (
              <div className="flex items-center gap-1.5 bg-white px-2 py-0.5 rounded-md border border-amber-300">
                <span className="text-[11px] text-slate-500">Board:</span>
                <select
                  value={activeBoardId}
                  onChange={(e) => {
                    onSelectBoard(e.target.value);
                    setShowLiveGridOverview(false);
                  }}
                  className="text-xs font-semibold text-slate-900 bg-transparent focus:outline-none cursor-pointer pr-1"
                >
                  <option value="main">Main Class Board ({fullMainElements.length} items)</option>
                  {(Object.values(subBoards) as SubBoardData[]).map((sb) => (
                    <option key={sb.id} value={sb.id}>
                      {sb.title} ({sb.elements.length} items)
                    </option>
                  ))}
                </select>

                <span className="text-slate-300" aria-hidden="true">|</span>

                <button
                  type="button"
                  onClick={() => setShowLiveGridOverview(!showLiveGridOverview)}
                  className={cn(
                    "flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold transition-colors cursor-pointer whitespace-nowrap",
                    showLiveGridOverview
                      ? "bg-blue-600 text-white"
                      : "text-blue-700 hover:bg-blue-50"
                  )}
                  title="View live miniature previews of all student and group boards at once"
                >
                  <LayoutGrid size={12} />
                  <span>{showLiveGridOverview ? 'Close Grid' : 'Live Grid View'}</span>
                </button>

                <span className="text-slate-300" aria-hidden="true">|</span>

                <button
                  type="button"
                  disabled={Boolean(pdfExportProgress)}
                  onClick={handleBatchExportAllPdf}
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
                  title="Download a multi-page PDF containing every student or group board in one file"
                >
                  <FileSpreadsheet size={12} />
                  <span>
                    {pdfExportProgress
                      ? `PDF ${pdfExportProgress.current}/${pdfExportProgress.total}...`
                      : 'Export All (.PDF)'}
                  </span>
                </button>
              </div>
            )}

            <span aria-hidden="true">·</span>

            {/* Teacher Classroom Countdown Timer Button & Popover */}
            <div ref={timerMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setShowTimerMenu((prev) => !prev)}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer border",
                  timer?.isRunning
                    ? displayRemainingMs <= 60000
                      ? "bg-red-600 text-white border-red-700 animate-pulse"
                      : "bg-slate-900 text-amber-300 border-slate-800"
                    : displayRemainingMs > 0
                    ? "bg-amber-200 text-slate-900 border-amber-400"
                    : "bg-white text-slate-800 border-amber-300 hover:bg-amber-100/60"
                )}
                title="Start, pause, or configure the synchronized classroom countdown timer"
              >
                <Timer size={13} className={timer?.isRunning ? "text-amber-300" : "text-amber-600"} />
                <span className="font-mono tabular-nums">
                  {timer?.isRunning || displayRemainingMs > 0
                    ? `${formatTimerMs(displayRemainingMs)}${!timer?.isRunning ? ' (Paused)' : ''}`
                    : 'Timer'}
                </span>
              </button>

              {showTimerMenu && (
                <div className="absolute left-0 top-full mt-1.5 z-50 w-72 p-3.5 rounded-xl bg-white border border-slate-200 shadow-xl space-y-3 text-slate-800 select-text">
                  <div className="flex items-center justify-between">
                    <span className="font-display font-bold text-xs text-slate-900">
                      Classroom Countdown Timer
                    </span>
                    {(timer?.isRunning || displayRemainingMs > 0) && (
                      <span className="font-mono tabular-nums text-xs font-bold text-blue-600">
                        {formatTimerMs(displayRemainingMs)}
                      </span>
                    )}
                  </div>

                  {/* Default Preset Buttons: 5, 10, 20, 30 minutes */}
                  <div>
                    <span className="block text-[11px] font-medium text-slate-500 mb-1.5">
                      Quick Start Presets:
                    </span>
                    <div className="grid grid-cols-4 gap-1.5">
                      {[5, 10, 20, 30].map((mins) => (
                        <button
                          key={mins}
                          type="button"
                          onClick={() => {
                            onTeacherTimerControl({
                              action: 'start',
                              durationSeconds: mins * 60,
                            });
                            setShowTimerMenu(false);
                          }}
                          className="py-1.5 px-2 rounded-lg text-xs font-mono font-semibold bg-slate-100 hover:bg-blue-600 hover:text-white text-slate-800 transition-colors cursor-pointer"
                        >
                          {mins}m
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Custom Exact Time Input */}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const secs = parseCustomTimeSeconds(customTimeInput);
                      if (secs && secs >= 5) {
                        onTeacherTimerControl({
                          action: 'start',
                          durationSeconds: secs,
                        });
                        setShowTimerMenu(false);
                      }
                    }}
                    className="space-y-1"
                  >
                    <label className="block text-[11px] font-medium text-slate-500">
                      Exact Time (e.g. <span className="font-mono">7:30</span> or minutes like <span className="font-mono">12</span>):
                    </label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={customTimeInput}
                        onChange={(e) => setCustomTimeInput(e.target.value)}
                        placeholder="e.g. 7:30 or 15"
                        className="flex-1 px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600"
                      />
                      <button
                        type="submit"
                        disabled={!parseCustomTimeSeconds(customTimeInput)}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 cursor-pointer whitespace-nowrap"
                      >
                        Start
                      </button>
                    </div>
                  </form>

                  {/* Active Timer Controls (Pause/Resume, +1m, Stop) */}
                  {(timer?.isRunning || displayRemainingMs > 0) && (
                    <div className="flex items-center gap-1.5 pt-1 border-t border-slate-100">
                      {timer?.isRunning ? (
                        <button
                          type="button"
                          onClick={() => onTeacherTimerControl({ action: 'pause' })}
                          className="flex-1 flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg text-xs font-semibold bg-amber-100 text-amber-900 hover:bg-amber-200 cursor-pointer"
                        >
                          <Pause size={12} />
                          <span>Pause</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onTeacherTimerControl({ action: 'resume' })}
                          className="flex-1 flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 cursor-pointer"
                        >
                          <Play size={12} />
                          <span>Resume</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onTeacherTimerControl({ action: 'add-minute' })}
                        className="py-1.5 px-2.5 rounded-lg text-xs font-mono font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 cursor-pointer"
                        title="Add 1 minute"
                      >
                        +1m
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onTeacherTimerControl({ action: 'stop' });
                          setShowTimerMenu(false);
                        }}
                        className="flex items-center justify-center gap-1 py-1.5 px-2.5 rounded-lg text-xs font-semibold bg-red-50 text-red-600 hover:bg-red-100 cursor-pointer"
                        title="Stop and clear timer"
                      >
                        <RotateCcw size={12} />
                        <span>Stop</span>
                      </button>
                    </div>
                  )}

                  {/* Auto-Lock on Expire Option */}
                  <label className="flex items-center gap-2 pt-1 border-t border-slate-100 text-xs text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(timer?.autoLockOnExpire)}
                      onChange={(e) =>
                        onTeacherTimerControl({
                          action: 'set-autolock',
                          autoLockOnExpire: e.target.checked,
                        })
                      }
                      className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span>Auto-lock board when time expires</span>
                  </label>
                </div>
              )}
            </div>

            <span aria-hidden="true">·</span>

            {/* Built-In Worksheet Templates Button */}
            <button
              type="button"
              onClick={() => setShowTemplateModal(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-white text-slate-800 border border-amber-300 hover:bg-amber-100/60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              title="Choose from 3 customizable classroom worksheet templates"
            >
              <LayoutTemplate size={13} className="text-amber-600" />
              <span>Templates (3)</span>
            </button>

            {/* Upload Custom Background Worksheet Button */}
            <button
              type="button"
              disabled={isUploadingWorksheet}
              onClick={() => worksheetInputRef.current?.click()}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-white text-slate-800 border border-amber-300 hover:bg-amber-100/60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              title="Upload a .jpg, .png, or multi-page .pdf worksheet as a non-erasable background"
            >
              <ImagePlus size={13} className="text-blue-600" />
              <span>
                {isUploadingWorksheet
                  ? 'Rendering...'
                  : background
                  ? 'Upload Custom'
                  : 'Upload (.JPG / .PNG / .PDF)'}
              </span>
            </button>

            {/* Active Background Worksheet Controls */}
            {background && (
              <div className="flex items-center gap-1.5 bg-white/90 px-2 py-0.5 rounded-md border border-amber-200 text-xs text-slate-700">
                <button
                  type="button"
                  onClick={() => setTool(tool === 'move-bg' ? 'solid' : 'move-bg')}
                  className={cn(
                    "flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap",
                    effectiveTool === 'move-bg'
                      ? "bg-blue-600 text-white"
                      : "hover:bg-slate-100 text-slate-700"
                  )}
                  title="Drag background worksheet on the canvas"
                >
                  <Move size={11} />
                  <span>{effectiveTool === 'move-bg' ? 'Moving...' : 'Move'}</span>
                </button>

                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() =>
                      onTeacherUpdateBackground({
                        scale: Math.max(0.2, Number(((background.scale || 1) - 0.15).toFixed(2))),
                      })
                    }
                    className="px-1.5 py-0.5 rounded hover:bg-slate-100 font-mono text-xs cursor-pointer"
                    title="Shrink worksheet"
                  >
                    -
                  </button>
                  <span className="font-mono tabular-nums text-[11px] px-1">
                    {Math.round((background.scale || 1) * 100)}%
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      onTeacherUpdateBackground({
                        scale: Math.min(4.0, Number(((background.scale || 1) + 0.15).toFixed(2))),
                      })
                    }
                    className="px-1.5 py-0.5 rounded hover:bg-slate-100 font-mono text-xs cursor-pointer"
                    title="Enlarge worksheet"
                  >
                    +
                  </button>
                </div>

                {background.pages.length > 1 && (
                  <>
                    <span className="text-slate-300" aria-hidden="true">|</span>
                    <button
                      type="button"
                      onClick={() =>
                        onTeacherUpdateBackground({
                          layout: background.layout === 'row' ? 'stack' : 'row',
                        })
                      }
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-slate-100 text-[11px] font-medium cursor-pointer whitespace-nowrap"
                    >
                      {background.layout === 'row' ? <Columns size={12} /> : <Rows size={12} />}
                      <span>{background.layout === 'row' ? 'Side-by-Side' : 'Stacked'}</span>
                    </button>
                  </>
                )}

                <span className="text-slate-300" aria-hidden="true">|</span>

                <button
                  type="button"
                  onClick={() => {
                    onTeacherSetBackground(null);
                    if (tool === 'move-bg') setTool('solid');
                  }}
                  className="text-red-600 hover:bg-red-50 px-1.5 py-0.5 rounded text-[11px] font-medium cursor-pointer whitespace-nowrap"
                  title="Remove background worksheet from this board"
                >
                  Remove
                </button>
              </div>
            )}

            {worksheetError && (
              <span className="text-xs text-red-600 font-medium">{worksheetError}</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium bg-white text-slate-800 border border-amber-300 hover:bg-amber-100/60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              title="Restore or merge a previously saved .json room snapshot"
            >
              <Upload size={13} />
              <span>Import .JSON</span>
            </button>

            <button
              type="button"
              onClick={() => onTeacherToggleLock(!isCanvasLocked)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer",
                isCanvasLocked
                  ? "bg-amber-600 text-white hover:bg-amber-700"
                  : "bg-white text-amber-900 border border-amber-300 hover:bg-amber-100/60"
              )}
            >
              {isCanvasLocked ? <Unlock size={13} /> : <Lock size={13} />}
              <span>{isCanvasLocked ? 'Unlock Board' : 'Lock Board'}</span>
            </button>

            {confirmClearAll ? (
              <div className="flex items-center gap-1.5 bg-white px-2.5 py-1 rounded-md border border-red-300">
                <span className="text-xs font-medium text-red-700 whitespace-nowrap">
                  Clear ink on {activeBoardTitle}?
                </span>
                <button
                  type="button"
                  onClick={() => {
                    onTeacherClearAll();
                    setConfirmClearAll(false);
                  }}
                  className="px-2 py-0.5 text-xs font-medium bg-red-600 text-white rounded hover:bg-red-700 cursor-pointer whitespace-nowrap"
                >
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmClearAll(false)}
                  className="px-1.5 py-0.5 text-xs text-slate-600 hover:text-slate-900 cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmClearAll(true)}
                className="flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium bg-white text-red-600 border border-red-200 hover:bg-red-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Trash2 size={13} />
                <span>Clear Ink</span>
              </button>
            )}
          </div>
        </div>
      ) : (
        /* Student Status Banner (Breakout / Individual Board Indicator, Active Timer, or Lock Banner) */
        (breakoutConfig.mode !== 'main' ||
          isCanvasLocked ||
          timer?.isRunning ||
          displayRemainingMs > 0) && (
          <div className="px-4 py-1.5 bg-blue-50/90 border-b border-blue-200/80 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-800 z-10">
            <div className="flex items-center gap-2">
              <span className="font-display font-semibold text-blue-900">
                Active Board: {activeBoardTitle}
              </span>
              {breakoutConfig.mode === 'individual' && (
                <span className="text-slate-600">· Personal Individual Assignment</span>
              )}
              {breakoutConfig.mode === 'groups' && (
                <span className="text-slate-600">· Breakout Group Board</span>
              )}
            </div>

            <div className="flex items-center gap-3">
              {(timer?.isRunning || displayRemainingMs > 0) && (
                <span
                  className={cn(
                    "flex items-center gap-1.5 px-2.5 py-0.5 rounded-md font-mono tabular-nums font-bold text-xs",
                    timer?.isRunning
                      ? displayRemainingMs <= 60000
                        ? "bg-red-600 text-white animate-pulse"
                        : "bg-slate-900 text-amber-300"
                      : "bg-amber-200 text-slate-900"
                  )}
                >
                  <Timer size={12} />
                  <span>
                    {formatTimerMs(displayRemainingMs)}
                    {!timer?.isRunning ? ' (Paused)' : ''}
                  </span>
                </span>
              )}

              {breakoutConfig.mode === 'groups' && breakoutConfig.allowSelfSelect && (
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-600">Switch Group:</span>
                  <select
                    value={activeBoardId}
                    onChange={(e) => onAssignUserToBoard(e.target.value)}
                    className="bg-white border border-blue-300 rounded px-2 py-0.5 text-xs font-semibold text-blue-900 cursor-pointer"
                  >
                    {activeSubBoardList.map((sb) => (
                      <option key={sb.id} value={sb.id}>
                        {sb.title} ({sb.assignedUserIds.length} students)
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {isCanvasLocked && (
                <span className="flex items-center gap-1 text-amber-800 font-medium">
                  <Lock size={13} className="text-amber-600" />
                  <span>Read-Only / Locked by Teacher</span>
                </span>
              )}
            </div>
          </div>
        )
      )}

      {/* Teacher Live Grid Overview of All Student / Group Boards */}
      {isTeacher && showLiveGridOverview && (
        <LiveGridOverview
          activeBoardId={activeBoardId}
          activeSubBoardList={activeSubBoardList}
          subBoards={subBoards}
          users={users}
          fullMainElements={fullMainElements}
          fullMainBackground={fullMainBackground}
          pdfExportProgress={pdfExportProgress}
          onBatchExportAllPdf={handleBatchExportAllPdf}
          onOpenBreakoutModal={handleOpenBreakoutModal}
          onSelectBoard={onSelectBoard}
          onClose={() => setShowLiveGridOverview(false)}
        />
      )}

      {/* Teacher Breakout & Individual Assignment Manager Modal */}
      {showBreakoutModal && (
        <BreakoutManagerModal
          users={users}
          fullMainBackground={fullMainBackground}
          draftBreakoutMode={draftBreakoutMode}
          setDraftBreakoutMode={setDraftBreakoutMode}
          draftGroupCount={draftGroupCount}
          setDraftGroupCount={setDraftGroupCount}
          draftGroups={draftGroups}
          setDraftGroups={setDraftGroups}
          draftAllowSelfSelect={draftAllowSelfSelect}
          setDraftAllowSelfSelect={setDraftAllowSelfSelect}
          draftChatScope={draftChatScope}
          setDraftChatScope={setDraftChatScope}
          draftWorksheetChoice={draftWorksheetChoice}
          setDraftWorksheetChoice={setDraftWorksheetChoice}
          draftWorksheetTopic={draftWorksheetTopic}
          setDraftWorksheetTopic={setDraftWorksheetTopic}
          initializeDraftGroups={initializeDraftGroups}
          onConfigureBreakout={onConfigureBreakout}
          onClose={() => setShowBreakoutModal(false)}
          onShowLiveGridOverview={setShowLiveGridOverview}
        />
      )}

      {/* Teacher Built-In Worksheet Templates Modal */}
      {showTemplateModal && (
        <WorksheetTemplateModal
          activeBoardTitle={activeBoardTitle}
          selectedTemplateId={selectedTemplateId}
          setSelectedTemplateId={setSelectedTemplateId}
          templatePromptText={templatePromptText}
          setTemplatePromptText={setTemplatePromptText}
          onApplyTemplate={async (generatedBg) => {
            const res = await onTeacherSetBackground(generatedBg);
            if (res.ok) {
              setTimeout(() => fitElementsAndBackgroundInView(elements, generatedBg), 80);
            }
          }}
          onClose={() => setShowTemplateModal(false)}
        />
      )}

      {/* Teacher JSON Snapshot Restore Modal */}
      {pendingSnapshot && (
        <RestoreSnapshotModal
          roomId={roomId}
          pendingSnapshot={pendingSnapshot}
          importError={importError}
          importMode={importMode}
          setImportMode={setImportMode}
          isImporting={isImporting}
          onConfirmImport={handleConfirmImport}
          onCancel={() => {
            setPendingSnapshot(null);
            setImportError(null);
          }}
        />
      )}

      {/* Infinite Canvas Viewport (Hidden when Teacher is in Live Grid Overview) */}
      <div
        ref={containerRef}
        onPointerDown={handleViewportPointerDown}
        onPointerMove={handleViewportPointerMove}
        onPointerUp={handleViewportPointerUp}
        onPointerCancel={handleViewportPointerUp}
        onDoubleClick={handleViewportDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
        className={cn(
          "flex-1 relative overflow-hidden touch-none",
          showLiveGridOverview && isTeacher && "hidden",
          effectiveTool === 'pan' || effectiveTool === 'move-bg'
            ? isPanning || isMovingBg
              ? "cursor-grabbing"
              : "cursor-grab"
            : effectiveTool === 'select'
            ? selectionDragOffset
              ? "cursor-grabbing"
              : hoveredNoteId
              ? "cursor-move"
              : "cursor-crosshair"
            : effectiveTool === 'text'
            ? draggingNotePreview
              ? "cursor-grabbing"
              : hoveredNoteId
              ? "cursor-move"
              : "cursor-text"
            : "cursor-none"
        )}
        style={getCanvasGridStyle(gridMode, gridSpacing, stagePos)}
      >
        <Stage
          width={dimensions.width}
          height={dimensions.height}
          onWheel={handleWheel}
          ref={stageRef}
        >
          {/* Layer 1: Indelible Teacher Background Worksheet Layer */}
          <Layer
            x={stagePos.x}
            y={stagePos.y}
            scaleX={stageScale}
            scaleY={stageScale}
            listening={false}
          >
            {computedBackgroundPages.map((pg) => (
              <WorksheetPageNode
                key={pg.key}
                dataUrl={pg.dataUrl}
                x={pg.x}
                y={pg.y}
                width={pg.width}
                height={pg.height}
                opacity={pg.opacity}
              />
            ))}
          </Layer>

          {/* Layer 2..N: Per-Student Isolated Multiply-Highlight Layer + Top Ink Layer (OverBoard architecture) */}
          {elementsGroupedByUser.map(
            ({ userId: groupUserId, userElements, goneNoteIds, hasSeeThroughHighlights }) => (
              <React.Fragment key={groupUserId}>
                {hasSeeThroughHighlights && (
                  <MultiplyHighlightLayer
                    x={stagePos.x}
                    y={stagePos.y}
                    scaleX={stageScale}
                    scaleY={stageScale}
                  >
                    {userElements
                      .filter((el) => isSeeThroughHighlight(el) || el.tool === 'eraser')
                      .map((el) => renderElement(el, goneNoteIds))}
                  </MultiplyHighlightLayer>
                )}

                <Layer
                  x={stagePos.x}
                  y={stagePos.y}
                  scaleX={stageScale}
                  scaleY={stageScale}
                  listening={false}
                >
                  {userElements
                    .filter((el) => !isSeeThroughHighlight(el))
                    .map((el) => renderElement(el, goneNoteIds))}
                </Layer>
              </React.Fragment>
            )
          )}

          {/* Top Overlay Layer: Live Remote Cursors (filtered to current activeBoardId) & Local Brush/Stamp Preview */}
          <Layer
            x={stagePos.x}
            y={stagePos.y}
            scaleX={stageScale}
            scaleY={stageScale}
            listening={false}
          >
            {(Object.values(remoteCursors) as RemoteCursor[]).map((rc) => {
              if (rc.userId === userId) return null;
              if ((rc.boardId || 'main') !== activeBoardId) return null;
              return (
                <Group key={rc.userId} x={rc.x} y={rc.y}>
                  <Circle
                    radius={5 / stageScale}
                    fill={rc.color}
                    stroke="#ffffff"
                    strokeWidth={1.5 / stageScale}
                  />
                  <KonvaText
                    x={8 / stageScale}
                    y={-6 / stageScale}
                    text={rc.userName}
                    fontSize={11 / stageScale}
                    fontFamily="Plus Jakarta Sans, sans-serif"
                    fontStyle="600"
                    fill={rc.color}
                  />
                </Group>
              );
            })}

            {effectiveTool !== 'pan' &&
              effectiveTool !== 'move-bg' &&
              effectiveTool !== 'select' &&
              effectiveTool !== 'text' &&
              (effectiveTool === 'hollow' ? (
                <Shape
                  listening={false}
                  perfectDrawEnabled={false}
                  sceneFunc={(ctx) => {
                    const rawCtx = (ctx as any)._context as CanvasRenderingContext2D;
                    if (!rawCtx) return;
                    rawCtx.save();
                    rawCtx.beginPath();
                    traceHollowTipShape(
                      rawCtx,
                      worldPos.x,
                      worldPos.y,
                      strokeWidth / 2,
                      hollowShape
                    );
                    rawCtx.strokeStyle = color;
                    rawCtx.lineWidth = 1.4 / stageScale;
                    rawCtx.setLineDash([3 / stageScale, 3 / stageScale]);
                    rawCtx.stroke();
                    rawCtx.restore();
                  }}
                />
              ) : (
                <Circle
                  x={worldPos.x}
                  y={worldPos.y}
                  radius={
                    effectiveTool === 'stamp'
                      ? Math.max(16, strokeWidth * 1.8 + 10)
                      : effectiveTool === 'eraser'
                      ? Math.max(8, strokeWidth * 1.5) / 2
                      : strokeWidth / 2
                  }
                  stroke={effectiveTool === 'eraser' ? '#64748b' : color}
                  strokeWidth={1.2 / stageScale}
                  dash={[3 / stageScale, 3 / stageScale]}
                />
              ))}

            {/* OverBoard Freehand Lasso Loop Preview */}
            {lassoPoints.length >= 4 && (
              <Line
                points={lassoPoints}
                closed
                stroke="#4f46e5"
                strokeWidth={2 / stageScale}
                dash={[6 / stageScale, 4 / stageScale]}
                fill="rgba(79, 70, 229, 0.08)"
              />
            )}

            {/* Selected Elements Bounding Box */}
            {selectionBounds && selectedElements.length > 0 && (
              <Rect
                x={selectionBounds[0] - 8 / stageScale}
                y={selectionBounds[1] - 8 / stageScale}
                width={Math.max(12 / stageScale, selectionBounds[2] - selectionBounds[0] + 16 / stageScale)}
                height={Math.max(12 / stageScale, selectionBounds[3] - selectionBounds[1] + 16 / stageScale)}
                stroke="#2563eb"
                strokeWidth={1.75 / stageScale}
                dash={[6 / stageScale, 4 / stageScale]}
                fill="rgba(37, 99, 235, 0.05)"
                cornerRadius={4 / stageScale}
              />
            )}
          </Layer>
        </Stage>

        {/* Floating Action Bar for Selected / Lassoed Elements */}
        {selectedElements.length > 0 && selectionBounds && !selectionDragOffset && canDraw && (
          <div
            data-hud="true"
            data-keep-note="true"
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            className="absolute z-40 flex flex-wrap items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-slate-900/95 text-white shadow-xl border border-slate-700 text-xs"
            style={{
              left: Math.max(
                12,
                Math.min(
                  Math.max(12, dimensions.width - 420),
                  stagePos.x + ((selectionBounds[0] + selectionBounds[2]) / 2) * stageScale - 160
                )
              ),
              top: Math.max(
                10,
                Math.min(
                  Math.max(10, dimensions.height - 64),
                  stagePos.y + selectionBounds[1] * stageScale - 52
                )
              ),
            }}
          >
            <span className="font-semibold text-indigo-300 px-1 whitespace-nowrap">
              {selectedElements.length} selected
            </span>

            {selectedTextElements.length > 0 && (
              <>
                <div className="h-3.5 w-px bg-slate-700" />
                <button
                  type="button"
                  onClick={() => handleSelectTextFontSize(activeTextSize - 4)}
                  className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 font-semibold cursor-pointer"
                  title="Shrink selected text"
                >
                  A&minus;
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectTextFontSize(activeTextSize + 4)}
                  className="px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 font-semibold cursor-pointer"
                  title="Grow selected text"
                >
                  A+
                </button>
                {selectedElements.length === 1 && selectedTextElements.length === 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      const target = selectedTextElements[0];
                      setSelectedIds([]);
                      openOrTapNoteAt(target.x || 0, target.y || 0, target);
                    }}
                    className="flex items-center gap-1 px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-500 font-medium cursor-pointer whitespace-nowrap"
                    title="Edit text content"
                  >
                    <Edit3 size={12} />
                    <span>Edit</span>
                  </button>
                )}
              </>
            )}

            <div className="h-3.5 w-px bg-slate-700" />

            <button
              type="button"
              onClick={handleCopySelection}
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 font-medium cursor-pointer whitespace-nowrap"
              title="Copy selection (Ctrl+C)"
            >
              <Copy size={12} />
              <span>Copy</span>
            </button>
            <button
              type="button"
              onClick={handleDuplicateSelection}
              className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 font-medium cursor-pointer whitespace-nowrap"
              title="Duplicate selection (Ctrl+D)"
            >
              Duplicate
            </button>
            <button
              type="button"
              onClick={handleDeleteSelection}
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-red-600/90 hover:bg-red-500 font-medium cursor-pointer whitespace-nowrap"
              title="Delete selected items (Delete)"
            >
              <Trash2 size={12} />
              <span>Delete</span>
            </button>

            {isTeacher && (
              <>
                <div className="h-3.5 w-px bg-slate-700" />
                <select
                  aria-label="Target board to send copy"
                  value={sendToBoardTarget}
                  onChange={(e) => setSendToBoardTarget(e.target.value)}
                  className="bg-slate-800 border border-slate-600 rounded px-1.5 py-0.5 text-[11px] text-white"
                >
                  <option value="ALL_SUBBOARDS">All Breakout Boards</option>
                  <option value="main">Main Class Board</option>
                  {activeSubBoardList.map((sb) => (
                    <option key={sb.id} value={sb.id}>
                      {sb.title}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => handleSendSelectionToBoard(sendToBoardTarget)}
                  className="px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 font-semibold cursor-pointer whitespace-nowrap"
                >
                  Send Copy
                </button>
                {sentFeedback && (
                  <span className="text-[11px] text-emerald-300 font-medium whitespace-nowrap">
                    {sentFeedback}
                  </span>
                )}
              </>
            )}

            <button
              type="button"
              onClick={() => setSelectedIds([])}
              className="p-0.5 rounded text-slate-400 hover:text-white cursor-pointer"
              title="Deselect (Esc)"
            >
              <X size={13} />
            </button>
          </div>
        )}

        {/* Tap-to-Paste Prompt after copying with Select tool */}
        {pastePrompt && clipboardElements.length > 0 && selectedElements.length === 0 && canDraw && (
          <div
            data-hud="true"
            onPointerDown={(e) => e.stopPropagation()}
            className="absolute z-40 flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-slate-900 text-white shadow-xl border border-slate-700 text-xs"
            style={{
              left: Math.max(12, Math.min(dimensions.width - 180, stagePos.x + pastePrompt.worldX * stageScale)),
              top: Math.max(12, Math.min(dimensions.height - 48, stagePos.y + pastePrompt.worldY * stageScale - 36)),
            }}
          >
            <button
              type="button"
              onClick={() => handlePasteElements({ x: pastePrompt.worldX, y: pastePrompt.worldY })}
              className="px-2 py-0.5 rounded bg-indigo-600 hover:bg-indigo-500 font-semibold cursor-pointer whitespace-nowrap"
            >
              Paste {clipboardElements.length} item{clipboardElements.length > 1 ? 's' : ''} here
            </button>
            <button
              type="button"
              onClick={() => setPastePrompt(null)}
              className="p-0.5 text-slate-400 hover:text-white cursor-pointer"
              title="Dismiss"
            >
              <X size={13} />
            </button>
          </div>
        )}

        {/* OverBoard v45 Editable Multiline Text Note (`makeTyping` port) — Drag handle + Live Text Size bar + Multiline Textarea */}
        {editingNote && (
          <div
            data-hud="true"
            data-keep-note="true"
            className="absolute z-40 select-text"
            style={{
              left: stagePos.x + editingNote.worldX * stageScale,
              top: stagePos.y + editingNote.worldY * stageScale,
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {/* Floating Drag Handle & Quick Size Controls */}
            <div
              data-keep-note="true"
              className="absolute -top-8 left-0 flex items-center gap-1 px-1.5 py-0.5 rounded-lg bg-slate-900/95 text-white shadow-md border border-slate-700 text-[11px] whitespace-nowrap"
            >
              <button
                type="button"
                aria-label="Drag note position"
                title="Drag to move this note"
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const startClientX = e.clientX;
                  const startClientY = e.clientY;
                  const origWorldX = editingNote.worldX;
                  const origWorldY = editingNote.worldY;
                  const onMove = (ev: PointerEvent) => {
                    const dx = (ev.clientX - startClientX) / stageScale;
                    const dy = (ev.clientY - startClientY) / stageScale;
                    setEditingNote((prev) =>
                      prev
                        ? {
                            ...prev,
                            worldX: Math.round((origWorldX + dx) * 10) / 10,
                            worldY: Math.round((origWorldY + dy) * 10) / 10,
                          }
                        : null
                    );
                  };
                  const onUp = () => {
                    window.removeEventListener('pointermove', onMove);
                    window.removeEventListener('pointerup', onUp);
                    window.removeEventListener('pointercancel', onUp);
                    requestAnimationFrame(() => noteTextareaRef.current?.focus());
                  };
                  window.addEventListener('pointermove', onMove);
                  window.addEventListener('pointerup', onUp);
                  window.addEventListener('pointercancel', onUp);
                }}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 cursor-grab active:cursor-grabbing text-slate-200 font-medium"
              >
                <Move size={11} />
                <span>Drag</span>
              </button>

              <div className="h-3 w-px bg-slate-700 mx-0.5" />

              {TEXT_SIZE_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => handleSelectTextFontSize(preset.size)}
                  className={cn(
                    "px-1 py-0.5 rounded font-bold cursor-pointer",
                    editingNote.fontSize === preset.size
                      ? "bg-blue-600 text-white"
                      : "text-slate-300 hover:bg-slate-800"
                  )}
                  title={preset.title}
                >
                  {preset.label}
                </button>
              ))}

              <button
                type="button"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => handleSelectTextFontSize(editingNote.fontSize - 3)}
                className="px-1 py-0.5 rounded text-slate-300 hover:bg-slate-800 font-bold cursor-pointer"
                title="Smaller text"
              >
                &minus;
              </button>
              <button
                type="button"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => handleSelectTextFontSize(editingNote.fontSize + 3)}
                className="px-1 py-0.5 rounded text-slate-300 hover:bg-slate-800 font-bold cursor-pointer"
                title="Larger text"
              >
                +
              </button>

              <button
                type="button"
                aria-label="Done editing note"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => commitEditingNote()}
                className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-semibold cursor-pointer ml-0.5"
                title="Save note (Esc or Ctrl+Enter)"
              >
                <Check size={11} />
                <span>Done</span>
              </button>
            </div>

            <textarea
              ref={noteTextareaRef}
              rows={1}
              wrap="off"
              dir="auto"
              spellCheck={false}
              aria-label="Editable text note"
              value={editingNote.value}
              onChange={(e) => {
                setEditingNote({ ...editingNote, value: e.target.value });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
                  e.preventDefault();
                  e.stopPropagation();
                  commitEditingNote();
                }
              }}
              onBlur={(e) => {
                // Keep note open if user clicked the toolbar to change color or size (`restyle`)
                const related = e.relatedTarget as HTMLElement | null;
                if (related && related.closest && related.closest('[data-keep-note="true"]')) {
                  return;
                }
                if (Date.now() - editingNote.openedAt < 200) {
                  requestAnimationFrame(() => noteTextareaRef.current?.focus());
                  return;
                }
                setTimeout(() => {
                  if (document.activeElement !== noteTextareaRef.current) {
                    commitEditingNote();
                  }
                }, 0);
              }}
              placeholder="Type note… (Enter = new line, Esc = done)"
              className="m-0 p-0 border-0 outline-2 outline-dashed outline-blue-600 rounded-xs bg-white/88 resize-none overflow-hidden focus:outline-blue-600 shadow-sm"
              style={{
                color: editingNote.color,
                fontSize: `${editingNote.fontSize * stageScale}px`,
                lineHeight: NOTE_LH,
                fontFamily: NOTE_FONT,
                fontWeight: 600,
              }}
            />
          </div>
        )}

        {/* Custom Precision Cursor Overlay when Drawing */}
        {effectiveTool !== 'pan' && effectiveTool !== 'move-bg' && effectiveTool !== 'select' && effectiveTool !== 'text' && (
          <div
            className="pointer-events-none absolute z-30 flex items-center justify-center"
            style={{
              left: screenPos.x,
              top: screenPos.y,
              transform: 'translate(-50%, -50%)',
            }}
          >
            <div className="relative">
              <MousePointer2 size={15} className="text-slate-900 fill-white drop-shadow-xs" />
              <div
                className="absolute -top-4 left-4 text-white text-[10px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap shadow-xs"
                style={{ backgroundColor: userColor }}
              >
                {userName}
              </div>
            </div>
          </div>
        )}

        {/* Floating Bottom-Right Infinite Canvas Zoom & Navigation HUD */}
        <div
          data-hud="true"
          onPointerDown={(e) => e.stopPropagation()}
          onPointerMove={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          className="absolute bottom-4 right-4 z-20 flex items-center gap-1 bg-white/95 backdrop-blur-xs px-2 py-1.5 rounded-lg border border-slate-200 shadow-sm text-xs text-slate-700"
        >
          {/* Upward Curved Radial Background Grid Selector (Blank, Dots, Graph Paper, Isometric 3D) */}
          <div ref={gridMenuRef} className="relative flex items-center">
            <button
              type="button"
              onClick={() => setShowGridMenu((prev) => !prev)}
              aria-haspopup="true"
              aria-expanded={showGridMenu}
              className={cn(
                "p-1.5 rounded hover:bg-slate-100 transition-colors cursor-pointer",
                gridMode !== 'blank' || showGridMenu
                  ? "text-blue-600 bg-blue-50/70"
                  : "text-slate-400"
              )}
              title={`Background Grid: ${GRID_MODE_OPTIONS.find((o) => o.mode === gridMode)?.label || gridMode} (click to choose Blank, Dots, Graph Paper, or Isometric 3D)`}
            >
              <GridModeIcon mode={gridMode} size={14} />
            </button>

            {showGridMenu && (
              <div
                role="menu"
                aria-label="Canvas background grid options"
                className="absolute left-1/2 bottom-full z-50 pointer-events-none"
                style={{ width: 0, height: 0 }}
              >
                {/* Subtle SVG radial guide arc curving upward */}
                <svg
                  width="156"
                  height="88"
                  viewBox="-78 -80 156 88"
                  className="overflow-visible pointer-events-none"
                >
                  <path
                    d="M -54 -26 Q 0 -76 54 -26"
                    fill="none"
                    stroke="rgba(15, 23, 42, 0.25)"
                    strokeWidth="2"
                    strokeDasharray="3 3"
                  />
                </svg>

                {GRID_MODE_OPTIONS.map((opt) => {
                  const isSelected = gridMode === opt.mode;
                  return (
                    <button
                      key={opt.mode}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isSelected}
                      aria-label={opt.label}
                      onClick={(e) => {
                        e.stopPropagation();
                        setGridMode(opt.mode);
                        saveLocal('allaboard-grid-mode', opt.mode);
                        setShowGridMenu(false);
                      }}
                      style={{
                        left: `${opt.dx}px`,
                        top: `${opt.dy}px`,
                        transform: 'translate(-50%, -50%)',
                      }}
                      className={cn(
                        "pointer-events-auto absolute w-8 h-8 rounded-full flex items-center justify-center shadow-lg border transition-transform hover:scale-110 cursor-pointer",
                        isSelected
                          ? "bg-blue-600 text-white border-white ring-2 ring-blue-500/50"
                          : "bg-slate-900/95 text-slate-200 border-slate-700 hover:bg-slate-800 hover:text-white"
                      )}
                      title={opt.label}
                    >
                      <GridModeIcon mode={opt.mode} size={15} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="h-4 w-px bg-slate-200 mx-0.5" />

          <button
            type="button"
            onClick={() => zoomStep(1 / 1.25)}
            className="p-1.5 rounded hover:bg-slate-100 transition-colors cursor-pointer"
            title="Zoom Out"
          >
            <ZoomOut size={14} />
          </button>

          <button
            type="button"
            onClick={resetView}
            className="px-2 py-1 rounded hover:bg-slate-100 font-mono tabular-nums font-medium text-slate-700 cursor-pointer"
            title="Click to reset zoom to 100% at origin (0,0)"
          >
            {Math.round(stageScale * 100)}%
          </button>

          <button
            type="button"
            onClick={() => zoomStep(1.25)}
            className="p-1.5 rounded hover:bg-slate-100 transition-colors cursor-pointer"
            title="Zoom In"
          >
            <ZoomIn size={14} />
          </button>

          <div className="h-4 w-px bg-slate-200 mx-0.5" />

          <button
            type="button"
            onClick={fitAllContent}
            className="flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-100 font-medium text-slate-700 whitespace-nowrap cursor-pointer"
            title="Fit worksheet and all drawings into view"
          >
            <Maximize2 size={13} />
            <span>Fit All</span>
          </button>
        </div>
      </div>
    </div>
  );
}
