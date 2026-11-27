/**
 * "Something not working?" problem reports: the categories, the safe diagnostics, and the text that goes to the public
 * GitHub issue and to the private email. See docs/REPORTS.md.
 *
 * Pure: no React, DOM or Node imports. The browser builds a preview from these helpers, and the server rebuilds the
 * real report from the same helpers with `normalizeReportInput`, so a modified client can't add fields.
 *
 * Privacy rules (issue #57):
 * - Never include student names, room codes, PINs, chat, drawings or worksheets automatically.
 * - Contact details and "anything else" comments are private (email only), never in the public issue.
 * - The description is public unless the reporter ticks "keep it private". Public text is scrubbed of emails,
 *   phone numbers, links, long numbers and anything in `redact` (the browser passes the room code, the PIN and
 *   the names on the roster; those values themselves are never sent).
 */

export const REPORT_APP_NAME = 'AllAboard';
/** Shared with OverBoard. Shown to people when automatic sending fails. */
export const REPORT_INBOX = 'overboard.reporting@gmail.com';
export const REPORT_LABELS = ['user-report'];

export const REPORT_TEXT_MAX = 2000;
export const REPORT_CONTACT_MAX = 200;
const DIAG_STRING_MAX = 80;
const TITLE_SNIPPET_MAX = 60;

export interface ReportCategory {
  id: string;
  label: string;
  hint: string;
}

export const REPORT_CATEGORIES: ReportCategory[] = [
  { id: 'joining', label: 'Joining a room or staying connected', hint: "Can't get in, kicked out, keeps reconnecting" },
  {
    id: 'sync',
    label: 'Drawing or seeing other people’s work',
    hint: 'Ink missing, slow, or different on another screen',
  },
  { id: 'worksheets', label: 'Worksheets, PDFs or images', hint: "Won't upload, looks wrong, pages missing" },
  { id: 'breakouts', label: 'Breakout rounds or student boards', hint: 'Wrong board, rounds, groups, Live Grid' },
  { id: 'chat', label: 'Chat', hint: 'Messages missing, late or in the wrong place' },
  { id: 'teacher', label: 'Teacher tools', hint: 'PIN, lock, timer, stamps, moderation' },
  { id: 'saving', label: 'Saving, loading or exporting', hint: 'Save class work, lessons, PDF export, Google Drive' },
  { id: 'other', label: 'Something else', hint: 'Anything that doesn’t fit above' },
];

export function categoryLabel(id: string): string {
  return REPORT_CATEGORIES.find((c) => c.id === id)?.label ?? 'Something else';
}

/**
 * The only diagnostics a report may carry. Every field is a short string, number or boolean about the app or the
 * device, never about the class. `normalizeReportInput` drops anything else.
 */
export interface ReportDiagnostics {
  appVersion?: string;
  browser?: string;
  os?: string;
  screen?: string;
  language?: string;
  touch?: boolean;
  online?: boolean;
  /** 'lobby' or 'room'. */
  page?: string;
  connection?: string;
  transport?: string;
  role?: string;
  /** Where students are now: main / individual / groups. */
  breakoutMode?: string;
  /** The board this person is looking at: main / individual / group. Never its id. */
  boardKind?: string;
  worksheetPages?: number;
  itemsOnBoard?: number;
  peopleInRoom?: number;
  canvasLocked?: boolean;
  chatHidden?: boolean;
}

/** Field order and the label each one gets in the report. */
export const DIAGNOSTIC_FIELDS: {
  key: keyof ReportDiagnostics;
  label: string;
  type: 'string' | 'number' | 'boolean';
}[] = [
  { key: 'appVersion', label: 'App version', type: 'string' },
  { key: 'browser', label: 'Browser', type: 'string' },
  { key: 'os', label: 'Device', type: 'string' },
  { key: 'screen', label: 'Screen', type: 'string' },
  { key: 'language', label: 'Language', type: 'string' },
  { key: 'touch', label: 'Touch screen', type: 'boolean' },
  { key: 'online', label: 'Browser online', type: 'boolean' },
  { key: 'page', label: 'Page', type: 'string' },
  { key: 'connection', label: 'Connection', type: 'string' },
  { key: 'transport', label: 'Transport', type: 'string' },
  { key: 'role', label: 'Role', type: 'string' },
  { key: 'breakoutMode', label: 'Breakout mode', type: 'string' },
  { key: 'boardKind', label: 'Board being viewed', type: 'string' },
  { key: 'worksheetPages', label: 'Worksheet pages', type: 'number' },
  { key: 'itemsOnBoard', label: 'Items on board', type: 'number' },
  { key: 'peopleInRoom', label: 'People in room', type: 'number' },
  { key: 'canvasLocked', label: 'Canvas locked', type: 'boolean' },
  { key: 'chatHidden', label: 'Chat hidden', type: 'boolean' },
];

export interface ProblemReportInput {
  category: string;
  whatHappened: string;
  steps: string;
  /** Send the description by email only, not in the public issue. */
  keepDescriptionPrivate: boolean;
  /** Private: email only. */
  contact: string;
  /** Private: email only. */
  comments: string;
  diagnostics: ReportDiagnostics;
}

