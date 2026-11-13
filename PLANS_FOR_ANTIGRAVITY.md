# AllAboard — Multi-Round Breakout Rooms: Implementation Plan

> **Who this is for:** an implementing agent (Gemini Flash / Antigravity).
> **How to use it:** Do the phases **in order**. Each phase lists exact files, exact
> functions, and code to paste. Each phase ends with a **checkpoint**. Do not start the
> next phase until its checkpoint passes. The architecture decisions are already made
> (see Appendix A). Do not redesign anything. If something in the code does not match
> this plan, stop and report it. Do not improvise a different design.

---

## 0. Read this first

### 0.1 The problem in one paragraph

Breakout boards live in `room.subBoards` and are keyed by fixed IDs (`ind_<userId>`,
`grp_1`, `grp_2`, …). That means a teacher can only ever run **one** breakout activity.
Launching a second one either sends students back into their old, already-drawn-on
boards, or overwrites them. We are adding **rounds**. Each breakout launch creates a
new round with its own boards. Old rounds stay saved, and the teacher can view and
export them. The teacher can also pull everyone to the Main Board and later **resume**
the same round.

### 0.2 Mental model (memorize these 5 facts)

1. A **round** is one breakout activity. Its metadata lives in
   `breakoutConfig.rounds: BreakoutRoundMeta[]`. Round IDs are `r1`, `r2`, `r3`, …
2. Exactly one round is the **active round**: `breakoutConfig.activeRoundId`.
   Students are only ever routed to boards in the active round.
3. `breakoutConfig.mode` still says where students are right now: `'main'`,
   `'individual'`, or `'groups'`. Setting `mode = 'main'` **never deletes or changes any
   board**.
4. Every sub-board has two new fields: `roundId` (which round it belongs to) and `kind`
   (`'individual'` or `'group'`). **All logic uses these fields. Never parse a board ID
   string to find out its kind or round** (no more `id.startsWith('grp_')`).
5. New board IDs are `r2_ind_<userId>` and `r2_grp_1`. Old (legacy) boards keep
   their old IDs (`ind_<userId>`, `grp_1`). The migration only adds `roundId: 'r1'` and
   `kind` to them. Because of fact 4, the ID format does not matter to any logic.

### 0.3 The four teacher actions (the whole feature)

All four go through the **existing** socket event `teacher:configure-breakout`, using a
new `action` field. (The old spec said `breakout:configure`. That event does not exist,
so do not create it.)

| `action`           | What it does                                                                                      | Touches drawings? |
|--------------------|---------------------------------------------------------------------------------------------------|-------------------|
| `'new-round'`      | Creates round N+1 with fresh boards, makes it active, sets `mode` to `'individual'`/`'groups'`.    | Creates empty boards only |
| `'resume'`         | Sets `activeRoundId` to a round (default: the current active round) and `mode` to that round's mode. Can also apply group/assignment edits. | **Never** |
| `'update-current'` | Edits the active round: group titles, student→group assignments, `allowSelfSelect`, `chatScope`. Does **not** change `mode`. | **Never** |
| `'return-to-main'` | Sets `mode = 'main'`. Nothing else.                                                                 | **Never** |

### 0.4 Hard rules for the implementer

- **R1.** After every phase, run `npm run lint` and `npm test`. Both must pass before you continue.
- **R2.** Do not rename existing socket events. Do not add new socket events. The only protocol change is new optional fields on the `teacher:configure-breakout` payload.
- **R3.** `resume`, `update-current` and `return-to-main` must **never** assign to a board's `elements`, `background`, or `messages`.
- **R4.** Never use `startsWith('ind_')`, `startsWith('grp_')`, `` `ind_${...}` `` or `` `grp_${...}` `` for lookups anywhere in `server.ts` or `src/`. Use the helpers in `src/lib/breakoutRounds.ts`. Before finishing, run the grep in Phase 8 to confirm.
- **R5.** Do not touch code unrelated to breakouts (ink rendering, timer, moderation, chat UI, and so on).
- **R6.** Keep existing Tailwind class styles. When adding UI, copy class strings from neighboring buttons/selects in the same file.
- **R7.** Commit after each phase with a message like `feat(breakout-rounds): phase N – <summary>`.

### 0.5 Files you will touch

| File | Phase | What changes |
|---|---|---|
| `src/types.ts` | 1 | New types + new optional fields |
| `src/lib/breakoutRounds.ts` (**new**) | 2 | Pure helper functions shared by server and client |
| `tests/breakoutRounds.test.ts` (**new**) | 2 | Unit tests for the helpers |
| `server.ts` | 3 | Migration, `teacher:configure-breakout`, `breakout:join-board`, late joiners, renames, `ALL_SUBBOARDS`, import |
| `tests/server.test.ts` | 4 | Update one assertion, add round tests |
| `src/App.tsx` | 5 | `activeBoardId`, `handleConfigureBreakout` type, rename handler |
| `src/lib/batchPdfExport.ts` | 6 | Optional `fileLabel` param (1-line change) |
| `src/components/Canvas.tsx` | 6 | Round selector, quick buttons, board lists, modal wiring, PDF export |
| `src/components/CanvasModals.tsx` | 7 | `BreakoutManagerModal` tabs, `LiveGridOverview` boards + live reassignment |

### 0.6 Baseline

Before you start, run `npm run lint && npm test`. At the time of writing, both pass
(24 tests). If they don't pass, stop and report.

---

## Phase 1: Types (`src/types.ts`)

### 1.1 Add new types

Directly **above** `export interface SubBoardData`, add:

```ts
export type SubBoardKind = 'individual' | 'group';

export interface BreakoutRoundMeta {
  id: string;                       // 'r1', 'r2', ...
  number: number;                   // 1, 2, ...
  title: string;                    // 'Round 2 · Groups · Frayer Model'
  mode: 'individual' | 'groups';
  createdAt: number;
}

export type BreakoutAction = 'new-round' | 'resume' | 'update-current' | 'return-to-main';

export interface BreakoutGroupDraft {
  id: string;
  title: string;
  assignedUserIds: string[];
}

/** Payload of the `teacher:configure-breakout` socket event. Every field is optional. */
export interface ConfigureBreakoutPayload {
  action?: BreakoutAction;
  mode?: BreakoutMode;                       // used by 'new-round' (and legacy callers)
  roundId?: string;                          // used by 'resume' (defaults to active round)
  allowSelfSelect?: boolean;
  chatScope?: 'unified' | 'board';
  copyWorksheet?: boolean;                   // 'new-round' only
  customBackground?: RoomBackground | null;  // 'new-round' only
  groups?: BreakoutGroupDraft[];             // 'new-round': ids ignored. 'resume'/'update-current': ids must be real board ids
  templateLabel?: string;                    // 'new-round' only, used in the round title
}
```

### 1.2 Extend existing interfaces

Change `SubBoardData` to:

```ts
export interface SubBoardData {
  id: string;
  roundId?: string;        // 'r1', 'r2', ... (always set by the server after migration)
  kind?: SubBoardKind;     // 'individual' | 'group' (always set by the server after migration)
  title: string;
  assignedUserIds: string[];
  elements: CanvasElement[];
  background: RoomBackground | null;
  messages: ChatMessage[];
}
```

Change `BreakoutConfig` to:

```ts
export interface BreakoutConfig {
  mode: BreakoutMode;
  activeRoundId?: string;
  rounds?: BreakoutRoundMeta[];
  allowSelfSelect: boolean;
  chatScope: 'unified' | 'board';
}
```

**Checkpoint 1:** `npm run lint` passes. (Every new field is optional, so nothing else breaks.)

---

## Phase 2: Shared helper module (`src/lib/breakoutRounds.ts`)

This file is **pure**. It has no React, no socket.io, no `fs`, and no `Date.now()` except
inside the migration. Both `server.ts` and the React client import it. **Paste this file
exactly.**

