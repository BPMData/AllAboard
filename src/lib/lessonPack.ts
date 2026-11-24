/**
 * `.allaboard` lesson packs: a lesson's main-board worksheet and teacher ink, its breakout rounds (worksheets and
 * group names) and room settings, with every image embedded once in `assets`. Never student data.
 *
 * Pure: no React, DOM or Node imports. The server builds the skeleton (`buildLessonPack`, `assets: {}`), the browser
 * embeds the images, and both sides check a file with `validateLesson`.
 */
import type { BreakoutRoundMeta, CanvasElement, RoomBackground } from '../types.ts';

export const LESSON_KIND = 'allaboard-lesson';
/** Bump only on a breaking change; loaders refuse newer versions. */
export const LESSON_VERSION = 1;
export const LESSON_EXTENSION = '.allaboard';
export const LESSON_FILE_ACCEPT = '.allaboard,.json,application/json';
export const LESSON_TITLE_MAX = 80;
export const LESSON_MAX_ROUNDS = 50;
export const LESSON_MAX_GROUPS = 30;
/** Same as MAX_BOARD_ELEMENTS in socketGuards.ts (kept here so this file stays free of Node imports). */
export const LESSON_MAX_ELEMENTS = 10_000;
const MAX_PAGES_PER_BACKGROUND = 200;
const MAX_LABEL = 40;
const ASSET_PREFIX = '/api/assets/';
/** Placeholder author on every element in a pack; the loading teacher becomes the author. */
export const LESSON_AUTHOR_ID = 'lesson';

/** The four teacher-only socket events (all with an ack). */
export type LessonRequestEvent =
  | 'teacher:export-lesson'
  | 'teacher:has-assets'
  | 'teacher:upload-asset'
  | 'teacher:load-lesson';

export type MainInkChoice = 'teacher' | 'all' | 'none';
export type ChatScope = 'unified' | 'board';

export interface LessonRound {
  /** 'a', 'b', … unique in the file. Never a room round id. */
  key: string;
  /** The round's own name ("Exit ticket"), without "Round N · Mode". May be empty. */
  title: string;
  mode: 'individual' | 'groups';
  worksheet: RoomBackground | null;
  /** Groups only: titles, never assignments. */
  groups?: { title: string }[];
  /** Groups only: ink drawn on each prepared group board, by index. */
  groupInk?: CanvasElement[][];
  /** Phase 3 (template ink); absent until then. */
  ink?: CanvasElement[];
  allowSelfSelect?: boolean;
  chatScope?: ChatScope;
}

export interface LessonSettings {
  oneNameStamp?: boolean;
  hideStudentCursors?: boolean;
  allowSelfSelect?: boolean;
  chatScope?: ChatScope;
  autoIndividual?: boolean;
  autoIndividualBackground?: RoomBackground | null;
  autoIndividualTemplateLabel?: string;
  timerDurationMs?: number;
  timerAutoLock?: boolean;
}

export interface LessonPack {
  kind: typeof LESSON_KIND;
  version: number;
  title: string;
  exportedAt: number;
  exportedBy?: string;
  main: { background: RoomBackground | null; elements: CanvasElement[] };
  rounds: LessonRound[];
  settings: LessonSettings;
  /** '/api/assets/<hash>' → data URL. Empty in the server's skeleton. */
  assets: Record<string, string>;
}

export interface LessonBoardInput {
  id: string;
  roundId?: string;
  kind: 'individual' | 'group';
  title: string;
  elements: CanvasElement[];
}

export interface LessonBuildInput {
  title: string;
  exportedBy?: string;
  exportedAt?: number;
  mainBackground: RoomBackground | null;
  mainElements: CanvasElement[];
  /** Everyone counted as a teacher for `mainInk: 'teacher'`. */
  teacherUserIds: ReadonlySet<string>;
  mainInk: MainInkChoice;
  rounds: BreakoutRoundMeta[];
  /** Worksheet per round id (the server's round templates, with its usual fallback). */
  roundTemplates: Record<string, RoomBackground | null | undefined>;
  boards: LessonBoardInput[];
  /** Which rounds to include. Omitted: every prepared round, plus launched rounds when `includeLaunchedRounds`. */
  roundIds?: string[];
  includeLaunchedRounds?: boolean;
  settings: LessonSettings;
}

