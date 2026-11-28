import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Group, Text as KonvaText, Layer, Line, Rect, Shape, Stage } from 'react-konva';
import type { Socket } from 'socket.io-client';
import { exportAllBoardsToPdf } from '../lib/batchPdfExport';
import {
  getActiveRound,
  getAllBoardsByRound,
  getBoardsInRound,
  getLaunchedRounds,
  getNextRoundNumber,
  getPreparedRounds,
  getRoundById,
  getRounds,
  isPreparedRound,
} from '../lib/breakoutRounds';
import { isPhoneViewport } from '../lib/compactLayout';
import type { ElementGroup } from '../lib/elementGroups';
import { isGoogleDriveConfigured } from '../lib/googleConfig';
import {
  GoogleError,
  downloadDriveFile,
  formatDownloadProgress,
  friendlyGoogleError,
  isWorksheetMime,
  pickDriveFile,
} from '../lib/googleDrive';
import { computeNotesGone, getSelectionBounds, isSeeThroughHighlight, traceHollowTipShape } from '../lib/inkCore';
import type { PageRange } from '../lib/pageRange';
import type { RoundVariants } from '../lib/roundVariants';
import { authorKeyOf, summarizeSelectionAuthors } from '../lib/selectionAuthors';
import type { ClientToServerEvents, ServerToClientEvents } from '../lib/socketContract';
import { hasNameStamp } from '../lib/stamps';
import { cn } from '../lib/utils';
import { layoutPages } from '../lib/worksheetLayout';
import {
  BUILT_IN_TEMPLATES,
  BuiltInTemplateId,
  DEFAULT_WORKSHEET_IMPORT_SCALE,
  MAX_PDF_PAGES,
  WORKSHEET_IMPORT_SCALE_STORAGE_KEY,
  buildWorksheetBackground,
  getPdfPageCount,
  isPdfFile,
  normalizeWorksheetImportScale,
  processWorksheetFile,
} from '../lib/worksheetLoader';
import {
  BreakoutConfig,
  BreakoutGroupDraft,
  CanvasElement,
  ChatMessage,
  ClassroomTimerState,
  ConfigureBreakoutPayload,
  GridMode,
  RemoteCursor,
  RoomBackground,
  SpotlightPayload,
  StudentStatus,
  SubBoardData,
  TimerControlPayload,
  ToolType,
  User,
  type RestoreClassWork,
} from '../types';
import {
  EMPTY_ROUND_TEMPLATES,
  EMPTY_ROUND_VARIANTS,
  EMPTY_TEMPLATE_INK,
  PAGE_GAP,
  getCanvasGridStyle,
  readLocalGridMode,
  saveLocal,
} from './canvas/canvasHelpers';
import { CanvasToolbar } from './canvas/CanvasToolbar';
import { CanvasViewportOverlays } from './canvas/CanvasViewportOverlays';
import { InkLayer, MultiplyHighlightLayer, UNFOCUSED_INK_OPACITY, WorksheetPageNode } from './canvas/KonvaLayers';
import { createCanvasElementRenderer } from './canvas/renderCanvasElement';
import { TeacherClassroomBar } from './canvas/TeacherClassroomBar';
import { useCanvasHistory } from './canvas/useCanvasHistory';
import { useCanvasInteractionState } from './canvas/useCanvasInteractionState';
import { useCanvasLaser } from './canvas/useCanvasLaser';
import { useCanvasPointerTools } from './canvas/useCanvasPointerTools';
import { useStageViewport } from './canvas/useStageViewport';
import { useToolSettings } from './canvas/useToolSettings';
import {
  BreakoutManagerModal,
  DriveSaveModal,
  LiveGridOverview,
  PdfPageRangeModal,
  RestoreSnapshotModal,
  WorksheetTemplateModal,
  type RoundWorksheetChoice,
} from './CanvasModals';
import { LoadLessonModal, SaveLessonModal, type LessonRequest } from './LessonPackModals';
import { STATUS_OPTIONS } from './StudentStatusBadge';
import { useClassWorkFiles } from './useClassWorkFiles';

/** Board writes, from `useDrawingActions`. */
export interface CanvasDrawingActions {
  onElementStart: (element: CanvasElement) => void;
  onElementAppendPoints: (id: string, newPoints: number[]) => void;
  onElementUpdate: (patch: Partial<CanvasElement> & { id: string; bringToFront?: boolean }) => void;
  onElementRemove: (id: string) => void;
  onElementsBatchUpdate: (updates: Array<Partial<CanvasElement> & { id: string }>, bringToFront?: boolean) => void;
  onElementsBatchAdd: (elements: CanvasElement[], targetBoardId?: string) => void;
  onElementsBatchRemove: (ids: string[]) => void;
  /** Edits that keep stacking order (eraser). Missing in old callers: the eraser then stays an eraser stroke. */
  onElementsReplace?: (groups: ElementGroup<CanvasElement>[]) => void;
  onCursorMove: (cursor: Omit<RemoteCursor, 'updatedAt'>) => void;
  onUndo: () => void;
  onClearMine: () => void;
}

/** Teacher room actions, from `useClassroomActions`. */
export interface CanvasTeacherActions {
  onSelectBoard: (boardId: string) => void;
  onConfigureBreakout: (
    payload: ConfigureBreakoutPayload
  ) => Promise<{ ok: boolean; error?: string; roundId?: string }>;
  onSpotlightBoard: (payload: SpotlightPayload) => Promise<{ ok: boolean; error?: string }>;
  onAssignUserToBoard: (targetBoardId: string, targetUserId?: string) => void;
  onTeacherToggleLock: (locked: boolean) => void;
  onTeacherToggleHideCursors: (hide: boolean) => void;
  onTeacherToggleOneNameStamp: (enabled: boolean) => void;
  onTeacherClearAll: () => void;
  onTeacherSetBackground: (bg: RoomBackground | null) => Promise<{ ok: boolean; error?: string }>;
  onTeacherSendWorksheet?: (
    boardIds: string[],
    bg: RoomBackground | null,
    roundTemplateFor?: string
  ) => Promise<{ ok: boolean; updated?: number; skipped?: string[]; error?: string }>;
  onTeacherUpdateBackground: (patch: Partial<RoomBackground>) => void;
  onTeacherImportRoom: RestoreClassWork;
  /** Lesson packs: the four teacher-only socket events. */
  onTeacherLessonRequest?: LessonRequest;
  onOpenLoadedLessonRoom?: (roomId: string, pin: string) => void;
  getSavedTeacherPin?: () => string;
  generateUnusedRoomCode?: () => Promise<string>;
  onTeacherTimerControl: (payload: TimerControlPayload) => void;
  onTeacherClearStatus: (targetUserId?: string) => void;
}

