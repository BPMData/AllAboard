import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeSelectionAuthors,
  formatSelectionAuthors,
  summarizeSelectionAuthors,
} from '../src/lib/selectionAuthors';
import { makeAnonymousAuthorId } from '../src/lib/anonymousInk';
import type { CanvasElement } from '../src/types';

function item(userId: string, userName: string, tool: CanvasElement['tool'] = 'solid'): CanvasElement {
  return { id: `${userId}-${Math.random()}`, userId, userName, tool, color: '#000', strokeWidth: 4 };
}

const noRoster = new Map<string, string>();

describe('selection authors', () => {
  it('names the author of drawings, highlights, text and stamps', () => {
    for (const tool of ['solid', 'highlighter', 'text', 'stamp', 'rect'] as const) {
      const authors = summarizeSelectionAuthors([item('sam', 'Sam', tool)], noRoster, 'teacher');
      assert.equal(formatSelectionAuthors(authors), 'By Sam');
    }
  });

  it('lists the biggest contributor first and summarizes long lists', () => {
    const authors = summarizeSelectionAuthors(
      [item('a', 'Ada'), item('s', 'Sam'), item('s', 'Sam'), item('l', 'Lee'), item('k', 'Kai')],
      noRoster,
      'teacher'
    );
    assert.equal(formatSelectionAuthors(authors), 'By Sam, Ada +2');
    assert.equal(describeSelectionAuthors(authors), 'Sam (2 items), Ada (1 item), Kai (1 item), Lee (1 item)');
  });

  it('prefers the current roster name and labels your own ink', () => {
    const roster = new Map([['sam', 'Samantha']]);
    const authors = summarizeSelectionAuthors([item('sam', 'Sam'), item('me', 'Ms T')], roster, 'me');
    assert.deepEqual(authors.map((author) => author.name).sort(), ['Samantha', 'You']);
  });

  it('keeps two students with the same name separate', () => {
    const authors = summarizeSelectionAuthors([item('sam-1', 'Sam'), item('sam-2', 'Sam')], noRoster, 'teacher');
    assert.equal(authors.length, 2);
    assert.equal(formatSelectionAuthors(authors), 'By Sam, Sam');
  });

  it('shows anonymously shared ink as one anonymous author', () => {
    const authors = summarizeSelectionAuthors(
      [item(makeAnonymousAuthorId('1'), 'Class Example'), item(makeAnonymousAuthorId('2'), 'Class Example')],
      noRoster,
      'teacher'
    );
    assert.deepEqual(authors, [{ key: 'anonymous', name: 'Class Example', itemCount: 2 }]);
  });

  it('ignores erasers and falls back when a name is missing', () => {
    assert.deepEqual(summarizeSelectionAuthors([item('sam', 'Sam', 'eraser')], noRoster, 'teacher'), []);
    assert.equal(formatSelectionAuthors([]), '');
    const authors = summarizeSelectionAuthors([item('gone', '')], noRoster, 'teacher');
    assert.equal(formatSelectionAuthors(authors), 'By Student');
  });
});
