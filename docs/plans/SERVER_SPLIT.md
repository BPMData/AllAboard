# Plan: Split `server.ts` into Focused `server/` Modules

> **For Code 6.1 Terra:** Read `CLAUDE.md`, `docs/ARCHITECTURE.md`, and `docs/DEPLOYMENT.md` first. Every merge to `main` deploys to Cloud Run.
> **Behavior-preserving refactor only.** Do not change Socket.IO event names, payload shapes, HTTP routes, error strings, rate limits, backup bucket behavior (`DEFAULT_BACKUP_BUCKET`), or `StartServerOptions` / `startServer()` return shape.
> **Strict Node 22 rules (`tsconfig.json` has `erasableSyntaxOnly: true`):**
>
> - Every file in `server/` must use **strictly erasable TypeScript** (no `enum`, `namespace`, parameter properties, or `import x = require()`).
> - Use `import type` for type-only imports and **explicit `.ts` extensions** on all relative imports.
> - Never import React, CSS, Playwright, or devDependencies into `server.ts` or `server/`.

## Why this split matters

`server.ts` is ~3,522 lines, with ~3,260 lines nested inside the single `startServer()` closure and 44 `socket.on(...)` handlers sharing mutable maps (`rooms`, `socketMeta`, `dirtyRooms`, `pendingDigests`, `pendingCursors`). Moving logical subsystems into `server/` with an explicit `ServerContext` breaks that monolithic closure into testable, single-purpose modules while keeping `src/lib/socketContract.ts` as the compile-time guardrail.

---

## Phase 1 — `server/types.ts`, `server/roomSerialization.ts`, and `server/httpRoutes.ts`

1. Create `server/types.ts`:
   - Move `StartServerOptions`, `UserKeyCheck`, `ServerUserRecord`, `BannedUserRecord`, `SubBoardState`, `BreakoutConfigState`, `TimerState`, `RoomState`, and `SerializedRoom` out of `server.ts` (keeping `StartServerOptions` re-exported from `server.ts` so existing tests and `e2e/serve.ts` keep compiling untouched).
   - Define `TypedIo = Server<ClientToServerEvents, ServerToClientEvents>` and `TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>`, plus `SocketMeta` (`{ roomId: string; userId: string; channel?: string; viewBoardId?: string; inTeachers?: boolean }`).
   - Define `ServerContext` holding the shared dependencies passed into extracted modules (`io`, `store`, `backup`, `rooms`, `socketMeta`, `pinFailures`, and lifecycle callbacks added in Phases 2–4).
2. Create `server/roomSerialization.ts`:
   - Move pure room/background/round serialization & validation helpers:
     - `ROOM_TTL_MS`, `IDLE_UNLOAD_MS`, `HOUSEKEEPING_INTERVAL_MS`, `PIN_FAILURES_PER_WINDOW`, `PIN_FAILURE_WINDOW_MS`, `MAX_CHAT_CHARS`, `USER_KEY_PATTERN`, `MAX_GROUPS_PER_ROUND`, `PIN_BLOCKED_ERROR`
     - `checkUserKey`, `normalizeRoomId`, `serializeSubBoards`, `deserializeSubBoards`, `storedPinHash`, `isRoomEmpty`, `cloneBackground`
     - `cleanImportedRoundTemplates`, `storedTemplateInk`, `storedRoundVariants`, `cleanRoundVariants`, `cleanImportedRoundVariants`, `cleanImportedTemplateInk`
     - `getRosterPayload`, `getRoomSettingsPayload`, `cleanRoundTitle`, `payloadWorksheet` (pure parts)
3. Create `server/httpRoutes.ts`:
   - Move `registerHttpRoutes(app, deps)` for `/healthz`, `/api/report`, `/api/rooms/:roomId` (`getRoomAvailability`), and `/api/assets/:hash`.

### Phase 1 Checkpoint

```sh
npm run lint
npm test
node -e "import('./server.ts').then(() => console.log('OK'))"
```

---

## Phase 2 — `server/roomPersistence.ts` and `server/boardChannels.ts`

1. Create `server/roomPersistence.ts`:
   - Move `DEFAULT_BACKUP_BUCKET`, `isProductionRuntime`, and `openBackupMirror` (exporting `openBackupMirror` or keeping it tested cleanly).
   - Extract room lifecycle/persistence manager (`createRoomPersistence(...)`):
     - `hydrateRoom`, `serializeRoom`, `internRoomAssets`, `migrateLegacyJsonStore`, `restoreFromBackup`, `backupRoom`
     - `dirtyRooms`, `saveTimeout`, `flushRoomsToDisk`, `flushRoomsToDiskAsync`, `scheduleSaveToDisk`
     - `roomHasActiveSockets`, `runHousekeeping`, `findRoom`, `getOrCreateRoom`, `getRoomAvailability`
   - Preserve exact boot order documented in `docs/ARCHITECTURE.md` §4 (`RoomStore` → `openBackupMirror` → `migrateLegacyJsonStore` → `restoreFromBackup` → listen).
