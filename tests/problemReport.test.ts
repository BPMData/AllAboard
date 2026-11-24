import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPORT_CATEGORIES,
  REPORT_INBOX,
  buildMailtoLink,
  buildPlainReport,
  buildPrivateEmail,
  buildPublicIssue,
  describeUserAgent,
  emptyReport,
  normalizeReportInput,
  prepareReportForSending,
  scrubPublicText,
  type ProblemReportInput,
} from '../src/lib/problemReport.ts';

const base = (patch: Partial<ProblemReportInput> = {}): ProblemReportInput => ({
  ...emptyReport(),
  category: 'sync',
  whatHappened: 'My ink vanished when I switched boards.',
  steps: '1. Join 2. Draw 3. Switch boards',
  contact: 'teacher@example.org',
  comments: 'This happened in third period, ask me anything.',
  diagnostics: { browser: 'Chrome 131', os: 'ChromeOS', role: 'student', itemsOnBoard: 12, online: true },
  ...patch,
});

describe('problem reports: categories', () => {
  it('offers the AllAboard-specific categories from issue #57', () => {
    const ids = REPORT_CATEGORIES.map((c) => c.id);
    for (const id of ['joining', 'sync', 'worksheets', 'breakouts', 'chat']) assert.ok(ids.includes(id), id);
  });
});

describe('problem reports: privacy', () => {
  it('keeps contact details and comments out of the public issue', () => {
    const issue = buildPublicIssue(base());
    const text = `${issue.title}\n${issue.body}`;
    assert.ok(!text.includes('teacher@example.org'));
    assert.ok(!text.includes('third period'));
    assert.ok(text.includes('My ink vanished'));
    assert.deepEqual(issue.labels, ['user-report']);
  });

  it('puts contact details and comments in the private email, with a reply-to', () => {
    const email = buildPrivateEmail(base());
    assert.match(email.subject, /^\[AllAboard\] Problem report: /);
    assert.ok(email.body.includes('teacher@example.org'));
    assert.ok(email.body.includes('third period'));
    assert.equal(email.replyTo, 'teacher@example.org');
  });

  it('leaves out reply-to when the contact is not an email address', () => {
    assert.equal(buildPrivateEmail(base({ contact: 'Room 204, Mr. M' })).replyTo, undefined);
  });

  it('moves the description to the email only when asked', () => {
    const report = base({ keepDescriptionPrivate: true });
    const issue = buildPublicIssue(report);
    assert.ok(!issue.body.includes('My ink vanished'));
    assert.ok(!issue.title.includes('My ink vanished'));
    assert.match(issue.body, /kept the description private/);
    assert.ok(buildPrivateEmail(report).body.includes('My ink vanished'));
  });

  it('scrubs room codes, PINs, names, emails, links and phone numbers from the description', () => {
    const raw = 'Room bright-fox-12, PIN 4829, Jayden and maria@x.com saw it at https://allaboard.app/?room=bright-fox-12, call 203-555-0199. In 2026.';
    const out = scrubPublicText(raw, ['bright-fox-12', 'Jayden']);
    for (const secret of ['bright-fox-12', '4829', 'Jayden', 'maria@x.com', 'https://', '555-0199']) {
      assert.ok(!out.includes(secret), `${secret} in ${out}`);
    }
    assert.ok(out.includes('2026'), 'years stay');
  });

  it('matches redactions as whole words only', () => {
    assert.equal(scrubPublicText('Ann annotated the page', ['Ann']), '[removed] annotated the page');
  });

  it('prepareReportForSending scrubs the description but sends private fields as typed', () => {
    const sent = prepareReportForSending(base({ whatHappened: 'Jayden lost his work', comments: 'Jayden is fine to contact' }), ['Jayden']);
    assert.equal(sent.whatHappened, '[removed] lost his work');
    assert.equal(sent.comments, 'Jayden is fine to contact');
  });

  it('neutralises markdown mentions and headings in the public body', () => {
    const issue = buildPublicIssue(base({ whatHappened: '@everyone\n# Big heading' }));
    assert.ok(issue.body.includes('@\u200beveryone'));
    assert.ok(issue.body.includes('> # Big heading'));
  });
});

describe('problem reports: validation', () => {
  it('rejects an unknown category', () => {
    assert.equal(normalizeReportInput({ category: 'nope' }).ok, false);
    assert.equal(normalizeReportInput(null).ok, false);
  });

  it('drops unknown fields and diagnostics, caps text and fixes types', () => {
    const res = normalizeReportInput({
      category: 'chat',
      whatHappened: 'x'.repeat(5000),
      roomCode: 'secret-room',
      diagnostics: {
        browser: 'Chrome 131',
        roomId: 'secret-room',
        userName: 'Jayden',
        chat: ['hi'],
        itemsOnBoard: '12',
        peopleInRoom: 7.6,
        online: 'yes',
      },
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.input.whatHappened.length, 2000);
    assert.deepEqual(res.input.diagnostics, { browser: 'Chrome 131', peopleInRoom: 8 });
    assert.ok(!JSON.stringify(res.input).includes('secret-room'));
    assert.ok(!JSON.stringify(res.input).includes('Jayden'));
  });

  it('lets people skip everything but the category', () => {
    const res = normalizeReportInput({ category: 'other' });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const issue = buildPublicIssue(res.input);
    assert.equal(issue.title, '[Report] Something else');
    assert.match(issue.body, /_Not given\._/);
  });
});

describe('problem reports: fallback', () => {
  it('the copied report says where to email it and includes everything', () => {
    const text = buildPlainReport(base());
    assert.ok(text.startsWith(`Please email this report to ${REPORT_INBOX}`));
    assert.ok(text.includes('teacher@example.org'));
    assert.ok(text.includes('Chrome 131'));
  });

  it('mailto link goes to the shared inbox and drops the body when too long', () => {
    assert.match(buildMailtoLink(base()), new RegExp(`^mailto:${REPORT_INBOX}\\?subject=.*&body=`));
    const long = buildMailtoLink(base({ comments: 'y'.repeat(1900) }));
    assert.ok(!long.includes('&body='));
  });
});

describe('problem reports: user agent', () => {
  it('names common school devices', () => {
    assert.deepEqual(
      describeUserAgent('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'),
      { browser: 'Chrome 131', os: 'ChromeOS' },
    );
    assert.deepEqual(
      describeUserAgent('Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'),
      { browser: 'Safari 17', os: 'iOS' },
    );
    assert.deepEqual(
      describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'),
      { browser: 'Edge 131', os: 'Windows' },
    );
  });
});
