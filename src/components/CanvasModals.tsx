import React from 'react';
import {
  BreakoutConfig,
  CanvasElement,
  ChatMessage,
  ImportRestoreMode,
  RoomBackground,
  SubBoardData,
  User,
} from '../types';
import {
  BUILT_IN_TEMPLATES,
  BuiltInTemplateId,
  generateTemplateBackground,
} from '../lib/worksheetLoader';
import { AlertCircle, Check, Download, Shuffle, X } from 'lucide-react';
import { cn } from '../lib/utils';

export interface PendingSnapshotData {
  fileName: string;
  roomId: string;
  exportedAt?: number;
  exportedBy?: string;
  elements: CanvasElement[];
  messages: ChatMessage[];
  background?: RoomBackground | null;
  subBoards?: Record<string, SubBoardData>;
  breakoutConfig?: BreakoutConfig;
}

interface LiveGridOverviewProps {
  activeBoardId: string;
  activeSubBoardList: SubBoardData[];
  subBoards: Record<string, SubBoardData>;
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
  activeSubBoardList,
  subBoards,
  users,
  fullMainElements,
  fullMainBackground,
  pdfExportProgress,
  onBatchExportAllPdf,
  onOpenBreakoutModal,
  onSelectBoard,
  onClose,
}: LiveGridOverviewProps) {
  return (
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
          <div className="flex flex-wrap items-center gap-2">
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
                  : `Export All Boards (.PDF)`}
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
                  onClose();
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
  );
}

interface BreakoutManagerModalProps {
  users: User[];
  fullMainBackground: RoomBackground | null;
  draftBreakoutMode: 'main' | 'individual' | 'groups';
  setDraftBreakoutMode: (mode: 'main' | 'individual' | 'groups') => void;
  draftGroupCount: number;
  setDraftGroupCount: (count: number) => void;
  draftGroups: Array<{ id: string; title: string; assignedUserIds: string[] }>;
  setDraftGroups: React.Dispatch<
    React.SetStateAction<Array<{ id: string; title: string; assignedUserIds: string[] }>>
  >;
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
  onConfigureBreakout: (payload: {
    mode: 'main' | 'individual' | 'groups';
    allowSelfSelect: boolean;
    chatScope: 'unified' | 'board';
    copyWorksheet: boolean;
    customBackground?: RoomBackground | null;
    groups?: Array<{ id: string; title: string; assignedUserIds: string[] }>;
  }) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
  onShowLiveGridOverview: (show: boolean) => void;
}

/**
 * Teacher modal for configuring individual student boards or breakout group rooms.
 */
export function BreakoutManagerModal({
  users,
  fullMainBackground,
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
            onClick={onClose}
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
              onClose();
              if (draftBreakoutMode !== 'main') {
                onShowLiveGridOverview(true);
              } else {
                onShowLiveGridOverview(false);
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
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-500 transition-colors cursor-pointer"
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
              className="px-4 py-2 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-500 disabled:bg-slate-300 transition-colors cursor-pointer"
            >
              {isImporting ? 'Restoring...' : 'Restore Room Snapshot'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
