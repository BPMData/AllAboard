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
