import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CHAT_WIDTH,
  MIN_CHAT_WIDTH,
  MAX_CHAT_WIDTH,
  CHAT_STORAGE_KEYS,
  getMaxChatWidth,
  clampChatWidth,
  readStoredChatWidth,
  readStoredChatHidden,
  storeChatHiddenChoice,
  COMPACT_LAYOUT_MAX_WIDTH,
} from '../src/lib/chatSidebar';

describe('chatSidebar helpers', () => {
  it('computes viewport-aware max width while preserving canvas space', () => {
    assert.equal(getMaxChatWidth(), MAX_CHAT_WIDTH);
    assert.equal(getMaxChatWidth(1440), MAX_CHAT_WIDTH);
    assert.equal(getMaxChatWidth(700), 420);
    assert.equal(getMaxChatWidth(400), MIN_CHAT_WIDTH);
  });

  it('clamps widths within min, max, and viewport bounds', () => {
    assert.equal(clampChatWidth(100, 1440), MIN_CHAT_WIDTH);
    assert.equal(clampChatWidth(450, 1440), 450);
    assert.equal(clampChatWidth(900, 1440), MAX_CHAT_WIDTH);
    assert.equal(clampChatWidth(500, 700), 420);
    assert.equal(clampChatWidth(Number.NaN, 1440), DEFAULT_CHAT_WIDTH);
    assert.equal(clampChatWidth(333.6, 1440), 334);
  });

  it('reads stored chat width safely from storage', () => {
    assert.equal(readStoredChatWidth(null, 1440), DEFAULT_CHAT_WIDTH);
    assert.equal(
      readStoredChatWidth({ getItem: () => '410' }, 1440),
      410
    );
    assert.equal(
      readStoredChatWidth({ getItem: () => '50' }, 1440),
      MIN_CHAT_WIDTH
    );
    assert.equal(
      readStoredChatWidth({ getItem: () => 'invalid' }, 1440),
      DEFAULT_CHAT_WIDTH
    );
    assert.equal(
      readStoredChatWidth(
        {
          getItem: () => {
            throw new Error('blocked');
          },
        },
        1440
      ),
      DEFAULT_CHAT_WIDTH
    );
  });

  it('starts hidden on narrow screens unless the person chose otherwise', () => {
    const store = (values: Record<string, string>) => ({ getItem: (k: string) => values[k] ?? null });
    const phone = 390;
    const ipadPortrait = 820;
    const laptop = 1366;
    assert.ok(ipadPortrait < COMPACT_LAYOUT_MAX_WIDTH && laptop >= COMPACT_LAYOUT_MAX_WIDTH);
    // No saved choice: the screen decides.
    assert.equal(readStoredChatHidden(store({}), phone), true);
    assert.equal(readStoredChatHidden(store({}), ipadPortrait), true);
    assert.equal(readStoredChatHidden(store({}), laptop), false);
    // The legacy key was written on every load, so its 'false' isn't a choice; its 'true' always was.
    assert.equal(readStoredChatHidden(store({ [CHAT_STORAGE_KEYS.HIDDEN]: 'false' }), phone), true);
    assert.equal(readStoredChatHidden(store({ [CHAT_STORAGE_KEYS.HIDDEN]: 'true' }), laptop), true);
    // A real choice wins either way.
    assert.equal(readStoredChatHidden(store({ [CHAT_STORAGE_KEYS.HIDDEN_CHOICE]: 'false' }), phone), false);
    assert.equal(readStoredChatHidden(store({ [CHAT_STORAGE_KEYS.HIDDEN_CHOICE]: 'true' }), laptop), true);
    // Blocked storage: the screen decides.
    assert.equal(readStoredChatHidden({ getItem: () => { throw new Error('blocked'); } }, phone), true);
  });

  it('stores only an explicit choice, and survives blocked storage', () => {
    const saved: Record<string, string> = {};
    storeChatHiddenChoice({ setItem: (k, v) => { saved[k] = v; } }, true);
    assert.equal(saved[CHAT_STORAGE_KEYS.HIDDEN_CHOICE], 'true');
    assert.doesNotThrow(() => storeChatHiddenChoice({ setItem: () => { throw new Error('blocked'); } }, false));
    assert.doesNotThrow(() => storeChatHiddenChoice(null, false));
  });

  it('reads stored chat hidden flag safely from storage', () => {
    assert.equal(readStoredChatHidden(null), false);
    assert.equal(
      readStoredChatHidden({ getItem: (k) => (k === CHAT_STORAGE_KEYS.HIDDEN ? 'true' : null) }),
      true
    );
    assert.equal(
      readStoredChatHidden({ getItem: () => 'false' }),
      false
    );
    assert.equal(
      readStoredChatHidden({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
      false
    );
  });
});