```ts
// src/lib/breakoutRounds.ts
// Pure helpers for multi-round breakout boards. Shared by server.ts and the React client.
// RULE: never infer a board's round or kind from its id. Use `roundId` / `kind`.

import type {
  BreakoutAction,
  BreakoutMode,
  BreakoutRoundMeta,
  ConfigureBreakoutPayload,
  SubBoardKind,
} from '../types';

/** Minimal board shape. Works for both server SubBoardState and client SubBoardData. */
export interface BoardLike {
  id: string;
  title: string;
  roundId?: string;
  kind?: SubBoardKind;
  assignedUserIds: string[];
}

/** Minimal breakout config shape. Works for both server and client. */
export interface BreakoutConfigLike {
  mode: BreakoutMode;
  activeRoundId?: string;
  rounds?: BreakoutRoundMeta[];
  allowSelfSelect: boolean;
  chatScope: 'unified' | 'board';
}

export type BoardCollection<B> = Map<string, B> | Record<string, B>;

export function toBoardList<B extends BoardLike>(boards: BoardCollection<B>): B[] {
  return boards instanceof Map ? Array.from(boards.values()) : Object.values(boards);
}

// ---------- IDs & titles ----------

export function makeRoundId(roundNumber: number): string {
  return `r${roundNumber}`;
}

export function makeIndividualBoardId(roundId: string, userId: string): string {
  return `${roundId}_ind_${userId}`;
}

/** groupIndex is 0-based; the id is 1-based (r2_grp_1 is the first group). */
export function makeGroupBoardId(roundId: string, groupIndex: number): string {
  return `${roundId}_grp_${groupIndex + 1}`;
}

export function buildRoundTitle(
  roundNumber: number,
  mode: 'individual' | 'groups',
  templateLabel?: string
): string {
  const modeLabel = mode === 'groups' ? 'Groups' : 'Individual';
  const label = typeof templateLabel === 'string' ? templateLabel.trim().slice(0, 40) : '';
  return label ? `Round ${roundNumber} · ${modeLabel} · ${label}` : `Round ${roundNumber} · ${modeLabel}`;
}

export function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((x): x is string => typeof x === 'string' && x.length > 0)));
}

// ---------- Round lookups ----------

/** Rounds sorted by number ascending. Always returns a new array. */
export function getRounds(config: BreakoutConfigLike): BreakoutRoundMeta[] {
  return Array.isArray(config.rounds) ? [...config.rounds].sort((a, b) => a.number - b.number) : [];
}

export function getRoundById(
  config: BreakoutConfigLike,
  roundId: string | null | undefined
): BreakoutRoundMeta | null {
  if (!roundId) return null;
  return getRounds(config).find((r) => r.id === roundId) || null;
}

export function getActiveRound(config: BreakoutConfigLike): BreakoutRoundMeta | null {
  return getRoundById(config, config.activeRoundId);
}

export function getNextRoundNumber(config: BreakoutConfigLike): number {
  return getRounds(config).reduce((max, r) => Math.max(max, r.number), 0) + 1;
}

// ---------- Board lookups ----------

function compareBoards(a: BoardLike, b: BoardLike): number {
  if (a.kind === 'group' && b.kind === 'group') {
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  }
  return a.title.localeCompare(b.title, undefined, { numeric: true });
}

/** All boards in one round, sorted (groups by number, individuals by title). */
export function getBoardsInRound<B extends BoardLike>(
  boards: BoardCollection<B>,
  roundId: string | null | undefined
): B[] {
  if (!roundId) return [];
  return toBoardList(boards)
    .filter((sb) => sb.roundId === roundId)
    .sort(compareBoards);
}

/** Every board in every round, ordered by round number, then sorted inside each round. */
export function getAllBoardsByRound<B extends BoardLike>(
  boards: BoardCollection<B>,
  config: BreakoutConfigLike
): B[] {
  const order = new Map(getRounds(config).map((r) => [r.id, r.number] as const));
  return toBoardList(boards)
    .slice()
    .sort((a, b) => {
      const ra = order.get(a.roundId ?? '') ?? Number.MAX_SAFE_INTEGER;
      const rb = order.get(b.roundId ?? '') ?? Number.MAX_SAFE_INTEGER;
      return ra !== rb ? ra - rb : compareBoards(a, b);
    });
}

/**
 * Which board should a STUDENT see right now? Returns a board id or 'main'.
 * - mode 'main' or no active round      -> 'main'
 * - individual: their individual board in the active round
 * - groups: the group in the active round that lists them; else the first group (legacy behavior)
 */
export function findStudentBoardId<B extends BoardLike>(
  boards: BoardCollection<B>,
  config: BreakoutConfigLike,
  userId: string
): string {
  if (config.mode === 'main') return 'main';
  const round = getActiveRound(config);
  if (!round) return 'main';
  const wantedKind: SubBoardKind = config.mode === 'groups' ? 'group' : 'individual';
  const roundBoards = getBoardsInRound(boards, round.id).filter((sb) => sb.kind === wantedKind);
  const mine = roundBoards.find((sb) => sb.assignedUserIds.includes(userId));
  if (mine) return mine.id;
  if (wantedKind === 'group' && roundBoards.length > 0) return roundBoards[0].id;
  return 'main';
}

// ---------- Normalization & migration (server-side use) ----------

/** Turns any persisted / imported value into a valid config object. Never throws. */
export function normalizeBreakoutConfig(raw: unknown): BreakoutConfigLike {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<BreakoutConfigLike>;
  const mode: BreakoutMode = r.mode === 'individual' || r.mode === 'groups' ? r.mode : 'main';
  const rounds = Array.isArray(r.rounds)
    ? r.rounds.filter(
        (x): x is BreakoutRoundMeta =>
          !!x &&
          typeof x.id === 'string' &&
          typeof x.number === 'number' &&
          (x.mode === 'individual' || x.mode === 'groups')
      )
    : [];
  const activeRoundId =
    typeof r.activeRoundId === 'string' && rounds.some((x) => x.id === r.activeRoundId)
      ? r.activeRoundId
      : undefined;
  return {
    mode,
    activeRoundId,
    rounds,
    allowSelfSelect: Boolean(r.allowSelfSelect),
    chatScope: r.chatScope === 'board' ? 'board' : 'unified',
  };
}

/** Legacy ids were exactly 'ind_<userId>' or 'grp_<n>'. Only used during migration. */
export function inferLegacyKind(boardId: string): SubBoardKind {
  return boardId.startsWith('grp_') ? 'group' : 'individual';
}

/**
 * MUTATES `boards` and `config` in place. Safe to call repeatedly (idempotent).
 * 1. Gives every board a `kind`.
 * 2. Puts boards without a `roundId` into new round(s). If legacy individual AND group
 *    boards both exist, they become two rounds; the kind matching the current mode gets
 *    the higher number and becomes active.
 * 3. Makes `mode` consistent with the active round.
 * Returns true if anything changed.
 */
export function migrateLegacyBreakout<B extends BoardLike>(
  boards: Map<string, B>,
  config: BreakoutConfigLike
): boolean {
  let changed = false;
  const list = Array.from(boards.values());

  for (const sb of list) {
    if (!sb.kind) {
      sb.kind = inferLegacyKind(sb.id);
      changed = true;
    }
  }

  const untagged = list.filter((sb) => !sb.roundId);
  if (untagged.length > 0) {
    const rounds = getRounds(config);
    const activeKind: SubBoardKind = config.mode === 'groups' ? 'group' : 'individual';
    const otherKind: SubBoardKind = activeKind === 'group' ? 'individual' : 'group';
    let nextNumber = getNextRoundNumber(config);
    let lastCreatedId: string | undefined;

    for (const kind of [otherKind, activeKind]) {
      const ofKind = untagged.filter((sb) => sb.kind === kind);
      if (ofKind.length === 0) continue;
      const number = nextNumber++;
      const id = makeRoundId(number);
      const mode = kind === 'group' ? 'groups' : 'individual';
      rounds.push({ id, number, title: buildRoundTitle(number, mode), mode, createdAt: Date.now() });
      for (const sb of ofKind) sb.roundId = id;
      lastCreatedId = id;
    }

    config.rounds = rounds;
    if (!getActiveRound(config) && lastCreatedId) config.activeRoundId = lastCreatedId;
    changed = true;
  }

  if (!Array.isArray(config.rounds)) config.rounds = [];

  const active = getActiveRound(config);
  if (!active) {
    if (config.activeRoundId !== undefined) {
      config.activeRoundId = undefined;
      changed = true;
    }
    if (config.mode !== 'main') {
      config.mode = 'main';
      changed = true;
    }
  } else if (config.mode !== 'main' && config.mode !== active.mode) {
    config.mode = active.mode;
    changed = true;
  }
  return changed;
}

/**
 * Old clients send no `action`. Map them onto the new actions:
 * - mode 'main'                        -> 'return-to-main'
 * - no active round                    -> 'new-round'
 * - same mode as the active round      -> 'update-current' (+ server switches mode on)
 * - different mode                     -> 'new-round'
 */
export function resolveBreakoutAction(
  payload: ConfigureBreakoutPayload,
  config: BreakoutConfigLike
): BreakoutAction {
  if (payload.action) return payload.action;
  if (payload.mode === 'main') return 'return-to-main';
  const active = getActiveRound(config);
  if (!active) return 'new-round';
  return active.mode === payload.mode ? 'resume' : 'new-round';
}
```

