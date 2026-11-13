# AllAboard — Multi-Round Breakout Rooms & Session Archiving Spec
*(Architectural Blueprint & Implementation Guide for Claude Code / Antigravity)*

---

## 1. Problem Statement & Current Limitation

Currently in AllAboard, a room's `subBoards` map (`Record<string, SubBoardData>`) uses static board IDs:
- Individual mode uses `ind_<userId>` (e.g. `ind_usr_abc123`).
- Group mode uses `grp_1`, `grp_2`, …, `grp_N`.

Because those board IDs are deterministic and flat:
1. **Single-Use Breakout Limitation**: If a teacher runs Breakout Round 1 (e.g., a 4-Box Frayer Model), brings students back to the Main Board (`breakoutConfig.mode = 'main'`), and then tries to launch a **new** breakout activity (e.g., a 4-Corners Argumentation template or newly shuffled groups), either:
   - Students get routed straight back into their Round 1 `ind_<userId>` / `grp_1` boards with Round 1's drawings still sitting on top, **or**
   - Overwriting the background/elements destroys Round 1's work.
2. **Returning to Old vs. New Breakout Boards**: After pulling students back to the Main Board for whole-class discussion, the teacher needs an explicit choice when re-activating breakout mode:
   - **Resume Current Breakout Round**: Send students back into their existing breakout boards with all their annotations intact.
   - **Start New Breakout Round**: Archive the previous round's boards (so zero annotations or worksheets are lost, and the teacher can still inspect or batch-export them to PDF later) and create a brand-new round of breakout boards with a fresh worksheet/template and optional new group assignments.

---

## 2. Target User Experience (Teacher & Student Flows)

### Flow A: Pulling Students Back to Main Board ("All Eyes on Main")
- A one-click **"Bring All to Main"** toggle/button in the Teacher Board Switcher bar (and inside the Breakout Manager modal) sets `breakoutConfig.mode = 'main'` **without deleting or mutating any sub-boards**.
- While students are on the Main Board, the teacher can still browse any breakout board from Round 1 (or earlier rounds) using the Teacher Board Switcher bar or Live Grid View.

### Flow B: Resuming vs. Starting a New Breakout Round
When the room already has an active/previous breakout round (`subBoards` is non-empty) and the teacher opens the **Breakout & Individual Boards** modal:
1. **Option 1 — Resume Current Breakout Boards (One-Click)**:
   - Re-activates `individual` or `groups` mode for `activeRoundId` so every student immediately returns to their existing board and annotations.
2. **Option 2 — Launch New Breakout Round (`Round N + 1`)**:
   - Teacher picks the mode (`Individual` or `Groups`), chooses a new worksheet/template (`Copy Main`, `Frayer`, `Check-In`, `4-Corners`, or `Blank`), and (if Groups) optionally re-shuffles or edits group assignments.
   - Previous round's boards remain preserved under their round namespace (`r1_ind_<userId>`, `r1_grp_1`, etc.) and are tagged with `roundId: 'round_1'` and `roundTitle: 'Round 1 — Frayer Model'`.
   - New boards are created under `r2_ind_<userId>` or `r2_grp_1` (`roundId: 'round_2'`), and `breakoutConfig.activeRoundId` switches to `'round_2'`.

### Flow C: Live Manual Student Switching Between Breakout Rooms
- In both the **Breakout Manager Modal** and the **Live Grid View** cards (or the **Class** roster tab), the teacher can drag or select a dropdown next to any student to move them from `Group 1` to `Group 2` (or to any specific breakout board) in real time via `breakout:join-board`.
- As soon as the server updates `assignedUserIds`, `breakout-sync` routes that student's canvas view immediately to their newly assigned breakout board.

### Flow D: Round Switcher & Batch PDF Export Across Rounds
- In the **Teacher Board Switcher** bar and **Live Grid View**, if multiple rounds exist (`Round 1`, `Round 2`, …), a compact **Round selector dropdown** lets the teacher view or export:
  - **Current Round (`Round 2`)**,
  - **Any Past Round (`Round 1`)**, or
  - **All Rounds Combined** into a single multi-page `.pdf`.

---

## 3. Proposed Data Model Changes (`src/types.ts` & `server.ts`)