2. Create `server/boardChannels.ts`:
   - Move channel routing, digests, cursor batching, and shared edit publishing:
     - `boardChannel`, `teacherChannel`, `boardAudience`, `boardElementsOf`
     - `pendingDigests` (`noteChange`, `flushDigests`), `pendingCursors` (`flushCursors`)
     - `placeSocket`, `syncBoardChannels`, `subBoardsFor`, `broadcastRoster`, `broadcastRoomSettings`, `broadcastBreakoutSync`, `teacherTemplatesPayload`
     - `publishDrawingEdit` (activity timestamp, `scheduleSaveToDisk`, digest tracking, board-audience emit)

### Phase 2 Checkpoint

```sh
npm run lint
npm test
node -e "import('./server.ts').then(() => console.log('OK'))"
```

---

## Phase 3 — `server/breakoutHandlers.ts` and `server/lessonPackHandlers.ts`

1. Create `server/breakoutHandlers.ts`:
   - Move round/template-ink/variant helpers:
     - `setRoundVariants`, `mainTemplateInk`, `setRoundTemplateInk`, `templateInkForBoard`, `stampTemplateInkOnGroupBoards`
     - `getBreakoutStudents`, `getRoundTemplate`, `provisionIndividualBoard`, `variantWorksheetFor`, `studentsInDealOrder`
     - `applyRoundEdits`, `createGroupBoards`, `createRound`, `launchPreparedRound`, `editPreparedRound`, `ensureIndividualBoardForUser`, `startAutoIndividualRound`
   - Move `registerBreakoutHandlers(socket, ctx, state)` for:
     - `teacher:configure-breakout`, `teacher:spotlight-board`, `teacher:view-board`, `breakout:join-board`, `teacher:set-background`, `teacher:set-background-multi`, `teacher:set-round-variants`, `teacher:update-background`.
2. Create `server/lessonPackHandlers.ts`:
   - Move `teacherIdsOf`, `buildLessonForRoom`, `checkIncomingLesson`, `lessonInk`, `removeRound`, `applyLessonToRoom`.
   - Move `registerLessonPackHandlers(socket, ctx)` for:
     - `teacher:import-room`, `teacher:export-lesson`, `teacher:has-assets`, `teacher:upload-asset`, `teacher:load-lesson`.

### Phase 3 Checkpoint

```sh
npm run lint
npm test
node -e "import('./server.ts').then(() => console.log('OK'))"
```

---

## Phase 4 — `server/drawingHandlers.ts` and `server/moderationHandlers.ts`

1. Create `server/drawingHandlers.ts`:
   - Move `registerDrawingHandlers(socket, ctx, boardFull)` for:
     - `element-start`, `element-append-points`, `element-update`, `elements-batch-update`, `elements-batch-add`, `elements-batch-remove`, `elements-replace`, `element-remove`, `laser-pulse`, `cursor-move`, `undo`, `clear-user-drawings`, `teacher:clear-all`.
2. Create `server/moderationHandlers.ts`:
   - Move `registerModerationHandlers(socket, ctx, sessionState)` (where `sessionState` holds per-socket `provenPin` / `boardFull`) for:
     - `check-room`, `join-room`, `teacher:auth`, `user:set-status`, `teacher:clear-status`, `teacher:step-down`, `update-profile`, `teacher:rename-user`, `teacher:delete-message`, `teacher:kick-user`, `teacher:unban-user`, `teacher:purge-user-contributions`, `chat-message`, `teacher:set-hide-cursors`, `teacher:set-one-name-stamp`, `teacher:set-lock`, `teacher:timer-control`, `disconnect`.
3. Shrink `server.ts` to ~250–350 lines:
   - Initializes `store`, `backup`, `app`, `httpServer`, `io`, `persistence`, `channels`, load monitoring (`loopDelay` + `[load]` log line), `timerTickInterval`, Vite/static asset mounting, `io.on('connection')` wrapper (per-socket arrival queue + `socketGuards` rate limiter + handler registration), `SIGTERM`/`SIGINT` flush, and `close()`.
4. Update `docs/ARCHITECTURE.md` §3 with the new `server/*.ts` files.

### Final Verification

```sh
npm run lint
npm test
npm run build
bash scripts/smoke.sh
npm run test:e2e
```