> Note on `resolveBreakoutAction`: a legacy call with the *same* mode maps to `'resume'`
> (not `'update-current'`), because legacy callers expected that call to also send
> students into breakout mode.

### 2.1 Unit tests: create `tests/breakoutRounds.test.ts`

Use the same style as `tests/inkCore.test.ts` (`node:test` + `node:assert/strict`).
Write **at least** these test cases:

| # | Test name | Setup | Assert |
|---|---|---|---|
| 1 | `makes round and board ids` | — | `makeRoundId(2) === 'r2'`, `makeIndividualBoardId('r2','u1') === 'r2_ind_u1'`, `makeGroupBoardId('r2',0) === 'r2_grp_1'` |
| 2 | `getNextRoundNumber starts at 1 and follows the max` | config with no rounds → 1; with rounds numbered 1 and 3 → 4 | |
| 3 | `migrates legacy individual boards into r1` | Map with `ind_a`, `ind_b` (no roundId/kind); config `normalizeBreakoutConfig({mode:'individual'})` | both boards `roundId==='r1'`, `kind==='individual'`; `config.activeRoundId==='r1'`; `config.rounds.length===1`; `config.rounds[0].mode==='individual'`; function returned `true` |
| 4 | `migrates mixed legacy boards into two rounds, active kind last` | Map with `ind_a` and `grp_1`; config mode `'groups'` | `ind_a.roundId==='r1'`, `grp_1.roundId==='r2'`, `activeRoundId==='r2'`, `mode==='groups'` |
| 5 | `migration is idempotent` | run test 3's migration twice | second call returns `false`; still one round |
| 6 | `migration with no boards forces mode main` | empty Map; config `{mode:'groups'}` | `mode==='main'`, `activeRoundId===undefined` |
| 7 | `findStudentBoardId routes only within the active round` | boards `r1_ind_u1` (r1, individual, [u1]) and `r2_ind_u1` (r2, individual, [u1]); config `{mode:'individual', activeRoundId:'r2', rounds:[r1meta,r2meta]}` | returns `'r2_ind_u1'`; with `mode:'main'` returns `'main'` |
| 8 | `findStudentBoardId falls back to first group` | r1 group boards `r1_grp_1` [u2], `r1_grp_2` [u3]; mode groups, active r1; userId `u9` | returns `'r1_grp_1'`; userId `u3` returns `'r1_grp_2'` |
| 9 | `resolveBreakoutAction maps legacy payloads` | | `{mode:'main'}` → `'return-to-main'`; no rounds + `{mode:'individual'}` → `'new-round'`; active individual round + `{mode:'individual'}` → `'resume'`; active individual round + `{mode:'groups'}` → `'new-round'`; `{action:'update-current'}` → `'update-current'` |
| 10 | `getAllBoardsByRound orders by round number` | boards in r2 and r1 inserted in reverse order | r1 boards come first |

Import with: `import { ... } from '../src/lib/breakoutRounds';`

**Checkpoint 2:** `npm run lint && npm test` pass (should be 24 old + your new tests).
Commit.

---

## Phase 3: Server (`server.ts`)

Work through the steps top to bottom. Line numbers are approximate (from the commit this
plan was written against). Find the code by the **function or event name** shown.

### 3.1 Imports (top of file)

Below the existing imports, add:

```ts
import type { BreakoutRoundMeta, ConfigureBreakoutPayload, SubBoardKind } from './src/types';
import {
  BreakoutConfigLike,
  buildRoundTitle,
  getActiveRound,
  getBoardsInRound,
  getNextRoundNumber,
  getRoundById,
  getRounds,
  makeGroupBoardId,
  makeIndividualBoardId,
  makeRoundId,
  migrateLegacyBreakout,
  normalizeBreakoutConfig,
  resolveBreakoutAction,
  uniqueStrings,
} from './src/lib/breakoutRounds';
```

(If `tsc` complains that `BreakoutConfigLike` is a type, change it to `import type { BreakoutConfigLike }` on its own line.)

### 3.2 Server-side interfaces (~line 36–88)

1. In `interface SubBoardState`, add two fields after `id`:
   ```ts
   roundId?: string;
   kind?: SubBoardKind;
   ```
2. **Replace** the whole `interface BreakoutConfigState { ... }` with:
   ```ts
   type BreakoutConfigState = BreakoutConfigLike;
   ```
3. In `interface RoomState`, add:
   ```ts
   /** Worksheet background each round was launched with, used to provision late-joining students. Server-only; not broadcast. */
   roundTemplates: Record<string, any | null>;
   ```
4. In `interface SerializedRoom`, add:
   ```ts
   roundTemplates?: Record<string, any | null>;
   ```

### 3.3 `deserializeSubBoards` (~line 121)

Inside `map.set(k, { ... })`, add these two properties after `id: v.id,`:

```ts
roundId: typeof v.roundId === 'string' ? v.roundId : undefined,
kind: v.kind === 'group' || v.kind === 'individual' ? v.kind : undefined,
```

### 3.4 `loadRoomsFromDisk` (~line 140)

Inside the `for` loop, **before** `rooms.set(item.id, {...})`, add:

```ts
const subBoards = deserializeSubBoards(item.subBoards);
const breakoutConfig = normalizeBreakoutConfig(item.breakoutConfig);
migrateLegacyBreakout(subBoards, breakoutConfig);
```

Then in the `rooms.set(...)` object:
- replace `subBoards: deserializeSubBoards(item.subBoards),` with `subBoards,`
- replace the whole `breakoutConfig: item.breakoutConfig || { ... },` with `breakoutConfig,`
- add `roundTemplates: item.roundTemplates && typeof item.roundTemplates === 'object' ? item.roundTemplates : {},`

### 3.5 Save-to-disk serializer (~line 220, the `serialized.push({...})` block)

Add `roundTemplates: room.roundTemplates,` next to `breakoutConfig: room.breakoutConfig,`.

### 3.6 `getOrCreateRoom` (~line 320)

In the new-room object literal, add `roundTemplates: {},` and change the
`breakoutConfig` literal to:

```ts
breakoutConfig: { mode: 'main', activeRoundId: undefined, rounds: [], allowSelfSelect: false, chatScope: 'unified' },
```

### 3.7 New helper functions (put them directly above `ensureIndividualBoardForUser`, ~line 418)

```ts
function cloneBackground(bg: any | null | undefined): any | null {
  return bg ? JSON.parse(JSON.stringify(bg)) : null;
}

/** Students who should receive breakout boards. */
function getBreakoutStudents(room: RoomState): ServerUserRecord[] {
  return Array.from(room.usersByUserId.values()).filter((u) => !u.isTeacher);
}

/** Background used when the round was launched; falls back to any individual board's background in that round. */
function getRoundTemplate(room: RoomState, roundId: string): any | null {
  if (Object.prototype.hasOwnProperty.call(room.roundTemplates, roundId)) {
    return room.roundTemplates[roundId];
  }
  const sample = getBoardsInRound(room.subBoards, roundId).find((sb) => sb.kind === 'individual');
  return sample ? sample.background : null;
}

/** Creates `<roundId>_ind_<userId>` if this user has no individual board in that round. Returns true if created. */
function provisionIndividualBoard(
  room: RoomState,
  roundId: string,
  user: { userId: string; name: string }
): boolean {
  const existing = getBoardsInRound(room.subBoards, roundId).find(
    (sb) => sb.kind === 'individual' && sb.assignedUserIds.includes(user.userId)
  );
  if (existing) {
    existing.title = `${user.name}'s Board`;
    return false;
  }
  const id = makeIndividualBoardId(roundId, user.userId);
  room.subBoards.set(id, {
    id,
    roundId,
    kind: 'individual',
    title: `${user.name}'s Board`,
    assignedUserIds: [user.userId],
    elements: [],
    background: cloneBackground(getRoundTemplate(room, roundId)),
    messages: [],
  });
  return true;
}

