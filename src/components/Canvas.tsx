import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Stage, Layer, Line, Circle, Rect, Text as KonvaText, Group, Image as KonvaImage } from 'react-konva';
import {
  CanvasElement,
  ChatMessage,
  ToolType,
  StampKind,
  RoomBackground,
  RemoteCursor,
  ImportRestoreMode,
  RoomSnapshot,
  BreakoutConfig,
  SubBoardData,
  User,
} from '../types';
import {
  processWorksheetFile,
  BUILT_IN_TEMPLATES,
  BuiltInTemplateId,
  generateTemplateBackground,
} from '../lib/worksheetLoader';
import {
  Eraser,
  Undo2,
  MousePointer2,
  Paintbrush,
  SprayCan,
  Circle as CircleIcon,
  Highlighter,
  Square,
  Minus,
  Type,
  Hand,
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
  AlertCircle,
  Stamp,
  ImagePlus,
  LayoutTemplate,
  Move,
  Columns,
  Rows,
  Users,
  LayoutGrid,
  Shuffle,
} from 'lucide-react';
import { cn } from '../lib/utils';

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
  onElementUpdate: (patch: Partial<CanvasElement> & { id: string }) => void;
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
  fullMainElements: CanvasElement[];
  fullMainMessages: ChatMessage[];
  fullMainBackground: RoomBackground | null;
}

