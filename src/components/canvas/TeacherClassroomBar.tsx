import {
  BookMarked,
  BookOpen,
  Columns,
  FileSpreadsheet,
  HardDrive,
  ImagePlus,
  LayoutGrid,
  LayoutTemplate,
  Lock,
  MousePointer2,
  Move,
  Pause,
  Play,
  RotateCcw,
  Rows,
  Timer,
  Trash2,
  Unlock,
  Upload,
  Users,
} from 'lucide-react';
import React from 'react';
import { isPreparedRound } from '../../lib/breakoutRounds';
import { isGoogleDriveConfigured } from '../../lib/googleConfig';
import type { SelectionAuthor } from '../../lib/selectionAuthors';
import { cn } from '../../lib/utils';
import { WORKSHEET_SCALE_OPTIONS } from '../../lib/worksheetLoader';
import type { BreakoutRoundMeta } from '../../types';
import {
  BreakoutConfig,
  CanvasElement,
  ClassroomTimerState,
  ConfigureBreakoutPayload,
  RoomBackground,
  SubBoardData,
  TimerControlPayload,
  ToolType,
} from '../../types';
import { type LessonRequest } from '../LessonPackModals';
import { useClassWorkFiles } from '../useClassWorkFiles';
import { formatTimerMs, parseCustomTimeSeconds } from './canvasHelpers';