/** Applies group titles/assignments + allowSelfSelect + chatScope to a round. NEVER touches elements/background/messages. */
function applyRoundEdits(room: RoomState, round: BreakoutRoundMeta, payload: ConfigureBreakoutPayload) {
  const cfg = room.breakoutConfig;
  if (typeof payload.allowSelfSelect === 'boolean') cfg.allowSelfSelect = payload.allowSelfSelect;
  if (payload.chatScope === 'board' || payload.chatScope === 'unified') cfg.chatScope = payload.chatScope;

  if (round.mode === 'groups' && Array.isArray(payload.groups)) {
    const seen = new Set<string>();
    for (const g of payload.groups) {
      if (!g || typeof g.id !== 'string') continue;
      const board = room.subBoards.get(g.id);
      if (!board || board.roundId !== round.id || board.kind !== 'group') continue; // ignore unknown ids
      if (typeof g.title === 'string' && g.title.trim()) board.title = g.title.trim().slice(0, 40);
      board.assignedUserIds = uniqueStrings(g.assignedUserIds).filter((uid) => !seen.has(uid));
      board.assignedUserIds.forEach((uid) => seen.add(uid));
    }
  }
}
```

### 3.8 Replace `ensureIndividualBoardForUser` (~line 419)

Replace the whole function with:

```ts
// If the room is in 'individual' mode and a student joins, make sure they have a board in the ACTIVE round.
function ensureIndividualBoardForUser(room: RoomState, userId: string, userName: string, isTeacher: boolean) {
  if (room.breakoutConfig.mode !== 'individual' || isTeacher) return false;
  const round = getActiveRound(room.breakoutConfig);
  if (!round || round.mode !== 'individual') return false;
  return provisionIndividualBoard(room, round.id, { userId, name: userName });
}
```

The call site in `join-room` does not change.

### 3.9 Replace the body of `teacher:configure-breakout` (~line 582)

Keep the event name. Replace the **entire** `socket.on('teacher:configure-breakout', ...)`
block with:

```ts
// Teacher Breakout & Individual Assignment Launcher (multi-round)
socket.on('teacher:configure-breakout', (payload: ConfigureBreakoutPayload, callback) => {
  const meta = socketMeta.get(socket.id);
  if (!meta) {
    callback?.({ ok: false, error: 'Not in a room.' });
    return;
  }
  const room = rooms.get(meta.roomId);
  if (!room) {
    callback?.({ ok: false, error: 'Room not found.' });
    return;
  }
  const callerRecord = room.usersByUserId.get(meta.userId);
  if (!callerRecord?.isTeacher) {
    callback?.({ ok: false, error: 'Only a verified Teacher can configure breakout boards.' });
    return;
  }

  const safePayload: ConfigureBreakoutPayload = payload && typeof payload === 'object' ? payload : {};
  const cfg = room.breakoutConfig;
  const action = resolveBreakoutAction(safePayload, cfg);

  if (action === 'return-to-main') {
    cfg.mode = 'main';
  } else if (action === 'resume' || action === 'update-current') {
    const round =
      action === 'resume'
        ? getRoundById(cfg, safePayload.roundId || cfg.activeRoundId)
        : getActiveRound(cfg);
    if (!round) {
      callback?.({ ok: false, error: 'There is no breakout round to resume or edit yet.' });
      return;
    }
    applyRoundEdits(room, round, safePayload);
    if (action === 'resume') {
      cfg.activeRoundId = round.id;
      cfg.mode = round.mode;
    }
    if (round.mode === 'individual' && cfg.mode === 'individual' && cfg.activeRoundId === round.id) {
      for (const u of getBreakoutStudents(room)) provisionIndividualBoard(room, round.id, u);
    }
  } else {
    // 'new-round'
    const mode: 'individual' | 'groups' = safePayload.mode === 'groups' ? 'groups' : 'individual';
    const groups = Array.isArray(safePayload.groups) ? safePayload.groups.filter(Boolean) : [];
    if (mode === 'groups' && groups.length === 0) {
      callback?.({ ok: false, error: 'Add at least one group before launching a group round.' });
      return;
    }

    const roundNumber = getNextRoundNumber(cfg);
    const roundId = makeRoundId(roundNumber);
    const templateBg =
      safePayload.customBackground !== undefined
        ? safePayload.customBackground
        : safePayload.copyWorksheet
        ? room.background
        : null;
    room.roundTemplates[roundId] = cloneBackground(templateBg);

    const roundMeta: BreakoutRoundMeta = {
      id: roundId,
      number: roundNumber,
      title: buildRoundTitle(roundNumber, mode, safePayload.templateLabel),
      mode,
      createdAt: Date.now(),
    };

    if (mode === 'individual') {
      for (const u of getBreakoutStudents(room)) provisionIndividualBoard(room, roundId, u);
    } else {
      const seen = new Set<string>();
      groups.forEach((g, i) => {
        const id = makeGroupBoardId(roundId, i);
        const assigned = uniqueStrings(g.assignedUserIds).filter((uid) => !seen.has(uid));
        assigned.forEach((uid) => seen.add(uid));
        room.subBoards.set(id, {
          id,
          roundId,
          kind: 'group',
          title: (typeof g.title === 'string' && g.title.trim()) ? g.title.trim().slice(0, 40) : `Group ${i + 1}`,
          assignedUserIds: assigned,
          elements: [],
          background: cloneBackground(templateBg),
          messages: [],
        });
      });
    }

    room.breakoutConfig = {
      mode,
      activeRoundId: roundId,
      rounds: [...getRounds(cfg), roundMeta],
      allowSelfSelect: Boolean(safePayload.allowSelfSelect),
      chatScope: safePayload.chatScope === 'board' ? 'board' : 'unified',
    };
  }

  room.lastActiveAt = Date.now();
  scheduleSaveToDisk(true);
  broadcastRoomSettings(room);
  broadcastBreakoutSync(room);
  callback?.({ ok: true, action, activeRoundId: room.breakoutConfig.activeRoundId });
});
```

> Important: in `'new-round'` the order matters. `provisionIndividualBoard` reads
> `room.roundTemplates[roundId]`, so `roundTemplates` must be set **before** the
> provisioning loop. The code above already does this. Do not reorder it.

### 3.10 Replace the body of `breakout:join-board` (~line 687)

Keep the signature `({ targetBoardId, targetUserId })`. Replace everything from
`const targetBoard = room.subBoards.get(targetBoardId);` through the
`if (!targetBoard.assignedUserIds.includes(...)) { ... }` block with:

```ts
const activeRound = getActiveRound(room.breakoutConfig);
const targetBoard = room.subBoards.get(targetBoardId);
// Only group boards in the ACTIVE round can be joined. Archived rounds are never edited here.
if (!activeRound || !targetBoard || targetBoard.roundId !== activeRound.id || targetBoard.kind !== 'group') {
  return;
}

