import { Check, Copy, Edit3, Keyboard, Maximize2, MousePointer2, Move, Trash2, X, ZoomIn, ZoomOut } from 'lucide-react';
import React, { useState } from 'react';
import { NOTE_FONT, NOTE_LH, TEXT_SIZE_PRESETS } from '../../lib/inkCore';
import type { SelectionAuthor } from '../../lib/selectionAuthors';
import { describeSelectionAuthors, formatSelectionAuthors } from '../../lib/selectionAuthors';
import { cn } from '../../lib/utils';
import { CanvasElement, GridMode, SubBoardData, ToolType } from '../../types';
import { GRID_MODE_OPTIONS, GridModeIcon, saveLocal } from './canvasHelpers';
import type { useCanvasInteractionState } from './useCanvasInteractionState';
import type { useCanvasNoteSelection } from './useCanvasNoteSelection';
import type { useStageViewport } from './useStageViewport';
import type { ToolSettings } from './useToolSettings';

/** The current selection, as `Canvas` derives it. */
export interface OverlaySelection {
  selectedElements: CanvasElement[];
  selectionBounds: [number, number, number, number];
  selectionAuthors: SelectionAuthor[];
  selectedTextElements: CanvasElement[];
}

export interface GridControls {
  gridMode: GridMode;
  setGridMode: React.Dispatch<React.SetStateAction<GridMode>>;
  showGridMenu: boolean;
  setShowGridMenu: React.Dispatch<React.SetStateAction<boolean>>;
  gridMenuRef: React.RefObject<HTMLDivElement>;
}

export interface HotkeysModal {
  showHotkeysModal: boolean;
  setShowHotkeysModal: React.Dispatch<React.SetStateAction<boolean>>;
}

export interface OverlayUser {
  userName: string;
  userColor: string;
  isTeacher: boolean;
  canDraw: boolean;
}