interface Props {
  isTeacher: boolean;
  toolbarCollapsed: boolean;
  handleOpenBreakoutModal: () => void;
  breakoutConfig: BreakoutConfig;
  activeRoundBoards: SubBoardData[];
  onConfigureBreakout: (
    payload: ConfigureBreakoutPayload
  ) => Promise<{ ok: boolean; error?: string; roundId?: string }>;
  viewingRound: BreakoutRoundMeta;
  setTeacherViewingRoundId: React.Dispatch<React.SetStateAction<string>>;
  activeRound: BreakoutRoundMeta;
  subBoards: Record<string, SubBoardData>;
  rounds: BreakoutRoundMeta[];
  effectiveViewingRoundId: string;
  activeBoardId: string;
  onSelectBoard: (boardId: string) => void;
  setShowLiveGridOverview: React.Dispatch<React.SetStateAction<boolean>>;
  fullMainElements: CanvasElement[];
  teacherVisibleBoards: SubBoardData[];
  roundShortLabel: (roundId?: string) => string;
  activeBoardTitle: string;
  showLiveGridOverview: boolean;
  pdfExportProgress: { current: number; total: number };
  handleBatchExportAllPdf: () => Promise<void>;
  timerMenuRef: React.RefObject<HTMLDivElement>;
  setShowTimerMenu: React.Dispatch<React.SetStateAction<boolean>>;
  timer: ClassroomTimerState;
  displayRemainingMs: number;
  showTimerMenu: boolean;
  onTeacherTimerControl: (payload: TimerControlPayload) => void;
  customTimeInput: string;
  setCustomTimeInput: React.Dispatch<React.SetStateAction<string>>;
  setShowTemplateModal: React.Dispatch<React.SetStateAction<boolean>>;
  isUploadingWorksheet: boolean;
  worksheetInputRef: React.RefObject<HTMLInputElement>;
  background: RoomBackground;
  driveBusy: string;
  handleWorksheetFromDrive: () => Promise<void>;
  driveCanCancel: boolean;
  handleCancelDriveImport: () => void;
  worksheetImportScale: number;
  handleUpdateWorksheetImportScale: (next: number) => void;
  setTool: React.Dispatch<React.SetStateAction<ToolType>>;
  tool: ToolType;
  effectiveTool: ToolType;
  onTeacherUpdateBackground: (patch: Partial<RoomBackground>) => void;
  elements: CanvasElement[];
  confirmRemoveWorksheet: boolean;
  setConfirmRemoveWorksheet: React.Dispatch<React.SetStateAction<boolean>>;
  removeWorksheetTimerRef: React.RefObject<NodeJS.Timeout>;
  onTeacherSetBackground: (bg: RoomBackground | null) => Promise<{ ok: boolean; error?: string }>;
  worksheetError: string;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onTeacherLessonRequest: LessonRequest;
  setLessonModal: React.Dispatch<React.SetStateAction<'save' | 'load'>>;
  classWork: ReturnType<typeof useClassWorkFiles>;
  onTeacherToggleLock: (locked: boolean) => void;
  isCanvasLocked: boolean;
  onTeacherToggleHideCursors: (hide: boolean) => void;
  hideStudentCursors: boolean;
  onTeacherToggleOneNameStamp: (enabled: boolean) => void;
  oneNameStamp: boolean;
  focusedInkAuthor: string;
  setInkFocusKey: React.Dispatch<React.SetStateAction<string>>;
  boardInkAuthors: SelectionAuthor[];
  confirmClearAll: boolean;
  onTeacherClearAll: () => void;
  setConfirmClearAll: React.Dispatch<React.SetStateAction<boolean>>;
  onAssignUserToBoard: (targetBoardId: string, targetUserId?: string) => void;
}
export function TeacherClassroomBar({
  isTeacher,
  toolbarCollapsed,
  handleOpenBreakoutModal,
  breakoutConfig,
  activeRoundBoards,
  onConfigureBreakout,
  viewingRound,
  setTeacherViewingRoundId,
  activeRound,
  subBoards,
  rounds,
  effectiveViewingRoundId,
  activeBoardId,
  onSelectBoard,
  setShowLiveGridOverview,
  fullMainElements,
  teacherVisibleBoards,
  roundShortLabel,
  activeBoardTitle,
  showLiveGridOverview,
  pdfExportProgress,
  handleBatchExportAllPdf,
  timerMenuRef,
  setShowTimerMenu,
  timer,
  displayRemainingMs,
  showTimerMenu,
  onTeacherTimerControl,
  customTimeInput,
  setCustomTimeInput,
  setShowTemplateModal,
  isUploadingWorksheet,
  worksheetInputRef,
  background,
  driveBusy,
  handleWorksheetFromDrive,
  driveCanCancel,
  handleCancelDriveImport,
  worksheetImportScale,
  handleUpdateWorksheetImportScale,
  setTool,
  tool,
  effectiveTool,
  onTeacherUpdateBackground,
  elements,
  confirmRemoveWorksheet,
  setConfirmRemoveWorksheet,
  removeWorksheetTimerRef,
  onTeacherSetBackground,
  worksheetError,
  fileInputRef,
  onTeacherLessonRequest,
  setLessonModal,
  classWork,
  onTeacherToggleLock,
  isCanvasLocked,
  onTeacherToggleHideCursors,
  hideStudentCursors,
  onTeacherToggleOneNameStamp,
  oneNameStamp,
  focusedInkAuthor,
  setInkFocusKey,
  boardInkAuthors,
  confirmClearAll,
  onTeacherClearAll,
  setConfirmClearAll,
  onAssignUserToBoard,
}: Props) {
  return (
    <>
      {isTeacher ? (
        <div
          className={cn(
            'oh-teacher-bar px-4 py-2 border-b border-amber-300/90 flex flex-wrap items-center justify-between gap-3 z-10',
            toolbarCollapsed && 'hidden'
          )}
        >
          <div className="flex flex-wrap items-center gap-2 text-xs text-amber-900">
            <span className="font-display font-semibold">Teacher</span>

            {/* Breakout / Individual Mode Launcher */}
            <button
              type="button"
              onClick={handleOpenBreakoutModal}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-[2px] border text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer',
                breakoutConfig.mode !== 'main'
                  ? 'oh-btn-primary text-white'
                  : breakoutConfig.autoIndividual
                    ? 'oh-btn-emerald text-white'
                    : 'oh-btn text-slate-800'
              )}
              title="Assign individual student boards or breakout group rooms"
            >
              <Users size={13} />
              <span>
                {breakoutConfig.mode === 'individual'
                  ? `Individual Boards (${activeRoundBoards.length})`
                  : breakoutConfig.mode === 'groups'
                    ? `Breakout Groups (${activeRoundBoards.length})`
                    : breakoutConfig.autoIndividual
                      ? 'Breakouts · Students → Own Boards'
                      : 'Breakouts / Individual'}
              </span>
            </button>

            {breakoutConfig.mode !== 'main' && (
              <button
                type="button"
                onClick={() => onConfigureBreakout({ action: 'return-to-main' })}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-[2px] border oh-btn text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer text-slate-800"
                title="Pull every student back to the Main Board. Their breakout work is kept."
              >
                Bring All to Main
              </button>
            )}
            {viewingRound && (breakoutConfig.mode === 'main' || viewingRound.id !== breakoutConfig.activeRoundId) && (
              <button
                type="button"
                onClick={() => {
                  onConfigureBreakout({ action: 'resume', roundId: viewingRound.id });
                  setTeacherViewingRoundId(null);
                }}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-[2px] border oh-btn-active text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer text-brand-900"
                title={`Send students to ${viewingRound.title} with their work intact`}
              >
                {breakoutConfig.mode === 'main' && viewingRound.id === activeRound?.id
                  ? `Resume Round ${viewingRound.number}`
                  : `Send Class to Round ${viewingRound.number}`}
              </button>
            )}

            {/* Teacher Board Switcher Dropdown + Live Grid Overview Button */}
            {Object.keys(subBoards).length > 0 && (
              <div className="flex items-center gap-1.5 bg-white px-2 py-0.5 rounded-[2px] border border-[#CBD5E1]">
                {(rounds.length > 1 || (viewingRound && isPreparedRound(viewingRound))) && (
                  <>
                    <span className="text-[11px] text-slate-500">Round:</span>
                    <select
                      aria-label="Breakout round to view"
                      value={effectiveViewingRoundId ?? ''}
                      onChange={(e) => {
                        const v = e.target.value;
                        setTeacherViewingRoundId(v === breakoutConfig.activeRoundId ? null : v);
                      }}
                      className="text-xs font-semibold text-slate-900 bg-transparent focus:outline-none cursor-pointer pr-1"
                    >
                      {rounds.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.title}
                          {r.id === breakoutConfig.activeRoundId ? ' (live)' : ''}
                        </option>
                      ))}
                      {viewingRound && isPreparedRound(viewingRound) && (
                        <option value={viewingRound.id}>{viewingRound.title} (prepared)</option>
                      )}
                      <option value="all">All Rounds</option>
                    </select>
                    <span className="text-slate-300" aria-hidden="true">
                      |
                    </span>
                  </>
                )}
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
                  {activeBoardId !== 'main' && !teacherVisibleBoards.some((sb) => sb.id === activeBoardId) && (
                    <option value={activeBoardId}>
                      {roundShortLabel(subBoards[activeBoardId]?.roundId)} · {activeBoardTitle}
                    </option>
                  )}
                  {teacherVisibleBoards.map((sb) => (
                    <option key={sb.id} value={sb.id}>
                      {effectiveViewingRoundId === 'all' ? `${roundShortLabel(sb.roundId)} · ` : ''}
                      {sb.title} ({sb.elements.length} items)
                    </option>
                  ))}
                </select>

                <span className="text-slate-300" aria-hidden="true">
                  |
                </span>

                <button
                  type="button"
                  onClick={() => setShowLiveGridOverview(!showLiveGridOverview)}
                  className={cn(
                    'flex items-center gap-1 px-2 py-0.5 rounded-[2px] border text-[11px] font-semibold transition-colors cursor-pointer whitespace-nowrap',
                    showLiveGridOverview
                      ? 'oh-btn-primary text-white'
                      : 'border-transparent text-brand-700 hover:bg-brand-50'
                  )}
                  title="View live miniature previews of all student and group boards at once"
                >
                  <LayoutGrid size={12} />
                  <span>{showLiveGridOverview ? 'Close Grid' : 'Live Grid View'}</span>
                </button>

                <span className="text-slate-300" aria-hidden="true">
                  |
                </span>

                <button
                  type="button"
                  disabled={Boolean(pdfExportProgress)}
                  onClick={handleBatchExportAllPdf}
                  className="flex items-center gap-1 px-2 py-0.5 rounded-[2px] text-[11px] font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
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
                  'flex items-center gap-1.5 px-2.5 py-1 rounded-[2px] text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer border',
                  timer?.isRunning
                    ? displayRemainingMs <= 60000
                      ? 'oh-btn-danger text-white animate-pulse'
                      : 'oh-btn-dark text-amber-300'
                    : displayRemainingMs > 0
                      ? 'bg-amber-200 text-slate-900 border-amber-400'
                      : 'oh-btn text-slate-800'
                )}
                title="Start, pause, or configure the synchronized classroom countdown timer"
              >
                <Timer size={13} className={timer?.isRunning ? 'text-amber-300' : 'text-amber-600'} />
                <span className="font-mono tabular-nums">
                  {timer?.isRunning || displayRemainingMs > 0
                    ? `${formatTimerMs(displayRemainingMs)}${!timer?.isRunning ? ' (Paused)' : ''}`
                    : 'Timer'}
                </span>
              </button>

              {showTimerMenu && (
                <div className="absolute left-0 top-full mt-1.5 z-50 w-72 rounded-[3px] bg-white border-2 border-[#CBD5E1] overflow-hidden text-slate-800 select-text">
                  <div className="oh-panel-header flex items-center justify-between px-3.5 py-2 border-b border-[#CBD5E1]">
                    <span className="font-display font-bold text-xs text-slate-900">Classroom Countdown Timer</span>
                    {(timer?.isRunning || displayRemainingMs > 0) && (
                      <span className="font-mono tabular-nums text-xs font-bold text-brand-600">
                        {formatTimerMs(displayRemainingMs)}
                      </span>
                    )}
                  </div>

                  <div className="p-3.5 space-y-3">
                    {/* Default Preset Buttons: 5, 10, 20, 30 minutes */}
                    <div>
                      <span className="block text-[11px] font-medium text-slate-500 mb-1.5">Quick Start Presets:</span>
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
                            className="py-1.5 px-2 rounded-[2px] border oh-btn text-xs font-mono font-semibold text-slate-800 hover:text-brand-700 transition-colors cursor-pointer"
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
                        Exact Time (e.g. <span className="font-mono">7:30</span> or minutes like{' '}
                        <span className="font-mono">12</span>):
                      </label>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={customTimeInput}
                          onChange={(e) => setCustomTimeInput(e.target.value)}
                          placeholder="e.g. 7:30 or 15"
                          className="flex-1 px-2.5 py-1.5 text-xs font-mono border border-[#CBD5E1] rounded-[2px] focus:outline-none focus:border-brand-600"
                        />
                        <button
                          type="submit"
                          disabled={!parseCustomTimeSeconds(customTimeInput)}
                          className="px-3 py-1.5 rounded-[2px] border oh-btn-primary text-xs font-semibold text-white disabled:opacity-40 cursor-pointer whitespace-nowrap"
                        >
                          Start
                        </button>
                      </div>
                    </form>

                    {/* Active Timer Controls (Pause/Resume, +1m, Stop) */}
                    {(timer?.isRunning || displayRemainingMs > 0) && (
                      <div className="flex items-center gap-1.5 pt-2 border-t border-slate-200">
                        {timer?.isRunning ? (
                          <button
                            type="button"
                            onClick={() => onTeacherTimerControl({ action: 'pause' })}
                            className="flex-1 flex items-center justify-center gap-1 py-1.5 px-2 rounded-[2px] border border-amber-300 bg-amber-100 text-amber-900 hover:bg-amber-200 text-xs font-semibold cursor-pointer"
                          >
                            <Pause size={12} />
                            <span>Pause</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onTeacherTimerControl({ action: 'resume' })}
                            className="flex-1 flex items-center justify-center gap-1 py-1.5 px-2 rounded-[2px] border oh-btn-emerald text-xs font-semibold text-white cursor-pointer"
                          >
                            <Play size={12} />
                            <span>Resume</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => onTeacherTimerControl({ action: 'add-minute' })}
                          className="py-1.5 px-2.5 rounded-[2px] border oh-btn text-xs font-mono font-semibold text-slate-700 cursor-pointer"
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
                          className="flex items-center justify-center gap-1 py-1.5 px-2.5 rounded-[2px] border border-red-200 bg-red-50 text-red-600 hover:bg-red-100 text-xs font-semibold cursor-pointer"
                          title="Stop and clear timer"
                        >
                          <RotateCcw size={12} />
                          <span>Stop</span>
                        </button>
                      </div>
                    )}

                    {/* Auto-Lock on Expire Option */}
                    <label className="flex items-center gap-2 pt-2 border-t border-slate-200 text-xs text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(timer?.autoLockOnExpire)}
                        onChange={(e) =>
                          onTeacherTimerControl({
                            action: 'set-autolock',
                            autoLockOnExpire: e.target.checked,
                          })
                        }
                        className="rounded-[2px] border-[#CBD5E1] text-brand-600 focus:ring-brand-500"
                      />
                      <span>Auto-lock board when time expires</span>
                    </label>
                  </div>
                </div>
              )}
            </div>

            <span aria-hidden="true">·</span>

            {/* Built-In Worksheet Templates Button */}
            <button
              type="button"
              onClick={() => setShowTemplateModal(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-[2px] border oh-btn text-xs font-medium text-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
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
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-[2px] border oh-btn text-xs font-medium text-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              title="Upload a .jpg, .png, or multi-page .pdf worksheet as a non-erasable background"
            >
              <ImagePlus size={13} className="text-brand-600" />
              <span>
                {isUploadingWorksheet ? 'Rendering...' : background ? 'Upload Custom' : 'Upload (.JPG / .PNG / .PDF)'}
              </span>
            </button>

            {isGoogleDriveConfigured() && (
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  disabled={isUploadingWorksheet || Boolean(driveBusy)}
                  onClick={handleWorksheetFromDrive}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-[2px] border oh-btn text-xs font-medium text-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                  title="Import a Google Slides deck or PDF from your Google Drive as a worksheet"
                >
                  <HardDrive size={13} className="text-emerald-600" />
                  <span>{driveBusy || 'Slides / PDF from Drive'}</span>
                </button>
                {driveCanCancel && (
                  <button
                    type="button"
                    onClick={handleCancelDriveImport}
                    className="text-xs font-medium text-amber-900 underline hover:text-red-700 cursor-pointer whitespace-nowrap"
                  >
                    Cancel
                  </button>
                )}
              </div>
            )}

            {/* Import Size Multiplier Selector (0.5x to 3x, default 2x) */}
            <label
              className="flex items-center gap-1 px-2 py-0.5 rounded-[2px] bg-white border border-[#b6c2d2] text-xs text-slate-700 shrink-0"
              title="Set the size at which PDFs, Google Slides, PowerPoint decks, and images are imported onto the board (default 2x so standard pen and text sizes feel natural)"
            >
              <span className="text-[11px] font-medium text-slate-500">Import Size:</span>
              <select
                aria-label="Worksheet import size"
                value={String(worksheetImportScale)}
                onChange={(e) => handleUpdateWorksheetImportScale(Number(e.target.value))}
                className="font-mono font-semibold text-xs text-slate-900 bg-transparent focus:outline-none cursor-pointer"
              >
                {WORKSHEET_SCALE_OPTIONS.map((mult) => (
                  <option key={mult} value={String(mult)}>
                    {mult}&times;
                  </option>
                ))}
              </select>
            </label>

            {/* Active Background Worksheet Controls */}
            {background && (
              <div className="flex items-center gap-1.5 bg-white px-2 py-0.5 rounded-[2px] border border-[#b6c2d2] text-xs text-slate-700">
                <button
                  type="button"
                  onClick={() => setTool(tool === 'move-bg' ? 'solid' : 'move-bg')}
                  className={cn(
                    'flex items-center gap-1 px-1.5 py-0.5 rounded-[2px] border text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap',
                    effectiveTool === 'move-bg'
                      ? 'oh-btn-primary text-white'
                      : 'border-transparent hover:bg-slate-100 text-slate-700'
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
                    className="px-1.5 py-0.5 rounded-[2px] hover:bg-slate-100 font-mono text-xs cursor-pointer"
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
                    className="px-1.5 py-0.5 rounded-[2px] hover:bg-slate-100 font-mono text-xs cursor-pointer"
                    title="Enlarge worksheet"
                  >
                    +
                  </button>
                </div>

                {background.pages.length > 1 && (
                  <>
                    <span className="text-slate-300" aria-hidden="true">
                      |
                    </span>
                    <div className="flex items-center gap-1" role="group" aria-label="Worksheet page layout">
                      <span className="text-[11px] font-medium text-slate-500">Layout:</span>
                      <div className="flex items-center bg-slate-100 rounded-[2px] p-0.5 border border-[#CBD5E1]">
                        {(
                          [
                            { value: 'row', label: 'Row', title: 'Pages side by side', Icon: Columns },
                            { value: 'stack', label: 'Column', title: 'Pages top to bottom', Icon: Rows },
                            { value: 'grid', label: 'Grid', title: 'Pages in a grid', Icon: LayoutGrid },
                          ] as const
                        ).map(({ value, label, title, Icon }) => {
                          const activeLayout =
                            background.layout === 'stack' || background.layout === 'grid' ? background.layout : 'row';
                          const isActive = activeLayout === value;
                          return (
                            <button
                              key={value}
                              type="button"
                              aria-pressed={isActive}
                              title={title}
                              onClick={() => {
                                if (isActive) return;
                                const hasInkOrStamps = elements.some((el) => el.tool !== 'eraser');
                                if (
                                  hasInkOrStamps &&
                                  !window.confirm(
                                    'Changing the layout moves the pages but not the ink already on them. Continue?'
                                  )
                                ) {
                                  return;
                                }
                                onTeacherUpdateBackground({ layout: value });
                              }}
                              className={cn(
                                'flex items-center gap-1 px-1.5 py-0.5 rounded-[2px] border text-[11px] font-medium transition-colors cursor-pointer whitespace-nowrap',
                                isActive
                                  ? 'oh-btn-active text-brand-800'
                                  : 'border-transparent text-slate-600 hover:text-slate-900'
                              )}
                            >
                              <Icon size={11} />
                              <span>{label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </>
                )}

                <span className="text-slate-300" aria-hidden="true">
                  |
                </span>

                <button
                  type="button"
                  onClick={() => {
                    if (!confirmRemoveWorksheet) {
                      setConfirmRemoveWorksheet(true);
                      if (removeWorksheetTimerRef.current) {
                        clearTimeout(removeWorksheetTimerRef.current);
                      }
                      removeWorksheetTimerRef.current = setTimeout(() => {
                        setConfirmRemoveWorksheet(false);
                        removeWorksheetTimerRef.current = null;
                      }, 3000);
                      return;
                    }
                    if (removeWorksheetTimerRef.current) {
                      clearTimeout(removeWorksheetTimerRef.current);
                      removeWorksheetTimerRef.current = null;
                    }
                    setConfirmRemoveWorksheet(false);
                    onTeacherSetBackground(null);
                    if (tool === 'move-bg') setTool('solid');
                  }}
                  className={cn(
                    'px-1.5 py-0.5 rounded-[2px] text-[11px] cursor-pointer whitespace-nowrap transition-colors',
                    confirmRemoveWorksheet
                      ? 'bg-red-50 text-red-700 font-bold'
                      : 'text-red-600 hover:bg-red-50 font-medium'
                  )}
                  title="Remove background worksheet from this board. Ink stays."
                >
                  {confirmRemoveWorksheet ? 'Tap again to remove' : 'Remove worksheet'}
                </button>
              </div>
            )}

            {worksheetError && <span className="text-xs text-red-600 font-medium">{worksheetError}</span>}
          </div>

          {/* Wraps: without it, anything past the right edge (Ink by, Clear Ink on a 1366 px Chromebook) was cut off. */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 px-3 py-1 rounded-[2px] border oh-btn text-xs font-medium text-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              title="Open a .json file made with Save class work: every student's board, the worksheets and the chat log"
            >
              <Upload size={13} />
              <span>Open class work</span>
            </button>

            {onTeacherLessonRequest && (
              <button
                type="button"
                onClick={() => setLessonModal('save')}
                className="flex items-center gap-1.5 px-3 py-1 rounded-[2px] border oh-btn text-xs font-medium text-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                title="Save this lesson (worksheets, your ink, breakout rounds and settings, no student work) as a .allaboard file"
              >
                <BookMarked size={13} />
                <span>Save lesson…</span>
              </button>
            )}

            {onTeacherLessonRequest && (
              <button
                type="button"
                onClick={() => setLessonModal('load')}
                className="flex items-center gap-1.5 px-3 py-1 rounded-[2px] border oh-btn text-xs font-medium text-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                title="Set up a saved .allaboard lesson in a new room or this one"
              >
                <BookOpen size={13} />
                <span>Load lesson…</span>
              </button>
            )}

            {isGoogleDriveConfigured() && (
              <>
                <button
                  type="button"
                  disabled={classWork.driveOpening}
                  onClick={classWork.handleOpenFromDrive}
                  className="flex items-center gap-1.5 px-3 py-1 rounded-[2px] border oh-btn text-xs font-medium text-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                  title="Open a room you saved to Google Drive"
                >
                  <HardDrive size={13} className="text-emerald-600" />
                  <span>{classWork.driveOpening ? 'Opening...' : 'Open Room from Drive'}</span>
                </button>
                <button
                  type="button"
                  onClick={classWork.handleSaveToDrive}
                  className="flex items-center gap-1.5 px-3 py-1 rounded-[2px] border oh-btn text-xs font-medium text-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  title="Save this room (drawings, chat, worksheets and breakout boards) to your Google Drive"
                >
                  <HardDrive size={13} className="text-emerald-600" />
                  <span>Save Room to Drive</span>
                </button>
                {classWork.driveOpenError && (
                  <span className="text-xs text-red-600 font-medium">{classWork.driveOpenError}</span>
                )}
                {classWork.driveNotice && (
                  <span
                    className={cn(
                      'text-xs whitespace-nowrap',
                      classWork.driveNotice.isError ? 'text-red-600 font-medium' : 'text-slate-500'
                    )}
                  >
                    {classWork.driveNotice.text}
                  </span>
                )}
                {classWork.driveAccount && (
                  <span className="text-xs text-slate-500 whitespace-nowrap" data-testid="drive-account-chip">
                    Drive: {classWork.driveAccount.email} ·{' '}
                    <button
                      type="button"
                      onClick={() => void classWork.handleSwitchDriveAccount()}
                      className="text-indigo-600 hover:text-indigo-700 hover:underline font-medium cursor-pointer"
                    >
                      Switch
                    </button>
                  </span>
                )}
              </>
            )}

            <button
              type="button"
              onClick={() => onTeacherToggleLock(!isCanvasLocked)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1 rounded-[2px] border text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer',
                isCanvasLocked ? 'oh-btn-amber text-white' : 'oh-btn text-amber-900'
              )}
            >
              {isCanvasLocked ? <Unlock size={13} /> : <Lock size={13} />}
              <span>{isCanvasLocked ? 'Unlock Board' : 'Lock Board'}</span>
            </button>

            <button
              type="button"
              onClick={() => onTeacherToggleHideCursors(!hideStudentCursors)}
              aria-pressed={hideStudentCursors}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1 rounded-[2px] border text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer',
                hideStudentCursors ? 'oh-btn-amber text-white' : 'oh-btn text-amber-900'
              )}
            >
              <MousePointer2 size={13} />
              <span>{hideStudentCursors ? 'Show Student Cursors' : 'Hide Student Cursors'}</span>
            </button>

            <button
              type="button"
              onClick={() => onTeacherToggleOneNameStamp(!oneNameStamp)}
              aria-pressed={oneNameStamp}
              title="Limit each student to one name stamp per board. They can still drag or delete it."
              className={cn(
                'flex items-center gap-1.5 px-3 py-1 rounded-[2px] border text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer',
                oneNameStamp ? 'oh-btn-amber text-white' : 'oh-btn text-amber-900'
              )}
            >
              <span>One Name Stamp: {oneNameStamp ? 'On' : 'Off'}</span>
            </button>

            <label
              className={cn(
                'flex items-center gap-1 px-2 py-0.5 rounded-[2px] border text-xs shrink-0',
                focusedInkAuthor ? 'oh-btn-amber text-white' : 'bg-white border-[#b6c2d2] text-amber-900'
              )}
              title="Fade everyone else's ink on your screen. Students and exports are not affected."
            >
              <span className="font-medium whitespace-nowrap">Ink by:</span>
              <select
                aria-label="Focus ink by student"
                value={focusedInkAuthor ?? ''}
                onChange={(e) => setInkFocusKey(e.target.value || null)}
                className="max-w-[160px] bg-transparent font-semibold focus:outline-none cursor-pointer"
              >
                <option value="" className="text-slate-900">
                  Everyone
                </option>
                {boardInkAuthors.map((author) => (
                  <option key={author.key} value={author.key} className="text-slate-900">
                    {author.name} ({author.itemCount})
                  </option>
                ))}
              </select>
            </label>

            {confirmClearAll ? (
              <div className="flex items-center gap-1.5 bg-white px-2.5 py-1 rounded-[2px] border border-red-300">
                <span className="text-xs font-medium text-red-700 whitespace-nowrap">
                  Clear ink on {activeBoardTitle}?
                </span>
                <button
                  type="button"
                  onClick={() => {
                    onTeacherClearAll();
                    setConfirmClearAll(false);
                  }}
                  className="px-2 py-0.5 text-xs font-medium oh-btn-danger border text-white rounded-[2px] cursor-pointer whitespace-nowrap"
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
                className="flex items-center gap-1.5 px-3 py-1 rounded-[2px] border oh-btn text-xs font-medium text-red-600 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Trash2 size={13} />
                <span>Clear Ink</span>
              </button>
            )}
          </div>
        </div>
      ) : (
        /* Student Status Banner (Breakout / Individual Board Indicator, Active Timer, or Lock Banner) */
        (breakoutConfig.mode !== 'main' || isCanvasLocked || timer?.isRunning || displayRemainingMs > 0) && (
          <div className="oh-chrome-bar px-4 py-1.5 border-b border-brand-300 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-800 z-10">
            <div className="flex items-center gap-2">
              <span className="font-display font-semibold text-brand-900">Active Board: {activeBoardTitle}</span>
              {breakoutConfig.mode === 'individual' && (
                <span className="text-slate-600">· Personal Individual Assignment</span>
              )}
              {breakoutConfig.mode === 'groups' && <span className="text-slate-600">· Breakout Group Board</span>}
            </div>

            <div className="flex items-center gap-3">
              {(timer?.isRunning || displayRemainingMs > 0) && (
                <span
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-0.5 rounded-[2px] border font-mono tabular-nums font-bold text-xs',
                    timer?.isRunning
                      ? displayRemainingMs <= 60000
                        ? 'bg-red-600 border-red-700 text-white animate-pulse'
                        : 'bg-slate-900 border-[#243044] text-amber-300'
                      : 'bg-amber-200 border-amber-400 text-slate-900'
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
                    className="bg-white border border-brand-300 rounded-[2px] px-2 py-0.5 text-xs font-semibold text-brand-900 cursor-pointer"
                  >
                    {activeRoundBoards
                      .filter((sb) => sb.kind === 'group')
                      .map((sb) => (
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
    </>
  );
}