for (const sb of getBoardsInRound(room.subBoards, activeRound.id)) {
  if (sb.kind === 'group') {
    sb.assignedUserIds = sb.assignedUserIds.filter((id) => id !== userToMove);
  }
}
targetBoard.assignedUserIds.push(userToMove);
```

Leave the permission checks above it and the save/broadcast lines below it unchanged.

### 3.11 `update-profile` (~line 900)

Replace:

```ts
const indBoard = room.subBoards.get(`ind_${userId}`);
if (indBoard) {
  indBoard.title = `${existing.name}'s Board`;
  broadcastBreakoutSync(room);
}
```

with:

```ts
let renamedBoard = false;
for (const sb of room.subBoards.values()) {
  if (sb.kind === 'individual' && sb.assignedUserIds[0] === userId) {
    sb.title = `${existing.name}'s Board`;
    renamedBoard = true;
  }
}
if (renamedBoard) broadcastBreakoutSync(room);
```

### 3.12 `teacher:rename-user` (~line 956)

Inside `for (const sb of room.subBoards.values())`, replace
`if (sb.id === \`ind_${targetUserId}\`) {` with:

```ts
if (sb.kind === 'individual' && sb.assignedUserIds[0] === targetUserId) {
```

### 3.13 `elements-batch-add` with `ALL_SUBBOARDS` (~line 1302)

Replace `for (const sb of room.subBoards.values()) {` (inside the `ALL_SUBBOARDS` branch
**only**) with:

```ts
for (const sb of getBoardsInRound(room.subBoards, room.breakoutConfig.activeRoundId)) {
```

This sends teacher broadcasts only to the current round. Archived rounds are never modified.

### 3.14 `teacher:import-room` (~line 785)

1. **Merge branch** (`if (mode === 'merge')`): replace the `if (importedSubBoards) { ... }` block with:
   ```ts
   if (importedSubBoards) {
     const parsedSubs = deserializeSubBoards(importedSubBoards);
     const importedCfg = normalizeBreakoutConfig(importedBreakoutConfig);
     migrateLegacyBreakout(parsedSubs, importedCfg);
     for (const [k, v] of parsedSubs.entries()) {
       if (!room.subBoards.has(k)) room.subBoards.set(k, v);
     }
     const knownRoundIds = new Set(getRounds(room.breakoutConfig).map((r) => r.id));
     const mergedRounds = getRounds(room.breakoutConfig);
     for (const r of getRounds(importedCfg)) {
       if (!knownRoundIds.has(r.id)) mergedRounds.push(r);
     }
     room.breakoutConfig.rounds = mergedRounds;
   }
   ```
2. **Readonly branch and replace branch**: in **both**, change
   `room.breakoutConfig = importedBreakoutConfig;` to
   `room.breakoutConfig = normalizeBreakoutConfig(importedBreakoutConfig);`
   and, in both, add `room.roundTemplates = {};` next to the
   `room.subBoards = deserializeSubBoards(importedSubBoards);` line.
3. **After** the whole `if / else if / else` (before the save/broadcast code that
   follows it), add:
   ```ts
   migrateLegacyBreakout(room.subBoards, room.breakoutConfig);
   ```
4. Check the `room-restored` emit that follows. If it does not include `breakoutConfig`
   (through `roomSettings`) and `subBoards`, add a `broadcastBreakoutSync(room);` call
   right after it.

**Checkpoint 3:** `npm run lint` passes. `npm test` will now have **one** expected failure in
`supports breakout boards, ALL_SUBBOARDS broadcast...`, because the board is now called
`r1_ind_stu-1`. You fix that in Phase 4. No other test may fail.

---

## Phase 4: Server tests (`tests/server.test.ts`)

### 4.1 Fix the existing test

In `it('supports breakout boards, ALL_SUBBOARDS broadcast, timer control, and snapshot restore'`,
replace the three occurrences of `'ind_stu-1'` with `'r1_ind_stu-1'`. Change nothing else.

### 4.2 Add a new `describe` block: `'multi-round breakouts'`

Put it inside the existing top-level `describe` so it can use `joinTracked`, `emitAck`,
`waitForEvent`, `delay`, and `srv`. Shared setup for every test below:

```ts
async function setupClass(roomId: string) {
  const { socket: teacher } = await joinTracked({ roomId, userId: 't1', name: 'Teacher' });
  await emitAck(teacher, 'teacher:auth', { pin: '1234' });
  const { socket: s1 } = await joinTracked({ roomId, userId: 's1', name: 'Sam' });
  const { socket: s2 } = await joinTracked({ roomId, userId: 's2', name: 'Ada' });
  return { teacher, s1, s2 };
}

function stroke(id: string, boardId: string, userId: string) {
  return { id, boardId, userId, userName: userId, tool: 'solid', color: '#000', strokeWidth: 4, points: [0, 0, 10, 10], timestamp: Date.now() };
}
```

Always register `waitForEvent(...)` **before** you emit the event you are waiting for.
After a fire-and-forget emit (`element-start`), `await delay(50)`.

Write these tests:

**T1 – resume preserves strokes**
1. `emitAck(teacher, 'teacher:configure-breakout', { action: 'new-round', mode: 'individual', chatScope: 'unified' })` → `ok === true`, `activeRoundId === 'r1'`.
2. `s1.emit('element-start', stroke('k1', 'r1_ind_s1', 's1'))`, then `await delay(50)`.
3. `emitAck(teacher, ..., { action: 'return-to-main' })`. Capture the `breakout-sync` it triggers on `teacher`. Assert `breakoutConfig.mode === 'main'` and `subBoards['r1_ind_s1'].elements.length === 1`.
4. `emitAck(teacher, ..., { action: 'resume' })`. Capture `breakout-sync`. Assert `mode === 'individual'`, `activeRoundId === 'r1'`, and `subBoards['r1_ind_s1'].elements.length === 1`.

**T2 – new round archives the old round**
1. Launch r1 individual, then draw `k1` on `r1_ind_s1` as in T1.
2. `emitAck(..., { action: 'new-round', mode: 'groups', groups: [{ id: 'grp_1', title: 'Red', assignedUserIds: ['s1'] }, { id: 'grp_2', title: 'Blue', assignedUserIds: ['s2', 's1'] }] })`.
3. From the `breakout-sync`, assert:
   - `breakoutConfig.activeRoundId === 'r2'` and `breakoutConfig.rounds.length === 2`
   - `subBoards['r2_grp_1'].title === 'Red'` and `assignedUserIds` deep-equals `['s1']`
   - `subBoards['r2_grp_2'].assignedUserIds` deep-equals `['s2']` (s1 de-duplicated)
   - `subBoards['r2_grp_1'].elements.length === 0`
   - `subBoards['r1_ind_s1'].elements.length === 1` and `subBoards['r1_ind_s1'].roundId === 'r1'`

**T3 – join-board only moves within the active round**
1. Launch r1 groups (`grp` drafts with s1 in group 1, s2 in group 2), then launch r2 groups with the same drafts.
2. `teacher.emit('breakout:join-board', { targetBoardId: 'r2_grp_2', targetUserId: 's1' })`. Capture `breakout-sync`. Assert `r2_grp_2` includes `s1`, `r2_grp_1` does not, and `r1_grp_1` **still** includes `s1`.
3. `teacher.emit('breakout:join-board', { targetBoardId: 'r1_grp_2', targetUserId: 's2' })`, then `await delay(100)`. Get a fresh state with any later `breakout-sync` (for example, emit `{ action: 'update-current' }` with `emitAck` and capture its sync). Assert `r1_grp_2.assignedUserIds` is unchanged (the archived round was ignored).

**T4 – late joiner gets a board in the active round with the round's worksheet**
1. Launch r1 individual with `customBackground: { id: 'bg1', fileName: 'frayer.png', pages: [], x: 0, y: 0, scale: 1, layout: 'row', opacity: 1 }`.
2. Register `waitForEvent(teacher, 'breakout-sync')`, then `joinTracked({ roomId, userId: 's3', name: 'Lee' })`.
3. Assert `subBoards['r1_ind_s3']` exists, `roundId === 'r1'`, and `background.fileName === 'frayer.png'`.

**T5 – ALL_SUBBOARDS only hits the active round**
1. Launch r1 individual, then launch r2 individual.
2. Teacher emits `elements-batch-add` with `boardId: 'ALL_SUBBOARDS'` (copy the element shape from the existing test). Capture `breakout-sync`.
3. Assert `r2_ind_s1.elements.length === 1` and `r1_ind_s1.elements.length === 0`.

**T6 – legacy rooms on disk are migrated**
Follow the pattern of the existing test `'persists room state asynchronously to disk and restores it on server restart'`
to stop `srv` and start a new server on the same `tmpDir`. Before you start the new server,
write `path.join(tmpDir, 'rooms-store.json')` yourself:

```ts
{
  rooms: [{
    id: 'legacy-room', messages: [], elements: [], background: null,
    subBoards: { 'ind_s1': { id: 'ind_s1', title: "Sam's Board", assignedUserIds: ['s1'], elements: [stroke('old', 'ind_s1', 's1')], background: null, messages: [] } },
    breakoutConfig: { mode: 'individual', allowSelfSelect: false, chatScope: 'unified' },
    isCanvasLocked: false, teacherPin: '1234', lastActiveAt: Date.now(),
  }],
}
```

Check how `loadRoomsFromDisk` reads the file (`parsed.rooms`) and match that shape exactly.
Then join as `s1` and assert from `init`:
- `init.subBoards['ind_s1'].roundId === 'r1'` and `.kind === 'individual'`
- `init.roomSettings.breakoutConfig.activeRoundId === 'r1'`
- `init.subBoards['ind_s1'].elements.length === 1`
- No new `r1_ind_s1` board was created (the legacy board was reused).

**T7 – non-teacher cannot configure**
A student emits `teacher:configure-breakout` with `{ action: 'new-round', mode: 'individual' }`. Assert `ok === false`.

**Checkpoint 4:** `npm run lint && npm test` all green. Commit.

---

## Phase 5: Client state (`src/App.tsx`)

### 5.1 Imports

Add `ConfigureBreakoutPayload` to the existing `../types` / `./types` import. Add:

```ts
import { findStudentBoardId } from './lib/breakoutRounds';
```

### 5.2 Default `breakoutConfig` objects (~line 109 and ~line 117)

In both default literals, add `rounds: [],` (leave `activeRoundId` out).

### 5.3 `activeBoardId` (~line 124)

Replace the **student branch** (everything after the `if (isTeacher) { ... }` block, down to
and including `return 'main';`) with:

```ts
return findStudentBoardId(subBoards, breakoutConfig, userId);
```

Change the dependency array to:

```ts
}, [isTeacher, teacherSelectedBoardId, roomSettings.breakoutConfig, subBoards, userId]);
```

Leave the teacher branch unchanged. Teachers can open any board from any round.

### 5.4 `handleConfigureBreakout` (~line 670)

1. Change the parameter type from the inline object type to `payload: ConfigureBreakoutPayload`.
2. Change the success check to:
   ```ts
   if (res?.ok && (payload.action === 'return-to-main' || payload.mode === 'main')) {
     setTeacherSelectedBoardId('main');
   }
   ```

### 5.5 `user-renamed` handler (~line 355)

Replace:

```ts
title: k === `ind_${renamedUserId}` ? `${newName}'s Board` : sb.title,
```

with:

```ts
title: sb.kind === 'individual' && sb.assignedUserIds[0] === renamedUserId ? `${newName}'s Board` : sb.title,
```

**Checkpoint 5:** `npm run lint` passes. If `Canvas.tsx` now shows a type error about
`onConfigureBreakout`, that is expected. Fix it in Phase 6.1.

---

## Phase 6: Teacher and student UI wiring (`src/components/Canvas.tsx` + PDF exporter)

### 6.0 `src/lib/batchPdfExport.ts`: optional file label

In `exportAllBoardsToPdf(params: {...})`, add an optional param `fileLabel?: string;`.
Destructure it, then change the download line (~line 565) to:

```ts
link.download = `allaboard-${roomId}-${fileLabel || 'boards'}-${new Date().toISOString().slice(0, 10)}.pdf`;
```

Nothing else in this file changes.

### 6.1 Props and imports

- Import `ConfigureBreakoutPayload` and `BreakoutRoundMeta` from `../types`.
- Import from `../lib/breakoutRounds`: `getActiveRound`, `getAllBoardsByRound`, `getBoardsInRound`, `getNextRoundNumber`, `getRoundById`, `getRounds`.
- In the props interface (~line 131), change `onConfigureBreakout`'s type to
  `(payload: ConfigureBreakoutPayload) => Promise<{ ok: boolean; error?: string }>;`

### 6.2 Draft state (~line 703)

1. Change `draftBreakoutMode`'s type to `'individual' | 'groups'`, with initial value
   `breakoutConfig.mode === 'groups' ? 'groups' : 'individual'`.
2. Change the `draftGroups` type to `BreakoutGroupDraft[]` (import it from `../types`).
3. Add new state:
   ```ts
   const [draftRoundAction, setDraftRoundAction] = useState<'update-current' | 'new-round'>('new-round');
   /** null = follow the live active round; 'all' = every round; otherwise a round id. */
   const [teacherViewingRoundId, setTeacherViewingRoundId] = useState<string | 'all' | null>(null);
   ```

### 6.3 Derived round data

**Replace** the `activeSubBoardList` `useMemo` (~line 2946) with the block below. **Then
rename every remaining use** of `activeSubBoardList` in this file to `activeRoundBoards`.
Use search, and expect about 4 uses: the launcher button label, the student "Switch Group"
dropdown, the "Send to board" dropdown, and the `LiveGridOverview` prop that you replace
in 6.8.

```ts
const rounds = useMemo(() => getRounds(breakoutConfig), [breakoutConfig]);
const activeRound = useMemo(() => getActiveRound(breakoutConfig), [breakoutConfig]);

// Boards in the live (active) round. Used for students, counts, and broadcast targets.
const activeRoundBoards = useMemo(
  () => getBoardsInRound(subBoards, breakoutConfig.activeRoundId),
  [subBoards, breakoutConfig.activeRoundId]
);

// Which round the TEACHER is browsing in the switcher / grid / PDF export.
const effectiveViewingRoundId: string | 'all' | null =
  teacherViewingRoundId === 'all' || getRoundById(breakoutConfig, teacherViewingRoundId)
    ? teacherViewingRoundId
    : breakoutConfig.activeRoundId ?? null;

const teacherVisibleBoards = useMemo(
  () =>
    effectiveViewingRoundId === 'all'
      ? getAllBoardsByRound(subBoards, breakoutConfig)
      : getBoardsInRound(subBoards, effectiveViewingRoundId),
  [subBoards, breakoutConfig, effectiveViewingRoundId]
);

const viewingRoundLabel =
  effectiveViewingRoundId === 'all'
    ? 'All Rounds'
    : getRoundById(breakoutConfig, effectiveViewingRoundId)?.title || 'Current Round';

const roundShortLabel = (roundId?: string) => {
  const r = getRoundById(breakoutConfig, roundId);
  return r ? `R${r.number}` : '';
};
```

Notes:
- In the **student** "Switch Group" dropdown (~line 4206), use
  `activeRoundBoards.filter((sb) => sb.kind === 'group')`.
- In the "Send to board" dropdown (~line 4604), change the label
  `All Breakout Boards` to `All Boards in Current Round`. Make the same label change in
  `handleSendSelectionToBoard` (~line 1366).

### 6.4 `handleOpenBreakoutModal` (~line 946) and a group loader

Replace `handleOpenBreakoutModal` with:

```ts
const loadDraftGroupsFromActiveRound = useCallback((): boolean => {
  const current = activeRound
    ? getBoardsInRound(subBoards, activeRound.id).filter((sb) => sb.kind === 'group')
    : [];
  if (current.length === 0) return false;
  setDraftGroupCount(current.length);
  setDraftGroups(current.map((sb) => ({ id: sb.id, title: sb.title, assignedUserIds: [...sb.assignedUserIds] })));
  return true;
}, [activeRound, subBoards]);

const handleChangeDraftRoundAction = (next: 'update-current' | 'new-round') => {
  setDraftRoundAction(next);
  if (next === 'update-current' && activeRound) {
    setDraftBreakoutMode(activeRound.mode);
    if (!loadDraftGroupsFromActiveRound()) initializeDraftGroups(draftGroupCount, true);
  } else if (next === 'new-round') {
    initializeDraftGroups(draftGroupCount, true);
  }
};

const handleOpenBreakoutModal = () => {
  setDraftRoundAction(activeRound ? 'update-current' : 'new-round');
  setDraftBreakoutMode(activeRound?.mode ?? 'individual');
  setDraftAllowSelfSelect(breakoutConfig.allowSelfSelect);
  setDraftChatScope(breakoutConfig.chatScope);
  if (!loadDraftGroupsFromActiveRound()) {
    initializeDraftGroups(draftGroupCount, true);
  }
  setShowBreakoutModal(true);
};
```

`handleOpenBreakoutModal` may be declared before `activeRound` in the file. If so, **move
the 6.3 block up** so it sits above this code (anywhere after `subBoards`/`breakoutConfig`
are available). Do **not** duplicate it.

### 6.5 Teacher bar: quick buttons (~line 3740)

Directly **after** the "Breakout / Individual Mode Launcher" `<button>` and its closing tag,
add:

```tsx
{breakoutConfig.mode !== 'main' && (
  <button
    type="button"
    onClick={() => onConfigureBreakout({ action: 'return-to-main' })}
    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer bg-white text-slate-800 border border-amber-300 hover:bg-amber-100/60"
    title="Pull every student back to the Main Board. Their breakout work is kept."
  >
    Bring All to Main
  </button>
)}
{breakoutConfig.mode === 'main' && activeRound && (
  <button
    type="button"
    onClick={() => onConfigureBreakout({ action: 'resume', roundId: activeRound.id })}
    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer bg-white text-blue-800 border border-blue-300 hover:bg-blue-50"
    title={`Send students back to ${activeRound.title} with their work intact`}
  >
    Resume Round {activeRound.number}
  </button>
)}
```

### 6.6 Teacher bar: round selector and board dropdown (~line 3761)

Inside the `{Object.keys(subBoards).length > 0 && ( <div ...> ... )}` block:

1. **Before** `<span className="text-[11px] text-slate-500">Board:</span>`, add the round
   selector (it renders only when there is more than one round):

```tsx
{rounds.length > 1 && (
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
          {r.title}{r.id === breakoutConfig.activeRoundId ? ' (live)' : ''}
        </option>
      ))}
      <option value="all">All Rounds</option>
    </select>
    <span className="text-slate-300" aria-hidden="true">|</span>
  </>
)}
```

2. In the **board** `<select>`, replace the `(Object.values(subBoards) as SubBoardData[]).map(...)`
   options with:

```tsx
{activeBoardId !== 'main' && !teacherVisibleBoards.some((sb) => sb.id === activeBoardId) && (
  <option value={activeBoardId}>{roundShortLabel(subBoards[activeBoardId]?.roundId)} · {activeBoardTitle}</option>
)}
{teacherVisibleBoards.map((sb) => (
  <option key={sb.id} value={sb.id}>
    {effectiveViewingRoundId === 'all' ? `${roundShortLabel(sb.roundId)} · ` : ''}
    {sb.title} ({sb.elements.length} items)
  </option>
))}
```

(The first option stops the controlled `<select>` from showing the wrong value when the
teacher is on a board from a round they are not currently browsing. If `activeBoardTitle`
is not in scope in `Canvas.tsx`, use `subBoards[activeBoardId]?.title`.)

### 6.7 PDF export (`handleBatchExportAllPdf`, ~line 794)

Replace the line `const allSubBoards = Object.values(subBoards) as SubBoardData[];` with:

```ts
const allSubBoards: SubBoardData[] =
  effectiveViewingRoundId === 'all'
    ? teacherVisibleBoards.map((sb) => ({ ...sb, title: `${roundShortLabel(sb.roundId)} · ${sb.title}` }))
    : teacherVisibleBoards;