```ts
export interface BreakoutRoundMeta {
  id: string;          // e.g. 'round_1', 'round_2'
  number: number;      // 1, 2, 3...
  title: string;       // e.g. 'Round 1 (Individual — Frayer Model)'
  mode: 'individual' | 'groups';
  createdAt: number;
}

export interface SubBoardData {
  id: string;          // Namespaced by round: e.g. 'round_1:ind_usr_123' or 'round_2:grp_1'
  roundId?: string;    // e.g. 'round_1' (legacy boards default to 'round_1')
  title: string;
  assignedUserIds: string[];
  elements: CanvasElement[];
  background: RoomBackground | null;
  messages: ChatMessage[];
}

export interface BreakoutConfig {
  mode: BreakoutMode;              // 'main' | 'individual' | 'groups'
  activeRoundId?: string;          // e.g. 'round_2'
  rounds?: BreakoutRoundMeta[];    // Ordered history of all breakout rounds in this room
  allowSelfSelect: boolean;
  chatScope: 'unified' | 'board';
}
```

---

## 4. Server-Side Implementation Steps (`server.ts`)

1. **Backward-Compatible Migration in `deserializeSubBoards`**:
   - If a persisted room has legacy `ind_<userId>` or `grp_1` boards without a `roundId`, assign them `roundId: 'round_1'` and initialize `breakoutConfig.activeRoundId = 'round_1'` and `breakoutConfig.rounds = [{ id: 'round_1', number: 1, title: 'Round 1', mode: ... }]`.
2. **Update `breakout:configure` Socket Handler**:
   - Accept `action?: 'resume' | 'new-round' | 'update-current' | 'return-to-main'` in the payload:
     - `'return-to-main'`: Sets `room.breakoutConfig.mode = 'main'` while leaving `activeRoundId`, `rounds`, and all `subBoards` untouched.
     - `'resume'`: Sets `room.breakoutConfig.mode = targetRound.mode` and `room.breakoutConfig.activeRoundId = targetRound.id` without touching any board's `elements` or `background`.
     - `'new-round'`: Increments `roundNumber = (room.breakoutConfig.rounds?.length || 0) + 1`, creates `roundId = 'round_' + roundNumber`, appends to `room.breakoutConfig.rounds`, and creates fresh `SubBoardState` entries prefixed with `${roundId}:ind_${userId}` or `${roundId}:grp_${i + 1}`.
     - `'update-current'`: Updates group assignments (`assignedUserIds`), `allowSelfSelect`, or `chatScope` on the currently active round without wiping student drawings.
3. **Auto-Provisioning Late-Joining Students in `join-room`**:
   - When `room.breakoutConfig.mode === 'individual'` and a new student joins, check for `${activeRoundId}:ind_${userId}` (falling back to legacy `ind_${userId}`). If missing, clone the active round's template background into a new board for that student in `activeRoundId`.

---

## 5. Client-Side Implementation Steps (`src/App.tsx`, `src/components/Canvas.tsx`, `src/components/CanvasModals.tsx`)

1. **`activeBoardId` Resolution in `src/App.tsx`**:
   - Filter candidate `subBoards` by `sb.roundId === breakoutConfig.activeRoundId` (with fallback for legacy un-namespaced boards).
   - In `individual` mode, match `sb.assignedUserIds.includes(userId)` within the active round.
   - In `groups` mode, match `sb.assignedUserIds.includes(userId)` within the active round.
2. **Teacher Board Switcher & Live Grid Round Selector (`src/components/Canvas.tsx` & `CanvasModals.tsx`)**:
   - Add a `teacherViewingRoundId` state (defaulting to `breakoutConfig.activeRoundId`).
   - Filter `visibleSubBoards` by `teacherViewingRoundId` so the teacher can flip between `Round 1`, `Round 2`, etc. at any time, even while students are working in `Round 2` or on the `Main Board`.
   - Add a quick **"Return All to Main"** / **"Resume Round X"** button right in the Teacher Board Switcher bar so the teacher can pull students back and forth with a single click.
3. **Breakout Manager Modal (`src/components/CanvasModals.tsx`)**:
   - When an existing round is present, show a clear top segmented choice:
     - **Resume / Edit Current Round (`Round X`)**
     - **Start Fresh Breakout Round (`Round X + 1`)** (archives Round X safely)
   - Add a quick student-to-group dropdown on each student pill so teachers can reassign students between groups in 1 click without resetting boards.

---

## 6. Verification & Test Cases to Add (`tests/server.test.ts`)

1. Launching Round 1 (`individual`), drawing strokes on `round_1:ind_s1`, returning to `main`, and resuming Round 1 preserves all strokes on `round_1:ind_s1`.
2. Launching Round 2 (`groups` or `individual` with a new template) creates `round_2:*` boards with 0 strokes while keeping `round_1:ind_s1` and its strokes intact in `subBoards`.
3. Reassigning a student via `breakout:join-board` within the active round moves their `userId` between group boards in `activeRoundId` without affecting archived rounds.