const COLORS = [
  '#0f172a',
  '#dc2626',
  '#ea580c',
  '#d97706',
  '#059669',
  '#0891b2',
  '#2563eb',
  '#4f46e5',
  '#7c3aed',
  '#db2777',
  '#ffffff',
];

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
  onCursorMove,
  onUndo,
  onClearMine,
  onTeacherToggleLock,
  onTeacherClearAll,
  onTeacherSetBackground,
  onTeacherUpdateBackground,
  onTeacherImportRoom,
  fullMainElements,
  fullMainMessages,
  fullMainBackground,
}: CanvasProps) {
  const [color, setColor] = useState('#0f172a');
  const [strokeWidth, setStrokeWidth] = useState(6);
  const [tool, setTool] = useState<ToolType>('solid');
  const [stampKind, setStampKind] = useState<StampKind>('check');
  const [showGrid, setShowGrid] = useState(true);

  // Infinite Canvas Viewport Transform
  const [stageScale, setStageScale] = useState(1);
  const [stagePos, setStagePos] = useState({ x: 0, y: 0 });
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number; stageX: number; stageY: number } | null>(null);

  // Teacher dragging worksheet state
  const [isMovingBg, setIsMovingBg] = useState(false);
  const bgMoveStartRef = useRef<{ worldX: number; worldY: number; origX: number; origY: number } | null>(null);

  // Active Drawing / Shape State
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentElementId, setCurrentElementId] = useState<string | null>(null);
  const shapeOriginRef = useRef<{ x: number; y: number } | null>(null);

  // Pointer position in screen and world coordinates
  const [screenPos, setScreenPos] = useState({ x: -100, y: -100 });
  const [worldPos, setWorldPos] = useState({ x: 0, y: 0 });

  // Floating Text Input State + Focus Guard Ref to prevent canvas mousedown from blurring on open
  const [textDraft, setTextDraft] = useState<{
    worldX: number;
    worldY: number;
    screenX: number;
    screenY: number;
    value: string;
    openedAt: number;
  } | null>(null);
  const textInputRef = useRef<HTMLInputElement>(null);

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

  // Ensure text input receives focus reliably after Konva canvas pointer event completes
  useEffect(() => {
    if (textDraft) {
      const id = requestAnimationFrame(() => {
        textInputRef.current?.focus();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [textDraft]);

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

  // Group all elements on the current board by userId so each student's elements live on their own isolated Konva Layer.
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
    return Array.from(groups.entries());
  }, [elements]);

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

  // Spacebar shortcut for quick panning on the infinite canvas
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
        return;
      }
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        setIsSpacePressed(true);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (canDraw) onUndo();
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
  }, [canDraw, onUndo]);

  const screenToWorld = useCallback(
    (sx: number, sy: number) => ({
      x: Number(((sx - stagePos.x) / stageScale).toFixed(1)),
      y: Number(((sy - stagePos.y) / stageScale).toFixed(1)),
    }),
    [stagePos.x, stagePos.y, stageScale]
  );

  const commitTextDraft = useCallback(() => {
    if (!textDraft) return;
    const trimmed = textDraft.value.trim();
    if (trimmed && canDraw) {
      const id = Math.random().toString(36).substring(2, 11);
      const newElement: CanvasElement = {
        id,
        boardId: activeBoardId,
        userId,
        userName,
        tool: 'text',
        color: color === '#ffffff' ? '#0f172a' : color,
        strokeWidth,
        x: textDraft.worldX,
        y: textDraft.worldY,
        text: trimmed,
        timestamp: Date.now(),
      };
      onElementStart(newElement);
    }
    setTextDraft(null);
  }, [textDraft, canDraw, activeBoardId, userId, userName, color, strokeWidth, onElementStart]);

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
        if (el.tool === 'eraser') continue;
        const pad = (el.strokeWidth || 6) + 12;
        if (el.points && el.points.length >= 2) {
          for (let i = 0; i < el.points.length; i += 2) {
            const px = el.points[i];
            const py = el.points[i + 1];
            if (px - pad < minX) minX = px - pad;
            if (py - pad < minY) minY = py - pad;
            if (px + pad > maxX) maxX = px + pad;
            if (py + pad > maxY) maxY = py + pad;
          }
        } else if (typeof el.x === 'number' && typeof el.y === 'number') {
          const w = el.width || (el.text ? el.text.length * (el.strokeWidth * 2 + 8) : 44);
          const h = el.height || (el.text ? el.strokeWidth * 3 + 24 : 44);
          const x1 = Math.min(el.x, el.x + w) - pad;
          const y1 = Math.min(el.y, el.y + h) - pad;
          const x2 = Math.max(el.x, el.x + w) + pad;
          const y2 = Math.max(el.y, el.y + h) + pad;
          if (x1 < minX) minX = x1;
          if (y1 < minY) minY = y1;
          if (x2 > maxX) maxX = x2;
          if (y2 > maxY) maxY = y2;
        }
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
    [dimensions.width, dimensions.height, resetView]
  );

  const fitAllContent = () => {
    fitElementsAndBackgroundInView(elements, background);
  };

  // Auto-fit when switching between sub-boards
  useEffect(() => {
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

    const dataUrl = stage.toDataURL({
      pixelRatio: 2,
      mimeType: 'image/png',
    });

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

  const handlePointerDown = (e: any) => {
    const stage = e.target.getStage();
    const pos = stage.getPointerPosition();
    if (!pos) return;

    const isMiddleClick = e.evt && e.evt.button === 1;
    if (effectiveTool === 'pan' || isMiddleClick) {
      setIsPanning(true);
      panStartRef.current = {
        x: pos.x,
        y: pos.y,
        stageX: stagePos.x,
        stageY: stagePos.y,
      };
      return;
    }

    const world = screenToWorld(pos.x, pos.y);

    // Teacher dragging background worksheet
    if (effectiveTool === 'move-bg') {
      if (isTeacher && background) {
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

    if (effectiveTool === 'text') {
      // Prevent native canvas mousedown from stealing focus from the text input we are about to open
      if (e.evt && typeof e.evt.preventDefault === 'function') {
        e.evt.preventDefault();
      }
      if (textDraft && textDraft.value.trim()) {
        commitTextDraft();
      } else {
        setTextDraft({
          worldX: world.x,
          worldY: world.y,
          screenX: Math.min(dimensions.width - 220, Math.max(12, pos.x)),
          screenY: Math.min(dimensions.height - 60, Math.max(12, pos.y)),
          value: '',
          openedAt: Date.now(),
        });
      }
      return;
    }

    if (textDraft) {
      commitTextDraft();
    }

    const id = Math.random().toString(36).substring(2, 11);

    // One-click Stamp placement (including 'username' badge stamp)
    if (effectiveTool === 'stamp') {
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
      onElementStart(stampElement);
      return;
    }

    setCurrentElementId(id);
    setIsDrawing(true);

    if (effectiveTool === 'rect' || effectiveTool === 'circle') {
      shapeOriginRef.current = { x: world.x, y: world.y };
      const newElement: CanvasElement = {
        id,
        boardId: activeBoardId,
        userId,
        userName,
        tool: effectiveTool,
        color,
        strokeWidth,
        x: world.x,
        y: world.y,
        width: 0,
        height: 0,
        timestamp: Date.now(),
      };
      onElementStart(newElement);
    } else if (effectiveTool === 'line') {
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
      onElementStart(newElement);
    } else {
      const newElement: CanvasElement = {
        id,
        boardId: activeBoardId,
        userId,
        userName,
        tool: effectiveTool,
        color,
        strokeWidth,
        points: [world.x, world.y],
        timestamp: Date.now(),
      };
      onElementStart(newElement);
    }
  };

  const handlePointerMove = (e: any) => {
    const stage = e.target.getStage();
    const pos = stage.getPointerPosition();
    if (!pos) return;

    setScreenPos(pos);
    const world = screenToWorld(pos.x, pos.y);
    setWorldPos(world);

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

    if (isPanning && panStartRef.current) {
      const dx = pos.x - panStartRef.current.x;
      const dy = pos.y - panStartRef.current.y;
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

    if (effectiveTool === 'rect' || effectiveTool === 'circle') {
      const origin = shapeOriginRef.current;
      if (!origin) return;
      onElementUpdate({
        id: currentElementId,
        x: origin.x,
        y: origin.y,
        width: Number((world.x - origin.x).toFixed(1)),
        height: Number((world.y - origin.y).toFixed(1)),
      });
    } else if (effectiveTool === 'line') {
      const origin = shapeOriginRef.current;
      if (!origin) return;
      onElementUpdate({
        id: currentElementId,
        points: [origin.x, origin.y, world.x, world.y],
      });
    } else {
      onElementAppendPoints(currentElementId, [world.x, world.y]);
    }
  };

  const handlePointerUp = () => {
    if (isPanning) {
      setIsPanning(false);
      panStartRef.current = null;
    }
    if (isMovingBg) {
      setIsMovingBg(false);
      bgMoveStartRef.current = null;
    }
    if (isDrawing) {
      setIsDrawing(false);
      setCurrentElementId(null);
      shapeOriginRef.current = null;
    }
  };

  const renderElement = (el: CanvasElement) => {
    if (el.tool === 'stamp') {
      // Special Username Badge Stamp!
      if (el.stamp === 'username') {
        const label = el.userName || 'Student';
        const fontSize = Math.max(13, Math.round(el.strokeWidth * 1.1 + 10));
        const padX = Math.round(fontSize * 0.85);
        const badgeW = Math.max(64, Math.round(label.length * (fontSize * 0.62) + padX * 2));
        const badgeH = Math.round(fontSize * 1.85);
        return (
          <Group key={el.id} x={el.x || 0} y={el.y || 0}>
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
        <Group key={el.id} x={el.x || 0} y={el.y || 0}>
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
          key={el.id}
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
          key={el.id}
          x={centerX}
          y={centerY}
          radius={radius}
          stroke={el.color}
          strokeWidth={el.strokeWidth}
        />
      );
    }

    if (el.tool === 'text') {
      const fontSize = Math.max(14, el.strokeWidth * 3 + 8);
      return (
        <KonvaText
          key={el.id}
          x={el.x || 0}
          y={el.y || 0}
          text={el.text || ''}
          fill={el.color}
          fontSize={fontSize}
          fontFamily="Plus Jakarta Sans, sans-serif"
          fontStyle="600"
        />
      );
    }

    const pts = el.points || [];
    if (pts.length < 2) return null;

    if (el.tool === 'eraser') {
      return (
        <Line
          key={el.id}
          points={pts}
          stroke="#000000"
          strokeWidth={Math.max(8, el.strokeWidth * 1.5)}
          tension={0.45}
          lineCap="round"
          lineJoin="round"
          globalCompositeOperation="destination-out"
        />
      );
    }

    if (el.tool === 'spray') {
      return (
        <Line
          key={el.id}
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
        <Line
          key={el.id}
          points={pts}
          stroke={el.color}
          strokeWidth={Math.max(12, el.strokeWidth * 2.2)}
          tension={0.3}
          lineCap="square"
          lineJoin="round"
          opacity={0.32}
        />
      );
    }

    if (el.tool === 'hollow') {
      return (
        <Group key={el.id}>
          <Line
            points={pts}
            stroke={el.color}
            strokeWidth={Math.max(4, el.strokeWidth)}
            tension={0.5}
            lineCap="round"
            lineJoin="round"
          />
          <Line
            points={pts}
            stroke="#ffffff"
            strokeWidth={Math.max(1, el.strokeWidth - 4)}
            tension={0.5}
            lineCap="round"
            lineJoin="round"
          />
        </Group>
      );
    }

    return (
      <Line
        key={el.id}
        points={pts}
        stroke={el.color}
        strokeWidth={el.strokeWidth}
        tension={el.tool === 'line' ? 0 : 0.45}
        lineCap="round"
        lineJoin="round"
      />
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

      {/* Primary Drawing & Studio Toolbar */}
      <div className="px-4 py-2.5 border-b border-slate-200 flex flex-wrap items-center gap-3 bg-white z-20">
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
            title="Solid Brush"
          >
            <Paintbrush size={17} />
          </button>
          <button
            type="button"
            disabled={!canDraw}
            onClick={() => setTool('hollow')}
            className={cn(
              "p-1.5 rounded-md transition-colors cursor-pointer disabled:opacity-40",
              tool === 'hollow' && effectiveTool !== 'pan'
                ? "bg-white text-blue-600 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            )}
            title="Hollow Outline Brush"
          >
            <CircleIcon size={17} />
          </button>
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
          <button
            type="button"
            disabled={!canDraw}
            onClick={() => setTool('highlighter')}
            className={cn(
              "p-1.5 rounded-md transition-colors cursor-pointer disabled:opacity-40",
              tool === 'highlighter' && effectiveTool !== 'pan'
                ? "bg-white text-blue-600 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            )}
            title="Highlighter"
          >
            <Highlighter size={17} />
          </button>
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
            title="Personal Eraser Brush (Erases ONLY your own ink, never the worksheet or classmates' drawings)"
          >
            <Eraser size={17} />
          </button>

          <div className="h-4 w-px bg-slate-300 mx-0.5" />

          {/* Geometric Shapes, Text & Quick Stamp */}
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
              "p-1.5 rounded-md transition-colors cursor-pointer disabled:opacity-40",
              tool === 'text' && effectiveTool !== 'pan'
                ? "bg-white text-blue-600 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            )}
            title="Text Annotation (Click on canvas to type)"
          >
            <Type size={17} />
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

        {/* One-Click Color Palette */}
        <div className="flex items-center gap-1.5">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => {
                setColor(c);
                if (tool === 'eraser' || tool === 'pan' || tool === 'move-bg') setTool('solid');
              }}
              className={cn(
                "w-5 h-5 rounded-full border border-slate-300 transition-transform hover:scale-110 cursor-pointer",
                color === c && tool !== 'eraser' && "ring-2 ring-blue-600 ring-offset-2"
              )}
              style={{ backgroundColor: c }}
              title={`Color ${c}`}
            />
          ))}
        </div>

        <div className="h-5 w-px bg-slate-200" />

        {/* Labeled Brush Size Slider */}
        <div className="flex items-center gap-2">
          <label htmlFor="brush-size-slider" className="text-xs font-medium text-slate-600 whitespace-nowrap">
            Size:
          </label>
          <input
            id="brush-size-slider"
            type="range"
            min="1"
            max="50"
            value={strokeWidth}
            onChange={(e) => setStrokeWidth(parseInt(e.target.value, 10))}
            className="w-24 h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
          />
          <span className="text-xs font-mono tabular-nums text-slate-600 w-8">
            {strokeWidth}px
          </span>
        </div>

        <div className="flex-1" />

        {/* Personal Actions, JSON Room Save & PNG Export */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={!canDraw}
            onClick={onUndo}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40"
            title="Undo your last stroke (Ctrl+Z)"
          >
            <Undo2 size={15} />
            <span>Undo</span>
          </button>

          {confirmClearMine ? (
            <div className="flex items-center gap-1 bg-red-50 px-2 py-1 rounded-lg border border-red-200">
              <span className="text-xs text-red-800 font-medium whitespace-nowrap">Erase yours?</span>
              <button
                type="button"
                onClick={() => {
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
              </div>
            )}

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
        /* Student Status Banner (Breakout / Individual Board Indicator or Lock Banner) */
        (breakoutConfig.mode !== 'main' || isCanvasLocked) && (
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
        <div className="flex-1 bg-slate-100 overflow-y-auto p-6 z-30 select-text">
          <div className="max-w-6xl mx-auto space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-4 rounded-xl border border-slate-200">
              <div>
                <h2 className="font-display text-lg font-bold text-slate-900">
                  Live Classroom Boards Overview ({activeSubBoardList.length + 1} Boards)
                </h2>
                <p className="text-xs text-slate-500">
                  Click any student or group board below to jump onto their canvas, give feedback, or project it to the class.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleOpenBreakoutModal}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 text-slate-800 hover:bg-slate-200 cursor-pointer"
                >
                  Configure Breakouts / Groups
                </button>
                <button
                  type="button"
                  onClick={() => setShowLiveGridOverview(false)}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-900 text-white hover:bg-slate-800 cursor-pointer"
                >
                  Back to Active Canvas
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {/* Main Class Board Card */}
              <div
                onClick={() => {
                  onSelectBoard('main');
                  setShowLiveGridOverview(false);
                }}
                className={cn(
                  "bg-white rounded-xl border p-4 cursor-pointer transition-all hover:shadow-md flex flex-col justify-between gap-3",
                  activeBoardId === 'main' ? "border-blue-600 ring-2 ring-blue-600/20" : "border-slate-200"
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="font-display font-bold text-sm text-slate-900">
                    Main Class Board
                  </span>
                  <span className="font-mono tabular-nums text-xs text-slate-500">
                    {fullMainElements.length} items
                  </span>
                </div>
                <div className="h-32 rounded-lg bg-slate-50 border border-slate-200/80 flex items-center justify-center overflow-hidden relative">
                  {fullMainBackground?.pages?.[0] ? (
                    <img
                      src={fullMainBackground.pages[0].dataUrl}
                      alt="Main Board Worksheet"
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-contain opacity-90"
                    />
                  ) : (
                    <span className="text-xs text-slate-400">Blank Infinite Board</span>
                  )}
                </div>
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>Whole-class shared stage</span>
                  <span className="text-blue-600 font-semibold">Open Board →</span>
                </div>
              </div>

              {/* Individual / Group Sub-Board Cards */}
              {(Object.values(subBoards) as SubBoardData[]).map((sb) => {
                const assignedNames = sb.assignedUserIds
                  .map((uid) => users.find((u) => u.userId === uid)?.name || 'Student')
                  .join(', ');

                return (
                  <div
                    key={sb.id}
                    onClick={() => {
                      onSelectBoard(sb.id);
                      setShowLiveGridOverview(false);
                    }}
                    className={cn(
                      "bg-white rounded-xl border p-4 cursor-pointer transition-all hover:shadow-md flex flex-col justify-between gap-3",
                      activeBoardId === sb.id ? "border-blue-600 ring-2 ring-blue-600/20" : "border-slate-200"
                    )}
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-display font-bold text-sm text-slate-900 truncate">
                          {sb.title}
                        </span>
                        <span className="font-mono tabular-nums text-xs text-blue-600 font-semibold shrink-0">
                          {sb.elements.length} {sb.elements.length === 1 ? 'stroke' : 'strokes'}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 truncate mt-0.5">
                        {assignedNames || 'No students assigned yet'}
                      </p>
                    </div>

                    <div className="h-32 rounded-lg bg-slate-50 border border-slate-200/80 flex items-center justify-center overflow-hidden relative">
                      {sb.background?.pages?.[0] ? (
                        <img
                          src={sb.background.pages[0].dataUrl}
                          alt={sb.title}
                          referrerPolicy="no-referrer"
                          className="h-full w-full object-contain opacity-90"
                        />
                      ) : (
                        <span className="text-xs text-slate-400">Blank Infinite Board</span>
                      )}
                    </div>

                    <div className="flex items-center justify-between text-xs text-slate-500">
                      <span>{sb.messages.length} group messages</span>
                      <span className="text-blue-600 font-semibold">Inspect & Draw →</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Teacher Breakout & Individual Assignment Manager Modal */}
      {showBreakoutModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4 select-text">
          <div className="bg-white border border-slate-200 rounded-2xl shadow-xl w-full max-w-2xl p-6 space-y-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-display text-lg font-bold text-slate-900">
                  Classroom Breakout & Individual Boards Manager
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Give every student their own personal worksheet board (e.g. Frayer Model) or split the class into small breakout groups.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowBreakoutModal(false)}
                className="p-1 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {/* 1. Mode Selection */}
            <div className="grid grid-cols-3 gap-2.5">
              <button
                type="button"
                onClick={() => setDraftBreakoutMode('main')}
                className={cn(
                  "p-3 rounded-xl border text-left transition-colors cursor-pointer",
                  draftBreakoutMode === 'main'
                    ? "bg-blue-50/80 border-blue-600"
                    : "bg-white border-slate-200 hover:border-slate-300"
                )}
              >
                <div className="font-display font-semibold text-xs text-slate-900">
                  Whole-Class Main Board
                </div>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Everyone draws together on one shared board.
                </p>
              </button>

              <button
                type="button"
                onClick={() => setDraftBreakoutMode('individual')}
                className={cn(
                  "p-3 rounded-xl border text-left transition-colors cursor-pointer",
                  draftBreakoutMode === 'individual'
                    ? "bg-blue-50/80 border-blue-600"
                    : "bg-white border-slate-200 hover:border-slate-300"
                )}
              >
                <div className="font-display font-semibold text-xs text-slate-900">
                  Individual Student Boards
                </div>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Every student gets their own private board + worksheet.
                </p>
              </button>

              <button
                type="button"
                onClick={() => {
                  setDraftBreakoutMode('groups');
                  if (draftGroups.length === 0) {
                    initializeDraftGroups(draftGroupCount, true);
                  }
                }}
                className={cn(
                  "p-3 rounded-xl border text-left transition-colors cursor-pointer",
                  draftBreakoutMode === 'groups'
                    ? "bg-blue-50/80 border-blue-600"
                    : "bg-white border-slate-200 hover:border-slate-300"
                )}
              >
                <div className="font-display font-semibold text-xs text-slate-900">
                  Breakout Group Rooms
                </div>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  Split into 2–8 small groups (random, manual, or self-select).
                </p>
              </button>
            </div>

            {/* 2. Group Assignment Controls (when 'groups' is selected) */}
            {draftBreakoutMode === 'groups' && (
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-semibold text-slate-700">Number of Groups:</span>
                    {[2, 3, 4, 5, 6, 8].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => {
                          setDraftGroupCount(n);
                          initializeDraftGroups(n, true);
                        }}
                        className={cn(
                          "w-7 h-7 rounded-md font-mono text-xs font-semibold cursor-pointer",
                          draftGroupCount === n
                            ? "bg-blue-600 text-white"
                            : "bg-white border border-slate-300 text-slate-700 hover:bg-slate-100"
                        )}
                      >
                        {n}
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() => initializeDraftGroups(draftGroupCount, true)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 cursor-pointer"
                  >
                    <Shuffle size={13} />
                    <span>Auto-Randomize Students</span>
                  </button>
                </div>

                {/* Manual Student Group Reassignment */}
                <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                  {users.filter((u) => !u.isTeacher).length === 0 ? (
                    <p className="text-xs text-slate-400 italic">
                      No students online yet — groups will still be created and ready for students to join!
                    </p>
                  ) : (
                    users
                      .filter((u) => !u.isTeacher)
                      .map((student) => {
                        const currentGrp =
                          draftGroups.find((g) => g.assignedUserIds.includes(student.userId))?.id ||
                          draftGroups[0]?.id ||
                          'grp_1';
                        return (
                          <div
                            key={student.userId}
                            className="flex items-center justify-between bg-white px-3 py-1.5 rounded-lg border border-slate-200 text-xs"
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className="w-2.5 h-2.5 rounded-xs"
                                style={{ backgroundColor: student.color }}
                              />
                              <span className="font-medium text-slate-800">{student.name}</span>
                            </div>
                            <select
                              value={currentGrp}
                              onChange={(e) => {
                                const nextGrpId = e.target.value;
                                setDraftGroups((prev) =>
                                  prev.map((g) => ({
                                    ...g,
                                    assignedUserIds:
                                      g.id === nextGrpId
                                        ? [...g.assignedUserIds.filter((id) => id !== student.userId), student.userId]
                                        : g.assignedUserIds.filter((id) => id !== student.userId),
                                  }))
                                );
                              }}
                              className="bg-slate-50 border border-slate-300 rounded px-2 py-0.5 text-xs font-medium text-slate-800 cursor-pointer"
                            >
                              {draftGroups.map((g) => (
                                <option key={g.id} value={g.id}>
                                  {g.title}
                                </option>
                              ))}
                            </select>
                          </div>
                        );
                      })
                  )}
                </div>

                <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={draftAllowSelfSelect}
                    onChange={(e) => setDraftAllowSelfSelect(e.target.checked)}
                    className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span>Allow students to freely switch between breakout groups themselves</span>
                </label>
              </div>
            )}

            {/* 3. Pre-load Worksheet / Template on Sub-Boards */}
            {draftBreakoutMode !== 'main' && (
              <div className="space-y-3 pt-1 border-t border-slate-100">
                <label className="block text-xs font-semibold text-slate-700">
                  Pre-load Worksheet / Template onto Every Board:
                </label>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => setDraftWorksheetChoice('frayer')}
                    className={cn(
                      "p-2.5 rounded-lg border text-left cursor-pointer",
                      draftWorksheetChoice === 'frayer'
                        ? "bg-blue-50 border-blue-600 font-semibold text-slate-900"
                        : "border-slate-200 text-slate-700"
                    )}
                  >
                    4-Box Frayer Concept Model
                  </button>
                  <button
                    type="button"
                    onClick={() => setDraftWorksheetChoice('checkin')}
                    className={cn(
                      "p-2.5 rounded-lg border text-left cursor-pointer",
                      draftWorksheetChoice === 'checkin'
                        ? "bg-blue-50 border-blue-600 font-semibold text-slate-900"
                        : "border-slate-200 text-slate-700"
                    )}
                  >
                    Task Pulse Check (3 Columns)
                  </button>
                  <button
                    type="button"
                    onClick={() => setDraftWorksheetChoice('corners')}
                    className={cn(
                      "p-2.5 rounded-lg border text-left cursor-pointer",
                      draftWorksheetChoice === 'corners'
                        ? "bg-blue-50 border-blue-600 font-semibold text-slate-900"
                        : "border-slate-200 text-slate-700"
                    )}
                  >
                    Four Corners Debate
                  </button>
                  <button
                    type="button"
                    onClick={() => setDraftWorksheetChoice('current')}
                    className={cn(
                      "p-2.5 rounded-lg border text-left cursor-pointer",
                      draftWorksheetChoice === 'current'
                        ? "bg-blue-50 border-blue-600 font-semibold text-slate-900"
                        : "border-slate-200 text-slate-700"
                    )}
                  >
                    {fullMainBackground
                      ? `Copy Current (${fullMainBackground.fileName.slice(0, 18)})`
                      : 'Blank Canvas (No Worksheet)'}
                  </button>
                </div>

                {(draftWorksheetChoice === 'frayer' ||
                  draftWorksheetChoice === 'checkin' ||
                  draftWorksheetChoice === 'corners') && (
                  <div>
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Worksheet Header / Concept Prompt:
                    </label>
                    <input
                      type="text"
                      value={draftWorksheetTopic}
                      onChange={(e) => setDraftWorksheetTopic(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-lg text-xs text-slate-900 focus:bg-white focus:border-blue-600 focus:outline-none"
                    />
                  </div>
                )}

                {/* Chat Scope Selector */}
                <div className="flex items-center justify-between pt-2">
                  <span className="text-xs font-semibold text-slate-700">Chat Room Mode:</span>
                  <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg text-xs">
                    <button
                      type="button"
                      onClick={() => setDraftChatScope('unified')}
                      className={cn(
                        "px-2.5 py-1 rounded-md font-medium cursor-pointer",
                        draftChatScope === 'unified'
                          ? "bg-white text-slate-900 shadow-xs"
                          : "text-slate-600"
                      )}
                    >
                      Unified Class Chat
                    </button>
                    <button
                      type="button"
                      onClick={() => setDraftChatScope('board')}
                      className={cn(
                        "px-2.5 py-1 rounded-md font-medium cursor-pointer",
                        draftChatScope === 'board'
                          ? "bg-white text-slate-900 shadow-xs"
                          : "text-slate-600"
                      )}
                    >
                      Per-Board Group Chat
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setShowBreakoutModal(false)}
                className="px-4 py-2 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  let customBg: RoomBackground | null | undefined = undefined;
                  if (draftWorksheetChoice === 'frayer') {
                    customBg = generateTemplateBackground('frayer-model', draftWorksheetTopic);
                  } else if (draftWorksheetChoice === 'checkin') {
                    customBg = generateTemplateBackground('checkin-columns', draftWorksheetTopic);
                  } else if (draftWorksheetChoice === 'corners') {
                    customBg = generateTemplateBackground('four-corners', draftWorksheetTopic);
                  } else if (draftWorksheetChoice === 'none') {
                    customBg = null;
                  }

                  await onConfigureBreakout({
                    mode: draftBreakoutMode,
                    allowSelfSelect: draftAllowSelfSelect,
                    chatScope: draftChatScope,
                    copyWorksheet: draftWorksheetChoice === 'current',
                    customBackground: customBg,
                    groups: draftBreakoutMode === 'groups' ? draftGroups : undefined,
                  });
                  setShowBreakoutModal(false);
                  if (draftBreakoutMode !== 'main') {
                    setShowLiveGridOverview(true);
                  } else {
                    setShowLiveGridOverview(false);
                  }
                }}
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-500 cursor-pointer"
              >
                {draftBreakoutMode === 'main'
                  ? 'Return Class to Main Board'
                  : 'Launch Boards for Class'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Teacher Built-In Worksheet Templates Modal */}
      {showTemplateModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4 select-text">
          <div className="bg-white border border-slate-200 rounded-2xl shadow-xl w-full max-w-lg p-6 space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-display text-lg font-bold text-slate-900">
                  Classroom Worksheet Templates
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Pick a ready-made template and customize the prompt header for <span className="font-semibold text-slate-700">{activeBoardTitle}</span>.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowTemplateModal(false)}
                className="p-1 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-2">
              {BUILT_IN_TEMPLATES.map((tpl) => {
                const isSelected = selectedTemplateId === tpl.id;
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => {
                      setSelectedTemplateId(tpl.id);
                      setTemplatePromptText(tpl.defaultPrompt);
                    }}
                    className={cn(
                      "w-full text-left p-3.5 rounded-xl border transition-colors flex items-start justify-between gap-3 cursor-pointer",
                      isSelected
                        ? "bg-blue-50/70 border-blue-600"
                        : "bg-white border-slate-200 hover:border-slate-300"
                    )}
                  >
                    <div>
                      <div className="font-display font-semibold text-xs text-slate-900">
                        {tpl.name}
                      </div>
                      <p className="text-xs text-slate-600 mt-0.5">{tpl.description}</p>
                    </div>
                    {isSelected && <Check size={16} className="text-blue-600 shrink-0 mt-0.5" />}
                  </button>
                );
              })}
            </div>

            <div>
              <label
                htmlFor="template-prompt-input"
                className="block text-xs font-semibold text-slate-700 mb-1.5"
              >
                Customize Task / Topic Prompt (Displayed at top of worksheet):
              </label>
              <input
                id="template-prompt-input"
                type="text"
                value={templatePromptText}
                onChange={(e) => setTemplatePromptText(e.target.value)}
                placeholder={
                  BUILT_IN_TEMPLATES.find((t) => t.id === selectedTemplateId)?.promptPlaceholder
                }
                maxLength={80}
                className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-sm text-slate-900 focus:bg-white focus:border-blue-600 focus:outline-none"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setShowTemplateModal(false)}
                className="px-4 py-2 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  const generatedBg = generateTemplateBackground(
                    selectedTemplateId,
                    templatePromptText
                  );
                  setShowTemplateModal(false);
                  const res = await onTeacherSetBackground(generatedBg);
                  if (res.ok) {
                    setTimeout(() => fitElementsAndBackgroundInView(elements, generatedBg), 80);
                  }
                }}
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-500 transition-colors cursor-pointer"
              >
                Apply Worksheet to Board
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Teacher JSON Snapshot Restore Modal */}
      {pendingSnapshot && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4 select-text">
          <div className="bg-white border border-slate-200 rounded-2xl shadow-xl w-full max-w-lg p-6 space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-display text-lg font-bold text-slate-900">
                  Restore Room Snapshot (.JSON)
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  File: <span className="font-mono text-slate-700">{pendingSnapshot.fileName}</span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setPendingSnapshot(null);
                  setImportError(null);
                }}
                className="p-1 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {importError ? (
              <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 flex items-start gap-2.5 text-xs text-red-800">
                <AlertCircle size={16} className="text-red-600 shrink-0 mt-0.5" />
                <span>{importError}</span>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-3 p-3.5 rounded-xl bg-slate-50 border border-slate-200/80 text-xs">
                  <div>
                    <span className="text-slate-400 block">Source Room</span>
                    <span className="font-mono font-semibold text-slate-900">
                      #{pendingSnapshot.roomId}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Board Content</span>
                    <span className="font-mono tabular-nums font-semibold text-slate-900">
                      {pendingSnapshot.elements.length} items
                      {pendingSnapshot.subBoards
                        ? ` + ${Object.keys(pendingSnapshot.subBoards).length} sub-boards`
                        : ''}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Chat History</span>
                    <span className="font-mono tabular-nums font-semibold text-slate-900">
                      {pendingSnapshot.messages.length} messages
                    </span>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="block text-xs font-semibold text-slate-700">
                    Choose how to restore into #{roomId}:
                  </label>

                  <button
                    type="button"
                    onClick={() => setImportMode('replace')}
                    className={cn(
                      "w-full text-left p-3 rounded-xl border transition-colors flex items-start justify-between gap-3 cursor-pointer",
                      importMode === 'replace'
                        ? "bg-blue-50/70 border-blue-600"
                        : "bg-white border-slate-200 hover:border-slate-300"
                    )}
                  >
                    <div>
                      <div className="font-display font-semibold text-xs text-slate-900">
                        Replace & Resume Live Session
                      </div>
                      <p className="text-xs text-slate-600 mt-0.5">
                        Replaces the current room's boards, worksheets, and chat with this snapshot and leaves the board unlocked.
                      </p>
                    </div>
                    {importMode === 'replace' && <Check size={16} className="text-blue-600 shrink-0 mt-0.5" />}
                  </button>

                  <button
                    type="button"
                    onClick={() => setImportMode('readonly')}
                    className={cn(
                      "w-full text-left p-3 rounded-xl border transition-colors flex items-start justify-between gap-3 cursor-pointer",
                      importMode === 'readonly'
                        ? "bg-blue-50/70 border-blue-600"
                        : "bg-white border-slate-200 hover:border-slate-300"
                    )}
                  >
                    <div>
                      <div className="font-display font-semibold text-xs text-slate-900">
                        Open as Read-Only Archive (Locked)
                      </div>
                      <p className="text-xs text-slate-600 mt-0.5">
                        Loads the snapshot and automatically locks the board so students can pan, zoom, and read without modifying anything.
                      </p>
                    </div>
                    {importMode === 'readonly' && <Check size={16} className="text-blue-600 shrink-0 mt-0.5" />}
                  </button>

                  <button
                    type="button"
                    onClick={() => setImportMode('merge')}
                    className={cn(
                      "w-full text-left p-3 rounded-xl border transition-colors flex items-start justify-between gap-3 cursor-pointer",
                      importMode === 'merge'
                        ? "bg-blue-50/70 border-blue-600"
                        : "bg-white border-slate-200 hover:border-slate-300"
                    )}
                  >
                    <div>
                      <div className="font-display font-semibold text-xs text-slate-900">
                        Merge into Current Room
                      </div>
                      <p className="text-xs text-slate-600 mt-0.5">
                        Keeps everything currently in #{roomId} and combines the snapshot's drawings, sub-boards, and messages.
                      </p>
                    </div>
                    {importMode === 'merge' && <Check size={16} className="text-blue-600 shrink-0 mt-0.5" />}
                  </button>
                </div>
              </>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => {
                  setPendingSnapshot(null);
                  setImportError(null);
                }}
                className="px-4 py-2 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              {!importError && (
                <button
                  type="button"
                  disabled={isImporting}
                  onClick={handleConfirmImport}
                  className="px-4 py-2 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-500 disabled:bg-slate-300 transition-colors cursor-pointer"
                >
                  {isImporting ? 'Restoring...' : 'Restore Room Snapshot'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Infinite Canvas Viewport (Hidden when Teacher is in Live Grid Overview) */}
      <div
        ref={containerRef}
        className={cn(
          "flex-1 relative overflow-hidden touch-none",
          showLiveGridOverview && isTeacher && "hidden",
          effectiveTool === 'pan' || effectiveTool === 'move-bg'
            ? isPanning || isMovingBg
              ? "cursor-grabbing"
              : "cursor-grab"
            : "cursor-none"
        )}
        style={
          showGrid
            ? {
                backgroundImage: `radial-gradient(#cbd5e1 1.25px, transparent 1.25px)`,
                backgroundSize: `${gridSpacing}px ${gridSpacing}px`,
                backgroundPosition: `${stagePos.x}px ${stagePos.y}px`,
              }
            : { backgroundColor: '#ffffff' }
        }
      >
        <Stage
          width={dimensions.width}
          height={dimensions.height}
          onWheel={handleWheel}
          onMouseDown={handlePointerDown}
          onMouseMove={handlePointerMove}
          onMouseUp={handlePointerUp}
          onTouchStart={handlePointerDown}
          onTouchMove={handlePointerMove}
          onTouchEnd={handlePointerUp}
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

          {/* Layer 2..N: Per-Student Isolated Ink Layers */}
          {elementsGroupedByUser.map(([groupUserId, userElements]) => (
            <Layer
              key={groupUserId}
              x={stagePos.x}
              y={stagePos.y}
              scaleX={stageScale}
              scaleY={stageScale}
              listening={false}
            >
              {userElements.map((el) => renderElement(el))}
            </Layer>
          ))}

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
              effectiveTool !== 'text' && (
                <Circle
                  x={worldPos.x}
                  y={worldPos.y}
                  radius={
                    effectiveTool === 'stamp'
                      ? Math.max(16, strokeWidth * 1.8 + 10)
                      : effectiveTool === 'highlighter'
                      ? Math.max(12, strokeWidth * 2.2) / 2
                      : effectiveTool === 'eraser'
                      ? Math.max(8, strokeWidth * 1.5) / 2
                      : strokeWidth / 2
                  }
                  stroke={effectiveTool === 'eraser' ? '#64748b' : color}
                  strokeWidth={1.2 / stageScale}
                  dash={[3 / stageScale, 3 / stageScale]}
                />
              )}
          </Layer>
        </Stage>

        {/* Inline Floating Text Input for Text ('T') Tool — with mousedown/blur race guard & explicit Commit button */}
        {textDraft && (
          <div
            className="absolute z-40 flex items-center gap-1 bg-white/95 p-1 rounded-lg border-2 border-blue-600 shadow-lg select-text"
            style={{
              left: textDraft.screenX,
              top: textDraft.screenY,
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
          >
            <input
              ref={textInputRef}
              type="text"
              value={textDraft.value}
              onChange={(e) => setTextDraft({ ...textDraft, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitTextDraft();
                } else if (e.key === 'Escape') {
                  setTextDraft(null);
                }
              }}
              onBlur={() => {
                // Ignore immediate blur caused by the canvas click that just opened this box
                if (Date.now() - textDraft.openedAt < 250) {
                  requestAnimationFrame(() => textInputRef.current?.focus());
                  return;
                }
                commitTextDraft();
              }}
              placeholder="Type text & press Enter..."
              className="px-2 py-0.5 bg-transparent focus:outline-none min-w-[180px]"
              style={{
                color: color === '#ffffff' ? '#0f172a' : color,
                fontSize: `${Math.min(28, Math.max(14, strokeWidth * 2 + 10))}px`,
                fontFamily: 'var(--font-display)',
                fontWeight: 600,
              }}
            />
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                commitTextDraft();
              }}
              className="p-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 cursor-pointer shrink-0"
              title="Add text to board (Enter)"
            >
              <Check size={14} />
            </button>
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setTextDraft(null);
              }}
              className="p-1.5 text-slate-400 hover:text-slate-700 rounded cursor-pointer shrink-0"
              title="Cancel (Esc)"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* Custom Precision Cursor Overlay when Drawing */}
        {effectiveTool !== 'pan' && effectiveTool !== 'move-bg' && (
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
        <div className="absolute bottom-4 right-4 z-20 flex items-center gap-1 bg-white/95 backdrop-blur-xs px-2 py-1.5 rounded-lg border border-slate-200 shadow-sm text-xs text-slate-700">
          <button
            type="button"
            onClick={() => setShowGrid(!showGrid)}
            className={cn(
              "p-1.5 rounded hover:bg-slate-100 transition-colors cursor-pointer",
              showGrid ? "text-blue-600" : "text-slate-400"
            )}
            title="Toggle background dot grid"
          >
            <Grid size={14} />
          </button>

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