const fileLabel =
  effectiveViewingRoundId === 'all'
    ? 'all-rounds'
    : effectiveViewingRoundId
    ? `round-${getRoundById(breakoutConfig, effectiveViewingRoundId)?.number ?? ''}`
    : 'boards';
```

Then pass `fileLabel` into `exportAllBoardsToPdf({ ..., fileLabel })`.

### 6.8 `LiveGridOverview` usage (~line 4228)

Replace the props passed to `<LiveGridOverview ...>` with:

```tsx
<LiveGridOverview
  activeBoardId={activeBoardId}
  boards={teacherVisibleBoards}
  roundLabel={viewingRoundLabel}
  showRoundPrefix={effectiveViewingRoundId === 'all'}
  roundShortLabel={roundShortLabel}
  activeRoundId={breakoutConfig.activeRoundId}
  activeRoundGroupBoards={activeRoundBoards.filter((sb) => sb.kind === 'group')}
  onAssignUserToBoard={onAssignUserToBoard}
  users={users}
  fullMainElements={fullMainElements}
  fullMainBackground={fullMainBackground}
  pdfExportProgress={pdfExportProgress}
  onBatchExportAllPdf={handleBatchExportAllPdf}
  onOpenBreakoutModal={handleOpenBreakoutModal}
  onSelectBoard={onSelectBoard}
  onClose={() => setShowLiveGridOverview(false)}
