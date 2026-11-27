# Plan: Split `src/components/Canvas.tsx` into Subsystems, Hooks, and Toolbars

> **For Code 6.1 Terra:** Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first.
> **Behavior-preserving refactor only.** Keep `CanvasProps` compatible with `src/App.tsx`, keep all `localStorage` keys, keep all Konva layer ordering (`WorksheetPageNode` → `MultiplyHighlightLayer` → `InkLayer` → overlay cursors/selection), keep CSS opacity / `mixBlendMode = 'multiply'` behavior, and preserve every `aria-label`, `title`, `data-keep-note`, button text, and Playwright test selector.
> **Run `npm run test:e2e` after EVERY phase**, not just at the end: `Canvas.tsx` is tested primarily by `e2e/*.spec.ts`.

## Goal

Break `src/components/Canvas.tsx` (6,411 lines, 186 React hooks) into focused, readable modules under `src/components/canvas/` so future tool, toolbar, or rendering changes touch a 200–600-line file instead of a 6,400-line monolith.

---

## Phase 1 — `canvasHelpers.ts` and `KonvaLayers.tsx` (zero hook-state changes)

1. Create `src/components/canvas/canvasHelpers.ts`:
   - Move `HistoryAction` type, `MIN_SCALE`, `MAX_SCALE`, `PAGE_GAP`, `PALM_ERASER_SCREEN_PX`, `readLocalNum`, `readLocalColor`, `saveLocal`, `HOLLOW_SHAPE_OPTIONS`, `STATUS_RADIAL_OPTIONS`, `TEXT_SIZE_DROPDOWN_PRESETS`, `readLocalHollowShape`, `HollowShapeIcon`, `GRID_MODE_OPTIONS`, `readLocalGridMode`, `GridModeIcon`, `getCanvasGridStyle`, `EMPTY_ROUND_TEMPLATES`, `EMPTY_TEMPLATE_INK`, `EMPTY_ROUND_VARIANTS`, `formatTimerMs`, `parseCustomTimeSeconds`.
2. Create `src/components/canvas/KonvaLayers.tsx`:
   - Move standalone Konva rendering components (lines 444–662):
     - `SmoothStrokeShape`, `HollowStrokeShape`, `SprayStrokeLine`, `UNFOCUSED_INK_OPACITY`, `MultiplyHighlightLayer`, `useLayerScreenOpacity`, `InkLayer`, `WorksheetPageNode`.
3. Create `src/components/canvas/renderCanvasElement.tsx`:
   - Move `renderElement` (lines 3254–3506) into a pure rendering helper / component taking the element, selection/drag/focus props, and note-edit state.

### Phase 1 Checkpoint
```sh
npm run lint
npm test
npm run build
npm run test:e2e
```

---

## Phase 2 — `useCanvasHistory.ts` and `useStageViewport.ts`

1. Create `src/components/canvas/useCanvasHistory.ts`:
   - Move per-board undo/redo state and actions:
     - `historyByBoardRef`, `getBoardHistory`, `recordUndo`, `canLocalUndo`, `canRedo`, `buildElementUpdatePatch`, `performUndo`, `performRedo`, plus the `laserSocket.on('board-replaced', ...)` reset `useEffect`.
2. Create `src/components/canvas/useStageViewport.ts`:
   - Move stage sizing, pan/zoom, and coordinate transforms:
     - `stageScale`, `setStageScale`, `stagePos`, `setStagePos`, `containerSize`, `stageRef`, `containerRef`
     - Resize observer `useEffect` (lines ~785–801), `screenToWorld`, `getLocalPosFromEvent`, `resetView`, `fitElementsAndBackgroundInView`, `fitAllContent`, `handleWheel`, `zoomStep`.

### Phase 2 Checkpoint
```sh
npm run lint
npm test
npm run build
npm run test:e2e
```

---

## Phase 3 — `useCanvasPointerTools.ts` and `useCanvasLaser.ts` (or combined cleanly)