/** Who is looking at the board. */
export interface CanvasViewer {
  userId: string;
  userName: string;
  userColor: string;
  isTeacher: boolean;
}

/** Room-wide switches and the classroom timer. */
export interface CanvasRoomFlags {
  isCanvasLocked: boolean;
  hideStudentCursors: boolean;
  oneNameStamp: boolean;
  hasTeacherPin?: boolean;
  timer?: ClassroomTimerState;
}

/** The board being viewed (a sub-board for a student in a round, otherwise the main board). */
export interface CanvasActiveBoard {
  activeBoardId: string;
  activeBoardTitle: string;
  elements: CanvasElement[];
  messages: ChatMessage[];
  background: RoomBackground | null;
}

/** The main board's full data, whichever board is active. */
export interface CanvasMainBoard {
  fullMainElements: CanvasElement[];
  fullMainMessages: ChatMessage[];
  fullMainBackground: RoomBackground | null;
}

/** Breakout rounds and their templates. */
export interface CanvasRounds {
  subBoards: Record<string, SubBoardData>;
  breakoutConfig: BreakoutConfig;
  /** Teacher-only: each round's starting worksheet. */
  roundTemplates?: Record<string, RoomBackground | null>;
  /** Teacher-only: ink each round copies onto its boards. */
  roundTemplateInk?: Record<string, CanvasElement[]>;
  /** Teacher-only: worksheet variants B–D per individual round. */
  roundVariants?: Record<string, RoundVariants>;
}

/** Chat sidebar state as seen from the canvas. */
export interface CanvasChat {
  isChatHidden?: boolean;
  unreadChatCount?: number;
  onShowChat?: () => void;
}

export interface CanvasProps {
  roomId: string;
  viewer: CanvasViewer;
  roomFlags: CanvasRoomFlags;
  activeBoard: CanvasActiveBoard;
  mainBoard: CanvasMainBoard;
  rounds: CanvasRounds;
  chat: CanvasChat;
  users: User[];
  remoteCursors: Record<string, RemoteCursor>;
  laserSocket: Socket<ServerToClientEvents, ClientToServerEvents> | null;
  onSetStatus: (status: StudentStatus) => void;
  /** Opens "Something not working?" (shown here only while the chat sidebar, which has the main link, is hidden). */
  onReportProblem?: () => void;
  drawingActions: CanvasDrawingActions;
  teacherActions: CanvasTeacherActions;
}

/**
 * OverBoard-style Midpoint Quadratic Curve + Single-Tap Dot Shape for Konva.
 */

/**
 * Multi-shape Hollow Stamp & Extruded Stroke Shape for Konva (Circle, Square, Triangle, Diamond, Star).
 */

/**
 * Spray stroke. Its own component so the `dash` array keeps the same identity between renders
 * (a fresh array would repaint the ink layer on every React render).
 */

/**
 * Dedicated Konva Layer whose underlying HTML5 canvas uses `mix-blend-mode: multiply`,
 * matching OverBoard's `#ink-hl` multiply highlighter layer so printed worksheet text stays crisp black.
 */

/**
 * Fades a layer's canvas with CSS: no redraw, erasers still work, and exports are unaffected.
 * (Konva's own opacity would make erasers only partly erase.)
 */

// Subcomponent to load and render a single background worksheet page image