/>
```

### 6.9 `BreakoutManagerModal` usage (~line 4245)

Add these props to the existing ones (keep all current props):

```tsx
activeRound={activeRound}
nextRoundNumber={getNextRoundNumber(breakoutConfig)}
currentMode={breakoutConfig.mode}
draftRoundAction={draftRoundAction}
onChangeDraftRoundAction={handleChangeDraftRoundAction}
```

**Checkpoint 6:** `npm run lint` will fail **only** in `CanvasModals.tsx`, about the props
you just passed. Phase 7 fixes it. There must be no errors in `Canvas.tsx` itself apart
from those prop mismatches.

---

## Phase 7: Modals (`src/components/CanvasModals.tsx`)

### 7.1 Imports

Add `BreakoutMode`, `BreakoutRoundMeta`, `BreakoutGroupDraft`, `ConfigureBreakoutPayload`
to the `../types` import.

### 7.2 `LiveGridOverview`

1. Replace the props interface with:

```ts
interface LiveGridOverviewProps {
  activeBoardId: string;
  boards: SubBoardData[];
  roundLabel: string;
  showRoundPrefix: boolean;
  roundShortLabel: (roundId?: string) => string;
  activeRoundId?: string;
  activeRoundGroupBoards: SubBoardData[];
  onAssignUserToBoard: (targetBoardId: string, targetUserId?: string) => void;
  users: User[];
  fullMainElements: CanvasElement[];
  fullMainBackground: RoomBackground | null;
  pdfExportProgress: { current: number; total: number } | null;
  onBatchExportAllPdf: () => void;
  onOpenBreakoutModal: () => void;
  onSelectBoard: (boardId: string) => void;
  onClose: () => void;
}
```

2. Update the destructured parameters to match.
3. Header: `({activeSubBoardList.length + 1} Boards)` → `— {roundLabel} ({boards.length + 1} Boards)`.
4. Export button text: `` `Export All Boards (.PDF)` `` → `` `Export ${roundLabel} (.PDF)` ``.
5. Card list: `(Object.values(subBoards) as SubBoardData[]).map((sb) => {` → `boards.map((sb) => {`.
6. In each card's title, prefix with `{showRoundPrefix ? `${roundShortLabel(sb.roundId)} · ` : ''}`.
7. **Live reassignment (Flow C).** Inside each card, after the line that shows
   `assignedNames`, add the block below. It renders only for group boards in the **live**
   round:

```tsx
{sb.kind === 'group' && sb.roundId === activeRoundId && sb.assignedUserIds.length > 0 && (
  <div className="space-y-1" onClick={(e) => e.stopPropagation()}>
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
```

`e.stopPropagation()` is **required**. Without it, clicking the select also triggers the
card's `onClick`, which opens that board and closes the grid.

### 7.3 `BreakoutManagerModal`

1. **Props interface**: change `draftBreakoutMode`/`setDraftBreakoutMode` to
   `'individual' | 'groups'`. Change `draftGroups`/`setDraftGroups` to use
   `BreakoutGroupDraft[]`. Change `onConfigureBreakout` to
   `(payload: ConfigureBreakoutPayload) => Promise<{ ok: boolean; error?: string }>;` and add:

```ts
activeRound: BreakoutRoundMeta | null;
nextRoundNumber: number;
currentMode: BreakoutMode;
draftRoundAction: 'update-current' | 'new-round';
onChangeDraftRoundAction: (next: 'update-current' | 'new-round') => void;
```

2. At the top of the function body, add:

```ts
const isEditing = Boolean(activeRound) && draftRoundAction === 'update-current';
const templateLabelFor = (choice: typeof draftWorksheetChoice): string =>
  choice === 'frayer' ? 'Frayer Model'
  : choice === 'checkin' ? 'Task Pulse Check'
  : choice === 'corners' ? 'Four Corners'
  : choice === 'current' && fullMainBackground ? 'Copy of Main'
  : 'Blank';
```

3. **Round tabs.** Directly below the header `<div>` (the one with the X close button),
   add the block below. It renders only when a round exists:

```tsx
{activeRound && (
  <div className="grid grid-cols-2 gap-2.5">
    <button
      type="button"
      onClick={() => onChangeDraftRoundAction('update-current')}
      className={cn(
        "p-3 rounded-xl border text-left transition-colors cursor-pointer",
        draftRoundAction === 'update-current' ? "bg-blue-50/80 border-blue-600" : "bg-white border-slate-200 hover:border-slate-300"
      )}
    >
      <div className="font-display font-semibold text-xs text-slate-900">Resume / Edit {activeRound.title}</div>
      <p className="text-[11px] text-slate-500 mt-0.5">Keep every board and drawing. Change groups or chat settings.</p>
    </button>
    <button
      type="button"
      onClick={() => onChangeDraftRoundAction('new-round')}
      className={cn(
        "p-3 rounded-xl border text-left transition-colors cursor-pointer",
        draftRoundAction === 'new-round' ? "bg-blue-50/80 border-blue-600" : "bg-white border-slate-200 hover:border-slate-300"
      )}
    >
      <div className="font-display font-semibold text-xs text-slate-900">Start New Round {nextRoundNumber}</div>
      <p className="text-[11px] text-slate-500 mt-0.5">Fresh boards and a new worksheet. Round {activeRound.number} is archived, not deleted.</p>
    </button>
  </div>
)}
```

4. **Mode cards.** Delete the **"Whole-Class Main Board"** card (the first button in the
   `grid grid-cols-3` mode grid). Change the grid to `grid grid-cols-2`. Wrap the whole
   grid in `{!isEditing && ( ... )}`. Right after it, add:

```tsx
{isEditing && activeRound && (
  <p className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
    {activeRound.mode === 'groups' ? 'Group round' : 'Individual round'} · Students' drawings and worksheets are never changed here.
    {activeRound.mode === 'individual' && ' Students who join late automatically get their own board.'}
  </p>
)}
```

5. **Groups panel.** Keep the existing `{draftBreakoutMode === 'groups' && (...)}` panel,
   with two changes:
   - Wrap the "Number of Groups" buttons **and** the "Auto-Randomize Students" button in
     `{!isEditing && ( ... )}`. You cannot change the group count of a live round.
   - In the per-student `<select>`, change the fallback `'grp_1'` to `''`.
6. **Worksheet section.** Change the condition `{draftBreakoutMode !== 'main' && (` to
   `{!isEditing && (`. **Move the "Chat Scope Selector" block out of this section** and
   place it directly after the section's closing `)}`, so it shows in both tabs. Do not
   change the block itself.
7. **"Archive" notice.** Directly above the footer, add:

```tsx
{activeRound && !isEditing && (
  <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
    {activeRound.title} will be archived. Nothing is deleted. You can still open and export it from the Round selector.
  </p>
)}
```

8. **Footer.** Replace the whole footer `<div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">…</div>` with:

```tsx
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
      if (isEditing && activeRound) {
        payload = {
          action: currentMode === 'main' ? 'resume' : 'update-current',
          roundId: activeRound.id,
          allowSelfSelect: draftAllowSelfSelect,
          chatScope: draftChatScope,
          groups: activeRound.mode === 'groups' ? draftGroups : undefined,
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
      onClose();
      onShowLiveGridOverview(payload.action !== 'update-current');
    }}
    className="px-4 py-2 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-500 cursor-pointer"
  >
    {isEditing && activeRound
      ? currentMode === 'main'
        ? `Send Class Back to Round ${activeRound.number}`
        : 'Save Changes'
      : `Launch Round ${nextRoundNumber}`}
  </button>
</div>
```

**Checkpoint 7:** `npm run lint && npm test && npm run build` all pass. Commit.

---

## Phase 8: Final checks

### 8.1 Forbidden-pattern grep (must print nothing)

```bash
grep -rnE 'startsWith\(.(ind|grp)_.\)|(ind|grp)_\$\{' server.ts src | grep -v breakoutRounds.ts
```

(Before this work it prints 13 lines. Afterwards it must print 0.)

The only allowed occurrence is `inferLegacyKind` inside `src/lib/breakoutRounds.ts`.
If anything else prints, replace it with a `kind`/`roundId` helper.

### 8.2 Manual QA script (`npm run dev`, then use two browser windows: one teacher, one student)

1. Teacher claims a PIN. A student joins.
2. Breakouts → no tabs are shown (no rounds yet) → Individual, Frayer → **Launch Round 1**. The student lands on their Frayer board. The student draws.
3. Teacher clicks **Bring All to Main** in the amber bar. The student sees the Main Board. The teacher's Board dropdown still lists the student's Round 1 board, and it shows the drawing.
4. Teacher clicks **Resume Round 1**. The student is back on the board, with the drawing intact.
5. Breakouts → the tab **Start New Round 2** → Groups, 2 groups, Four Corners → **Launch Round 2**. The student lands on a blank group board with the Four Corners worksheet.
6. The **Round:** selector appears. Switch it to Round 1. The board list shows the Round 1 board with its drawing. Switch to **All Rounds** → Live Grid → Export. The PDF contains both rounds, with titles prefixed `R1 ·`/`R2 ·`.
7. In Live Grid (Round 2 selected), move the student to the other group with the dropdown on the card. The student's view switches immediately. The card does **not** open.
8. Breakouts → **Resume / Edit Round 2** → change the chat scope → **Save Changes**. Nobody's board changes.
9. Refresh the server (stop/start `npm run dev`). Everything above persists.
10. Open an old exported room `.json` from before this change (for example, from `human_tests/`) with Restore → Replace. The breakout boards appear as Round 1.

### 8.3 Done means

- [ ] All checkpoints passed; `npm run lint && npm test && npm run build` are green.
- [ ] 8.1 grep is clean.
- [ ] 8.2 manual QA steps 1–10 behave as described.
- [ ] One commit per phase.

---

## Appendix A: Architecture decisions (already made; do not revisit)

| # | Decision | Why |
|---|---|---|
| A1 | **Explicit `roundId` + `kind` fields on every board. Never parse IDs.** | The old code mixed ID parsing into ~10 places. Explicit fields make legacy and new IDs work the same way and remove a whole class of bugs. |
| A2 | **Legacy boards keep their IDs** (`ind_x`, `grp_1`). Only `roundId: 'r1'` and `kind` are added. | Renaming keys would also mean rewriting `boardId` inside every element and chat message. That is risky and gains nothing because of A1. |
| A3 | ID format `r<N>_ind_<userId>` / `r<N>_grp_<n>` (underscore, not `:`). | Board IDs end up in PNG/PDF filenames and DOM attributes. `:` is unsafe in filenames on Windows. |
| A4 | **One existing event** (`teacher:configure-breakout`) plus an `action` field. Old payloads with no `action` are mapped by `resolveBreakoutAction`. | No new socket surface. Old clients and the existing test keep working. |
| A5 | `resume` / `update-current` / `return-to-main` **never** write `elements`, `background`, or `messages`. To change a worksheet, start a new round. | Makes "zero work lost" a structural guarantee rather than a careful-coding one. The old `copyWorksheet` re-apply on existing boards silently overwrote backgrounds. |
| A6 | Only the **active round** is mutable through breakout tools (`join-board`, `ALL_SUBBOARDS`, group edits). Archived rounds are read-only through those paths. | Archived work cannot be changed by accident. The teacher can still open and annotate an archived board directly from the switcher. |
| A7 | Per-round template stored server-side in `room.roundTemplates` (persisted, **not** broadcast). | Late-joining students need the round's worksheet even if no board existed at launch. It is not broadcast because worksheets can be MBs of data URLs. It falls back to cloning a sibling board's background (for example, after a snapshot import). |
| A8 | Pure helper module `src/lib/breakoutRounds.ts` imported by both server and client. | One implementation of routing and migration logic, unit-testable without sockets. |
| A9 | The teacher's round browsing (`teacherViewingRoundId`) is **local UI state**, separate from the live `activeRoundId`. | The teacher can look at Round 1 while students work in Round 2. |
| A10 | Student-to-group moves in the Live Grid use the existing `breakout:join-board` (immediate). Moves inside the modal are drafts saved with **Save Changes**. | This matches how each surface already behaves. |

## Appendix B: Out of scope (do NOT build)

- Deleting, renaming, or reordering rounds.
- Server-side enforcement of which student may draw on which board.
- Changing the group count of a live round (start a new round instead).
- Any change to `batchPdfExport.ts` beyond the `fileLabel` parameter.
- New socket events.