1. Extract laser-pulse handling (`laserPoints`, `laserIdRef`, `laserStrokeRef`, `lastLaserEmitRef`, `addLaserPoint`, `sendLaserPoint`, `laser-pulse` socket listener + animation frame fade loop) into `src/components/canvas/useCanvasLaser.ts` (or inside `useCanvasPointerTools.ts`).
2. Create `src/components/canvas/useCanvasPointerTools.ts`:
   - Move all pointer/tool refs and handlers:
     - `panStartRef`, `bgMoveStartRef`, `activeStrokeToolRef`, `activeStrokePointsRef`, `liveSmoothRef`, `downAtRef`, `activePointerIdRef`, `shapeOriginRef`, `pendingStrokeRef`, `draggingNoteRef`, `selectGestureRef`
     - Cursor emission throttling (`lastCursorEmitRef`, `pendingCursorRef`, `cursorTimerRef`, `onCursorMoveRef`)
     - Note inline editor refs/callbacks (`editingNote`, `noteTextareaRef`, `noteClosedAtRef`, `resizeNoteTextarea`, `commitEditingNote`, `openOrTapNoteAt`)
     - Selection clipboard/actions (`handleCopySelection`, `handlePasteElements`, `handleDuplicateSelection`, `handleDeleteSelection`, `handleSendSelectionToBoard`)
     - `handleViewportPointerDown`, `handleViewportPointerMove`, `handleViewportPointerUp`, `handleViewportDoubleClick`
     - Keyboard shortcut `useEffect`s (Ctrl/Cmd+Z/Y/C/V/D, Escape, Delete/Backspace, tool shortcuts).

### Phase 3 Checkpoint
```sh
npm run lint
npm test
npm run build
npm run test:e2e
```

---

## Phase 4 — Split JSX Chrome into `CanvasToolbar.tsx`, `TeacherClassroomBar.tsx`, and `CanvasViewportOverlays.tsx`

1. Create `src/components/canvas/CanvasToolbar.tsx`:
   - Extract lines 3532–4594 (`data-keep-note="true"` primary toolbar: phone tools toggle + Undo, navigation & brush/shape/stamp tools, personal undo/save/PNG export, status radial, mode-aware color swatches + custom picker, ink size, hollow weight slider, text size dropdown, smoothing & smartboard finger mode).
2. Create `src/components/canvas/TeacherClassroomBar.tsx`:
   - Extract lines 4595–5378 (Breakout/Individual mode launcher, Teacher board switcher dropdown + Live Grid Overview button, Classroom countdown timer popover, worksheet templates/upload/Drive/scale/position/opacity controls, Lock/Hide Cursors/One-Name-Stamp/Clear All moderation, ink-author focus pills, and Student sub-board bar).
3. Create `src/components/canvas/CanvasViewportOverlays.tsx`:
   - Extract the viewport overlays inside the stage container:
     - Selection floating action bar (recolor/size/duplicate/send-to-board/delete/close)
     - Tap-to-paste prompt banner
     - Floating editable multiline text note (`noteTextareaRef` + drag handle + live size bar)
     - Custom precision cursor overlay
     - Floating bottom-right zoom & radial grid HUD (`Blank`, `Dots`, `Graph`, `Isometric`)
     - Keyboard shortcuts & navigation modal
4. Shrink `src/components/Canvas.tsx` to a clean ~450–600-line coordinator wiring tool/palette state, `useClassWorkFiles`, `useStageViewport`, `useCanvasHistory`, `useCanvasPointerTools`, `CanvasToolbar`, `TeacherClassroomBar`, Konva `<Stage>` (`KonvaLayers` + `renderCanvasElement`), `CanvasViewportOverlays`, and the modals (`LiveGridOverview`, `BreakoutManagerModal`, etc.).
5. Update `docs/ARCHITECTURE.md` §3 with the new `src/components/canvas/*` files and updated `Canvas.tsx` line count.

### Final Verification
```sh
npm run lint
npm test
npm run build
bash scripts/smoke.sh
npm run test:e2e
```
