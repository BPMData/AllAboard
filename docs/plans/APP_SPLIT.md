# Plan: Split `src/App.tsx` into Identity, Socket Hook, Actions, and Lobby

> **For Code 6.1 Terra:** Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first.
> **Behavior-preserving refactor only.** Do not change `STORAGE_KEYS` (`localStorage` / `sessionStorage`), URL `?room=` handling, `outgoingInkRef` flush order before `emitDrawing`, DOM labels/selectors tested by `e2e/*.spec.ts`, or `CanvasProps` / `Chat` prop names (keep `Canvas.tsx` and `Chat.tsx` diffs minimal or zero here so `CANVAS_SPLIT.md` stays independent).

## Goal

Reduce `src/App.tsx` from ~2,327 lines (~120 hooks, 26 `newSocket.on` listeners, lobby JSX + all room handlers) down to a ~350–450-line root coordinator by extracting pure identity/URL helpers, `LobbyScreen`, `useRoomSocket`, and `useClassroomActions`.

---

## Phase 1 — `src/lib/identity.ts` and `src/components/LobbyScreen.tsx`

1. Create `src/lib/identity.ts`:
   - Move `STORAGE_KEYS`, `getOrCreatePersistentUserId`, `getOrCreatePersistentUserKey`, `hasInitialUrlRoomParam`, `getInitialRoomId`, and `generateFreshRoomCode`.
   - Note: `STORAGE_KEYS.TEACHER_PIN_PREFIX` is used by both socket reconnect/auth and `getSavedTeacherPin`; export `STORAGE_KEYS` cleanly from `src/lib/identity.ts`.
2. Create `src/components/LobbyScreen.tsx`:
   - Extract the pre-join lobby JSX currently in `if (!isJoined) { return (...); }` (lines 1940–2180 of `src/App.tsx`), including `RoomHistoryDropdown`, `RoomExistsModal`, `problemReportModal` slot, and the `displayNameInputRef` / `roomCodeInputRef` / `teacherPinInputRef` refs.
   - Preserve all `id`s, `aria-label`s, `placeholder`s, `title`s, button texts, and Tailwind classes verbatim.

### Phase 1 Checkpoint
```sh
npm run lint
npm test
```

---

## Phase 2 — Extract `src/hooks/useRoomSocket.ts`

1. Create `src/hooks/useRoomSocket.ts`:
   - Move the Socket.IO connection `useEffect` (lines 322–936), `outgoingInkRef` (`PointQueue`), `incomingInk` (`appendPointBatches`), `seenChatIdsRef`, `applyBoardElementsTransform`, all 26 `newSocket.on(...)` listeners, and the `teacher:view-board` sync `useEffect` (lines 940–948).
   - Keep `emitDrawing`, `enqueueOutgoingPoints`, and `flushOutgoingPoints` inside the hook so `outgoingInkRef.current?.flush()` always runs before discrete drawing emits (`element-start`, `element-update`, `elements-batch-*`, `elements-replace`, `element-remove`, `undo`, `clear-user-drawings`, `teacher:clear-all`).
   - Keep cleanup on unmount/room-change identical (`outgoingInk.flush(); ... incomingInk.clear(); newSocket.close();`).
   - **Important:** Check `App.tsx` refs synced for socket listeners (`userNameRef`, `isJoinedRef`, `isChatHiddenRef`, `activeBoardIdRef`, `chatScopeRef`) so listeners never read stale state.

### Phase 2 Checkpoint
```sh
npm run lint
npm test
npm run build
```

---

## Phase 3 — Extract `src/hooks/useClassroomActions.ts`

1. Create `src/hooks/useClassroomActions.ts` (or split cleanly into `useDrawingActions.ts` + `useClassroomActions.ts` if over ~450 lines):
   - Move the room-join/switch/leave/modal actions (`checkRoomAvailability`, `generateUnusedRoomCode`, `performLobbyJoin`, `handleSwitchRoom`, `handleCreateNewRoom`, `handleJoin`, `handleLobbyNewRoom`, `handleConfirmJoinAnyway`, `handleConfirmCreateFreshRoom`, `handleCustomRoomFromModal`, `handleLeaveRoom`, `handleOpenLoadedLessonRoom`).
   - Move teacher/moderation/chat/profile actions (`handleAuthenticateTeacher`, `handleStepDownTeacher`, `handleConfigureBreakout`, `handleSpotlightBoard`, `handleAssignUserToBoard`, `handleTeacherSendWorksheet`, `handleTeacherSetBackground`, `handleTeacherUpdateBackground`, `handleTeacherImportRoom`, `handleTeacherLessonRequest`, `handleUpdateName`, `handleTeacherRenameUser`, `handleTeacherDeleteMessage`, `handleTeacherKickUser`, `handleConfirmPurgeContributions`, `handleTeacherUnbanUser`, `sendMessage`, `handleTeacherToggleLock`, `handleTeacherToggleHideCursors`, `handleTeacherToggleOneNameStamp`, `handleSetStatus`, `handleClearStatus`, `handleTeacherClearAll`, `handleTeacherTimerControl`).
   - Move drawing actions (`handleElementStart`, `handleElementAppendPoints`, `updateActiveBoardElements`, `handleElementUpdate`, `handleElementsBatchUpdate`, `handleElementsBatchAdd`, `handleElementsBatchRemove`, `handleElementsReplace`, `handleElementRemove`, `handleCursorMove`, `handleUndo`, `handleClearMine`, `handleClearUserDrawings`).
2. Shrink `src/App.tsx` to ~350–450 lines owning room state, derived `activeBoardId` / `activeElements` / `activeBackground` / `activeMessages`, `useRoomSocket`, `useClassroomActions`, `ProblemReportModal`, and the top-level JSX (`LobbyScreen` vs `Chat` + `Canvas` + modals).
3. Update `docs/ARCHITECTURE.md` §3 with `src/lib/identity.ts`, `src/components/LobbyScreen.tsx`, `src/hooks/useRoomSocket.ts`, and `src/hooks/useClassroomActions.ts`.

### Final Verification
```sh
npm run lint
npm test
npm run build
bash scripts/smoke.sh
npm run test:e2e
```