// ---------- Small helpers ----------

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function isNameStamp(el: { tool?: unknown; stamp?: unknown }): boolean {
  return el.tool === 'stamp' && el.stamp === 'username';
}

function cleanText(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : '';
}

/** "Round 3 · Groups · Exit ticket" → "Exit ticket"; "Round 3 · Groups" → "". */
export function roundNameFromTitle(title: string): string {
  const parts = String(title || '').split(' · ');
  return parts.length > 2 ? parts.slice(2).join(' · ') : '';
}

function roundKey(index: number): string {
  // a … z, then aa, ab, …
  let n = index;
  let key = '';
  do {
    key = String.fromCharCode(97 + (n % 26)) + key;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return key;
}

/** A copy of an element without who drew it or which board it was on. */
function stripElement(el: CanvasElement): CanvasElement {
  const { boardId: _boardId, timestamp: _timestamp, ...rest } = el as CanvasElement & Record<string, unknown>;
  return { ...structuredClone(rest), userId: LESSON_AUTHOR_ID, userName: '' } as CanvasElement;
}

function cloneBg(bg: RoomBackground | null | undefined): RoomBackground | null {
  return bg ? structuredClone(bg) : null;
}

/** Elements kept on the main board for each ink choice. */
export function filterMainInk(
  elements: CanvasElement[],
  choice: MainInkChoice,
  teacherUserIds: ReadonlySet<string>
): CanvasElement[] {
  if (choice === 'none') return [];
  const noStamps = elements.filter((el) => !isNameStamp(el));
  return choice === 'all' ? noStamps : noStamps.filter((el) => teacherUserIds.has(el.userId));
}

// ---------- Build ----------

export function buildLessonPack(input: LessonBuildInput): LessonPack {
  const allRounds = [...input.rounds].sort((a, b) => a.number - b.number);
  const wanted = input.roundIds ? new Set(input.roundIds) : null;
  const chosen = allRounds.filter((r) =>
    wanted ? wanted.has(r.id) : r.prepared === true || input.includeLaunchedRounds !== false
  );

  const rounds: LessonRound[] = chosen.slice(0, LESSON_MAX_ROUNDS).map((r, i) => {
    const round: LessonRound = {
      key: roundKey(i),
      title: roundNameFromTitle(r.title),
      mode: r.mode === 'groups' ? 'groups' : 'individual',
      worksheet: cloneBg(input.roundTemplates[r.id]),
    };
    if (round.mode === 'groups') {
      const groupBoards = input.boards
        .filter((b) => b.roundId === r.id && b.kind === 'group')
        .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
        .slice(0, LESSON_MAX_GROUPS);
      round.groups = groupBoards.map((b, gi) => ({ title: cleanText(b.title, MAX_LABEL) || `Group ${gi + 1}` }));
      if (round.groups.length === 0) round.groups = [{ title: 'Group 1' }];
      // Only a prepared round's boards are the teacher's own setup; a launched round's boards hold student work.
      if (r.prepared === true) {
        const ink = groupBoards.map((b) => b.elements.filter((el) => !isNameStamp(el)).map(stripElement));
        if (ink.some((list) => list.length > 0)) round.groupInk = ink;
      }
    }
    if (r.prepared === true) {
      if (typeof r.allowSelfSelect === 'boolean') round.allowSelfSelect = r.allowSelfSelect;
      if (r.chatScope === 'board' || r.chatScope === 'unified') round.chatScope = r.chatScope;
    }
    return round;
  });

  const s = input.settings;
  const settings: LessonSettings = {
    oneNameStamp: Boolean(s.oneNameStamp),
    hideStudentCursors: Boolean(s.hideStudentCursors),
    allowSelfSelect: Boolean(s.allowSelfSelect),
    chatScope: s.chatScope === 'board' ? 'board' : 'unified',
    autoIndividual: Boolean(s.autoIndividual),
  };
  if (s.autoIndividual) {
    settings.autoIndividualBackground = cloneBg(s.autoIndividualBackground);
    const label = cleanText(s.autoIndividualTemplateLabel, MAX_LABEL);
    if (label) settings.autoIndividualTemplateLabel = label;
  }
  if (typeof s.timerDurationMs === 'number' && Number.isFinite(s.timerDurationMs)) {
    settings.timerDurationMs = s.timerDurationMs;
  }
  settings.timerAutoLock = Boolean(s.timerAutoLock);

  const pack: LessonPack = {
    kind: LESSON_KIND,
    version: LESSON_VERSION,
    title: cleanText(input.title, LESSON_TITLE_MAX) || 'Untitled lesson',
    exportedAt: input.exportedAt ?? Date.now(),
    main: {
      background: cloneBg(input.mainBackground),
      elements: filterMainInk(input.mainElements, input.mainInk, input.teacherUserIds).map(stripElement),
    },
    rounds,
    settings,
    assets: {},
  };
  const author = cleanText(input.exportedBy, 60);
  if (author) pack.exportedBy = author;
  return pack;
}

// ---------- Assets ----------

function allBackgrounds(lesson: LessonPack): RoomBackground[] {
  const list: Array<RoomBackground | null | undefined> = [
    lesson.main.background,
    ...lesson.rounds.map((r) => r.worksheet),
    lesson.settings.autoIndividualBackground,
  ];
  return list.filter((bg): bg is RoomBackground => Boolean(bg));
}

/** Every `/api/assets/…` page URL in the lesson, each once. */
export function lessonAssetUrls(lesson: LessonPack): string[] {
  const urls = new Set<string>();
  for (const bg of allBackgrounds(lesson)) {
    for (const page of bg.pages) {
      if (typeof page.dataUrl === 'string' && page.dataUrl.startsWith(ASSET_PREFIX)) urls.add(page.dataUrl);
    }
  }
  return Array.from(urls);
}

/** A copy of the lesson with every page URL found in `map` replaced. */
export function rewriteAssetUrls(lesson: LessonPack, map: Record<string, string>): LessonPack {
  const copy = structuredClone(lesson);
  for (const bg of allBackgrounds(copy)) {
    for (const page of bg.pages) {
      if (Object.prototype.hasOwnProperty.call(map, page.dataUrl)) page.dataUrl = map[page.dataUrl];
    }
  }
  const assets: Record<string, string> = {};
  for (const [url, data] of Object.entries(copy.assets || {})) {
    assets[Object.prototype.hasOwnProperty.call(map, url) ? map[url] : url] = data;
  }
  copy.assets = assets;
  return copy;
}

/** Rough size of the saved file, in bytes. */
export function lessonByteSize(lesson: LessonPack): number {
  return JSON.stringify(lesson).length;
}

/** 'photosynthesis-2026-11-24.allaboard' */
export function lessonFileName(title: string, date: Date = new Date()): string {
  const slug =
    String(title || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '') || 'lesson';
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${slug}-${day}${LESSON_EXTENSION}`;
}

// ---------- Validate / parse ----------

/** (The project builds without strictNullChecks, so this isn't a discriminated union.) */
interface Check<T> {
  ok: boolean;
  value: T;
  error: string;
}
const fail = (error: string): Check<any> => ({ ok: false, value: null, error });

function checkBackground(raw: unknown, where: string): Check<RoomBackground | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null, error: '' };
  if (!isObject(raw) || !Array.isArray(raw.pages)) return fail(`${where}: the worksheet is damaged.`);
  if (raw.pages.length > MAX_PAGES_PER_BACKGROUND) return fail(`${where}: the worksheet has too many pages.`);
  const pages = [];
  for (const p of raw.pages) {
    if (!isObject(p) || typeof p.dataUrl !== 'string') return fail(`${where}: a worksheet page is damaged.`);
    const width = Number(p.width);
    const height = Number(p.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return fail(`${where}: a worksheet page is damaged.`);
    }
    pages.push({ dataUrl: p.dataUrl, width, height });
  }
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const layout = raw.layout === 'stack' || raw.layout === 'grid' ? raw.layout : 'row';
  return {
    ok: true,
    value: {
      id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 100) : 'worksheet',
      fileName: cleanText(raw.fileName, 200),
      pages,
      x: num(raw.x, 0),
      y: num(raw.y, 0),
      scale: num(raw.scale, 1),
      layout,
      opacity: num(raw.opacity, 1),
    },
    error: '',
  };
}

function checkElements(raw: unknown, where: string): Check<CanvasElement[]> {
  if (raw === undefined) return { ok: true, value: [], error: '' };
  if (!Array.isArray(raw)) return fail(`${where}: the ink is damaged.`);
  if (raw.length > LESSON_MAX_ELEMENTS) return fail(`${where}: too much ink (over ${LESSON_MAX_ELEMENTS} marks).`);
  for (const el of raw) {
    if (!isObject(el) || typeof el.tool !== 'string') return fail(`${where}: the ink is damaged.`);
  }
  return { ok: true, value: raw as CanvasElement[], error: '' };
}

/** Checks a parsed lesson object and returns a clean copy. Never throws. */
export function validateLesson(raw: unknown): { lesson: LessonPack | null; error: string | null } {
  try {
    if (!isObject(raw)) return { lesson: null, error: "This isn't an AllAboard lesson file." };
    if (raw.kind !== LESSON_KIND) {
      if (raw.kind === undefined && (raw.version === 1 || raw.version === 2) && 'elements' in raw) {
        return { lesson: null, error: 'This is a room save. Use Import .JSON instead.' };
      }
      return { lesson: null, error: "This isn't an AllAboard lesson file." };
    }
    const version = Number(raw.version);
    if (!Number.isInteger(version) || version < 1) return { lesson: null, error: 'This lesson file is damaged.' };
    if (version > LESSON_VERSION) {
      return { lesson: null, error: 'This lesson was made by a newer AllAboard. Reload the page and try again.' };
    }

    const main = isObject(raw.main) ? raw.main : {};
    const mainBg = checkBackground(main.background, 'Main board');
    if (!mainBg.ok) return { lesson: null, error: mainBg.error };
    const mainEls = checkElements(main.elements, 'Main board');
    if (!mainEls.ok) return { lesson: null, error: mainEls.error };

    if (raw.rounds !== undefined && !Array.isArray(raw.rounds)) {
      return { lesson: null, error: 'This lesson file is damaged.' };
    }
    const rawRounds = (raw.rounds as unknown[] | undefined) ?? [];
    if (rawRounds.length > LESSON_MAX_ROUNDS) {
      return { lesson: null, error: `A lesson can have at most ${LESSON_MAX_ROUNDS} rounds.` };
    }
    const rounds: LessonRound[] = [];
    const keys = new Set<string>();
    for (let i = 0; i < rawRounds.length; i++) {
      const r = rawRounds[i];
      const where = `Round ${i + 1}`;
      if (!isObject(r)) return { lesson: null, error: `${where} is damaged.` };
      const mode = r.mode === 'groups' ? 'groups' : r.mode === 'individual' ? 'individual' : null;
      if (!mode) return { lesson: null, error: `${where} is damaged.` };
      let key = typeof r.key === 'string' && r.key ? r.key.slice(0, 20) : roundKey(i);
      if (keys.has(key)) key = `${key}-${i}`;
      keys.add(key);
      const ws = checkBackground(r.worksheet, where);
      if (!ws.ok) return { lesson: null, error: ws.error };
      const round: LessonRound = { key, title: cleanText(r.title, MAX_LABEL), mode, worksheet: ws.value };
      if (mode === 'groups') {
        if (!Array.isArray(r.groups) || r.groups.length === 0) return { lesson: null, error: `${where} has no groups.` };
        if (r.groups.length > LESSON_MAX_GROUPS) {
          return { lesson: null, error: `${where} has more than ${LESSON_MAX_GROUPS} groups.` };
        }
        round.groups = r.groups.map((g, gi) => ({
          title: (isObject(g) && cleanText(g.title, MAX_LABEL)) || `Group ${gi + 1}`,
        }));
        if (r.groupInk !== undefined) {
          if (!Array.isArray(r.groupInk) || r.groupInk.length > round.groups.length) {
            return { lesson: null, error: `${where}: the group ink is damaged.` };
          }
          const groupInk: CanvasElement[][] = [];
          for (const list of r.groupInk) {
            const checked = checkElements(list, where);
            if (!checked.ok) return { lesson: null, error: checked.error };
            groupInk.push(checked.value);
          }
          round.groupInk = groupInk;
        }
      }
      if (r.ink !== undefined) {
        const ink = checkElements(r.ink, where);
        if (!ink.ok) return { lesson: null, error: ink.error };
        round.ink = ink.value;
      }
      if (typeof r.allowSelfSelect === 'boolean') round.allowSelfSelect = r.allowSelfSelect;
      if (r.chatScope === 'board' || r.chatScope === 'unified') round.chatScope = r.chatScope;
      rounds.push(round);
    }

    const s = isObject(raw.settings) ? raw.settings : {};
    const settings: LessonSettings = {};
    for (const k of ['oneNameStamp', 'hideStudentCursors', 'allowSelfSelect', 'autoIndividual', 'timerAutoLock'] as const) {
      if (typeof s[k] === 'boolean') settings[k] = s[k] as boolean;
    }
    if (s.chatScope === 'board' || s.chatScope === 'unified') settings.chatScope = s.chatScope;
    if (s.autoIndividualBackground !== undefined) {
      const bg = checkBackground(s.autoIndividualBackground, 'Student boards');
      if (!bg.ok) return { lesson: null, error: bg.error };
      settings.autoIndividualBackground = bg.value;
    }
    const label = cleanText(s.autoIndividualTemplateLabel, MAX_LABEL);
    if (label) settings.autoIndividualTemplateLabel = label;
    const duration = Number(s.timerDurationMs);
    if (s.timerDurationMs !== undefined && Number.isFinite(duration) && duration > 0 && duration <= 24 * 3600_000) {
      settings.timerDurationMs = Math.round(duration);
    }

    const assets: Record<string, string> = {};
    if (isObject(raw.assets)) {
      for (const [url, data] of Object.entries(raw.assets)) {
        if (typeof data === 'string' && url.startsWith(ASSET_PREFIX)) assets[url] = data;
      }
    }

    const lesson: LessonPack = {
      kind: LESSON_KIND,
      version,
      title: cleanText(raw.title, LESSON_TITLE_MAX) || 'Untitled lesson',
      exportedAt: typeof raw.exportedAt === 'number' && Number.isFinite(raw.exportedAt) ? raw.exportedAt : 0,
      main: { background: mainBg.value, elements: mainEls.value },
      rounds,
      settings,
      assets,
    };
    const author = cleanText(raw.exportedBy, 60);
    if (author) lesson.exportedBy = author;
    return { lesson, error: null };
  } catch {
    return { lesson: null, error: 'This lesson file is damaged.' };
  }
}

/** Parses a lesson file's text. Never throws. */
export function parseLessonText(fileName: string, text: string): { lesson: LessonPack | null; error: string | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    const name = fileName ? `"${fileName}"` : 'This file';
    return { lesson: null, error: `${name} isn't a lesson file AllAboard can read.` };
  }
  return validateLesson(raw);
}

/** True if a parsed JSON object looks like a lesson pack (used by the room-save importer to redirect). */
export function looksLikeLesson(raw: unknown): boolean {
  return isObject(raw) && raw.kind === LESSON_KIND;
}
