# Plan: Typed Client–Server Socket.IO Contract

> **For Code 6.1 Terra:** Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first. Every merge to `main` deploys to production.
> Keep shared server-imported code strictly erasable TypeScript (no `enum`, `namespace`, parameter properties, or `import x = require()`), use `import type` for type-only imports, and use explicit `.ts` extensions on relative server imports.

## Goal

Eliminate untyped Socket.IO event strings and `as any` payload casts across `server.ts`, `src/App.tsx`, `src/components/Canvas.tsx`, and `tests/socketHelpers.ts` by introducing a single shared contract (`ClientToServerEvents` and `ServerToClientEvents`). Once in place, TypeScript (`npm run lint`) will verify event names, payload shapes, and ack callback signatures across client and server before any future refactor splits `server.ts` or `App.tsx`.

**Do not change runtime behavior or relax server validation.** TypeScript types erase at runtime; every existing runtime check in `server.ts` and `socketGuards.ts` (`typeof`, `Array.isArray`, finite-number bounds, teacher authorization) must stay intact.

---

## Phase 1 — Create `src/lib/socketContract.ts` (types only, no behavioral code)

Create `src/lib/socketContract.ts` exporting only TypeScript interfaces/types (no runtime code, no React/DOM/Node imports).

Verify exact current payloads from `server.ts` and `src/App.tsx` before finalizing each entry, covering **all 44 client→server events** and **all server→client events**:

1. **Common ack shapes:**
   - `export interface BasicAck { ok: boolean; error?: string }`
   - `export interface AuthAck extends BasicAck { mode?: 'claimed' | 'verified'; pin?: string }`
   - `export interface BreakoutAck extends BasicAck { roundId?: string }`
   - `export interface MultiBgAck extends BasicAck { updated?: number; skipped?: string[] }`
   - `export interface ImportRoomAck extends BasicAck { connectionError?: boolean }`
   - `export interface LessonExportAck extends BasicAck { lesson?: unknown }` (use `LessonPack` from `./lessonPack.ts`)
   - `export interface LessonHasAssetsAck extends BasicAck { missing?: string[] }`
   - `export interface LessonUploadAssetAck extends BasicAck { url?: string }`
   - `export interface LessonLoadAck extends BasicAck { roomId?: string; roundIds?: string[] }`

2. **`ClientToServerEvents`** (match every `socket.on(...)` in `server.ts`):
   - `check-room`: `(payload: { roomId?: string } | undefined, callback?: (res: RoomAvailability) => void) => void`
   - `join-room`: `(payload: { roomId?: string; userId: string; userKey?: string; name: string; color: string; teacherPin?: string }) => void`
   - `teacher:auth`: `(payload: { pin: string }, callback?: (res: AuthAck) => void) => void`
   - `user:set-status`: `(payload: { status?: StudentStatus | unknown } | undefined) => void`
   - `teacher:clear-status`: `(payload: { targetUserId?: string } | undefined) => void`
   - `teacher:step-down`: `() => void`
   - `teacher:configure-breakout`: `(payload: ConfigureBreakoutPayload, callback?: (res: BreakoutAck) => void) => void`
   - `teacher:spotlight-board`: `(payload: SpotlightPayload, callback?: (res: BasicAck) => void) => void`
   - `teacher:view-board`: `(payload: { boardId?: string } | undefined) => void`
   - `breakout:join-board`: `(payload: { targetBoardId: string; targetUserId?: string }) => void`
   - `teacher:set-background`: `(payload: { boardId?: string; background: RoomBackground | null }, callback?: (res: BasicAck) => void) => void`
   - `teacher:set-background-multi`: `(payload: { boardIds: string[]; background: RoomBackground | null; roundTemplateFor?: string }, callback?: (res: MultiBgAck) => void) => void`
   - `teacher:set-round-variants`: `(payload: { roundId: string; variants: RoundVariants | null }, callback?: (res: BasicAck) => void) => void`
   - `teacher:update-background`: `(payload: { boardId?: string; patch: Partial<RoomBackground> }) => void`
   - `teacher:import-room`: `(payload: ClassWorkData & { mode: ImportRestoreMode }, callback?: (res: ImportRoomAck) => void) => void`
   - `teacher:export-lesson`: `(payload: Record<string, unknown>, callback?: (res: LessonExportAck) => void) => void`
   - `teacher:has-assets`: `(payload: { urls: string[] }, callback?: (res: LessonHasAssetsAck) => void) => void`
   - `teacher:upload-asset`: `(payload: { url?: string; dataUrl: string }, callback?: (res: LessonUploadAssetAck) => void) => void`
   - `teacher:load-lesson`: `(payload: { lesson: LessonPack; target: 'new' | 'current'; roomId?: string; pin?: string }, callback?: (res: LessonLoadAck) => void) => void`
   - `update-profile`: `(payload: { name?: string; color?: string }) => void`
   - `teacher:rename-user`: `(payload: { targetUserId: string; newName: string }, callback?: (res: BasicAck) => void) => void`
   - `teacher:delete-message`: `(payload: { messageId: string; boardId?: string }, callback?: (res: BasicAck) => void) => void`
   - `teacher:kick-user`: `(payload: { targetUserId: string; mode?: 'kick' | 'ban'; targetName?: string }, callback?: (res: BasicAck) => void) => void`
   - `teacher:unban-user`: `(payload: { targetUserId: string }, callback?: (res: BasicAck) => void) => void`
   - `teacher:purge-user-contributions`: `(payload: { targetUserId?: string }, callback?: (res: BasicAck) => void) => void`
   - `chat-message`: `(payload: Partial<ChatMessage> & { text: string; boardId?: string }) => void`
   - `element-start`: `(element: CanvasElement) => void`
   - `element-append-points`: `(payload: { id: string; boardId?: string; newPoints: number[] }) => void`
   - `element-update`: `(patch: Partial<CanvasElement> & { id: string; boardId?: string; bringToFront?: boolean }) => void`
   - `elements-batch-update`: `(payload: { boardId?: string; updates: Array<Partial<CanvasElement> & { id: string }>; bringToFront?: boolean }) => void`
   - `elements-batch-add`: `(payload: { boardId?: string; elements: CanvasElement[] }) => void`
   - `elements-batch-remove`: `(payload: { boardId?: string; ids: string[] }) => void`
   - `elements-replace`: `(payload: { boardId?: string; groups: ElementGroup<CanvasElement>[] }) => void`
   - `element-remove`: `(payload: { id: string; boardId?: string }) => void`
   - `laser-pulse`: `(payload: { boardId?: string; x: number; y: number; color?: string }) => void`
   - `cursor-move`: `(cursor: Omit<RemoteCursor, 'updatedAt'>) => void`
   - `undo`: `(payload: { elementId?: string; boardId?: string } | undefined) => void`
   - `clear-user-drawings`: `(payload: { targetUserId?: string; boardId?: string } | undefined) => void`
   - `teacher:set-hide-cursors`: `(hide: boolean) => void`
   - `teacher:set-one-name-stamp`: `(enabled: boolean) => void`
   - `teacher:set-lock`: `(isLocked: boolean) => void`
   - `teacher:timer-control`: `(payload: TimerControlPayload, callback?: (res: BasicAck) => void) => void`
   - `teacher:clear-all`: `(payload: { boardId?: string } | undefined) => void`

   *(Inspect the exact signatures in `server.ts` lines 1651–3398 and `src/components/LessonPackModals.tsx` / `src/App.tsx` so every field name matches existing runtime code verbatim.)*

