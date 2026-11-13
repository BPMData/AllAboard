import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  type BoardLike,
  type BreakoutConfigLike,
  makeRoundId,
  makeIndividualBoardId,
  makeGroupBoardId,
  getNextRoundNumber,
  normalizeBreakoutConfig,
  migrateLegacyBreakout,
  findStudentBoardId,
  resolveBreakoutAction,
  getAllBoardsByRound,
} from '../src/lib/breakoutRounds';

describe('breakoutRounds helpers', () => {
  it('makes round and board ids', () => {
    assert.equal(makeRoundId(2), 'r2');
    assert.equal(makeIndividualBoardId('r2', 'u1'), 'r2_ind_u1');
    assert.equal(makeGroupBoardId('r2', 0), 'r2_grp_1');
  });

  it('getNextRoundNumber starts at 1 and follows the max', () => {
    const emptyCfg: BreakoutConfigLike = {
      mode: 'main',
      rounds: [],
      allowSelfSelect: false,
      chatScope: 'unified',
    };
    assert.equal(getNextRoundNumber(emptyCfg), 1);

    const populatedCfg: BreakoutConfigLike = {
      ...emptyCfg,
      rounds: [
        { id: 'r1', number: 1, title: 'Round 1 · Individual', mode: 'individual', createdAt: 1 },
        { id: 'r3', number: 3, title: 'Round 3 · Groups', mode: 'groups', createdAt: 3 },
      ],
    };
    assert.equal(getNextRoundNumber(populatedCfg), 4);
  });

  it('migrates legacy individual boards into r1', () => {
    const boards = new Map<string, BoardLike>([
      ['ind_a', { id: 'ind_a', title: "A's Board", assignedUserIds: ['a'] }],
      ['ind_b', { id: 'ind_b', title: "B's Board", assignedUserIds: ['b'] }],
    ]);
    const config = normalizeBreakoutConfig({ mode: 'individual' });

    const changed = migrateLegacyBreakout(boards, config);

    assert.equal(changed, true);
    assert.equal(boards.get('ind_a')?.roundId, 'r1');
    assert.equal(boards.get('ind_a')?.kind, 'individual');
    assert.equal(boards.get('ind_b')?.roundId, 'r1');
    assert.equal(boards.get('ind_b')?.kind, 'individual');
    assert.equal(config.activeRoundId, 'r1');
    assert.equal(config.rounds?.length, 1);
    assert.equal(config.rounds?.[0].mode, 'individual');
  });

  it('migrates mixed legacy boards into two rounds, active kind last', () => {
    const boards = new Map<string, BoardLike>([
      ['ind_a', { id: 'ind_a', title: "A's Board", assignedUserIds: ['a'] }],
      ['grp_1', { id: 'grp_1', title: 'Group 1', assignedUserIds: ['a'] }],
    ]);
    const config = normalizeBreakoutConfig({ mode: 'groups' });

    const changed = migrateLegacyBreakout(boards, config);

    assert.equal(changed, true);
    assert.equal(boards.get('ind_a')?.roundId, 'r1');
    assert.equal(boards.get('grp_1')?.roundId, 'r2');
    assert.equal(config.activeRoundId, 'r2');
    assert.equal(config.mode, 'groups');
  });

  it('migration is idempotent', () => {
    const boards = new Map<string, BoardLike>([
      ['ind_a', { id: 'ind_a', title: "A's Board", assignedUserIds: ['a'] }],
      ['ind_b', { id: 'ind_b', title: "B's Board", assignedUserIds: ['b'] }],
    ]);
    const config = normalizeBreakoutConfig({ mode: 'individual' });

    assert.equal(migrateLegacyBreakout(boards, config), true);
    assert.equal(migrateLegacyBreakout(boards, config), false);
    assert.equal(config.rounds?.length, 1);
  });

  it('migration with no boards forces mode main', () => {
    const boards = new Map<string, BoardLike>();
    const config = normalizeBreakoutConfig({ mode: 'groups' });

    const changed = migrateLegacyBreakout(boards, config);

    assert.equal(changed, true);
    assert.equal(config.mode, 'main');
    assert.equal(config.activeRoundId, undefined);
  });

  it('findStudentBoardId routes only within the active round', () => {
    const boards = new Map<string, BoardLike>([
      ['r1_ind_u1', { id: 'r1_ind_u1', roundId: 'r1', kind: 'individual', title: "U1's Board", assignedUserIds: ['u1'] }],
      ['r2_ind_u1', { id: 'r2_ind_u1', roundId: 'r2', kind: 'individual', title: "U1's Board", assignedUserIds: ['u1'] }],
    ]);
    const r1Meta = { id: 'r1', number: 1, title: 'Round 1 · Individual', mode: 'individual' as const, createdAt: 1 };
    const r2Meta = { id: 'r2', number: 2, title: 'Round 2 · Individual', mode: 'individual' as const, createdAt: 2 };
    const config: BreakoutConfigLike = {
      mode: 'individual',
      activeRoundId: 'r2',
      rounds: [r1Meta, r2Meta],
      allowSelfSelect: false,
      chatScope: 'unified',
    };

    assert.equal(findStudentBoardId(boards, config, 'u1'), 'r2_ind_u1');
    assert.equal(findStudentBoardId(boards, { ...config, mode: 'main' }, 'u1'), 'main');
  });

  it('findStudentBoardId falls back to first group', () => {
    const boards = new Map<string, BoardLike>([
      ['r1_grp_1', { id: 'r1_grp_1', roundId: 'r1', kind: 'group', title: 'Group 1', assignedUserIds: ['u2'] }],
      ['r1_grp_2', { id: 'r1_grp_2', roundId: 'r1', kind: 'group', title: 'Group 2', assignedUserIds: ['u3'] }],
    ]);
    const config: BreakoutConfigLike = {
      mode: 'groups',
      activeRoundId: 'r1',
      rounds: [{ id: 'r1', number: 1, title: 'Round 1 · Groups', mode: 'groups', createdAt: 1 }],
      allowSelfSelect: false,
      chatScope: 'unified',
    };

    assert.equal(findStudentBoardId(boards, config, 'u9'), 'r1_grp_1');
    assert.equal(findStudentBoardId(boards, config, 'u3'), 'r1_grp_2');
  });

  it('resolveBreakoutAction maps legacy payloads', () => {
    const noRoundsCfg: BreakoutConfigLike = {
      mode: 'main',
      rounds: [],
      allowSelfSelect: false,
      chatScope: 'unified',
    };
    const activeIndCfg: BreakoutConfigLike = {
      mode: 'individual',
      activeRoundId: 'r1',
      rounds: [{ id: 'r1', number: 1, title: 'Round 1 · Individual', mode: 'individual', createdAt: 1 }],
      allowSelfSelect: false,
      chatScope: 'unified',
    };

    assert.equal(resolveBreakoutAction({ mode: 'main' }, activeIndCfg), 'return-to-main');
    assert.equal(resolveBreakoutAction({ mode: 'individual' }, noRoundsCfg), 'new-round');
    assert.equal(resolveBreakoutAction({ mode: 'individual' }, activeIndCfg), 'resume');
    assert.equal(resolveBreakoutAction({ mode: 'groups' }, activeIndCfg), 'new-round');
    assert.equal(resolveBreakoutAction({ action: 'update-current' }, activeIndCfg), 'update-current');
  });

  it('getAllBoardsByRound orders by round number', () => {
    const boards = new Map<string, BoardLike>([
      ['r2_grp_1', { id: 'r2_grp_1', roundId: 'r2', kind: 'group', title: 'Group 1', assignedUserIds: [] }],
      ['r1_ind_u1', { id: 'r1_ind_u1', roundId: 'r1', kind: 'individual', title: "U1's Board", assignedUserIds: ['u1'] }],
    ]);
    const config: BreakoutConfigLike = {
      mode: 'groups',
      activeRoundId: 'r2',
      rounds: [
        { id: 'r2', number: 2, title: 'Round 2 · Groups', mode: 'groups', createdAt: 2 },
        { id: 'r1', number: 1, title: 'Round 1 · Individual', mode: 'individual', createdAt: 1 },
      ],
      allowSelfSelect: false,
      chatScope: 'unified',
    };

    const sorted = getAllBoardsByRound(boards, config);
    assert.deepEqual(
      sorted.map((b) => b.id),
      ['r1_ind_u1', 'r2_grp_1']
    );
  });
});
