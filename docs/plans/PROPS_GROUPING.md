# Plan: Shrink the Prop and Option Lists Left by the Splits

> Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first. Every merge to `main` deploys to production.
> **Behavior-preserving refactor only.** Keep every `aria-label`, `title`, button text, `data-keep-note`, `localStorage`
> key, Socket.IO event, and Playwright selector. Do not change the Konva layer order or the `outgoingInkRef` flush order.
> **One phase per PR**, in order. Run the checkpoint after every phase and report the before/after counts.

## Why

The splits (#78–#80) moved code into files without moving its state, so everything still lives in `Canvas.tsx` /
`App.tsx` and is handed down one value at a time:

| Target                                             | Inputs today |
| -------------------------------------------------- | ------------ |
| `src/components/canvas/useCanvasPointerTools.ts`   | 97           |
| `src/components/canvas/CanvasToolbar.tsx`          | 80           |
| `src/components/canvas/TeacherClassroomBar.tsx`    | 68           |
| `src/hooks/useClassroomActions.tsx`                | 48           |
| `src/components/canvas/CanvasViewportOverlays.tsx` | 45           |

**Goal:** each target takes **≤ 15** props/options (a grouped object counts as one).

Count fields with (swap the file and the `interface Props` / `interface Options` / `type Options` header):

```sh
awk '/^interface Props/{f=1;next} f&&/^}/{exit} f' src/components/canvas/CanvasToolbar.tsx | grep -cE '^  [a-zA-Z]+\??:'
```

## Prerequisite

`eslint-plugin-react-hooks` must be set up (`rules-of-hooks` as an error, `exhaustive-deps` at least as a warning)
and run in CI. This refactor changes what every hook receives, which is exactly what `exhaustive-deps` checks.
**No phase may add a new `exhaustive-deps` warning.**

## Rules (all phases)

1. **Colocate before grouping.** If a value is declared in the parent and the parent only passes it down (it appears
   just in its `useState`/`useRef` line and the JSX prop), move the state, and any effect that only touches it, into the
   child. Check with `grep -nw <name> src/components/Canvas.tsx` before moving. Only move it if the new owner stays
   mounted at least as long as the old one. Put moved state at the top of the child, never inside an
   `isTeacher ? … : …` branch, or it resets when the branch flips.
2. **Pass hook results whole.** When a child needs several things from one hook (`useStageViewport`, `useCanvasHistory`,
   `useCanvasNoteSelection`, `useCanvasLaser`, `useCanvasInteractionState`, `useClassWorkFiles`), give it the hook's return
   object (`viewport={viewport}`) instead of destructuring in the parent and listing the parts again.
3. **Group the rest by feature, with a named type** in the child's file (`TeacherActions`, `ToolSettings`, …). No
   `{...{ }}`, and no forwarding the parent's whole props (`{...props}`, `props: CanvasProps`): both hide what the child
   really uses.
4. **Watch object identity in hooks.** A grouped object built during render is new on every render. That's fine as a prop
   (no component here uses `React.memo`). In a **hook**, destructure groups at the top and put the _fields_ in
   `useCallback`/`useEffect` dependency lists, never the group object itself, or `useClassroomActions`' 42 `useCallback`s
   are rebuilt on every render. Never silence `exhaustive-deps` with a disable comment.
5. **No new behavior.** For example, don't merge the separate `show*Menu` booleans into one `openMenu` value unless the
   current code already closes the others when one opens. That's a change in behavior, so leave it out.

## Phase 1 — `TeacherClassroomBar` (68 → ≤ 15)

Start here: it's the clearest case and sets the pattern.

1. **Colocate** (all are only passed through, confirmed against `main`):
   - Timer UI: `showTimerMenu`, `customTimeInput`, `displayRemainingMs`, `timerMenuRef`, the 250 ms countdown effect and
     the outside-click effect (`Canvas.tsx` ~L549–583). Move them into a new `canvas/ClassroomTimerControl.tsx` rendered by
     the bar, which then only needs `timer` and `onTeacherTimerControl`. **Bonus:** today `setDisplayRemainingMs` runs in
     `Canvas`, so the whole 1,800-line Canvas re-renders 4× a second while a timer runs; after this only the timer does.
   - `confirmClearAll` and `confirmRemoveWorksheet` + `removeWorksheetTimerRef` and both of its effects (~L429–451, incl.
     the reset when `background` clears).
2. **Group:**
   - `teacherActions: TeacherActions`: `onConfigureBreakout`, `onTeacherTimerControl`, `onTeacherUpdateBackground`,
     `onTeacherSetBackground`, `onTeacherLessonRequest`, `onTeacherToggleLock`, `onTeacherToggleHideCursors`,
     `onTeacherToggleOneNameStamp`, `onTeacherClearAll`, `onAssignUserToBoard`.
   - `roundsView: RoundsView`: `breakoutConfig`, `rounds`, `activeRound`, `viewingRound`, `effectiveViewingRoundId`,
     `activeRoundBoards`, `teacherVisibleBoards`, `subBoards`, `roundShortLabel`, `setTeacherViewingRoundId`.
   - `worksheetImport: WorksheetImport`: `isUploadingWorksheet`, `worksheetInputRef`, `fileInputRef`, `driveBusy`,
     `driveCanCancel`, `handleWorksheetFromDrive`, `handleCancelDriveImport`, `worksheetImportScale`,
     `handleUpdateWorksheetImportScale`, `worksheetError`. If its logic lifts cleanly out of `Canvas.tsx`, make it a
     `useWorksheetImport()` hook that returns this object; if not, build the object in `Canvas`.
   - Moderation toggles: pass `isCanvasLocked`, `hideStudentCursors`, `oneNameStamp` as one `moderation` object.
   - `classWork` already arrives whole. Keep it.

## Phase 2 — `CanvasToolbar` (80 → ≤ 15)

1. **Colocate:** `confirmClearMine` / `setConfirmClearMine`.
2. **Hook out the tool settings:** move the `localStorage`-backed tool state (`readLocalNum`/`readLocalColor`/
   `readLocalHollowShape`/`saveLocal` callers: color, stroke width, highlighter, hollow shape/weight, cover mode, stamp kind,
   custom stamp text, text size, smoothing, finger scrolling) and their `handleSelect*` setters into
   `canvas/useToolSettings.ts`. It returns one `ToolSettings` object. Keep every key and default identical.
3. **Pass whole:** `history` (from `useCanvasHistory`), `toolSettings`, `menus` (the `show*Menu` booleans + setters, as
   they are).

## Phase 3 — `CanvasViewportOverlays` (45 → ≤ 15)

Pass `viewport`, `noteSelection` (the `useCanvasNoteSelection` result) and `toolSettings` whole. Colocate
`sendToBoardTarget` if `Canvas.tsx` doesn't use it anywhere else. `sentFeedback` and `showHotkeysModal` are also written by
the pointer/keyboard code, so they stay in `Canvas`.

## Phase 4 — `useClassroomActions` (48 → ≤ 15)

1. Group the options into `roomState` (values), `roomSetters` (the `set*` functions), `lobby` (lobby form values, refs
   and prompts) and `connection` (`socket`, `emitDrawing`). Follow Rule 4: destructure at the top, fields in deps.
2. Stop returning JSX: replace `problemReportModal` with `problemReport` state (`{ isOpen, open, close, diagnostics }`)
   and render `<ProblemReportModal>` in `App.tsx`. Then rename the file to `useClassroomActions.ts`.

## Phase 5 — `useCanvasPointerTools` (97 → ≤ 15)

The largest hook; do it last, once the earlier groups exist. Pass `viewport`, `history`, `laser`, `interaction` (the
`useCanvasInteractionState` result), `noteSelection`, `toolSettings`, `menus`, and a `boardActions` group (`onElementStart`,
`onElementAppendPoints`, `onElementUpdate`, `onElementRemove`, `onElementsBatchAdd`/`Update`/`Remove`, `onElementsReplace`,
`onTeacherUpdateBackground`, `onCursorMove`). It has 4 effects; keep their dependency lists exactly equivalent (the keyboard
shortcut effect at ~L472 lists many fields: re-list them as destructured locals).

## Phase 6 (optional) — `App.tsx` → `Canvas`

`docs/ARCHITECTURE.md` notes that `CanvasProps` has ~70 flat props. Once Phases 1–5 exist, have `useClassroomActions` /
`useDrawingActions` return `teacherActions` / `drawingActions` objects and pass those to `Canvas` directly. Update `e2e/`
helpers only if a test imports `CanvasProps`.

## Checkpoint (every phase)

```sh
npm run lint            # tsc + ESLint, no new exhaustive-deps warnings
npx prettier --check .
npm test
npm run build
bash scripts/smoke.sh
npm run test:e2e
```

In each PR description, report the target's input count before → after, anything colocated, and any place where
Rule 1's "only passed through" check failed and the value stayed in the parent.

When all phases are done, update the `Canvas.tsx` line count and the prop-count trade-off note in
`docs/ARCHITECTURE.md` §3.