export function emptyReport(): ProblemReportInput {
  return {
    category: '',
    whatHappened: '',
    steps: '',
    keepDescriptionPrivate: false,
    contact: '',
    comments: '',
    diagnostics: {},
  };
}

/** Browser and OS names from a user-agent string, without versions beyond the major one. */
export function describeUserAgent(ua: string): { browser: string; os: string } {
  const s = String(ua || '');
  const major = (re: RegExp) => s.match(re)?.[1]?.split('.')[0];
  let browser = 'Unknown browser';
  if (/Edg\//.test(s)) browser = `Edge ${major(/Edg\/([\d.]+)/) ?? ''}`;
  else if (/OPR\//.test(s)) browser = `Opera ${major(/OPR\/([\d.]+)/) ?? ''}`;
  else if (/Firefox\//.test(s)) browser = `Firefox ${major(/Firefox\/([\d.]+)/) ?? ''}`;
  else if (/CriOS\//.test(s)) browser = `Chrome ${major(/CriOS\/([\d.]+)/) ?? ''}`;
  else if (/Chrome\//.test(s)) browser = `Chrome ${major(/Chrome\/([\d.]+)/) ?? ''}`;
  else if (/Version\/[\d.]+.*Safari\//.test(s)) browser = `Safari ${major(/Version\/([\d.]+)/) ?? ''}`;
  let os = 'Unknown device';
  if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Windows/.test(s)) os = 'Windows';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
  else if (/Linux/.test(s)) os = 'Linux';
  return { browser: browser.trim(), os };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes things that shouldn't be public from free text: emails, phone numbers, links, standalone numbers of four
 * or more digits (PINs; years like 2026 stay), and every value in `redact` (case-insensitive, whole words).
 */
export function scrubPublicText(text: string, redact: string[] = []): string {
  let out = String(text || '');
  const values = [...new Set(redact.map((v) => String(v || '').trim()).filter((v) => v.length >= 2))].sort(
    (a, b) => b.length - a.length
  );
  for (const value of values) {
    out = out.replace(
      new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(value)}(?=$|[^\\p{L}\\p{N}])`, 'giu'),
      '$1[removed]'
    );
  }
  // Generic patterns after the exact values, so a room code with digits in it is removed whole.
  out = out.replace(/[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi, '[email removed]');
  out = out.replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, '[link removed]');
  out = out.replace(/(?:\+?\d[\s().-]?){7,}\d/g, '[number removed]');
  out = out.replace(/\b(?!(?:19|20)\d\d\b)\d{4,}\b/g, '[number removed]');
  return out;
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

/** Keeps only the known diagnostic fields, with the right types and short values. */
export function normalizeDiagnostics(raw: unknown): ReportDiagnostics {
  const out: Record<string, string | number | boolean> = {};
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;
  for (const field of DIAGNOSTIC_FIELDS) {
    const value = src[field.key];
    if (field.type === 'string' && typeof value === 'string') {
      const v = cleanText(value, DIAG_STRING_MAX).replace(/\n/g, ' ');
      if (v) out[field.key] = v;
    } else if (field.type === 'number' && typeof value === 'number' && Number.isFinite(value)) {
      out[field.key] = Math.max(0, Math.min(1_000_000, Math.round(value)));
    } else if (field.type === 'boolean' && typeof value === 'boolean') {
      out[field.key] = value;
    }
  }
  return out as ReportDiagnostics;
}

export type NormalizeResult = { ok: true; input: ProblemReportInput } | { ok: false; error: string };

/** Validates a report from the network. Unknown fields are dropped; text is trimmed and capped. */
export function normalizeReportInput(raw: unknown): NormalizeResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'The report is empty.' };
  const src = raw as Record<string, unknown>;
  const category = typeof src.category === 'string' ? src.category : '';
  if (!REPORT_CATEGORIES.some((c) => c.id === category)) return { ok: false, error: 'Choose what went wrong.' };
  return {
    ok: true,
    input: {
      category,
      whatHappened: cleanText(src.whatHappened, REPORT_TEXT_MAX),
      steps: cleanText(src.steps, REPORT_TEXT_MAX),
      keepDescriptionPrivate: src.keepDescriptionPrivate === true,
      contact: cleanText(src.contact, REPORT_CONTACT_MAX).replace(/\n/g, ' '),
      comments: cleanText(src.comments, REPORT_TEXT_MAX),
      diagnostics: normalizeDiagnostics(src.diagnostics),
    },
  };
}

/**
 * What the browser actually sends: the description scrubbed with the room's secrets (room code, PIN, roster names).
 * The secrets stay in the browser. Contact and comments are private and go as typed.
 */
export function prepareReportForSending(input: ProblemReportInput, redact: string[] = []): ProblemReportInput {
  return {
    ...input,
    whatHappened: scrubPublicText(input.whatHappened, redact).trim(),
    steps: scrubPublicText(input.steps, redact).trim(),
    diagnostics: normalizeDiagnostics(input.diagnostics),
  };
}

function formatDiagnosticValue(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

export function diagnosticLines(diagnostics: ReportDiagnostics): string[] {
  const lines: string[] = [];
  for (const field of DIAGNOSTIC_FIELDS) {
    const value = diagnostics[field.key];
    if (value === undefined) continue;
    lines.push(`${field.label}: ${formatDiagnosticValue(value as string | number | boolean)}`);
  }
  return lines;
}

/** Keeps markdown from turning a pasted line into a heading, table or mention in the issue. */
function quoteBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line.replace(/@/g, '@\u200b')}`)
    .join('\n');
}

function oneLine(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[`*_#<>[\]@]/g, '')
    .trim();
}

export interface PublicIssue {
  title: string;
  body: string;
  labels: string[];
}

/** The public GitHub issue. Anyone can read it. */
export function buildPublicIssue(input: ProblemReportInput, redact: string[] = []): PublicIssue {
  const category = categoryLabel(input.category);
  const what = input.keepDescriptionPrivate ? '' : scrubPublicText(input.whatHappened, redact).trim();
  const steps = input.keepDescriptionPrivate ? '' : scrubPublicText(input.steps, redact).trim();
  const snippet = oneLine(what).slice(0, TITLE_SNIPPET_MAX);
  const title = `[Report] ${category}${snippet ? `: ${snippet}${oneLine(what).length > TITLE_SNIPPET_MAX ? '…' : ''}` : ''}`;

  const parts: string[] = [`**What went wrong:** ${category}`, ''];
  if (input.keepDescriptionPrivate) {
    parts.push('**What happened:** The reporter kept the description private.', '');
  } else {
    parts.push('**What happened:**', what ? quoteBlock(what) : '_Not given._', '');
    parts.push('**How to make it happen again:**', steps ? quoteBlock(steps) : '_Not given._', '');
  }
  const diag = diagnosticLines(input.diagnostics);
  parts.push('**Diagnostics:**', diag.length ? diag.map((l) => `- ${l}`).join('\n') : '_None._', '');
  parts.push(
    `_Sent from ${REPORT_APP_NAME}'s "Something not working?" form. Contact details and private comments went to the developer by email, not here._`
  );
  return { title, body: parts.join('\n'), labels: [...REPORT_LABELS] };
}

export interface PrivateEmail {
  subject: string;
  body: string;
  /** The reporter's contact, when it looks like an email address. */
  replyTo?: string;
}

export function looksLikeEmail(text: string): boolean {
  return /^[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}$/i.test(text.trim());
}

/** The private email to the reporting inbox. It repeats the public part so the email stands alone. */
export function buildPrivateEmail(input: ProblemReportInput, redact: string[] = []): PrivateEmail {
  const category = categoryLabel(input.category);
  const issue = buildPublicIssue(input, redact);
  const lines: string[] = [`${REPORT_APP_NAME} problem report`, '', `What went wrong: ${category}`, ''];
  if (input.keepDescriptionPrivate) {
    lines.push('What happened (kept private):', scrubPublicText(input.whatHappened, redact) || 'Not given.', '');
    lines.push('How to make it happen again (kept private):', scrubPublicText(input.steps, redact) || 'Not given.', '');
  }
  lines.push('Contact (private):', input.contact || 'Not given.', '');
  lines.push('Anything else (private):', input.comments || 'Not given.', '');
  lines.push('--- Public GitHub issue ---', `Title: ${issue.title}`, '', issue.body);
  const email: PrivateEmail = {
    subject: `[${REPORT_APP_NAME}] Problem report: ${category}`,
    body: lines.join('\n'),
  };
  if (looksLikeEmail(input.contact)) email.replyTo = input.contact.trim();
  return email;
}

/** Plain-text copy of everything, for Copy / Download when automatic sending fails. */
export function buildPlainReport(input: ProblemReportInput, redact: string[] = []): string {
  const email = buildPrivateEmail(input, redact);
  return [`Please email this report to ${REPORT_INBOX}`, `Subject: ${email.subject}`, '', email.body].join('\n');
}

/** A mailto: link for the fallback. The body is left out when it would make the link too long for some mail apps. */
export function buildMailtoLink(input: ProblemReportInput, redact: string[] = []): string {
  const email = buildPrivateEmail(input, redact);
  const base = `mailto:${REPORT_INBOX}?subject=${encodeURIComponent(email.subject)}`;
  const withBody = `${base}&body=${encodeURIComponent(email.body)}`;
  return withBody.length <= 1800 ? withBody : base;
}

/** What the server sends the relay. */
export interface RelayPayload {
  app: string;
  kind: 'problem-report';
  issue: PublicIssue;
  email: PrivateEmail;
}

/** What `POST /api/report` answers. */
export type ReportResponse =
  | { ok: true; issueUrl?: string; issueNumber?: number; emailed?: boolean }
  | { ok: false; error: 'invalid' | 'rate-limited' | 'not-configured' | 'relay-failed'; message?: string };
