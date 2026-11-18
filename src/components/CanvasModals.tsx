import React, { useEffect, useRef, useState } from 'react';
import {
  BreakoutConfig,
  BreakoutGroupDraft,
  BreakoutMode,
  BreakoutRoundMeta,
  CanvasElement,
  ChatMessage,
  ConfigureBreakoutPayload,
  ImportRestoreMode,
  PendingSnapshotData,
  RoomBackground,
  SubBoardData,
  User,
  SpotlightPayload,
} from '../types';
import {
  BUILT_IN_TEMPLATES,
  BuiltInTemplateId,
  DEFAULT_WORKSHEET_IMPORT_SCALE,
  WORKSHEET_SCALE_OPTIONS,
  generateTemplateBackground,
  openPdfForThumbnails,
  type PdfThumbnailHandle,
} from '../lib/worksheetLoader';
import { clampPageRange, type PageRange } from '../lib/pageRange';
import {
  normalizeJsonFileName,
  replacesLastSave,
  type DriveFolder,
  type DriveSaveRecord,
} from '../lib/googleDrive';
import { AlertCircle, Check, Download, FolderOpen, Shuffle, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { StudentStatusBadge } from './StudentStatusBadge';

export type { PendingSnapshotData };

interface LiveGridOverviewProps {
  activeBoardId: string;
  boards: SubBoardData[];
  roundLabel: string;
  showRoundPrefix: boolean;
  roundShortLabel: (roundId?: string) => string;
  activeRoundId?: string;
  viewingRound?: BreakoutRoundMeta | null;
  currentMode?: BreakoutMode;
  onSendClassToRound?: (roundId: string) => void;
  activeRoundGroupBoards: SubBoardData[];
  onAssignUserToBoard: (targetBoardId: string, targetUserId?: string) => void;
  onTeacherClearStatus: (targetUserId?: string) => void;
  onSpotlightBoard: (payload: SpotlightPayload) => Promise<{ ok: boolean; error?: string }>;
  users: User[];
  fullMainElements: CanvasElement[];
  fullMainBackground: RoomBackground | null;
  pdfExportProgress: { current: number; total: number } | null;
  onBatchExportAllPdf: () => void;
  onOpenBreakoutModal: () => void;
  onSelectBoard: (boardId: string) => void;
  onClose: () => void;
}

/**
 * Teacher live grid overview displaying miniature previews of the main board and all sub-boards.
 */
export function LiveGridOverview({
  activeBoardId,
  boards,
  roundLabel,
  showRoundPrefix,
  roundShortLabel,
  activeRoundId,
  viewingRound,
  currentMode,
  onSendClassToRound,
  activeRoundGroupBoards,
  onAssignUserToBoard,
  onTeacherClearStatus,
  onSpotlightBoard,
  users,
  fullMainElements,
  fullMainBackground,
  pdfExportProgress,
  onBatchExportAllPdf,
  onOpenBreakoutModal,
  onSelectBoard,
  onClose,
}: LiveGridOverviewProps) {
  const [shareBoard, setShareBoard] = useState<SubBoardData | null>(null);
  const [anonymize, setAnonymize] = useState(true);
  const [copyBackground, setCopyBackground] = useState(true);
  const [returnToMain, setReturnToMain] = useState(currentMode !== 'main');
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState('');

  const canSendClassToViewingRound = Boolean(
    viewingRound &&
      onSendClassToRound &&
      (currentMode === 'main' || viewingRound.id !== activeRoundId)
  );

  return (
    <div className="flex-1 bg-slate-100 overflow-y-auto p-6 z-30 select-text">
      <div className="max-w-6xl mx-auto space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4 bg-white p-4 rounded-xl border border-slate-200">
          <div>
            <h2 className="font-display text-lg font-bold text-slate-900">
              Live Classroom Boards Overview — {roundLabel} ({boards.length + 1} Boards)
            </h2>
            <p className="text-xs text-slate-500">
              Click any student or group board below to jump onto their canvas, give feedback, or project it to the class.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canSendClassToViewingRound && viewingRound && onSendClassToRound && (
              <button
                type="button"
                onClick={() => onSendClassToRound(viewingRound.id)}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-brand-600 text-white hover:bg-brand-700 cursor-pointer"
                title={`Move the whole class into ${viewingRound.title} with their saved work intact`}
              >
                Send Class to Round {viewingRound.number}
              </button>
            )}
            <button
              type="button"
              disabled={Boolean(pdfExportProgress)}
              onClick={onBatchExportAllPdf}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 cursor-pointer"
              title="Download a single multi-page PDF with every student and group board for grading or portfolios"
            >
              <Download size={14} />
              <span>
                {pdfExportProgress
                  ? `Building PDF (${pdfExportProgress.current}/${pdfExportProgress.total})...`
                  : `Export ${roundLabel} (.PDF)`}
              </span>
            </button>
            <button
              type="button"
              onClick={onOpenBreakoutModal}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 text-slate-800 hover:bg-slate-200 cursor-pointer"
            >
              Configure Breakouts / Groups
            </button>
            <button
              type="button"
              onClick={onClose}
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
              onClose();
            }}
            className={cn(
              "bg-white rounded-xl border p-4 cursor-pointer transition-all hover:shadow-md flex flex-col justify-between gap-3",
              activeBoardId === 'main' ? "border-brand-600 ring-2 ring-brand-600/20" : "border-slate-200"
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
              <span className="text-brand-600 font-semibold">Open Board →</span>
            </div>
          </div>

          {/* Individual / Group Sub-Board Cards */}
          {boards.map((sb) => {
            const assignedNames = sb.assignedUserIds
              .map((uid) => users.find((u) => u.userId === uid)?.name || 'Student')
              .join(', ');

            return (
              <div
                key={sb.id}
                onClick={() => {
                  onSelectBoard(sb.id);
                  onClose();
                }}
                className={cn(
                  "bg-white rounded-xl border p-4 cursor-pointer transition-all hover:shadow-md flex flex-col justify-between gap-3",
                  activeBoardId === sb.id ? "border-brand-600 ring-2 ring-brand-600/20" : "border-slate-200"
                )}
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display font-bold text-sm text-slate-900 truncate">
                      {showRoundPrefix ? `${roundShortLabel(sb.roundId)} · ` : ''}{sb.title}
                    </span>
                    <span className="font-mono tabular-nums text-xs text-brand-600 font-semibold shrink-0">
                      {sb.elements.length} {sb.elements.length === 1 ? 'stroke' : 'strokes'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 truncate mt-0.5">
                    {assignedNames || 'No students assigned yet'}
                  </p>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {sb.assignedUserIds.map((uid) => {
                      const student = users.find((u) => u.userId === uid);
                      return student?.status && student.status !== 'none' ? <span key={uid} className="inline-flex items-center gap-1 text-xs text-slate-600">{sb.assignedUserIds.length > 1 && student.name}<StudentStatusBadge status={student.status} name={student.name} onClear={() => onTeacherClearStatus(uid)} /></span> : null;
                    })}
                  </div>
                  {sb.kind === 'group' && sb.roundId === activeRoundId && sb.assignedUserIds.length > 0 && (
                    <div className="space-y-1 mt-2" onClick={(e) => e.stopPropagation()}>
                      {sb.assignedUserIds.map((uid) => (
                        <div key={uid} className="flex items-center justify-between gap-2 text-[11px]">
                          <span className="text-slate-700 truncate">{users.find((u) => u.userId === uid)?.name || 'Student'}</span>
                          <select
                            aria-label="Move student to another group"
                            value={sb.id}
                            onChange={(e) => onAssignUserToBoard(e.target.value, uid)}
                            className="bg-slate-50 border border-slate-300 rounded px-1.5 py-0.5 text-[11px] text-slate-800 cursor-pointer"
                          >
                            {activeRoundGroupBoards.map((g) => (
                              <option key={g.id} value={g.id}>{g.title}</option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                  )}
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
                  <button type="button" onClick={(e) => { e.stopPropagation(); setShareBoard(sb); setAnonymize(true); setCopyBackground(true); setReturnToMain(currentMode !== 'main'); setShareError(''); }} className="text-brand-700 font-semibold hover:underline cursor-pointer">Share to Main</button>
                  <span className="text-brand-600 font-semibold">Inspect & Draw →</span>
                </div>
              </div>
            );
          })}
        </div>
        {shareBoard && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4" role="dialog" aria-modal="true" aria-labelledby="share-board-title">
            <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl space-y-4">
              <h3 id="share-board-title" className="font-bold text-slate-900">Share {shareBoard.title} to Main</h3>
              <p className="text-sm text-slate-600">This replaces the ink currently on Main. Review the work for names written in the drawing or worksheet before sharing.</p>
              <div className="space-y-2 text-sm text-slate-800">
                <label className="flex gap-2"><input type="checkbox" checked={anonymize} onChange={(e) => setAnonymize(e.target.checked)} /> Anonymize authors and remove name stamps</label>
                <label className="flex gap-2"><input type="checkbox" checked={copyBackground} onChange={(e) => setCopyBackground(e.target.checked)} /> Copy worksheet to Main</label>
                <label className="flex gap-2"><input type="checkbox" checked={returnToMain} onChange={(e) => setReturnToMain(e.target.checked)} /> Bring class to Main</label>
              </div>
              {shareError && <p role="alert" className="text-sm text-red-700">{shareError}</p>}
              <div className="flex justify-end gap-2">
                <button type="button" disabled={sharing} onClick={() => setShareBoard(null)} className="px-3 py-1.5 text-sm rounded bg-slate-100 cursor-pointer">Cancel</button>
                <button type="button" disabled={sharing} onClick={async () => {
                  setSharing(true);
                  const result = await onSpotlightBoard({ sourceBoardId: shareBoard.id, anonymize, copyBackground, returnToMain });
                  setSharing(false);
                  if (!result.ok) { setShareError(result.error || 'Could not share this board.'); return; }
                  setShareBoard(null); onSelectBoard('main'); onClose();
                }} className="px-3 py-1.5 text-sm rounded bg-brand-600 text-white disabled:opacity-50 cursor-pointer">{sharing ? 'Sharing…' : 'Share to Main'}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface BreakoutManagerModalProps {
  users: User[];
  fullMainBackground: RoomBackground | null;
  hasTeacherPin: boolean;
  autoIndividual: boolean;
  autoIndividualTemplateLabel?: string;
  rounds?: BreakoutRoundMeta[];
  activeRound: BreakoutRoundMeta | null;
  draftEditRoundId?: string;
  onSelectDraftEditRound?: (roundId: string) => void;
  onFollowRound?: () => void;
  nextRoundNumber: number;
  currentMode: BreakoutMode;
  draftRoundAction: 'update-current' | 'new-round';
  onChangeDraftRoundAction: (next: 'update-current' | 'new-round') => void;
  draftBreakoutMode: 'individual' | 'groups';
  setDraftBreakoutMode: (mode: 'individual' | 'groups') => void;
  draftGroupCount: number;
  setDraftGroupCount: (count: number) => void;
  draftGroups: BreakoutGroupDraft[];
  setDraftGroups: React.Dispatch<React.SetStateAction<BreakoutGroupDraft[]>>;
  draftAllowSelfSelect: boolean;
  setDraftAllowSelfSelect: (allow: boolean) => void;
  draftChatScope: 'unified' | 'board';
  setDraftChatScope: (scope: 'unified' | 'board') => void;
  draftWorksheetChoice: 'current' | 'frayer' | 'checkin' | 'corners' | 'none';
  setDraftWorksheetChoice: (
    choice: 'current' | 'frayer' | 'checkin' | 'corners' | 'none'
  ) => void;
  draftWorksheetTopic: string;
  setDraftWorksheetTopic: (topic: string) => void;
  initializeDraftGroups: (count: number, randomize?: boolean) => void;
  onConfigureBreakout: (payload: ConfigureBreakoutPayload) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
  onShowLiveGridOverview: (show: boolean) => void;
}

/**
 * Teacher modal for configuring individual student boards or breakout group rooms.
 */
export function BreakoutManagerModal({
  users,
  fullMainBackground,
  hasTeacherPin,
  autoIndividual,
  autoIndividualTemplateLabel,
  rounds = [],
  activeRound,
  draftEditRoundId,
  onSelectDraftEditRound,
  onFollowRound,
  nextRoundNumber,
  currentMode,
  draftRoundAction,
  onChangeDraftRoundAction,
  draftBreakoutMode,
  setDraftBreakoutMode,
  draftGroupCount,
  setDraftGroupCount,
  draftGroups,
  setDraftGroups,
  draftAllowSelfSelect,
  setDraftAllowSelfSelect,
  draftChatScope,
  setDraftChatScope,
  draftWorksheetChoice,
  setDraftWorksheetChoice,
  draftWorksheetTopic,
  setDraftWorksheetTopic,
  initializeDraftGroups,
  onConfigureBreakout,
  onClose,
  onShowLiveGridOverview,
}: BreakoutManagerModalProps) {
  const [autoDraftEnabled, setAutoDraftEnabled] = useState<boolean>(autoIndividual);
  const [autoWorksheetChoice, setAutoWorksheetChoice] = useState<
    'current' | 'frayer' | 'checkin' | 'corners' | 'none'
  >(() => {
    if (autoIndividualTemplateLabel === 'Frayer Model') return 'frayer';
    if (autoIndividualTemplateLabel === 'Task Pulse Check') return 'checkin';
    if (autoIndividualTemplateLabel === 'Four Corners') return 'corners';
    if (autoIndividualTemplateLabel === 'Blank') return 'none';
    if (fullMainBackground) return 'current';
    return 'none';
  });
  const [autoWorksheetTopic, setAutoWorksheetTopic] = useState<string>(draftWorksheetTopic);
  const [autoSaving, setAutoSaving] = useState(false);

  const targetRound =
    (draftEditRoundId ? rounds.find((r) => r.id === draftEditRoundId) : null) ||
    activeRound ||
    (rounds.length > 0 ? rounds[rounds.length - 1] : null);
  const isEditing = Boolean(targetRound) && draftRoundAction === 'update-current';
  const isSwitchingOrResuming = Boolean(
    isEditing && targetRound && (currentMode === 'main' || targetRound.id !== activeRound?.id)
  );
  const templateLabelFor = (choice: typeof draftWorksheetChoice): string =>
    choice === 'frayer' ? 'Frayer Model'
    : choice === 'checkin' ? 'Task Pulse Check'
    : choice === 'corners' ? 'Four Corners'
    : choice === 'current' && fullMainBackground ? 'Copy of Main'
    : 'Blank';

  const buildWorksheetConfig = (
    choice: 'current' | 'frayer' | 'checkin' | 'corners' | 'none',
    topic: string
  ): { customBackground?: RoomBackground | null; copyWorksheet: boolean; templateLabel: string } => {
    let customBackground: RoomBackground | null | undefined = undefined;
    if (choice === 'frayer') customBackground = generateTemplateBackground('frayer-model', topic);
    else if (choice === 'checkin') customBackground = generateTemplateBackground('checkin-columns', topic);
    else if (choice === 'corners') customBackground = generateTemplateBackground('four-corners', topic);
    else if (choice === 'none') customBackground = null;
    return {
      customBackground,
      copyWorksheet: choice === 'current',
      templateLabel: templateLabelFor(choice),
    };
  };

  return (
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
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        {targetRound && (
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => onChangeDraftRoundAction('update-current')}
              className={cn(
                "p-3 rounded-xl border text-left transition-colors cursor-pointer",
                draftRoundAction === 'update-current' ? "bg-brand-50/80 border-brand-600" : "bg-white border-slate-200 hover:border-slate-300"
              )}
            >
              <div className="font-display font-semibold text-xs text-slate-900">
                {rounds.length > 1 ? 'Resume / Edit Existing Round' : `Resume / Edit ${targetRound.title}`}
              </div>
              <p className="text-[11px] text-slate-500 mt-0.5">
                {rounds.length > 1
                  ? 'Send the class back to Round 1, Round 2, etc., or update groups with all work kept.'
                  : 'Keep every board and drawing. Change groups or chat settings.'}
              </p>
            </button>
            <button
              type="button"
              onClick={() => onChangeDraftRoundAction('new-round')}
              className={cn(
                "p-3 rounded-xl border text-left transition-colors cursor-pointer",
                draftRoundAction === 'new-round' ? "bg-brand-50/80 border-brand-600" : "bg-white border-slate-200 hover:border-slate-300"
              )}
            >
              <div className="font-display font-semibold text-xs text-slate-900">Start New Round {nextRoundNumber}</div>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Fresh boards and a new worksheet. Earlier rounds stay saved and can be resumed anytime.
              </p>
            </button>
          </div>
        )}

        {/* Round Picker when multiple rounds exist and teacher is in Resume / Edit mode */}
        {isEditing && rounds.length > 1 && targetRound && (
          <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
            <label className="block text-xs font-semibold text-slate-700">
              Choose Which Round to Send Class To / Edit:
            </label>
            <div className="flex flex-wrap gap-2">
              {rounds.map((r) => {
                const isSelected = r.id === targetRound.id;
                const isLive = currentMode !== 'main' && r.id === activeRound?.id;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => onSelectDraftEditRound?.(r.id)}
                    className={cn(
                      "px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors cursor-pointer flex items-center gap-1.5",
                      isSelected
                        ? "bg-brand-600 text-white border-brand-600"
                        : "bg-white text-slate-800 border-slate-300 hover:bg-slate-100"
                    )}
                  >
                    <span>{r.title}</span>
                    {isLive && (
                      <span
                        className={cn(
                          "px-1.5 py-0.2 rounded text-[10px] font-semibold",
                          isSelected ? "bg-brand-500 text-white" : "bg-emerald-100 text-emerald-800"
                        )}
                      >
                        Live
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* 1. Mode Selection */}
        {!isEditing && (
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setDraftBreakoutMode('individual')}
              className={cn(
                "p-3 rounded-xl border text-left transition-colors cursor-pointer",
                draftBreakoutMode === 'individual'
                  ? "bg-brand-50/80 border-brand-600"
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
                  ? "bg-brand-50/80 border-brand-600"
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
        )}
        {isEditing && targetRound && (
          <p className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
            {targetRound.mode === 'groups' ? 'Group round' : 'Individual round'} · Students&apos; drawings and worksheets in {targetRound.title} are kept intact.
            {targetRound.mode === 'individual' && ' Students who join late automatically get their own board.'}
          </p>
        )}

        {/* 2. Group Assignment Controls (when 'groups' is selected) */}
        {draftBreakoutMode === 'groups' && (
          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
            {!isEditing && (
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
                          ? "bg-brand-600 text-white"
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
            )}

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
                      '';
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
                className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              <span>Allow students to freely switch between breakout groups themselves</span>
            </label>
          </div>
        )}

        {/* 3. Pre-load Worksheet / Template on Sub-Boards */}
        {!isEditing && (
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
                    ? "bg-brand-50 border-brand-600 font-semibold text-slate-900"
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
                    ? "bg-brand-50 border-brand-600 font-semibold text-slate-900"
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
                    ? "bg-brand-50 border-brand-600 font-semibold text-slate-900"
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
                    ? "bg-brand-50 border-brand-600 font-semibold text-slate-900"
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
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-lg text-xs text-slate-900 focus:bg-white focus:border-brand-600 focus:outline-none"
                />
              </div>
            )}
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

        {activeRound && !isEditing && (
          <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            {activeRound.title} will be archived. Nothing is deleted. You can still open and export it from the Round selector.
          </p>
        )}

        {/* Auto-Start on Entry: Students start on their own boards */}
        <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-display text-xs font-semibold text-slate-900">
                  Students start on their own boards
                </span>
                {autoIndividual && (
                  <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[10px] font-semibold">
                    {currentMode === 'main'
                      ? `Armed${autoIndividualTemplateLabel ? ` · ${autoIndividualTemplateLabel}` : ''}`
                      : 'Active'}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Any non-teacher student joining Main lands straight on their own private board with your chosen worksheet, while you keep Main separate. Clicking Bring All to Main turns this off so latecomers follow the class.
              </p>
            </div>
            <label className="flex items-center gap-1.5 text-xs font-medium text-slate-800 shrink-0 cursor-pointer">
              <input
                type="checkbox"
                checked={autoDraftEnabled}
                disabled={!hasTeacherPin}
                onChange={(e) => setAutoDraftEnabled(e.target.checked)}
                className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              <span>Enable</span>
            </label>
          </div>

          {!hasTeacherPin && (
            <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
              Set a Room Teacher PIN in the sidebar first before enabling automatic student boards.
            </p>
          )}

          {hasTeacherPin && autoDraftEnabled && (
            <div className="space-y-2 pt-1 border-t border-slate-200/80">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="text-[11px] font-semibold text-slate-700">
                  Starting worksheet for students:
                </label>
                <select
                  aria-label="Starting worksheet for students"
                  value={autoWorksheetChoice}
                  onChange={(e) =>
                    setAutoWorksheetChoice(
                      e.target.value as 'current' | 'frayer' | 'checkin' | 'corners' | 'none'
                    )
                  }
                  className="bg-white border border-slate-300 rounded-md px-2 py-1 text-xs font-medium text-slate-800 cursor-pointer"
                >
                  <option value="frayer">4-Box Frayer Concept Model</option>
                  <option value="checkin">Task Pulse Check (3 Columns)</option>
                  <option value="corners">Four Corners Debate</option>
                  {fullMainBackground && (
                    <option value="current">
                      Copy Current Main Board ({fullMainBackground.fileName.slice(0, 18)})
                    </option>
                  )}
                  <option value="none">Blank Canvas (No Worksheet)</option>
                </select>
              </div>
              {(autoWorksheetChoice === 'frayer' ||
                autoWorksheetChoice === 'checkin' ||
                autoWorksheetChoice === 'corners') && (
                <input
                  type="text"
                  value={autoWorksheetTopic}
                  onChange={(e) => setAutoWorksheetTopic(e.target.value)}
                  placeholder="Worksheet Header / Concept Prompt..."
                  className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs text-slate-900 focus:border-brand-600 focus:outline-none"
                />
              )}
            </div>
          )}

          {hasTeacherPin && (autoDraftEnabled || autoIndividual) && (
            <div className="flex justify-end">
              <button
                type="button"
                disabled={autoSaving}
                onClick={async () => {
                  setAutoSaving(true);
                  const ws = buildWorksheetConfig(autoWorksheetChoice, autoWorksheetTopic);
                  const res = await onConfigureBreakout({
                    action: 'set-auto-individual',
                    autoIndividual: autoDraftEnabled,
                    customBackground: ws.customBackground,
                    copyWorksheet: ws.copyWorksheet,
                    templateLabel: ws.templateLabel,
                    chatScope: draftChatScope,
                  });
                  setAutoSaving(false);
                  if (!res.ok) {
                    window.alert(res.error || 'Could not save auto-start student board mode.');
                  }
                }}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50",
                  autoDraftEnabled
                    ? "bg-emerald-600 text-white hover:bg-emerald-500"
                    : "bg-white border border-slate-300 text-slate-700 hover:bg-slate-100"
                )}
              >
                {autoSaving
                  ? 'Saving...'
                  : autoDraftEnabled
                  ? autoIndividual
                    ? 'Update Auto-Start Mode'
                    : 'Save Auto-Start Mode (Stay on Main)'
                  : 'Turn Off Auto-Start'}
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 pt-3 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 cursor-pointer"
          >
            Cancel
          </button>
          {currentMode !== 'main' && (
            <button
              type="button"
              onClick={async () => {
                const res = await onConfigureBreakout({ action: 'return-to-main' });
                if (!res.ok) { window.alert(res.error || 'Could not return to the Main Board.'); return; }
                onClose();
                onShowLiveGridOverview(false);
              }}
              className="px-4 py-2 rounded-lg text-xs font-semibold bg-white border border-slate-300 text-slate-800 hover:bg-slate-100 cursor-pointer"
            >
              Bring Everyone to Main
            </button>
          )}
          <button
            type="button"
            onClick={async () => {
              let payload: ConfigureBreakoutPayload;
              if (isEditing && targetRound) {
                payload = {
                  action: isSwitchingOrResuming ? 'resume' : 'update-current',
                  roundId: targetRound.id,
                  allowSelfSelect: draftAllowSelfSelect,
                  chatScope: draftChatScope,
                  groups: targetRound.mode === 'groups' ? draftGroups : undefined,
                };
              } else {
                let customBg: RoomBackground | null | undefined = undefined;
                if (draftWorksheetChoice === 'frayer') customBg = generateTemplateBackground('frayer-model', draftWorksheetTopic);
                else if (draftWorksheetChoice === 'checkin') customBg = generateTemplateBackground('checkin-columns', draftWorksheetTopic);
                else if (draftWorksheetChoice === 'corners') customBg = generateTemplateBackground('four-corners', draftWorksheetTopic);
                else if (draftWorksheetChoice === 'none') customBg = null;
                payload = {
                  action: 'new-round',
                  mode: draftBreakoutMode,
                  allowSelfSelect: draftAllowSelfSelect,
                  chatScope: draftChatScope,
                  copyWorksheet: draftWorksheetChoice === 'current',
                  customBackground: customBg,
                  groups: draftBreakoutMode === 'groups' ? draftGroups : undefined,
                  templateLabel: templateLabelFor(draftWorksheetChoice),
                };
              }
              const res = await onConfigureBreakout(payload);
              if (!res.ok) { window.alert(res.error || 'Could not update breakout boards.'); return; }
              onFollowRound?.();
              onClose();
              onShowLiveGridOverview(payload.action !== 'update-current');
            }}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-brand-600 text-white hover:bg-brand-500 cursor-pointer"
          >
            {isEditing && targetRound
              ? isSwitchingOrResuming
                ? `Send Class to Round ${targetRound.number}`
                : 'Save Changes'
              : `Launch Round ${nextRoundNumber}`}
          </button>
        </div>
      </div>
    </div>
  );
}

interface WorksheetTemplateModalProps {
  activeBoardTitle: string;
  selectedTemplateId: BuiltInTemplateId;
  setSelectedTemplateId: (id: BuiltInTemplateId) => void;
  templatePromptText: string;
  setTemplatePromptText: (text: string) => void;
  onApplyTemplate: (bg: RoomBackground) => Promise<void>;
  onClose: () => void;
}

/**
 * Teacher modal for picking and customizing a built-in classroom worksheet template.
 */
export function WorksheetTemplateModal({
  activeBoardTitle,
  selectedTemplateId,
  setSelectedTemplateId,
  templatePromptText,
  setTemplatePromptText,
  onApplyTemplate,
  onClose,
}: WorksheetTemplateModalProps) {
  return (
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
            onClick={onClose}
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
                    ? "bg-brand-50/70 border-brand-600"
                    : "bg-white border-slate-200 hover:border-slate-300"
                )}
              >
                <div>
                  <div className="font-display font-semibold text-xs text-slate-900">
                    {tpl.name}
                  </div>
                  <p className="text-xs text-slate-600 mt-0.5">{tpl.description}</p>
                </div>
                {isSelected && <Check size={16} className="text-brand-600 shrink-0 mt-0.5" />}
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
            className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-sm text-slate-900 focus:bg-white focus:border-brand-600 focus:outline-none"
          />
        </div>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
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
              onClose();
              await onApplyTemplate(generatedBg);
            }}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-brand-600 text-white hover:bg-brand-500 transition-colors cursor-pointer"
          >
            Apply Worksheet to Board
          </button>
        </div>
      </div>
    </div>
  );
}

interface RestoreSnapshotModalProps {
  roomId: string;
  pendingSnapshot: PendingSnapshotData;
  importError: string | null;
  importMode: ImportRestoreMode;
  setImportMode: (mode: ImportRestoreMode) => void;
  isImporting: boolean;
  onConfirmImport: () => void;
  onCancel: () => void;
}

/**
 * Teacher modal for restoring or merging an exported `.json` room snapshot.
 */
export function RestoreSnapshotModal({
  roomId,
  pendingSnapshot,
  importError,
  importMode,
  setImportMode,
  isImporting,
  onConfirmImport,
  onCancel,
}: RestoreSnapshotModalProps) {
  return (
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
            onClick={onCancel}
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
                    ? "bg-brand-50/70 border-brand-600"
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
                {importMode === 'replace' && <Check size={16} className="text-brand-600 shrink-0 mt-0.5" />}
              </button>

              <button
                type="button"
                onClick={() => setImportMode('readonly')}
                className={cn(
                  "w-full text-left p-3 rounded-xl border transition-colors flex items-start justify-between gap-3 cursor-pointer",
                  importMode === 'readonly'
                    ? "bg-brand-50/70 border-brand-600"
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
                {importMode === 'readonly' && <Check size={16} className="text-brand-600 shrink-0 mt-0.5" />}
              </button>

              <button
                type="button"
                onClick={() => setImportMode('merge')}
                className={cn(
                  "w-full text-left p-3 rounded-xl border transition-colors flex items-start justify-between gap-3 cursor-pointer",
                  importMode === 'merge'
                    ? "bg-brand-50/70 border-brand-600"
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
                {importMode === 'merge' && <Check size={16} className="text-brand-600 shrink-0 mt-0.5" />}
              </button>
            </div>
          </>
        )}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
          >
            Cancel
          </button>
          {!importError && (
            <button
              type="button"
              disabled={isImporting}
              onClick={onConfirmImport}
              className="px-4 py-2 rounded-lg text-xs font-semibold bg-brand-600 text-white hover:bg-brand-500 disabled:bg-slate-300 transition-colors cursor-pointer"
            >
              {isImporting ? 'Restoring...' : 'Restore Room Snapshot'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface PdfPageRangeModalProps {
  file: File;
  fileName: string;
  totalPages: number;
  maxPages: number;
  importScale?: number;
  onImportScaleChange?: (nextScale: number) => void;
  onConfirm: (range: PageRange, importScale: number) => void;
  onCancel: () => void;
}

/**
 * Teacher modal for picking up to `maxPages` pages when importing a long PDF worksheet.
 */
export function PdfPageRangeModal({
  file,
  fileName,
  totalPages,
  maxPages,
  importScale = DEFAULT_WORKSHEET_IMPORT_SCALE,
  onImportScaleChange,
  onConfirm,
  onCancel,
}: PdfPageRangeModalProps) {
  const [firstText, setFirstText] = useState('1');
  const [lastText, setLastText] = useState(String(Math.min(maxPages, totalPages)));
  const [selectedScale, setSelectedScale] = useState<number>(importScale);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const gridRef = useRef<HTMLDivElement | null>(null);

  const clamped = clampPageRange(Number(firstText), Number(lastText), totalPages, maxPages);

  useEffect(() => {
    setThumbs({});
    const gridEl = gridRef.current;
    let cancelled = false;
    let pdfHandle: PdfThumbnailHandle | null = null;
    const visiblePages = new Set<number>();
    const renderedPages = new Set<number>();
    let processing = false;

    const drainQueue = async () => {
      if (processing || cancelled || !pdfHandle) return;
      processing = true;
      try {
        while (!cancelled && pdfHandle) {
          const nextPage = Array.from(visiblePages)
            .filter((p) => !renderedPages.has(p))
            .sort((a, b) => a - b)[0];
          if (!nextPage) break;
          renderedPages.add(nextPage);
          visiblePages.delete(nextPage);
          try {
            const dataUrl = await pdfHandle.renderThumb(nextPage, 120);
            if (cancelled) break;
            setThumbs((prev) => ({ ...prev, [nextPage]: dataUrl }));
          } catch {
            /* ignore thumbnail errors if dialog closed */
          }
        }
      } finally {
        processing = false;
      }
    };

    const observer =
      gridEl && typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                const pageNum = Number((entry.target as HTMLElement).dataset.page);
                if (!pageNum) continue;
                if (entry.isIntersecting) {
                  if (!renderedPages.has(pageNum)) {
                    visiblePages.add(pageNum);
                  }
                } else {
                  visiblePages.delete(pageNum);
                }
              }
              void drainQueue();
            },
            { root: gridEl, rootMargin: '400px' }
          )
        : null;

    if (gridEl && observer) {
      gridEl.querySelectorAll<HTMLElement>('[data-page]').forEach((el) => observer.observe(el));
    } else {
      for (let p = 1; p <= Math.min(totalPages, maxPages); p++) {
        visiblePages.add(p);
      }
    }

    openPdfForThumbnails(file)
      .then((handle) => {
        if (cancelled) {
          void handle.destroy();
          return;
        }
        pdfHandle = handle;
        void drainQueue();
      })
      .catch(() => {
        /* ignore thumbnail load failure; From/To numeric inputs still work */
      });

    return () => {
      cancelled = true;
      observer?.disconnect();
      void pdfHandle?.destroy();
    };
  }, [file, totalPages, maxPages]);

  const handleBlur = () => {
    const next = clampPageRange(Number(firstText), Number(lastText), totalPages, maxPages);
    setFirstText(String(next.first));
    setLastText(String(next.last));
  };

  const handleThumbClick = (pageNum: number, shiftKey: boolean) => {
    if (shiftKey) {
      const currentFrom = clamped.first;
      if (pageNum >= currentFrom) {
        const next = clampPageRange(currentFrom, pageNum, totalPages, maxPages);
        setFirstText(String(next.first));
        setLastText(String(next.last));
      }
      return;
    }
    const nextLast = Math.min(pageNum + maxPages - 1, totalPages);
    setFirstText(String(pageNum));
    setLastText(String(nextLast));
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4 select-text">
      <div className="bg-white border border-slate-200 rounded-2xl shadow-xl w-full max-w-3xl p-6 space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-display text-lg font-bold text-slate-900">
              Choose Pages to Import
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              "{fileName}" has {totalPages} pages. AllAboard imports up to {maxPages} at a time.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="p-1 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="pdf-range-from"
                className="block text-xs font-semibold text-slate-700 mb-1.5"
              >
                From
              </label>
              <input
                id="pdf-range-from"
                type="number"
                min={1}
                max={totalPages}
                value={firstText}
                onChange={(e) => setFirstText(e.target.value)}
                onBlur={handleBlur}
                className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-sm text-slate-900 focus:bg-white focus:border-brand-600 focus:outline-none"
              />
            </div>
            <div>
              <label
                htmlFor="pdf-range-to"
                className="block text-xs font-semibold text-slate-700 mb-1.5"
              >
                To
              </label>
              <input
                id="pdf-range-to"
                type="number"
                min={1}
                max={totalPages}
                value={lastText}
                onChange={(e) => setLastText(e.target.value)}
                onBlur={handleBlur}
                className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-sm text-slate-900 focus:bg-white focus:border-brand-600 focus:outline-none"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
            <span>Importing pages {clamped.first}&ndash;{clamped.last}.</span>
            <span className="text-[11px] text-slate-500">
              Click a page to start there; Shift-click to set the end.
            </span>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-xl bg-slate-50 border border-slate-200/80 text-xs">
            <span className="font-semibold text-slate-700">
              Import Size <span className="font-normal text-slate-500">(scales pages relative to pens &amp; text):</span>
            </span>
            <div className="flex items-center gap-1" role="group" aria-label="Worksheet import size">
              {WORKSHEET_SCALE_OPTIONS.map((mult) => {
                const isActive = Math.abs(selectedScale - mult) < 0.01;
                return (
                  <button
                    key={mult}
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => {
                      setSelectedScale(mult);
                      onImportScaleChange?.(mult);
                    }}
                    className={cn(
                      'px-2 py-1 rounded-md font-mono font-semibold text-xs transition-colors cursor-pointer',
                      isActive
                        ? 'bg-brand-600 text-white shadow-xs'
                        : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
                    )}
                  >
                    {mult}&times;
                  </button>
                );
              })}
            </div>
          </div>

          <div
            ref={gridRef}
            data-testid="pdf-thumb-grid"
            className="max-h-[50vh] overflow-y-auto rounded-xl border border-slate-200 bg-slate-50/60 p-2.5"
          >
            <div
              className="grid gap-2.5"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' }}
            >
              {Array.from({ length: totalPages }, (_, idx) => {
                const pageNum = idx + 1;
                const inRange = pageNum >= clamped.first && pageNum <= clamped.last;
                const thumbUrl = thumbs[pageNum];
                return (
                  <button
                    key={pageNum}
                    type="button"
                    data-testid={`pdf-thumb-${pageNum}`}
                    data-page={pageNum}
                    data-in-range={inRange ? 'true' : 'false'}
                    onClick={(e) => handleThumbClick(pageNum, e.shiftKey)}
                    className={cn(
                      'flex flex-col items-center gap-1.5 p-1.5 rounded-lg border transition-all cursor-pointer select-none',
                      inRange
                        ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500/40'
                        : 'border-slate-200 bg-white opacity-60 hover:opacity-100 hover:border-slate-300'
                    )}
                  >
                    {thumbUrl ? (
                      <img
                        src={thumbUrl}
                        alt={`Page ${pageNum}`}
                        className="w-full h-24 object-contain rounded bg-white"
                      />
                    ) : (
                      <div className="w-full h-24 rounded bg-slate-100 border border-slate-200/80" />
                    )}
                    <span
                      className={cn(
                        'text-[11px] font-medium tabular-nums',
                        inRange ? 'text-brand-700 font-semibold' : 'text-slate-600'
                      )}
                    >
                      {pageNum}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() =>
              onConfirm(
                clampPageRange(Number(firstText), Number(lastText), totalPages, maxPages),
                selectedScale
              )
            }
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-brand-600 text-white hover:bg-brand-500 transition-colors cursor-pointer"
          >
            Import pages
          </button>
        </div>
      </div>
    </div>
  );
}

interface DriveSaveModalProps {
  defaultFileName: string;
  folder: DriveFolder;
  lastSave: DriveSaveRecord | null;
  accountEmail?: string | null;
  busy: 'saving' | 'choosing-folder' | 'creating-folder' | null;
  error: string | null;
  onChangeFolder: () => void;
  onCreateFolder: (name: string) => Promise<boolean>;
  onSwitchAccount?: () => void;
  onSave: (fileName: string) => void;
  onCancel: () => void;
}

/**
 * Teacher "Save Room to Drive" dialog: an editable file name plus the destination folder,
 * which opens Google's folder picker. Starts in the last folder the teacher saved to.
 */
export function DriveSaveModal({
  defaultFileName,
  folder,
  lastSave,
  accountEmail,
  busy,
  error,
  onChangeFolder,
  onCreateFolder,
  onSwitchAccount,
  onSave,
  onCancel,
}: DriveSaveModalProps) {
  const [nameText, setNameText] = useState(defaultFileName);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('AllAboard rooms');
  const finalName = normalizeJsonFileName(nameText, defaultFileName);
  const willReplace = replacesLastSave(lastSave, finalName, folder);

  const submitNewFolder = async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed || busy) return;
    const ok = await onCreateFolder(trimmed);
    if (ok) {
      setNewFolderOpen(false);
      setNewFolderName('AllAboard rooms');
    }
  };

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    onSave(finalName);
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4 select-text">
      <form
        onSubmit={submit}
        className="bg-white border border-slate-200 rounded-2xl shadow-xl w-full max-w-md p-6 space-y-5"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-display text-lg font-bold text-slate-900">Save Room to Google Drive</h3>
            <p className="text-xs text-slate-500 mt-1">
              Saves drawings, chat, worksheets and breakout boards as a .json file you can open again later.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="p-1 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label htmlFor="drive-save-name" className="block text-xs font-semibold text-slate-700 mb-1.5">
              File name
            </label>
            <input
              id="drive-save-name"
              type="text"
              value={nameText}
              onChange={(e) => setNameText(e.target.value)}
              autoFocus
              onFocus={(e) => {
                const dot = e.target.value.toLowerCase().lastIndexOf('.json');
                e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
              }}
              maxLength={200}
              className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-sm text-slate-900 focus:bg-white focus:border-brand-600 focus:outline-none"
            />
          </div>

          <div>
            <span className="block text-xs font-semibold text-slate-700 mb-1.5">Folder</span>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0 flex items-center gap-2 px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900">
                <FolderOpen size={15} className="text-slate-400 shrink-0" />
                <span className="truncate" data-testid="drive-save-folder">{folder.name}</span>
              </div>
              <button
                type="button"
                onClick={onChangeFolder}
                disabled={Boolean(busy)}
                className="px-3 py-2.5 rounded-xl text-xs font-medium border border-slate-300 text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer disabled:opacity-50 shrink-0"
              >
                {busy === 'choosing-folder' ? 'Opening...' : 'Change...'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setNewFolderName('AllAboard rooms');
                  setNewFolderOpen((open) => !open);
                }}
                disabled={Boolean(busy)}
                className="px-3 py-2.5 rounded-xl text-xs font-medium border border-slate-300 text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer disabled:opacity-50 shrink-0"
              >
                New folder...
              </button>
            </div>
            {onSwitchAccount && (
              <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-slate-500">
                <span className="truncate">
                  {accountEmail ? `Signed in as ${accountEmail}` : 'Not signed in yet'}
                </span>
                <button
                  type="button"
                  onClick={onSwitchAccount}
                  disabled={Boolean(busy)}
                  className="text-indigo-600 hover:text-indigo-700 hover:underline font-medium cursor-pointer disabled:opacity-50 shrink-0"
                >
                  Switch account
                </button>
              </div>
            )}
            {newFolderOpen && (
              <div className="mt-2 p-2.5 rounded-xl bg-slate-50 border border-slate-200 flex items-center gap-2">
                <input
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      e.stopPropagation();
                      void submitNewFolder();
                    } else if (e.key === 'Escape') {
                      e.stopPropagation();
                      setNewFolderOpen(false);
                    }
                  }}
                  aria-label="New folder name"
                  placeholder="AllAboard rooms"
                  disabled={Boolean(busy)}
                  autoFocus
                  className="flex-1 min-w-0 px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                />
                <button
                  type="button"
                  onClick={() => void submitNewFolder()}
                  disabled={Boolean(busy) || !newFolderName.trim()}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-700 transition-colors cursor-pointer disabled:opacity-50 shrink-0"
                >
                  {busy === 'creating-folder' ? 'Creating...' : 'Create'}
                </button>
                <button
                  type="button"
                  onClick={() => setNewFolderOpen(false)}
                  disabled={Boolean(busy)}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-slate-300 text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer disabled:opacity-50 shrink-0"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          <p className="text-xs text-slate-600">
            {willReplace
              ? `Replaces the copy of this room you saved earlier in ${folder.name}.`
              : `Saves a new file in ${folder.name}.`}
          </p>
          {error && <p className="text-xs text-red-600 font-medium">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={Boolean(busy)}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-brand-600 text-white hover:bg-brand-500 transition-colors cursor-pointer disabled:opacity-60"
          >
            {busy === 'saving' ? 'Saving...' : willReplace ? 'Replace' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