interface Props {
  viewport: ReturnType<typeof useStageViewport>;
  interaction: ReturnType<typeof useCanvasInteractionState>;
  noteSelection: ReturnType<typeof useCanvasNoteSelection>;
  toolSettings: ToolSettings;
  selection: OverlaySelection;
  grid: GridControls;
  hotkeys: HotkeysModal;
  user: OverlayUser;
  activeRoundBoards: SubBoardData[];
  effectiveTool: ToolType;
}
export function CanvasViewportOverlays({
  viewport,
  interaction,
  noteSelection,
  toolSettings,
  selection,
  grid,
  hotkeys,
  user,
  activeRoundBoards,
  effectiveTool,
}: Props) {
  const { dimensions, stagePos, stageScale, zoomStep, resetView, fitAllContent } = viewport;
  const {
    selectionDragOffset,
    setSelectedIds,
    sentFeedback,
    pastePrompt,
    setPastePrompt,
    clipboardElements,
    editingNote,
    setEditingNote,
    noteTextareaRef,
    screenPos,
  } = interaction;
  const {
    openOrTapNoteAt,
    handleCopySelection,
    handleDuplicateSelection,
    handleDeleteSelection,
    handleSendSelectionToBoard,
    handlePasteElements,
    commitEditingNote,
  } = noteSelection;
  const { activeTextSize, handleSelectTextFontSize } = toolSettings;
  const { selectedElements, selectionBounds, selectionAuthors, selectedTextElements } = selection;
  const { gridMode, setGridMode, showGridMenu, setShowGridMenu, gridMenuRef } = grid;
  const { showHotkeysModal, setShowHotkeysModal } = hotkeys;
  const { userName, userColor, isTeacher, canDraw } = user;

  // Only the send-to-board picker reads this (moved here from useCanvasInteractionState).
  const [sendToBoardTarget, setSendToBoardTarget] = useState<string>('ALL_SUBBOARDS');
  return (
    <>
      {/* Floating Action Bar for Selected / Lassoed Elements */}
      {selectedElements.length > 0 && selectionBounds && !selectionDragOffset && canDraw && (
        <div
          data-hud="true"
          data-keep-note="true"
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          className="absolute z-40 flex flex-wrap items-center gap-1.5 px-2.5 py-1.5 rounded-[3px] bg-slate-900 text-white border-2 border-[#243044] text-xs"
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
              Math.min(Math.max(10, dimensions.height - 64), stagePos.y + selectionBounds[1] * stageScale - 52)
            ),
          }}
        >
          <span className="font-semibold text-indigo-300 px-1 whitespace-nowrap">
            {selectedElements.length} selected
          </span>

          {selectionAuthors.length > 0 && (
            <span
              data-testid="selection-authors"
              title={describeSelectionAuthors(selectionAuthors)}
              className="max-w-[220px] truncate px-1 font-medium text-slate-100"
            >
              {formatSelectionAuthors(selectionAuthors)}
            </span>
          )}

          {selectedTextElements.length > 0 && (
            <>
              <div className="h-3.5 w-px bg-slate-700" />
              <button
                type="button"
                onClick={() => handleSelectTextFontSize(activeTextSize - 4)}
                className="px-1.5 py-0.5 rounded-[2px] border oh-btn-dark font-semibold cursor-pointer"
                title="Shrink selected text"
              >
                A&minus;
              </button>
              <button
                type="button"
                onClick={() => handleSelectTextFontSize(activeTextSize + 4)}
                className="px-1.5 py-0.5 rounded-[2px] border oh-btn-dark font-semibold cursor-pointer"
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
                  className="flex items-center gap-1 px-2 py-0.5 rounded-[2px] border oh-btn-primary font-medium cursor-pointer whitespace-nowrap"
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
            className="flex items-center gap-1 px-2 py-0.5 rounded-[2px] border oh-btn-dark font-medium cursor-pointer whitespace-nowrap"
            title="Copy selection (Ctrl+C)"
          >
            <Copy size={12} />
            <span>Copy</span>
          </button>
          <button
            type="button"
            onClick={handleDuplicateSelection}
            className="px-2 py-0.5 rounded-[2px] border oh-btn-dark font-medium cursor-pointer whitespace-nowrap"
            title="Duplicate selection (Ctrl+D)"
          >
            Duplicate
          </button>
          <button
            type="button"
            onClick={handleDeleteSelection}
            className="flex items-center gap-1 px-2 py-0.5 rounded-[2px] border oh-btn-danger font-medium cursor-pointer whitespace-nowrap"
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
                className="bg-slate-800 border border-[#243044] rounded-[2px] px-1.5 py-0.5 text-[11px] text-white"
              >
                <option value="ALL_SUBBOARDS">All Boards in Current Round</option>
                <option value="main">Main Class Board</option>
                {activeRoundBoards.map((sb) => (
                  <option key={sb.id} value={sb.id}>
                    {sb.title}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => handleSendSelectionToBoard(sendToBoardTarget)}
                className="px-2 py-0.5 rounded-[2px] border oh-btn-emerald font-semibold cursor-pointer whitespace-nowrap"
              >
                Send Copy
              </button>
              {sentFeedback && (
                <span className="text-[11px] text-emerald-300 font-medium whitespace-nowrap">{sentFeedback}</span>
              )}
            </>
          )}

          <button
            type="button"
            onClick={() => setSelectedIds([])}
            className="p-0.5 rounded-[2px] text-slate-400 hover:text-white cursor-pointer"
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
          className="absolute z-40 flex items-center gap-1.5 px-2.5 py-1.5 rounded-[3px] bg-slate-900 text-white border-2 border-[#243044] text-xs"
          style={{
            left: Math.max(12, Math.min(dimensions.width - 180, stagePos.x + pastePrompt.worldX * stageScale)),
            top: Math.max(12, Math.min(dimensions.height - 48, stagePos.y + pastePrompt.worldY * stageScale - 36)),
          }}
        >
          <button
            type="button"
            onClick={() => handlePasteElements({ x: pastePrompt.worldX, y: pastePrompt.worldY })}
            className="px-2 py-0.5 rounded-[2px] border oh-btn-primary font-semibold cursor-pointer whitespace-nowrap"
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
            className="absolute -top-8 left-0 flex items-center gap-1 px-1.5 py-0.5 rounded-[3px] bg-slate-900 text-white border border-[#243044] text-[11px] whitespace-nowrap"
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
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-[2px] border oh-btn-dark cursor-grab active:cursor-grabbing text-slate-200 font-medium"
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
                  'px-1 py-0.5 rounded-[2px] border font-bold cursor-pointer',
                  editingNote.fontSize === preset.size
                    ? 'oh-btn-primary text-white'
                    : 'border-transparent text-slate-300 hover:bg-slate-800'
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
              className="px-1 py-0.5 rounded-[2px] text-slate-300 hover:bg-slate-800 font-bold cursor-pointer"
              title="Smaller text"
            >
              &minus;
            </button>
            <button
              type="button"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => handleSelectTextFontSize(editingNote.fontSize + 3)}
              className="px-1 py-0.5 rounded-[2px] text-slate-300 hover:bg-slate-800 font-bold cursor-pointer"
              title="Larger text"
            >
              +
            </button>

            <button
              type="button"
              aria-label="Done editing note"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => commitEditingNote()}
              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-[2px] border oh-btn-emerald text-white font-semibold cursor-pointer ml-0.5"
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
            className="m-0 p-0 border-0 outline-2 outline-dashed outline-brand-600 rounded-xs bg-white/88 resize-none overflow-hidden focus:outline-brand-600 shadow-sm"
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
      {effectiveTool !== 'pan' &&
        effectiveTool !== 'move-bg' &&
        effectiveTool !== 'select' &&
        effectiveTool !== 'text' && (
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
        className="oh-chrome-bar absolute bottom-4 right-4 z-20 flex items-center gap-1 px-2 py-1.5 rounded-[3px] border border-[#CBD5E1] text-xs text-slate-700"
      >
        {/* Upward Curved Radial Background Grid Selector (Blank, Dots, Graph Paper, Isometric 3D) */}
        <div ref={gridMenuRef} className="relative flex items-center">
          <button
            type="button"
            onClick={() => setShowGridMenu((prev) => !prev)}
            aria-haspopup="true"
            aria-expanded={showGridMenu}
            className={cn(
              'p-1.5 rounded-[2px] border transition-colors cursor-pointer',
              gridMode !== 'blank' || showGridMenu
                ? 'oh-btn-active text-brand-700'
                : 'border-transparent text-slate-500 hover:bg-white/80 hover:text-slate-800'
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
              <svg width="156" height="88" viewBox="-78 -80 156 88" className="overflow-visible pointer-events-none">
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
                      'pointer-events-auto absolute w-8 h-8 rounded-full flex items-center justify-center border transition-transform hover:scale-110 cursor-pointer',
                      isSelected
                        ? 'bg-brand-600 text-white border-white ring-2 ring-brand-500/50'
                        : 'bg-slate-900 text-slate-200 border-[#243044] hover:bg-slate-800 hover:text-white'
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

        <div className="h-4 w-px bg-slate-300 mx-0.5" />

        <button
          type="button"
          onClick={() => zoomStep(1 / 1.25)}
          className="p-1.5 rounded-[2px] border oh-btn transition-colors cursor-pointer"
          title="Zoom Out"
        >
          <ZoomOut size={14} />
        </button>

        <button
          type="button"
          onClick={resetView}
          className="px-2 py-1 rounded-[2px] hover:bg-white font-mono tabular-nums font-medium text-slate-700 cursor-pointer"
          title="Click to reset zoom to 100% at origin (0,0)"
        >
          {Math.round(stageScale * 100)}%
        </button>

        <button
          type="button"
          onClick={() => zoomStep(1.25)}
          className="p-1.5 rounded-[2px] border oh-btn transition-colors cursor-pointer"
          title="Zoom In"
        >
          <ZoomIn size={14} />
        </button>

        <div className="h-4 w-px bg-slate-300 mx-0.5" />

        <button
          type="button"
          onClick={fitAllContent}
          className="flex items-center gap-1 px-2 py-1 rounded-[2px] border oh-btn font-medium text-slate-700 whitespace-nowrap cursor-pointer"
          title="Fit worksheet and all drawings into view [F]"
        >
          <Maximize2 size={13} />
          <span>Fit All</span>
        </button>

        <div className="h-4 w-px bg-slate-300 mx-0.5" />

        <button
          type="button"
          onClick={() => setShowHotkeysModal((prev) => !prev)}
          className={cn(
            'flex items-center gap-1 px-2 py-1 rounded-[2px] border font-medium whitespace-nowrap cursor-pointer transition-colors',
            showHotkeysModal ? 'oh-btn-primary text-white' : 'oh-btn text-slate-700'
          )}
          title="Keyboard Shortcuts & Navigation [?]"
        >
          <Keyboard size={13} />
          <span>Hotkeys</span>
        </button>
      </div>
      {/* Keyboard Shortcuts & Navigation Modal */}
      {showHotkeysModal && (
        <div
          data-hud="true"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setShowHotkeysModal(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white border-2 border-[#CBD5E1] rounded-[3px] w-full max-w-lg overflow-hidden text-slate-800"
          >
            <div className="oh-panel-header flex items-center justify-between px-5 py-3.5 border-b border-[#CBD5E1]">
              <div className="flex items-center gap-2">
                <Keyboard size={17} className="text-brand-600" />
                <h2 className="font-display font-bold text-sm text-slate-900">Keyboard Shortcuts &amp; Navigation</h2>
              </div>
              <button
                type="button"
                onClick={() => setShowHotkeysModal(false)}
                className="p-1 rounded-[2px] border border-transparent hover:border-[#CBD5E1] text-slate-400 hover:text-slate-700 cursor-pointer"
                title="Close (Esc)"
              >
                <X size={16} />
              </button>
            </div>

            <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-5 text-xs">
              <div className="space-y-2.5">
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  Navigation &amp; Camera
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-700">Move around board</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-300 font-mono text-[11px] font-semibold text-slate-800">
                      ↑ ↓ ← →
                    </kbd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-700">Fast move around board</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-300 font-mono text-[11px] font-semibold text-slate-800">
                      Shift + Arrows
                    </kbd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-700">Hand / Pan tool</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-300 font-mono text-[11px] font-semibold text-slate-800">
                      H
                    </kbd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-700">Temporary pan while drawing</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-300 font-mono text-[11px] font-semibold text-slate-800">
                      Hold Space
                    </kbd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-700">Fit all pages &amp; ink</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-300 font-mono text-[11px] font-semibold text-slate-800">
                      F
                    </kbd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-700">Reset zoom to 100%</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-300 font-mono text-[11px] font-semibold text-slate-800">
                      0
                    </kbd>
                  </div>
                </div>
              </div>

              <div className="space-y-2.5">
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Drawing Tools</div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-700 font-medium">Solid Pen</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-300 font-mono text-[11px] font-semibold text-slate-800">
                      P / B
                    </kbd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-700 font-medium">Personal Eraser</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-300 font-mono text-[11px] font-semibold text-slate-800">
                      E
                    </kbd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-700">Select &amp; Lasso</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-300 font-mono text-[11px] font-semibold text-slate-800">
                      V
                    </kbd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-700">Highlighter / Cover</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-300 font-mono text-[11px] font-semibold text-slate-800">
                      M
                    </kbd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-700">Type Note</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-300 font-mono text-[11px] font-semibold text-slate-800">
                      T
                    </kbd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-700">Line / Rect / Circle / Stamp</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-300 font-mono text-[11px] font-semibold text-slate-800">
                      L / R / C / S
                    </kbd>
                  </div>
                </div>
              </div>
            </div>

            <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
              <span>
                Undo: <kbd className="font-mono font-semibold text-slate-700">Ctrl+Z</kbd> · Redo:{' '}
                <kbd className="font-mono font-semibold text-slate-700">Ctrl+Y</kbd> · Copy/Paste/Duplicate:{' '}
                <kbd className="font-mono font-semibold text-slate-700">Ctrl+C / V / D</kbd>
              </span>
              <span>
                Press <kbd className="font-mono font-semibold text-slate-700">?</kbd> anytime to toggle
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
