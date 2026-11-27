import {
  ChevronDown,
  ChevronUp,
  Circle as CircleIcon,
  Crosshair,
  Download,
  Eraser,
  FileJson,
  Hand,
  Highlighter,
  Lasso,
  LifeBuoy,
  Minus,
  PanelLeftOpen,
  PenLine,
  Redo2,
  SlidersHorizontal,
  SprayCan,
  Square,
  Stamp,
  Type,
  Undo2
} from 'lucide-react';
import React from 'react';
import {
  getPaletteColors,
  hlInk
} from '../../lib/inkCore';
import {
  STAMP_OPTIONS,
  TEACHER_STAMP_OPTIONS
} from '../../lib/stamps';
import { cn } from '../../lib/utils';
import {
  CanvasElement,
  HollowShapeKind,
  StampKind,
  StudentStatus,
  ToolType
} from '../../types';
import { useClassWorkFiles } from '../useClassWorkFiles';
import { HOLLOW_SHAPE_OPTIONS, HollowShapeIcon, STATUS_RADIAL_OPTIONS, TEXT_SIZE_DROPDOWN_PRESETS, saveLocal } from './canvasHelpers';


import type { HistoryAction } from './canvasHelpers';
interface Props {
  isChatHidden: boolean;
  onShowChat: () => void;
  unreadChatCount: number;
  roomId: string;
  onReportProblem: () => void;
  isPhone: boolean;
  setPhoneToolsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  phoneToolsOpen: boolean;
  strokeWidth: number;
  tool: ToolType;
  color: string;
  toolbarCollapsed: boolean;
  canDraw: boolean;
  editingNote: { existingId: string | null; worldX: number; worldY: number; value: string; color: string; strokeWidth: number; fontSize: number; openedAt: number; };
  commitEditingNote: () => void;
  performUndo: () => void;
  setTool: React.Dispatch<React.SetStateAction<ToolType>>;
  effectiveTool: ToolType;
  isTeacher: boolean;
  hollowMenuRef: React.RefObject<HTMLDivElement>;
  setShowHollowMenu: React.Dispatch<React.SetStateAction<boolean>>;
  showHollowMenu: boolean;
  hollowShape: HollowShapeKind;
  setHollowShape: React.Dispatch<React.SetStateAction<HollowShapeKind>>;
  hlMenuRef: React.RefObject<HTMLDivElement>;
  isCoverMode: boolean;
  setShowHlMenu: React.Dispatch<React.SetStateAction<boolean>>;
  showHlMenu: boolean;
  setIsCoverMode: React.Dispatch<React.SetStateAction<boolean>>;
  hlColor: string;
  hlStrength: number;
  setHlStrength: React.Dispatch<React.SetStateAction<number>>;
  coverColor: string;
  setCoverColor: React.Dispatch<React.SetStateAction<string>>;
  canLocalUndo: boolean;
  canRedo: boolean;
  performRedo: () => void;
  confirmClearMine: boolean;
  setEditingNote: React.Dispatch<React.SetStateAction<{ existingId: string | null; worldX: number; worldY: number; value: string; color: string; strokeWidth: number; fontSize: number; openedAt: number; }>>;
  elements: CanvasElement[];
  userId: string;
  allGoneNoteIds: Set<string>;
  recordUndo: (action: HistoryAction, boardId?: string) => void;
  setSelectedIds: React.Dispatch<React.SetStateAction<string[]>>;
  onClearMine: () => void;
  setConfirmClearMine: React.Dispatch<React.SetStateAction<boolean>>;
  classWork: ReturnType<typeof useClassWorkFiles>;
  handleExportPNG: () => void;
  statusMenuRef: React.RefObject<HTMLDivElement>;
  setShowStatusMenu: React.Dispatch<React.SetStateAction<boolean>>;
  showStatusMenu: boolean;
  myStatusOption: { readonly label: "Need Help"; readonly className: "bg-amber-100 text-amber-800 border-amber-300"; } | { readonly label: "Got It"; readonly className: "bg-emerald-100 text-emerald-800 border-emerald-300"; } | { readonly label: "Done"; readonly className: "bg-purple-100 text-purple-800 border-purple-300"; };
  myStatus: StudentStatus;
  onSetStatus: (status: StudentStatus) => void;
  setStampKind: React.Dispatch<React.SetStateAction<StampKind>>;
  nameStampTaken: boolean;
  stampKind: StampKind;
  userName: string;
  customTeacherStampText: string;
  setCustomTeacherStampText: React.Dispatch<React.SetStateAction<string>>;
  activeSwatches: { color: string; label: string; }[];
  paletteMode: "pen" | "hl" | "cover";
  handleSelectColor: (nextColor: string) => void;
  customColorInputRef: React.RefObject<HTMLInputElement>;
  handleSelectStrokeWidth: (nextWidth: number) => void;
  hollowWidth: number;
  hollowWeight: number;
  handleSelectHollowWeight: (nextWeight: number) => void;
  textSizeMenuRef: React.RefObject<HTMLDivElement>;
  setShowTextSizeMenu: React.Dispatch<React.SetStateAction<boolean>>;
  showTextSizeMenu: boolean;
  selectedTextElements: CanvasElement[];
  activeTextPreset: { readonly label: "S"; readonly size: 18; readonly title: "Small text (18px)"; } | { readonly label: "M"; readonly size: 26; readonly title: "Medium text (26px)"; } | { readonly label: "L"; readonly size: 38; readonly title: "Large text (38px)"; } | { readonly label: "XL"; readonly size: 54; readonly title: "Extra-large title text (54px)"; } | { readonly label: "XXL"; readonly size: 72; readonly title: "Extra-extra-large text (72px)"; };
  activeTextSize: number;
  handleSelectTextFontSize: (nextSize: number, applyToSelection?: boolean) => void;
  smoothLevel: number;
  setSmoothLevel: React.Dispatch<React.SetStateAction<number>>;
  fingerScrolls: boolean;
  setFingerScrolls: React.Dispatch<React.SetStateAction<boolean>>;
}
export function CanvasToolbar({
  isChatHidden,
  onShowChat,
  unreadChatCount,
  roomId,
  onReportProblem,
  isPhone,
  setPhoneToolsOpen,
  phoneToolsOpen,
  strokeWidth,
  tool,
  color,
  toolbarCollapsed,
  canDraw,
  editingNote,
  commitEditingNote,
  performUndo,
  setTool,
  effectiveTool,
  isTeacher,
  hollowMenuRef,
  setShowHollowMenu,
  showHollowMenu,
  hollowShape,
  setHollowShape,
  hlMenuRef,
  isCoverMode,
  setShowHlMenu,
  showHlMenu,
  setIsCoverMode,
  hlColor,
  hlStrength,
  setHlStrength,
  coverColor,
  setCoverColor,
  canLocalUndo,
  canRedo,
  performRedo,
  confirmClearMine,
  setEditingNote,
  elements,
  userId,
  allGoneNoteIds,
  recordUndo,
  setSelectedIds,
  onClearMine,
  setConfirmClearMine,
  classWork,
  handleExportPNG,
  statusMenuRef,
  setShowStatusMenu,
  showStatusMenu,
  myStatusOption,
  myStatus,
  onSetStatus,
  setStampKind,
  nameStampTaken,
  stampKind,
  userName,
  customTeacherStampText,
  setCustomTeacherStampText,
  activeSwatches,
  paletteMode,
  handleSelectColor,
  customColorInputRef,
  handleSelectStrokeWidth,
  hollowWidth,
  hollowWeight,
  handleSelectHollowWeight,
  textSizeMenuRef,
  setShowTextSizeMenu,
  showTextSizeMenu,
  selectedTextElements,
  activeTextPreset,
  activeTextSize,
  handleSelectTextFontSize,
  smoothLevel,
  setSmoothLevel,
  fingerScrolls,
  setFingerScrolls
}: Props) {
  return (
    <>
      <div
        data-keep-note="true"
        className="oh-chrome-bar px-3 py-1.5 border-b border-[#CBD5E1] flex flex-col gap-1.5 z-20"
      >
        <div className="flex flex-wrap items-center gap-2">
          {isChatHidden && onShowChat && (
            <div className="flex items-center gap-1.5 shrink-0">
              <img
                src="/assets/aistudio/favicon_68cc1684.svg"
                alt="AllAboard"
                referrerPolicy="no-referrer"
                className="w-6 h-6 rounded-[2px] border border-[#CBD5E1] shrink-0 object-contain"
              />
              <button
                type="button"
                onClick={onShowChat}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[2px] border oh-btn text-xs font-semibold text-slate-700 hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                title="Show chat sidebar"
                aria-label="Show chat sidebar"
              >
                <PanelLeftOpen size={15} />
                <span>Chat</span>
                {unreadChatCount > 0 && (
                  <span
                    aria-label={`${unreadChatCount} unread messages`}
                    className="px-1.5 py-0.5 rounded-full bg-brand-600 text-white text-[10px] font-mono tabular-nums leading-none"
                  >
                    {unreadChatCount > 99 ? '99+' : unreadChatCount}
                  </span>
                )}
              </button>
              <span
                data-testid="room-chip"
                className="px-2.5 py-1.5 rounded-[2px] text-xs bg-slate-100 text-slate-700 border border-[#CBD5E1] whitespace-nowrap"
              >
                Room: <span className="font-mono font-semibold text-slate-900">{roomId}</span>
              </span>
              {onReportProblem && (
                <button
                  type="button"
                  onClick={onReportProblem}
                  className="p-1.5 rounded-[2px] border oh-btn text-slate-600 hover:text-slate-900 transition-colors cursor-pointer shrink-0"
                  title="Something not working? Report a problem"
                  aria-label="Something not working?"
                >
                  <LifeBuoy size={15} />
                </button>
              )}
            </div>
          )}

          {/* Phone-only: Tools toggle (showing the current ink) and Undo, which is the one action worth keeping one tap away. */}
          {isPhone && (
            <div className="flex items-center gap-1.5" data-testid="phone-toolbar">
              <button
                type="button"
                onClick={() => setPhoneToolsOpen((open) => !open)}
                aria-expanded={phoneToolsOpen}
                aria-label={phoneToolsOpen ? 'Hide tools' : 'Show tools'}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1.5 rounded-[2px] text-xs font-semibold border transition-colors cursor-pointer',
                  phoneToolsOpen
                    ? 'oh-btn text-slate-700'
                    : 'oh-btn-primary text-white'
                )}
              >
                {phoneToolsOpen ? <ChevronUp size={15} /> : <SlidersHorizontal size={15} />}
                <span>{phoneToolsOpen ? 'Done' : 'Tools'}</span>
                {!phoneToolsOpen && (
                  <span
                    aria-hidden="true"
                    className="rounded-full ring-2 ring-white"
                    style={{
                      width: Math.max(6, Math.min(14, Math.round(strokeWidth * 0.3))),
                      height: Math.max(6, Math.min(14, Math.round(strokeWidth * 0.3))),
                      backgroundColor: tool === 'eraser' ? '#fff' : color,
                    }}
                  />
                )}
              </button>
              {toolbarCollapsed && (
                <button
                  type="button"
                  disabled={!canDraw}
                  onClick={() => {
                    if (editingNote) commitEditingNote();
                    performUndo();
                  }}
                  className="flex items-center gap-1 px-2 py-1.5 text-xs font-medium oh-btn border text-slate-700 rounded-[2px] transition-colors whitespace-nowrap cursor-pointer disabled:opacity-40"
                  aria-label="Undo"
                >
                  <Undo2 size={15} />
                  <span>Undo</span>
                </button>
              )}
            </div>
          )}

          {/* Everything below folds away on phones until "Tools" is tapped. `contents` keeps the wrapping layout as is. */}
          <div className={toolbarCollapsed ? 'hidden' : 'contents'}>

            {/* Navigation & Brush Tools (wraps on narrow screens instead of cutting tools off) */}
            <div className="flex flex-wrap items-center gap-0.5 bg-slate-100 p-0.5 rounded-[3px] border border-[#CBD5E1]">
              <button
                type="button"
                onClick={() => setTool('pan')}
                className={cn(
                  "p-1.5 rounded-[2px] border transition-colors cursor-pointer",
                  effectiveTool === 'pan'
                    ? "oh-btn-active text-brand-700"
                    : "border-transparent text-slate-600 hover:text-slate-900 hover:bg-white/70"
                )}
                title="Pan Tool [H] (or hold Spacebar + Drag, or use Arrow Keys)"
              >
                <Hand size={17} />
              </button>

              <button
                type="button"
                disabled={!canDraw}
                onClick={() => setTool('select')}
                aria-label="Select"
                className={cn(
                  "p-1.5 2xl:px-2 rounded-[2px] border transition-colors cursor-pointer disabled:opacity-40 flex items-center gap-1 text-xs font-semibold",
                  effectiveTool === 'select'
                    ? "oh-btn-active text-indigo-700"
                    : "border-transparent text-slate-600 hover:text-slate-900 hover:bg-white/70"
                )}
                title="Select & Lasso Tool [V]: Tap or circle annotations and text to move, resize, restyle, copy, duplicate, or delete"
              >
                <Lasso size={16} />
                <span className="hidden 2xl:inline">Select</span>
              </button>

              {isTeacher && (
                <button type="button" title="Laser pointer" aria-label="Laser pointer" aria-pressed={effectiveTool === 'laser'}
                  onClick={() => setTool('laser')}
                  className={cn("p-1.5 rounded-[2px] border transition-colors cursor-pointer", effectiveTool === 'laser' ? "oh-btn-active text-red-600" : "border-transparent text-slate-600 hover:text-red-600 hover:bg-white/70")}>
                  <Crosshair size={17} />
                </button>
              )}

              <div className="h-4 w-px bg-slate-300 mx-0.5" />

              <button
                type="button"
                disabled={!canDraw}
                onClick={() => setTool('solid')}
                className={cn(
                  "p-1.5 rounded-[2px] border transition-colors cursor-pointer disabled:opacity-40",
                  tool === 'solid' && effectiveTool !== 'pan'
                    ? "oh-btn-active text-brand-700"
                    : "border-transparent text-slate-600 hover:text-slate-900 hover:bg-white/70"
                )}
                title="Pen [P]"
                aria-label="Pen"
              >
                <PenLine size={17} />
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
                    "p-1.5 rounded-[2px] border transition-colors cursor-pointer disabled:opacity-40 flex items-center justify-center",
                    tool === 'hollow' && effectiveTool !== 'pan'
                      ? "oh-btn-active text-brand-700"
                      : "border-transparent text-slate-600 hover:text-slate-900 hover:bg-white/70"
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
                      className="overflow-visible pointer-events-none"
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
                            "pointer-events-auto w-8 h-8 rounded-full flex items-center justify-center transition-all cursor-pointer border",
                            isActive
                              ? "bg-brand-600 text-white border-white scale-110 ring-2 ring-brand-300"
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
                  "p-1.5 rounded-[2px] border transition-colors cursor-pointer disabled:opacity-40",
                  tool === 'spray' && effectiveTool !== 'pan'
                    ? "oh-btn-active text-brand-700"
                    : "border-transparent text-slate-600 hover:text-slate-900 hover:bg-white/70"
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
                    "px-2 py-1.5 rounded-l-[2px] border-y border-l transition-colors cursor-pointer disabled:opacity-40 flex items-center gap-1 text-xs font-semibold",
                    tool === 'highlighter' && effectiveTool !== 'pan'
                      ? isCoverMode
                        ? "bg-slate-800 border-slate-900 text-white"
                        : "bg-amber-200 border-amber-400 text-slate-900"
                      : "border-transparent text-slate-600 hover:text-slate-900 hover:bg-white/70"
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
                    "px-1 py-1.5 rounded-r-[2px] border transition-colors cursor-pointer disabled:opacity-40",
                    showHlMenu || (tool === 'highlighter' && effectiveTool !== 'pan')
                      ? isCoverMode
                        ? "bg-slate-700 border-slate-900 text-white"
                        : "bg-amber-300/80 border-amber-400 text-slate-900"
                      : "border-transparent border-l-slate-300/70 text-slate-500 hover:text-slate-900 hover:bg-white/70"
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
                    className="absolute left-0 top-full mt-1.5 z-50 w-64 p-3 rounded-[3px] bg-slate-900 text-white border-2 border-[#243044] space-y-2.5"
                  >
                    <div className="grid grid-cols-2 gap-1 bg-slate-800 border border-[#243044] p-0.5 rounded-[2px]">
                      <button
                        type="button"
                        onClick={() => {
                          setIsCoverMode(false);
                          setTool('highlighter');
                        }}
                        className={cn(
                          "px-2 py-1.5 rounded-[2px] text-xs font-semibold transition-colors cursor-pointer",
                          !isCoverMode
                            ? "bg-amber-400 text-slate-950"
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
                          "px-2 py-1.5 rounded-[2px] text-xs font-semibold transition-colors cursor-pointer",
                          isCoverMode
                            ? "bg-white text-slate-950"
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
                            className="w-6 h-6 rounded-[2px] border-2 border-white shrink-0"
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
                            className="w-full h-2 rounded-full appearance-none cursor-pointer accent-amber-400"
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
                            className="w-6 h-6 rounded-[2px] border-2 border-white shrink-0"
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
                  "p-1.5 rounded-[2px] border transition-colors cursor-pointer disabled:opacity-40",
                  tool === 'eraser' && effectiveTool !== 'pan'
                    ? "oh-btn-eraser-active"
                    : "oh-btn-eraser"
                )}
                title="Personal Eraser [E] (Erases your own ink, highlights, and whole text notes — SMART Board palm always erases)"
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
                  "p-1.5 rounded-[2px] border transition-colors cursor-pointer disabled:opacity-40",
                  tool === 'line' && effectiveTool !== 'pan'
                    ? "oh-btn-active text-brand-700"
                    : "border-transparent text-slate-600 hover:text-slate-900 hover:bg-white/70"
                )}
                title="Straight Line [L]"
              >
                <Minus size={17} />
              </button>
              <button
                type="button"
                disabled={!canDraw}
                onClick={() => setTool('rect')}
                className={cn(
                  "p-1.5 rounded-[2px] border transition-colors cursor-pointer disabled:opacity-40",
                  tool === 'rect' && effectiveTool !== 'pan'
                    ? "oh-btn-active text-brand-700"
                    : "border-transparent text-slate-600 hover:text-slate-900 hover:bg-white/70"
                )}
                title="Rectangle [R]"
              >
                <Square size={17} />
              </button>
              <button
                type="button"
                disabled={!canDraw}
                onClick={() => setTool('circle')}
                className={cn(
                  "p-1.5 rounded-[2px] border transition-colors cursor-pointer disabled:opacity-40",
                  tool === 'circle' && effectiveTool !== 'pan'
                    ? "oh-btn-active text-brand-700"
                    : "border-transparent text-slate-600 hover:text-slate-900 hover:bg-white/70"
                )}
                title="Circle [C]"
              >
                <CircleIcon size={17} className="stroke-[2.5]" />
              </button>
              <button
                type="button"
                disabled={!canDraw}
                onClick={() => setTool('text')}
                aria-label="Type"
                className={cn(
                  "p-1.5 2xl:px-2 rounded-[2px] border transition-colors cursor-pointer disabled:opacity-40 flex items-center gap-1 text-xs font-semibold",
                  tool === 'text' && effectiveTool !== 'pan'
                    ? "oh-btn-active text-brand-700"
                    : "border-transparent text-slate-600 hover:text-slate-900 hover:bg-white/70"
                )}
                title="Type Note [T]: Tap canvas to type, drag any note to move it, or tap/double-click a note to re-type it"
              >
                <Type size={16} />
                <span className="hidden 2xl:inline">Type</span>
              </button>
              <button
                type="button"
                disabled={!canDraw}
                onClick={() => setTool('stamp')}
                className={cn(
                  "p-1.5 rounded-[2px] border transition-colors cursor-pointer disabled:opacity-40",
                  tool === 'stamp' && effectiveTool !== 'pan'
                    ? "oh-btn-active text-brand-700"
                    : "border-transparent text-slate-600 hover:text-slate-900 hover:bg-white/70"
                )}
                title="Quick Stamp Tool [S] (Checkmark, Question Mark, Star, Thumbs Up, Heart, or Your Username)"
              >
                <Stamp size={17} />
              </button>
            </div>

            <div className="flex-1" />

            {/* Personal Actions, JSON Room Save & PNG Export */}
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                disabled={!canDraw}
                onClick={() => {
                  if (editingNote) commitEditingNote();
                  performUndo();
                }}
                className="flex items-center gap-1 px-2 py-1 text-xs font-medium oh-btn border text-slate-700 rounded-[2px] transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40"
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
                className="flex items-center gap-1 px-2 py-1 text-xs font-medium oh-btn border text-slate-700 rounded-[2px] transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40"
                title="Redo (Ctrl+Y / Ctrl+Shift+Z)"
              >
                <Redo2 size={15} />
                <span>Redo</span>
              </button>

              {confirmClearMine ? (
                <div className="flex items-center gap-1 bg-red-50 px-2 py-1 rounded-[2px] border border-red-300">
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
                    className="px-2 py-0.5 text-xs font-medium oh-btn-danger border text-white rounded-[2px] cursor-pointer whitespace-nowrap"
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
                  className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium oh-btn border text-red-600 rounded-[2px] transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40"
                  title="Erase only your own drawings"
                >
                  <Eraser size={15} />
                  <span>Clear Mine</span>
                </button>
              )}

              <div className="h-4 w-px bg-slate-300 mx-0.5" />

              <button
                type="button"
                disabled={classWork.isDownloading}
                onClick={classWork.handleExportJSON}
                className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium oh-btn border text-slate-700 rounded-[2px] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                title="Save everything in this room as a .json file: every student's board, the worksheets and the chat log. Open it later with Open class work."
              >
                <FileJson size={14} />
                <span>Save class work</span>
              </button>

              <button
                type="button"
                onClick={handleExportPNG}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium oh-btn-dark border text-white rounded-[2px] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                title="Download current canvas view as PNG"
              >
                <Download size={14} />
                <span>Export PNG</span>
              </button>
            </div>
          </div>
        </div>

        {/* Row 2: Student Status Radial, Colors, Ink Size, Text Size Dropdown, Smoothing & Smartboard Finger Mode */}
        <div className={cn("flex flex-wrap items-center gap-2", toolbarCollapsed && "hidden")}>
          {!isTeacher && (
            <div ref={statusMenuRef} className="relative flex items-center shrink-0">
              <button
                type="button"
                onClick={() => setShowStatusMenu((prev) => !prev)}
                aria-haspopup="true"
                aria-expanded={showStatusMenu}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 rounded-[2px] border text-xs font-medium transition-colors cursor-pointer whitespace-nowrap",
                  myStatusOption
                    ? cn(myStatusOption.className, "font-semibold")
                    : "oh-btn text-slate-700 hover:text-slate-900"
                )}
                title="Set your live classroom status for your teacher"
              >
                <span className="opacity-80">My Status is:</span>
                <span className="font-bold">{myStatusOption ? myStatusOption.label : 'None'}</span>
                <ChevronDown size={12} className="opacity-70" />
              </button>

              {showStatusMenu && (
                <div
                  role="menu"
                  aria-label="My status"
                  className="absolute left-0 top-full z-50 pointer-events-none"
                  style={{ width: 0, height: 0 }}
                >
                  <svg
                    width="260"
                    height="96"
                    viewBox="0 0 260 96"
                    className="overflow-visible pointer-events-none"
                    style={{ position: 'absolute', left: 0, top: 0 }}
                  >
                    <path
                      d="M 40 30 Q 128 102 214 28"
                      fill="none"
                      stroke="#0f172a"
                      strokeWidth="28"
                      strokeLinecap="round"
                      opacity="0.92"
                    />
                    <path
                      d="M 40 30 Q 128 102 214 28"
                      fill="none"
                      stroke="#334155"
                      strokeWidth="1.5"
                      strokeDasharray="3 3"
                    />
                  </svg>

                  {STATUS_RADIAL_OPTIONS.map((opt) => {
                    const isSelected = myStatus === opt.status;
                    return (
                      <button
                        key={opt.status}
                        type="button"
                        role="menuitemradio"
                        aria-checked={isSelected}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSetStatus(opt.status);
                          setShowStatusMenu(false);
                        }}
                        style={{
                          position: 'absolute',
                          left: opt.dx,
                          top: opt.dy,
                          transform: 'translate(-50%, -50%)',
                        }}
                        className={cn(
                          "pointer-events-auto px-2.5 py-1 rounded-full text-[11px] font-bold border whitespace-nowrap transition-transform hover:scale-105 cursor-pointer shadow-sm",
                          opt.pillClass,
                          isSelected && "ring-2 ring-white ring-offset-1 ring-offset-slate-900 scale-105"
                        )}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Inline Stamp Selector when Stamp Tool is Active */}
          {tool === 'stamp' && canDraw && (
            <div className="flex flex-wrap items-center gap-1.5">
              <div className="flex items-center gap-1 bg-brand-50/80 px-2 py-1 rounded-[3px] border border-brand-300/80">
                <span className="text-[11px] font-medium text-brand-800 mr-1">Stamp:</span>
                {STAMP_OPTIONS.map((st) => (
                  <button
                    key={st.kind}
                    type="button"
                    onClick={() => setStampKind(st.kind)}
                    disabled={st.kind === 'username' && nameStampTaken}
                    className={cn(
                      "px-2 h-6 rounded-[2px] border flex items-center justify-center text-xs font-bold transition-colors cursor-pointer whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed",
                      stampKind === st.kind
                        ? "oh-btn-primary text-white"
                        : "oh-btn text-slate-700"
                    )}
                    title={
                      st.kind === 'username' && nameStampTaken
                        ? 'You already placed your name stamp. Drag it to move it, or delete it to place it again.'
                        : st.label
                    }
                  >
                    {st.kind === 'username' ? `[ ${userName} ]` : st.symbol}
                  </button>
                ))}
              </div>

              {isTeacher && (
                <div
                  className="flex flex-wrap items-center gap-1 bg-amber-50/90 px-2 py-1 rounded-[3px] border border-amber-300/80"
                  data-testid="teacher-stamps-group"
                >
                  <span className="text-[11px] font-semibold text-amber-900 mr-1">Teacher stamps:</span>
                  {TEACHER_STAMP_OPTIONS.map((st) => {
                    const isSelected = stampKind === st.kind;
                    return (
                      <button
                        key={st.kind}
                        type="button"
                        onClick={() => setStampKind(st.kind)}
                        style={
                          isSelected
                            ? { backgroundColor: st.color, color: '#ffffff', borderColor: st.color }
                            : { color: st.color, borderColor: st.color }
                        }
                        className={cn(
                          "px-2 h-6 rounded-[2px] border text-[11px] font-extrabold tracking-wide transition-colors cursor-pointer whitespace-nowrap",
                          isSelected ? "" : "bg-white hover:bg-slate-50"
                        )}
                        title={
                          st.kind === 'teacher-custom'
                            ? 'Place a custom rubber-stamp label'
                            : `Place ${st.label} teacher stamp`
                        }
                      >
                        {st.label}
                      </button>
                    );
                  })}
                  {stampKind === 'teacher-custom' && (
                    <input
                      type="text"
                      value={customTeacherStampText}
                      onChange={(e) => setCustomTeacherStampText(e.target.value.slice(0, 24))}
                      aria-label="Custom teacher stamp text"
                      placeholder="Custom label"
                      maxLength={24}
                      className="h-6 w-28 px-2 text-[11px] font-bold uppercase bg-white border border-amber-300 rounded-[2px] text-slate-800 focus:outline-none focus:ring-1 focus:ring-amber-500"
                    />
                  )}
                </div>
              )}
            </div>
          )}

          {/* OverBoard Mode-Aware Color Swatches + Custom Color Picker */}
          <div className="flex items-center gap-1">
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
                    "w-[18px] h-[18px] rounded-full border border-slate-300 transition-transform hover:scale-110 cursor-pointer",
                    isSelected && "ring-2 ring-brand-600 ring-offset-2 scale-110"
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
                className="w-[18px] h-[18px] rounded-full border border-slate-300 flex items-center justify-center transition-transform hover:scale-110 cursor-pointer"
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

          {/* Ink size: named for the tool it sizes, boxed in AllAboard teal with a live dot in the ink color */}
          <div
            className="oh-teal-chrome flex items-center gap-1 px-2 py-0.5 rounded-[2px] border text-white"
            title="How thick your ink is (separate from text size)"
          >
            <label htmlFor="brush-size-slider" className="text-[11px] font-semibold text-white whitespace-nowrap">
              {tool === 'eraser'
                ? 'Eraser size:'
                : tool === 'highlighter'
                  ? isCoverMode
                    ? 'Cover size:'
                    : 'Highlighter size:'
                  : tool === 'hollow'
                    ? 'Brush size:'
                    : 'Pen size:'}
            </label>
            <span className="flex items-center justify-center w-6 h-6 shrink-0" aria-hidden="true" data-testid="ink-size-preview">
              <span
                // White ring keeps the dot visible on the green box whatever the ink color (green ink included).
                className={cn('rounded-full ring-2 ring-white', tool === 'eraser' && 'bg-white ring-white/60')}
                style={{
                  // Scaled so the slider's whole range fits; small sizes stay visible.
                  width: Math.max(3, Math.min(24, Math.round(strokeWidth * (tool === 'eraser' ? 0.06 : 0.48)))),
                  height: Math.max(3, Math.min(24, Math.round(strokeWidth * (tool === 'eraser' ? 0.06 : 0.48)))),
                  backgroundColor: tool === 'eraser' ? undefined : color,
                  opacity: tool === 'highlighter' && !isCoverMode ? 0.5 : 1,
                }}
              />
            </span>
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
              className="w-16 h-1.5 bg-brand-300 rounded-full appearance-none cursor-pointer accent-white"
            />
            <span className="text-xs font-mono tabular-nums text-white w-7 text-right">
              {strokeWidth}
            </span>
          </div>

          {/* Dedicated Line Weight Slider when Hollow Shape Brush is Active */}
          {tool === 'hollow' && (
            <div className="flex items-center gap-1.5 bg-brand-50/80 px-2 py-0.5 rounded-[2px] border border-brand-300">
              <label
                htmlFor="hollow-weight-slider"
                className="text-xs font-medium text-brand-900 whitespace-nowrap"
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
                className="w-20 h-1.5 bg-brand-200 rounded-full appearance-none cursor-pointer accent-brand-600"
              />
              <span className="text-xs font-mono tabular-nums text-brand-900 w-6">
                {Math.min(hollowWeight, Math.max(1, Math.floor(hollowWidth / 2) - 1))}
              </span>
            </div>
          )}

          {/* Compact Text Size Selector (shows currently selected size; click to pick S, M, L, XL, XXL or fine-tune) */}
          <div ref={textSizeMenuRef} className="relative flex items-center shrink-0">
            <button
              type="button"
              disabled={!canDraw}
              onClick={() => setShowTextSizeMenu((prev) => !prev)}
              aria-haspopup="true"
              aria-expanded={showTextSizeMenu}
              className={cn(
                "flex items-center gap-1 px-2 py-1 rounded-[2px] border text-xs font-medium transition-colors cursor-pointer whitespace-nowrap disabled:opacity-40",
                showTextSizeMenu || tool === 'text' || Boolean(editingNote) || selectedTextElements.length > 0
                  ? "oh-btn-active text-brand-800"
                  : "oh-btn text-slate-700 hover:text-slate-900"
              )}
              title="Text font size (click to pick S, M, L, XL, XXL or custom pixel size)"
            >
              <span className="text-slate-600">Text:</span>
              <span className="font-semibold font-mono tabular-nums text-slate-900">
                {activeTextPreset ? `${activeTextPreset.label} (${activeTextSize}px)` : `${activeTextSize}px`}
              </span>
              <ChevronDown size={12} className="opacity-70" />
            </button>

            {showTextSizeMenu && (
              <div
                role="menu"
                aria-label="Text size options"
                className="absolute left-0 top-full mt-1.5 z-50 w-64 p-3 rounded-[3px] bg-slate-900 text-white border-2 border-[#243044] space-y-2.5 shadow-lg"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-white">Text Font Size</span>
                  <span className="text-xs font-mono text-brand-300 tabular-nums">
                    {activeTextPreset ? `${activeTextPreset.label} · ${activeTextSize}px` : `${activeTextSize}px`}
                  </span>
                </div>

                <div className="grid grid-cols-5 gap-1">
                  {TEXT_SIZE_DROPDOWN_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      disabled={!canDraw}
                      onClick={() => {
                        handleSelectTextFontSize(preset.size);
                        setShowTextSizeMenu(false);
                      }}
                      className={cn(
                        "px-1.5 py-1.5 rounded-[2px] border text-xs font-bold transition-colors cursor-pointer disabled:opacity-40 text-center",
                        activeTextSize === preset.size
                          ? "oh-btn-primary text-white"
                          : "bg-slate-800 border-[#243044] text-slate-200 hover:bg-slate-700 hover:text-white"
                      )}
                      title={preset.title}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-1.5 pt-1 border-t border-slate-800">
                  <button
                    type="button"
                    disabled={!canDraw || activeTextSize <= 12}
                    onClick={() => handleSelectTextFontSize(activeTextSize - 2)}
                    className="w-6 h-6 rounded-[2px] bg-slate-800 border border-[#243044] hover:bg-slate-700 text-white font-bold disabled:opacity-35 cursor-pointer"
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
                    className="flex-1 h-1.5 bg-slate-700 rounded-full appearance-none cursor-pointer accent-brand-400"
                  />
                  <button
                    type="button"
                    disabled={!canDraw || activeTextSize >= 96}
                    onClick={() => handleSelectTextFontSize(activeTextSize + 2)}
                    className="w-6 h-6 rounded-[2px] bg-slate-800 border border-[#243044] hover:bg-slate-700 text-white font-bold disabled:opacity-35 cursor-pointer"
                    title="Increase text size"
                  >
                    +
                  </button>
                </div>

                <div className="flex items-center justify-between pt-1 border-t border-slate-800 text-slate-300">
                  <span className="text-[11px]">Preview</span>
                  <span
                    className="font-bold text-white leading-none truncate max-w-[140px]"
                    style={{ fontSize: Math.max(12, Math.min(30, Math.round(activeTextSize * 0.45))) }}
                  >
                    Aa
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* OverBoard Smoothing Control (0..8) & Smartboard Finger Mode Toggle */}
          <div className="flex items-center gap-1 bg-slate-100 px-1.5 py-0.5 rounded-[2px] border border-[#CBD5E1] text-xs">
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
              className="w-5 h-5 rounded-[2px] hover:bg-white text-slate-700 font-bold disabled:opacity-35 cursor-pointer"
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
              className="w-5 h-5 rounded-[2px] hover:bg-white text-slate-700 font-bold disabled:opacity-35 cursor-pointer"
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
              "px-2 py-1 rounded-[2px] text-[11px] font-medium border transition-colors cursor-pointer whitespace-nowrap",
              fingerScrolls
                ? "bg-amber-50 text-amber-900 border-amber-300"
                : "oh-btn text-slate-700 hover:text-slate-900"
            )}
            title="Smartboard / Tablet mode: Choose whether finger/mouse drags pan the board (while stylus writes & palm erases) or draw directly"
          >
            Finger: {fingerScrolls ? 'pans' : 'draws'}
          </button>
        </div>
      </div>
    </>
  );
}