export default function Canvas({
  roomId,
  viewer,
  roomFlags,
  activeBoard,
  mainBoard,
  rounds: roundsProp,
  chat,
  users,
  remoteCursors,
  laserSocket,
  onSetStatus,
  onReportProblem,
  drawingActions,
  teacherActions,
}: CanvasProps) {
  const { userId, userName, userColor, isTeacher } = viewer;
  const { isCanvasLocked, hideStudentCursors, oneNameStamp, hasTeacherPin = true, timer } = roomFlags;
  const { activeBoardId, activeBoardTitle, elements, messages, background } = activeBoard;
  const { fullMainElements, fullMainMessages, fullMainBackground } = mainBoard;
  const {
    subBoards,
    breakoutConfig,
    roundTemplates = EMPTY_ROUND_TEMPLATES,
    roundTemplateInk = EMPTY_TEMPLATE_INK,
    roundVariants = EMPTY_ROUND_VARIANTS,
  } = roundsProp;
  const { isChatHidden = false, unreadChatCount = 0, onShowChat } = chat;
  const {
    onElementStart,
    onElementAppendPoints,
    onElementUpdate,
    onElementRemove,
    onElementsBatchUpdate,
    onElementsBatchAdd,
    onElementsBatchRemove,
    onElementsReplace,
    onCursorMove,
    onUndo,
    onClearMine,
  } = drawingActions;
  const {
    onSelectBoard,
    onConfigureBreakout,
    onSpotlightBoard,
    onAssignUserToBoard,
    onTeacherToggleLock,
    onTeacherToggleHideCursors,
    onTeacherToggleOneNameStamp,
    onTeacherClearAll,
    onTeacherSetBackground,
    onTeacherSendWorksheet,
    onTeacherUpdateBackground,
    onTeacherImportRoom,
    onTeacherLessonRequest,
    onOpenLoadedLessonRoom,
    getSavedTeacherPin,
    generateUnusedRoomCode,
    onTeacherTimerControl,
    onTeacherClearStatus,
  } = teacherActions;
  // Per-tool settings (color, widths, highlighter, text size, ...) live in canvas/useToolSettings.
  const [showHollowMenu, setShowHollowMenu] = useState<boolean>(false);
  const hollowMenuRef = useRef<HTMLDivElement>(null);
  const [showHlMenu, setShowHlMenu] = useState<boolean>(false);
  const hlMenuRef = useRef<HTMLDivElement>(null);
  const [showStatusMenu, setShowStatusMenu] = useState<boolean>(false);
  const statusMenuRef = useRef<HTMLDivElement>(null);
  const [showTextSizeMenu, setShowTextSizeMenu] = useState<boolean>(false);
  const textSizeMenuRef = useRef<HTMLDivElement>(null);

  const [tool, setTool] = useState<ToolType>('solid');
  const [gridMode, setGridMode] = useState<GridMode>(() => readLocalGridMode('allaboard-grid-mode', 'dots'));
  const [showGridMenu, setShowGridMenu] = useState<boolean>(false);
  const gridMenuRef = useRef<HTMLDivElement>(null);

  // Phones: the full toolbar would cover most of the board, so it folds behind a "Tools" button (closed by default).
  // Tablets, Chromebooks and laptops always show it.
  const [isPhone, setIsPhone] = useState(() =>
    typeof window !== 'undefined' ? isPhoneViewport(window.innerWidth, window.innerHeight) : false
  );
  const [phoneToolsOpen, setPhoneToolsOpen] = useState(false);
  useEffect(() => {
    const update = () => setIsPhone(isPhoneViewport(window.innerWidth, window.innerHeight));
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  const toolbarCollapsed = isPhone && !phoneToolsOpen;

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

  const viewport = useStageViewport({
    elements,
    background,
    allGoneNoteIds,
  });
  const {
    stageScale,
    setStageScale,
    stagePos,
    stageRef,
    containerRef,
    dimensions,
    resetView,
    fitElementsAndBackgroundInView,
    handleWheel,
  } = viewport;

  const interaction = useCanvasInteractionState();
  const {
    isSpacePressed,
    isPanning,
    isMovingBg,
    activePointerIdRef,
    selectedIds,
    setSelectedIds,
    lassoPoints,
    selectionDragOffset,
    draggingNotePreview,
    worldPos,
    pointerOverCanvas,
    setPointerOverCanvas,
    hoveredNoteId,
    editingNote,
    setEditingNote,
    noteTextareaRef,
  } = interaction;

  // Confirmation States
  const [showHotkeysModal, setShowHotkeysModal] = useState(false);

  // Worksheet Upload & Built-In Templates State (Teacher Only)
  const worksheetInputRef = useRef<HTMLInputElement>(null);
  const [isUploadingWorksheet, setIsUploadingWorksheet] = useState(false);
  const [worksheetError, setWorksheetError] = useState<string | null>(null);
  const [worksheetImportScale, setWorksheetImportScale] = useState<number>(() => {
    try {
      return normalizeWorksheetImportScale(localStorage.getItem(WORKSHEET_IMPORT_SCALE_STORAGE_KEY));
    } catch {
      return DEFAULT_WORKSHEET_IMPORT_SCALE;
    }
  });
  const handleUpdateWorksheetImportScale = useCallback((next: number) => {
    const normalized = normalizeWorksheetImportScale(next);
    setWorksheetImportScale(normalized);
    saveLocal(WORKSHEET_IMPORT_SCALE_STORAGE_KEY, String(normalized));
  }, []);
  const [driveBusy, setDriveBusy] = useState<string | null>(null);
  const [driveCanCancel, setDriveCanCancel] = useState(false);
  const driveAbortRef = useRef<AbortController | null>(null);
  const [pendingPdfRange, setPendingPdfRange] = useState<{ file: File; totalPages: number } | null>(null);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<BuiltInTemplateId>('checkin-columns');
  const [templatePromptText, setTemplatePromptText] = useState(BUILT_IN_TEMPLATES[0].defaultPrompt);

  // Breakout & Individual Assignment Manager Modal State (Teacher Only)
  const [showBreakoutModal, setShowBreakoutModal] = useState(false);
  const [draftBreakoutMode, setDraftBreakoutMode] = useState<'individual' | 'groups'>(
    breakoutConfig.mode === 'groups' ? 'groups' : 'individual'
  );
  const [draftGroupCount, setDraftGroupCount] = useState<number>(4);
  const [draftGroups, setDraftGroups] = useState<BreakoutGroupDraft[]>([]);
  const [draftRoundAction, setDraftRoundAction] = useState<'update-current' | 'new-round'>('new-round');
  const [draftEditRoundId, setDraftEditRoundId] = useState<string>('');
  /** null = follow the live active round; 'all' = every round; otherwise a round id. */
  const [teacherViewingRoundId, setTeacherViewingRoundId] = useState<string | 'all' | null>(null);
  const [draftAllowSelfSelect, setDraftAllowSelfSelect] = useState<boolean>(breakoutConfig.allowSelfSelect);
  const [draftChatScope, setDraftChatScope] = useState<'unified' | 'board'>(breakoutConfig.chatScope);
  const [draftWorksheetChoice, setDraftWorksheetChoice] = useState<RoundWorksheetChoice>('current');
  const [draftWorksheetTopic, setDraftWorksheetTopic] = useState<string>("Today's Core Concept: Photosynthesis");
  const [showLiveGridOverview, setShowLiveGridOverview] = useState<boolean>(false);

  // Launched rounds only. Prepared rounds are listed in the breakout manager until they're launched.
  const rounds = useMemo(() => getLaunchedRounds(breakoutConfig), [breakoutConfig]);
  const preparedRounds = useMemo(() => getPreparedRounds(breakoutConfig), [breakoutConfig]);
  // What "Also copy my ink from Main" would copy: teachers' Main ink, without name stamps (server: mainTemplateInk).
  const mainTeacherInkCount = useMemo(() => {
    if (!isTeacher) return 0;
    const teacherIds = new Set(users.filter((u) => u.isTeacher).map((u) => u.userId));
    teacherIds.add(userId);
    return fullMainElements.filter(
      (el) => teacherIds.has(el.userId) && !(el.tool === 'stamp' && el.stamp === 'username')
    ).length;
  }, [isTeacher, users, userId, fullMainElements]);
  const activeRound = useMemo(() => getActiveRound(breakoutConfig), [breakoutConfig]);

  // Boards in the live (active) round. Used for students, counts, and broadcast targets.
  const activeRoundBoards = useMemo(
    () => getBoardsInRound(subBoards, breakoutConfig.activeRoundId),
    [subBoards, breakoutConfig.activeRoundId]
  );

  // Which round the TEACHER is browsing in the switcher / grid / PDF export.
  const effectiveViewingRoundId: string | 'all' | null =
    teacherViewingRoundId === 'all' || getRoundById(breakoutConfig, teacherViewingRoundId)
      ? teacherViewingRoundId
      : (breakoutConfig.activeRoundId ?? null);

  const viewingRound = useMemo(
    () =>
      effectiveViewingRoundId && effectiveViewingRoundId !== 'all'
        ? getRoundById(breakoutConfig, effectiveViewingRoundId)
        : activeRound,
    [breakoutConfig, effectiveViewingRoundId, activeRound]
  );

  const teacherVisibleBoards = useMemo(
    () =>
      effectiveViewingRoundId === 'all'
        ? getAllBoardsByRound(subBoards, breakoutConfig).filter(
            (sb) => !isPreparedRound(getRoundById(breakoutConfig, sb.roundId))
          )
        : getBoardsInRound(subBoards, effectiveViewingRoundId),
    [subBoards, breakoutConfig, effectiveViewingRoundId]
  );

  const viewingRoundLabel =
    effectiveViewingRoundId === 'all'
      ? 'All Rounds'
      : getRoundById(breakoutConfig, effectiveViewingRoundId)?.title || 'Current Round';

  const roundShortLabel = (roundId?: string) => {
    const r = getRoundById(breakoutConfig, roundId);
    return r ? `R${r.number}` : '';
  };

  // Batch Multi-Page PDF Export State (the countdown timer UI lives in canvas/ClassroomTimerControl)
  const [pdfExportProgress, setPdfExportProgress] = useState<{ current: number; total: number } | null>(null);

  const handleBatchExportAllPdf = async () => {
    if (pdfExportProgress) return;
    const allSubBoards: SubBoardData[] =
      effectiveViewingRoundId === 'all'
        ? teacherVisibleBoards.map((sb) => ({ ...sb, title: `${roundShortLabel(sb.roundId)} · ${sb.title}` }))
        : teacherVisibleBoards;
    const fileLabel =
      effectiveViewingRoundId === 'all'
        ? 'all-rounds'
        : effectiveViewingRoundId
          ? `round-${getRoundById(breakoutConfig, effectiveViewingRoundId)?.number ?? ''}`
          : 'boards';
    try {
      setPdfExportProgress({ current: 1, total: Math.max(1, allSubBoards.length + 1) });
      await exportAllBoardsToPdf({
        roomId,
        mainElements: fullMainElements,
        mainBackground: fullMainBackground,
        subBoards: allSubBoards,
        users,
        onProgress: (current, total) => setPdfExportProgress({ current, total }),
        fileLabel,
      });
    } finally {
      setPdfExportProgress(null);
    }
  };

  const [lessonModal, setLessonModal] = useState<'save' | 'load' | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const laser = useCanvasLaser({
    laserSocket,
    activeBoardId,
    isTeacher,
    userId,
    activePointerIdRef,
  });
  const { laserPoints, laserNow } = laser;

  const canDraw = !isCanvasLocked || isTeacher;
  const effectiveTool: ToolType = !canDraw
    ? 'pan'
    : isSpacePressed
      ? 'pan'
      : tool === 'move-bg' && (!isTeacher || !background)
        ? 'pan'
        : tool === 'laser' && !isTeacher
          ? 'pan'
          : tool;

  // Close Highlighter/Cover, Hollow, Grid, Status, or Text Size popout menu when clicking outside or pressing Escape
  useEffect(() => {
    if (!showHlMenu && !showHollowMenu && !showGridMenu && !showStatusMenu && !showTextSizeMenu) return;
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
      if (showStatusMenu && statusMenuRef.current && !statusMenuRef.current.contains(e.target as Node)) {
        setShowStatusMenu(false);
      }
      if (showTextSizeMenu && textSizeMenuRef.current && !textSizeMenuRef.current.contains(e.target as Node)) {
        setShowTextSizeMenu(false);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowHlMenu(false);
        setShowHollowMenu(false);
        setShowGridMenu(false);
        setShowStatusMenu(false);
        setShowTextSizeMenu(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDownOutside, true);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDownOutside, true);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [showHlMenu, showHollowMenu, showGridMenu, showStatusMenu, showTextSizeMenu]);

  // Color / stroke / text-size helpers are defined below `allGoneNoteIds` & `selectedElements`

  // Helper to initialize draft groups in the Breakout Modal
  const initializeDraftGroups = useCallback(
    (count: number, randomize = true) => {
      const students = users.filter((u) => !u.isTeacher);
      const shuffled = randomize ? [...students].sort(() => Math.random() - 0.5) : [...students];

      const nextGroups: BreakoutGroupDraft[] = [];
      for (let i = 0; i < count; i++) {
        nextGroups.push({
          id: `draft-group-${i + 1}`,
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

  const loadDraftGroupsForRound = useCallback(
    (roundId: string | null | undefined): boolean => {
      const current = roundId ? getBoardsInRound(subBoards, roundId).filter((sb) => sb.kind === 'group') : [];
      if (current.length === 0) return false;
      setDraftGroupCount(current.length);
      setDraftGroups(
        current.map((sb) => ({
          id: sb.id,
          title: sb.title,
          assignedUserIds: [...sb.assignedUserIds],
        }))
      );
      return true;
    },
    [subBoards]
  );

  const handleSelectDraftEditRound = useCallback(
    (roundId: string) => {
      setDraftEditRoundId(roundId);
      const target = getRoundById(breakoutConfig, roundId);
      if (target) {
        setDraftBreakoutMode(target.mode);
        if (!loadDraftGroupsForRound(target.id)) {
          initializeDraftGroups(draftGroupCount, true);
        }
      }
    },
    [breakoutConfig, loadDraftGroupsForRound, initializeDraftGroups, draftGroupCount]
  );

  const handleChangeDraftRoundAction = (next: 'update-current' | 'new-round') => {
    setDraftRoundAction(next);
    const target =
      (draftEditRoundId ? getRoundById(breakoutConfig, draftEditRoundId) : null) ||
      viewingRound ||
      activeRound ||
      (rounds.length > 0 ? rounds[rounds.length - 1] : null);
    if (next === 'update-current' && target) {
      setDraftEditRoundId(target.id);
      setDraftBreakoutMode(target.mode);
      if (!loadDraftGroupsForRound(target.id)) initializeDraftGroups(draftGroupCount, true);
    } else if (next === 'new-round') {
      initializeDraftGroups(draftGroupCount, true);
    }
  };

  const handleOpenBreakoutModal = () => {
    const initialTarget = viewingRound || activeRound || (rounds.length > 0 ? rounds[rounds.length - 1] : null);
    setDraftRoundAction(initialTarget ? 'update-current' : 'new-round');
    setDraftEditRoundId(initialTarget?.id || '');
    setDraftBreakoutMode(initialTarget?.mode ?? 'individual');
    setDraftAllowSelfSelect(breakoutConfig.allowSelfSelect);
    setDraftChatScope(breakoutConfig.chatScope);
    if (!loadDraftGroupsForRound(initialTarget?.id)) {
      initializeDraftGroups(draftGroupCount, true);
    }
    setShowBreakoutModal(true);
  };

  const selectedElements = useMemo(() => {
    if (selectedIds.length === 0) return [];
    const idSet = new Set(selectedIds);
    return elements.filter((el) => idSet.has(el.id) && !allGoneNoteIds.has(el.id));
  }, [elements, selectedIds, allGoneNoteIds]);

  const selectedTextElements = useMemo(() => selectedElements.filter((el) => el.tool === 'text'), [selectedElements]);

  const selectionAuthors = useMemo(() => {
    if (!isTeacher || selectedElements.length === 0) return [];
    const rosterNames = new Map(users.map((user) => [user.userId, user.name]));
    return summarizeSelectionAuthors(selectedElements, rosterNames, userId);
  }, [isTeacher, selectedElements, users, userId]);

  // Teacher-only view of one author's ink. Local to this browser; never changes the board.
  const [inkFocusKey, setInkFocusKey] = useState<string | null>(null);
  const boardInkAuthors = useMemo(() => {
    if (!isTeacher) return [];
    const rosterNames = new Map(users.map((user) => [user.userId, user.name]));
    return summarizeSelectionAuthors(elements, rosterNames, userId);
  }, [isTeacher, elements, users, userId]);
  const focusedInkAuthor = boardInkAuthors.some((author) => author.key === inkFocusKey) ? inkFocusKey : null;
  useEffect(() => setInkFocusKey(null), [activeBoardId]);

  const nameStampTaken = useMemo(
    () => oneNameStamp && !isTeacher && hasNameStamp(elements, userId),
    [oneNameStamp, isTeacher, elements, userId]
  );

  const selectionBounds = useMemo(() => {
    if (selectedElements.length === 0) return null;
    const base = getSelectionBounds(selectedElements);
    if (!base) return null;
    const dx = selectionDragOffset?.dx || 0;
    const dy = selectionDragOffset?.dy || 0;
    return [base[0] + dx, base[1] + dy, base[2] + dx, base[3] + dy] as [number, number, number, number];
  }, [selectedElements, selectionDragOffset]);

  // Per-board action-aware Undo & Redo history helpers

  const history = useCanvasHistory({
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
  });
  const { recordUndo } = history;

  const toolSettings = useToolSettings({
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
  });
  const { hollowShape, color, strokeWidth } = toolSettings;

  // Compute positioned geometry for each page of the background worksheet
  const computedBackgroundPages = useMemo(() => {
    if (!background || !Array.isArray(background.pages) || background.pages.length === 0) {
      return [];
    }
    const rects = layoutPages(background, PAGE_GAP);
    return background.pages.map((p, index) => ({
      key: `${background.id}_page_${index}`,
      dataUrl: p.dataUrl,
      x: rects[index].x,
      y: rects[index].y,
      width: rects[index].width,
      height: rects[index].height,
      opacity: background.opacity ?? 1,
    }));
  }, [background]);

  const classWork = useClassWorkFiles(
    {
      roomId,
      exportedBy: userName,
      elements: fullMainElements,
      messages: fullMainMessages,
      background: fullMainBackground,
      subBoards,
      breakoutConfig,
      roundTemplates,
      roundTemplateInk,
      roundVariants,
    },
    onTeacherImportRoom,
    (restored) => {
      const restoredBackground = restored.background || background;
      if (restored.elements.length || restoredBackground) {
        setTimeout(() => fitElementsAndBackgroundInView(restored.elements, restoredBackground), 80);
      }
    }
  );

  // Every popout menu; the toolbar renders four of them, the viewport overlays render the grid menu.
  const menus = {
    showHollowMenu,
    setShowHollowMenu,
    hollowMenuRef,
    showHlMenu,
    setShowHlMenu,
    hlMenuRef,
    showGridMenu,
    setShowGridMenu,
    gridMenuRef,
    showStatusMenu,
    setShowStatusMenu,
    statusMenuRef,
    showTextSizeMenu,
    setShowTextSizeMenu,
    textSizeMenuRef,
  };

  const {
    noteSelection,
    handleViewportPointerDown,
    handleViewportPointerMove,
    handleViewportPointerUp,
    handleViewportDoubleClick,
  } = useCanvasPointerTools({
    viewport,
    interaction,
    history,
    laser,
    toolSettings,
    menus,
    boardActions: {
      onElementStart,
      onElementAppendPoints,
      onElementUpdate,
      onElementRemove,
      onElementsBatchAdd,
      onElementsBatchUpdate,
      onElementsBatchRemove,
      onElementsReplace,
      onTeacherUpdateBackground,
      onCursorMove,
    },
    user: { userId, userName, userColor, isTeacher, canDraw, nameStampTaken },
    board: { activeBoardId, elements, allGoneNoteIds, subBoards, background },
    selection: { selectedElements, selectionBounds },
    toolState: { tool, effectiveTool, setTool },
    setShowHotkeysModal,
  });
  const { commitEditingNote } = noteSelection;

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

  const importWorksheetFile = async (file: File, range?: PageRange, scaleOverride?: number) => {
    setIsUploadingWorksheet(true);
    setWorksheetError(null);

    try {
      const effectiveScale = normalizeWorksheetImportScale(scaleOverride ?? worksheetImportScale);
      const pages = await processWorksheetFile(file, range, effectiveScale);
      const newBg = buildWorksheetBackground(
        pages,
        range ? `${file.name} (pp. ${range.first}–${range.last})` : file.name
      );

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

  const startWorksheetImport = async (file: File) => {
    setWorksheetError(null);
    if (isPdfFile(file)) {
      try {
        const total = await getPdfPageCount(file);
        if (total > MAX_PDF_PAGES) {
          setPendingPdfRange({ file, totalPages: total });
          return;
        }
      } catch {
        /* fall through; importWorksheetFile reports the error */
      }
    }
    await importWorksheetFile(file);
  };

  const handleWorksheetFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    await startWorksheetImport(file);
  };

  useEffect(() => {
    return () => {
      driveAbortRef.current?.abort();
    };
  }, []);

  const handleCancelDriveImport = () => {
    driveAbortRef.current?.abort();
  };

  const handleWorksheetFromDrive = async () => {
    setWorksheetError(null);
    setDriveBusy('Opening Google Drive...');
    setDriveCanCancel(false);
    const controller = new AbortController();
    driveAbortRef.current = controller;
    try {
      const doc = await pickDriveFile('worksheet'); // calls getAccessToken first, inside the click
      void classWork.refreshDriveAccount();
      if (!doc || controller.signal.aborted) return;
      if (!isWorksheetMime(doc.mimeType)) {
        throw new GoogleError('unsupported_worksheet_type', friendlyGoogleError('unsupported_worksheet_type'));
      }
      setDriveCanCancel(true);
      const file = await downloadDriveFile(doc, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (!controller.signal.aborted) {
            setDriveBusy(formatDownloadProgress(doc, progress));
          }
        },
      });
      if (controller.signal.aborted) return;
      setDriveBusy('Opening worksheet...');
      await startWorksheetImport(file); // same path as local upload, including the page-range modal
    } catch (err: any) {
      if (controller.signal.aborted || err?.name === 'AbortError') {
        return;
      }
      setWorksheetError(
        err instanceof GoogleError ? friendlyGoogleError(err.code) : err?.message || 'Could not import from Drive.'
      );
    } finally {
      if (driveAbortRef.current === controller) {
        driveAbortRef.current = null;
      }
      setDriveCanCancel(false);
      setDriveBusy(null);
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

  const renderElement = createCanvasElementRenderer({
    editingNote,
    selectionDragOffset,
    selectedIds,
    draggingNotePreview,
  });

  const gridSpacing = Math.max(20, Math.round(40 * stageScale));
  const myStatus: StudentStatus = users.find((user) => user.userId === userId)?.status ?? 'none';
  const myStatusOption = myStatus !== 'none' ? STATUS_OPTIONS[myStatus] : null;

  return (
    <div className="flex flex-col h-full bg-white select-none relative">
      {/* Hidden File Inputs for Teacher JSON Import and Worksheet Upload */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        onChange={classWork.handleFileChange}
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
      <CanvasToolbar
        history={history}
        toolSettings={toolSettings}
        menus={menus}
        toolState={{ tool, effectiveTool, setTool }}
        classWork={classWork}
        chat={{ isChatHidden, onShowChat, unreadChatCount }}
        phoneLayout={{ isPhone, phoneToolsOpen, setPhoneToolsOpen, toolbarCollapsed }}
        noteEditing={{ editingNote, setEditingNote, commitEditingNote, selectedTextElements }}
        user={{ userId, userName, isTeacher, canDraw, nameStampTaken }}
        status={{ myStatus, myStatusOption, onSetStatus }}
        clearMine={{ elements, allGoneNoteIds, setSelectedIds, onClearMine }}
        room={{ roomId, onReportProblem, handleExportPNG }}
      />

      {/* Teacher Classroom Moderation, Breakout Switchboard & Worksheet Deck OR Student Sub-Board Bar */}
      <TeacherClassroomBar
        isTeacher={isTeacher}
        toolbarCollapsed={toolbarCollapsed}
        timer={timer}
        classWork={classWork}
        teacherActions={{
          onConfigureBreakout,
          onTeacherTimerControl,
          onTeacherUpdateBackground,
          onTeacherSetBackground,
          onTeacherLessonRequest,
          onTeacherToggleLock,
          onTeacherToggleHideCursors,
          onTeacherToggleOneNameStamp,
          onTeacherClearAll,
          onAssignUserToBoard,
        }}
        roundsView={{
          breakoutConfig,
          rounds,
          activeRound,
          viewingRound,
          effectiveViewingRoundId,
          activeRoundBoards,
          teacherVisibleBoards,
          subBoards,
          roundShortLabel,
          setTeacherViewingRoundId,
        }}
        worksheetImport={{
          isUploadingWorksheet,
          worksheetInputRef,
          fileInputRef,
          driveBusy,
          driveCanCancel,
          handleWorksheetFromDrive,
          handleCancelDriveImport,
          worksheetImportScale,
          handleUpdateWorksheetImportScale,
          worksheetError,
        }}
        moderation={{ isCanvasLocked, hideStudentCursors, oneNameStamp }}
        board={{ activeBoardId, activeBoardTitle, onSelectBoard, elements, fullMainElements, background }}
        liveGrid={{ showLiveGridOverview, setShowLiveGridOverview, pdfExportProgress, handleBatchExportAllPdf }}
        modals={{ handleOpenBreakoutModal, setShowTemplateModal, setLessonModal }}
        toolState={{ tool, effectiveTool, setTool }}
        inkFocus={{ focusedInkAuthor, setInkFocusKey, boardInkAuthors }}
      />

      {/* Teacher Live Grid Overview of All Student / Group Boards */}
      {isTeacher && showLiveGridOverview && (
        <LiveGridOverview
          activeBoardId={activeBoardId}
          boards={teacherVisibleBoards}
          roundLabel={viewingRoundLabel}
          showRoundPrefix={effectiveViewingRoundId === 'all'}
          roundShortLabel={roundShortLabel}
          activeRoundId={breakoutConfig.activeRoundId}
          viewingRound={viewingRound}
          currentMode={breakoutConfig.mode}
          onSendClassToRound={(roundId) => {
            onConfigureBreakout({ action: 'resume', roundId });
            setTeacherViewingRoundId(null);
          }}
          activeRoundGroupBoards={activeRoundBoards.filter((sb) => sb.kind === 'group')}
          onAssignUserToBoard={onAssignUserToBoard}
          onTeacherClearStatus={onTeacherClearStatus}
          onSpotlightBoard={onSpotlightBoard}
          onSendWorksheet={onTeacherSendWorksheet}
          roundTemplates={roundTemplates}
          roundVariants={roundVariants}
          onTeacherRequest={onTeacherLessonRequest}
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
          hasTeacherPin={Boolean(hasTeacherPin)}
          autoIndividual={Boolean(breakoutConfig.autoIndividual)}
          autoIndividualTemplateLabel={breakoutConfig.autoIndividualTemplateLabel}
          rounds={rounds}
          preparedRounds={preparedRounds}
          roundTemplates={roundTemplates}
          roundTemplateInk={roundTemplateInk}
          roundVariants={roundVariants}
          onTeacherRequest={onTeacherLessonRequest}
          mainTeacherInkCount={mainTeacherInkCount}
          subBoards={subBoards}
          onLoadDraftGroupsForRound={loadDraftGroupsForRound}
          onViewRoundBoards={(roundId) => {
            setTeacherViewingRoundId(roundId);
            setShowLiveGridOverview(true);
          }}
          activeRound={activeRound}
          draftEditRoundId={draftEditRoundId}
          onSelectDraftEditRound={handleSelectDraftEditRound}
          onFollowRound={() => setTeacherViewingRoundId(null)}
          nextRoundNumber={getNextRoundNumber(breakoutConfig)}
          currentMode={breakoutConfig.mode}
          draftRoundAction={draftRoundAction}
          onChangeDraftRoundAction={handleChangeDraftRoundAction}
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

      {/* Teacher PDF Page Range Modal */}
      {pendingPdfRange && (
        <PdfPageRangeModal
          file={pendingPdfRange.file}
          fileName={pendingPdfRange.file.name}
          totalPages={pendingPdfRange.totalPages}
          maxPages={MAX_PDF_PAGES}
          importScale={worksheetImportScale}
          onImportScaleChange={handleUpdateWorksheetImportScale}
          onConfirm={(range, chosenScale) => {
            const { file } = pendingPdfRange;
            setPendingPdfRange(null);
            handleUpdateWorksheetImportScale(chosenScale);
            void importWorksheetFile(file, range, chosenScale);
          }}
          onCancel={() => setPendingPdfRange(null)}
        />
      )}

      {/* Teacher Save Room to Drive Modal */}
      {classWork.saveDialog && <DriveSaveModal {...classWork.saveDialog} />}

      {/* Teacher JSON Snapshot Restore Modal */}
      {isTeacher && lessonModal === 'save' && onTeacherLessonRequest && (
        <SaveLessonModal
          roomId={roomId}
          userName={userName}
          rounds={getRounds(breakoutConfig)}
          roundTemplates={roundTemplates}
          roundVariants={roundVariants}
          mainBackground={fullMainBackground}
          driveConfigured={isGoogleDriveConfigured()}
          onRequest={onTeacherLessonRequest}
          onClose={() => setLessonModal(null)}
        />
      )}
      {isTeacher && lessonModal === 'load' && onTeacherLessonRequest && (
        <LoadLessonModal
          roomId={roomId}
          isRoundLive={breakoutConfig.mode !== 'main'}
          driveConfigured={isGoogleDriveConfigured()}
          onRequest={onTeacherLessonRequest}
          generateUnusedRoomCode={generateUnusedRoomCode ?? (async () => '')}
          getSavedTeacherPin={getSavedTeacherPin ?? (() => '')}
          onOpenNewRoom={(newRoomId, pin) => onOpenLoadedLessonRoom?.(newRoomId, pin)}
          onSaveRoomFirst={() => void classWork.handleExportJSON()}
          onLoadedHere={(lesson) => {
            setTeacherViewingRoundId(null);
            setTimeout(() => fitElementsAndBackgroundInView([], lesson.main.background), 120);
          }}
          onClose={() => setLessonModal(null)}
        />
      )}
      {classWork.restoreDialog && <RestoreSnapshotModal {...classWork.restoreDialog} />}

      {(classWork.downloadError || classWork.restoreNotice) && (
        <div className="fixed bottom-4 left-1/2 z-[70] -translate-x-1/2 max-w-lg space-y-2">
          {classWork.downloadError && (
            <div role="alert" className="rounded border bg-white p-3 text-sm shadow-lg">
              <p>{classWork.downloadError}</p>
              <button
                type="button"
                className="mr-4 underline"
                disabled={classWork.isDownloading}
                onClick={classWork.handleExportJSON}
              >
                {classWork.isDownloading ? 'Saving…' : 'Retry download'}
              </button>
              <button type="button" onClick={classWork.dismissDownloadError}>
                Dismiss
              </button>
            </div>
          )}
          {classWork.restoreNotice && (
            <div role="alert" className="rounded border bg-white p-3 text-sm shadow-lg">
              <p>{classWork.restoreNotice}</p>
              <button type="button" className="mr-4 underline" onClick={classWork.reviewRestore}>
                Review restore
              </button>
              <button type="button" onClick={classWork.discardRestore}>
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}

      {/* Infinite Canvas Viewport (Hidden when Teacher is in Live Grid Overview) */}
      <div
        ref={containerRef}
        onPointerDown={handleViewportPointerDown}
        onPointerMove={handleViewportPointerMove}
        onPointerUp={handleViewportPointerUp}
        onPointerCancel={handleViewportPointerUp}
        onPointerLeave={() => setPointerOverCanvas(false)}
        onDoubleClick={handleViewportDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
        className={cn(
          'flex-1 relative overflow-hidden touch-none',
          showLiveGridOverview && isTeacher && 'hidden',
          effectiveTool === 'pan' || effectiveTool === 'move-bg'
            ? isPanning || isMovingBg
              ? 'cursor-grabbing'
              : 'cursor-grab'
            : effectiveTool === 'select'
              ? selectionDragOffset
                ? 'cursor-grabbing'
                : hoveredNoteId
                  ? 'cursor-move'
                  : 'cursor-crosshair'
              : effectiveTool === 'text'
                ? draggingNotePreview
                  ? 'cursor-grabbing'
                  : hoveredNoteId
                    ? 'cursor-move'
                    : 'cursor-text'
                : 'cursor-none'
        )}
        style={getCanvasGridStyle(gridMode, gridSpacing, stagePos)}
      >
        <Stage width={dimensions.width} height={dimensions.height} onWheel={handleWheel} ref={stageRef}>
          {/* Layer 1: Indelible Teacher Background Worksheet Layer */}
          <Layer x={stagePos.x} y={stagePos.y} scaleX={stageScale} scaleY={stageScale} listening={false}>
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
          {elementsGroupedByUser.map(({ userId: groupUserId, userElements, goneNoteIds, hasSeeThroughHighlights }) => {
            const screenOpacity =
              focusedInkAuthor && authorKeyOf(groupUserId) !== focusedInkAuthor ? UNFOCUSED_INK_OPACITY : 1;
            return (
              <React.Fragment key={groupUserId}>
                {hasSeeThroughHighlights && (
                  <MultiplyHighlightLayer
                    x={stagePos.x}
                    y={stagePos.y}
                    scaleX={stageScale}
                    scaleY={stageScale}
                    screenOpacity={screenOpacity}
                  >
                    {userElements
                      .filter((el) => isSeeThroughHighlight(el) || el.tool === 'eraser')
                      .map((el) => renderElement(el, goneNoteIds))}
                  </MultiplyHighlightLayer>
                )}

                <InkLayer
                  x={stagePos.x}
                  y={stagePos.y}
                  scaleX={stageScale}
                  scaleY={stageScale}
                  screenOpacity={screenOpacity}
                >
                  {userElements.filter((el) => !isSeeThroughHighlight(el)).map((el) => renderElement(el, goneNoteIds))}
                </InkLayer>
              </React.Fragment>
            );
          })}

          {/* Top Overlay Layer: Live Remote Cursors (filtered to current activeBoardId) & Local Brush/Stamp Preview */}
          <Layer x={stagePos.x} y={stagePos.y} scaleX={stageScale} scaleY={stageScale} listening={false}>
            {laserPoints.map((point, index) => {
              const previous = laserPoints[index - 1];
              const opacity = Math.max(0, 1 - (laserNow - point.time) / 1200);
              return (
                <Group key={point.id} opacity={opacity}>
                  {previous && previous.userId === point.userId && previous.strokeId === point.strokeId && (
                    <Line
                      points={[previous.x, previous.y, point.x, point.y]}
                      stroke="#ef4444"
                      strokeWidth={4 / stageScale}
                      lineCap="round"
                      lineJoin="round"
                    />
                  )}
                  <Circle x={point.x} y={point.y} radius={6 / stageScale} fill="#ef4444" opacity={0.35} />
                  <Circle x={point.x} y={point.y} radius={2.5 / stageScale} fill="#ff3030" />
                </Group>
              );
            })}
            {(Object.values(remoteCursors) as RemoteCursor[]).map((rc) => {
              if (rc.userId === userId) return null;
              if (hideStudentCursors && !users.find((user) => user.userId === rc.userId)?.isTeacher) return null;
              if ((rc.boardId || 'main') !== activeBoardId) return null;
              return (
                <Group key={rc.userId} x={rc.x} y={rc.y}>
                  <Circle radius={5 / stageScale} fill={rc.color} stroke="#ffffff" strokeWidth={1.5 / stageScale} />
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

            {pointerOverCanvas &&
              effectiveTool !== 'laser' &&
              effectiveTool !== 'pan' &&
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
                    traceHollowTipShape(rawCtx, worldPos.x, worldPos.y, strokeWidth / 2, hollowShape);
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
                stroke="#087f73"
                strokeWidth={1.75 / stageScale}
                dash={[6 / stageScale, 4 / stageScale]}
                fill="rgba(8, 127, 115, 0.06)"
                cornerRadius={4 / stageScale}
              />
            )}
          </Layer>
        </Stage>

        <CanvasViewportOverlays
          viewport={viewport}
          interaction={interaction}
          noteSelection={noteSelection}
          toolSettings={toolSettings}
          selection={{ selectedElements, selectionBounds, selectionAuthors, selectedTextElements }}
          grid={{ gridMode, setGridMode, showGridMenu, setShowGridMenu, gridMenuRef }}
          hotkeys={{ showHotkeysModal, setShowHotkeysModal }}
          user={{ userName, userColor, isTeacher, canDraw }}
          activeRoundBoards={activeRoundBoards}
          effectiveTool={effectiveTool}
        />
      </div>
    </div>
  );
}