3. **`ServerToClientEvents`** (match every `socket.emit(...)` / `io.to(...).emit(...)` in `server.ts`):
   - `init`, `state-sync`, `breakout-sync`, `round-templates-sync`, `background-sync`, `board-replaced`, `room-restored`, `roster-sync`, `room-settings`, `user-renamed`, `message-deleted`, `user-contributions-purged`, `room-kicked`, `chat-message`, `element-start`, `element-append-points`, `element-update`, `elements-batch-updated`, `elements-batch-added`, `elements-batch-removed`, `elements-replaced`, `element-removed`, `board-full`, `boards-digest`, `cursors-batch`, `cursor-leave`, `laser-pulse`.

### Phase 1 Checkpoint
- `npm run lint`
- `npm test`

---

## Phase 2 — Type `server.ts`

1. In `server.ts`, import `type { ClientToServerEvents, ServerToClientEvents }` from `'./src/lib/socketContract.ts'`.
2. Instantiate `io` as:
   ```ts
   const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, { ... });
   ```
3. Fix every resulting TypeScript error by tightening handler parameter types (not by casting back to `any`), specifically:
   - Remove `= {} as any` on `elements-replace` (still guard `const boardId = payload?.boardId || 'main'; const groups = payload?.groups;` defensively at runtime!).
   - Keep `socketGuards.ts` wrapping cleanly; type `guardSocket` generics if needed, without weakening runtime validation.
4. Keep every runtime validation check intact (`tests/guards.test.ts` sends intentionally malformed payloads at runtime — verify it keeps passing).

### Phase 2 Checkpoint
- `npm run lint`
- `npm test`
- `node -e "import('./server.ts').then(() => console.log('OK'))"`

---

## Phase 3 — Type `src/App.tsx`, `src/components/Canvas.tsx`, and `tests/socketHelpers.ts`

1. In `src/App.tsx`:
   - Type `socket` state as `Socket<ServerToClientEvents, ClientToServerEvents> | null`.
   - Remove redundant inline payload annotations and `(res: any)` callbacks where inferred from `ClientToServerEvents` / `ServerToClientEvents`.
2. In `src/components/Canvas.tsx`:
   - Update `CanvasProps.laserSocket` to `Socket<ServerToClientEvents, ClientToServerEvents> | null` (verify `laser-pulse` listener & emitter in `Canvas.tsx` lines 1150–1200 match the contract).
3. In `tests/socketHelpers.ts` (and `tests/server.test.ts` / `tests/lessonPackServer.test.ts` / `tests/roundVariantsServer.test.ts` if helpful):
   - Type the helper `Socket` if clean, or leave intentional malformed-payload tests using explicit test casts only inside `tests/`.
4. Update `docs/ARCHITECTURE.md` §3 (`src/lib/socketContract.ts`).

### Final Verification
```sh
npm run lint
npm test
npm run build
bash scripts/smoke.sh
npm run test:e2e
```
