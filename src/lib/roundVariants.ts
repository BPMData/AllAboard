/**
 * Worksheet variants (A–D) for an individual breakout round, and the rule that decides who gets which.
 *
 * Worksheet A is always the round's own worksheet (`roundTemplates[roundId]` on the server). This record holds B, C
 * and D plus the rule, so A can never drift out of sync with the round's worksheet.
 *
 * Used by the server (launch and late joiners), the prepared-round form, Send worksheet… and lesson packs.
 * Pure: no React, DOM or Node imports.
 */
import type { CanvasElement, RoomBackground } from '../types.ts';
import { quadrantsByUser, type Quadrant } from './stampQuadrants.ts';

export const VARIANT_LETTERS = ['A', 'B', 'C', 'D'] as const;
export type VariantLetter = (typeof VARIANT_LETTERS)[number];
/** 'same': everyone A. 'rotate': deal out in turn, alphabetical by student. 'corner': by name-stamp corner on Main. */
export type VariantRule = 'same' | 'rotate' | 'corner';
export type CornerKey = Quadrant | 'none';
export const CORNER_KEYS: CornerKey[] = ['tl', 'tr', 'bl', 'br', 'none'];

export interface RoundVariants {
  /** Worksheets B, C, D (index 0 = B). null = that letter has no worksheet. */
  extra: (RoomBackground | null)[];
  rule: VariantRule;
  /** Corner → letter index (0 = A). Used when `rule` is 'corner'. */
  cornerMap: Record<CornerKey, number>;
  /** Students who arrive after launch: by the same rule, or always A. */
  lateJoiners: 'rule' | 'a';
  /** The teacher's per-student picks, keyed by `studentKey(name)`. Survives rejoins and lesson packs. */
  overrides: Record<string, number>;
  /** Who got which letter (userId → index). Session data: kept in room saves, never in lesson packs. */
  assigned: Record<string, number>;
}

export const DEFAULT_CORNER_MAP: Record<CornerKey, number> = { tl: 0, tr: 1, bl: 2, br: 3, none: 0 };
const MAX_OVERRIDES = 200;
const MAX_ASSIGNED = 500;

export function emptyRoundVariants(): RoundVariants {
  return { extra: [null, null, null], rule: 'same', cornerMap: { ...DEFAULT_CORNER_MAP }, lateJoiners: 'rule', overrides: {}, assigned: {} };
}

/** How per-student picks are matched: trimmed, lowercased display name. */
export function studentKey(name: unknown): string {
  return typeof name === 'string' ? name.trim().toLowerCase().slice(0, 60) : '';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function letterIndex(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3 ? v : null;
}

function isBackground(v: unknown): v is RoomBackground {
  return isObject(v) && Array.isArray(v.pages);
}

function indexMap(raw: unknown, max: number, cleanKey: (k: string) => string): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObject(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    const key = cleanKey(k);
    const idx = letterIndex(v);
    if (!key || idx === null) continue;
    out[key] = idx;
    if (++n >= max) break;
  }
  return out;
}

/**
 * Turns any stored, imported or client-sent value into a valid record, or null when it carries nothing (no extra
 * worksheet, no picks). Backgrounds are kept as given: the server interns them separately. Never throws.
 */
export function normalizeRoundVariants(raw: unknown): RoundVariants | null {
  if (!isObject(raw)) return null;
  const extraRaw = Array.isArray(raw.extra) ? raw.extra : [];
  const extra = [0, 1, 2].map((i) => (isBackground(extraRaw[i]) ? (extraRaw[i] as RoomBackground) : null));
  const rule: VariantRule = raw.rule === 'rotate' || raw.rule === 'corner' ? raw.rule : 'same';
  const cornerMap = { ...DEFAULT_CORNER_MAP };
  if (isObject(raw.cornerMap)) {
    for (const k of CORNER_KEYS) {
      const idx = letterIndex(raw.cornerMap[k]);
      if (idx !== null) cornerMap[k] = idx;
    }
  }
  const out: RoundVariants = {
    extra,
    rule,
    cornerMap,
    lateJoiners: raw.lateJoiners === 'a' ? 'a' : 'rule',
    overrides: indexMap(raw.overrides, MAX_OVERRIDES, studentKey),
    assigned: indexMap(raw.assigned, MAX_ASSIGNED, (k) => k.slice(0, 200)),
  };
  return hasVariantContent(out) ? out : null;
}

/** True when the record changes anything compared with "everyone gets A". */
export function hasVariantContent(v: RoundVariants | null | undefined): boolean {
  if (!v) return false;
  return v.extra.some(Boolean) || Object.keys(v.overrides).length > 0 || Object.keys(v.assigned).length > 0;
}

/** Letter indexes that have a worksheet: A always (it's the round's worksheet), then B–D when set. */
export function availableLetters(v: RoundVariants | null | undefined): number[] {
  const out = [0];
  if (v) v.extra.forEach((bg, i) => { if (bg) out.push(i + 1); });
  return out;
}

/** The worksheet for a letter: A is the round's own worksheet. */
export function variantBackground(
  v: RoundVariants | null | undefined,
  index: number,
  roundWorksheet: RoomBackground | null
): RoomBackground | null {
  if (index <= 0 || !v) return roundWorksheet;
  return v.extra[index - 1] ?? roundWorksheet;
}

export interface VariantPickContext {
  userId: string;
  name: string;
  /** Arrived after the round launched (late joiner, rejoin without a board). */
  late: boolean;
  /** Main board, for corner mode. */
  mainElements: CanvasElement[];
  mainBackground: RoomBackground | null;
}

/**
 * Which letter a student gets. Order: the teacher's pick for that name, then late-joiner rule, then the round's rule.
 * 'rotate' deals the next letter in turn (the caller provisions students alphabetically at launch).
 */
export function pickVariant(v: RoundVariants | null | undefined, ctx: VariantPickContext): number {
  if (!v) return 0;
  const letters = availableLetters(v);
  const ok = (i: number | undefined): i is number => typeof i === 'number' && letters.includes(i);
  const override = v.overrides[studentKey(ctx.name)];
  if (ok(override)) return override;
  if (ctx.late && v.lateJoiners === 'a') return 0;
  if (v.rule === 'rotate') return letters[Object.keys(v.assigned).length % letters.length];
  if (v.rule === 'corner') {
    const q = quadrantsByUser(ctx.mainElements, ctx.mainBackground, [ctx.userId])[ctx.userId] ?? null;
    const idx = v.cornerMap[q ?? 'none'];
    return ok(idx) ? idx : 0;
  }
  return 0;
}

/** Every worksheet in the record (B–D), for asset embedding and interning. */
export function variantBackgrounds(v: RoundVariants | null | undefined): RoomBackground[] {
  return v ? v.extra.filter((bg): bg is RoomBackground => Boolean(bg)) : [];
}

/** Sorts students for dealing out in turn: alphabetical by name, then id. */
export function byStudentName<T extends { name: string; userId: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || a.userId.localeCompare(b.userId);
}

/** Same page images in the same order: the board already shows this worksheet. */
export function sameWorksheet(a: RoomBackground | null | undefined, b: RoomBackground | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.pages.length !== b.pages.length) return false;
  return a.pages.every((p, i) => p.dataUrl === b.pages[i].dataUrl);
}

/**
 * A copy of a worksheet whose `data:` pages are uploaded one at a time (`upload` returns the asset URL), so a payload
 * with several worksheets stays far under the socket size limit. Pages that are already URLs are kept.
 */
export async function uploadWorksheetPages(
  bg: RoomBackground | null,
  upload: (dataUrl: string) => Promise<string>
): Promise<RoomBackground | null> {
  if (!bg) return null;
  const pages = [];
  for (const page of bg.pages) {
    pages.push(page.dataUrl.startsWith('data:') ? { ...page, dataUrl: await upload(page.dataUrl) } : page);
  }
  return { ...bg, pages };
}

/** " + worksheets B, C (by corner)" for a round with variants, else "". */
export function variantsNote(v: Pick<RoundVariants, 'extra' | 'rule'> | null | undefined): string {
  const letters = (v?.extra ?? []).map((bg, i) => (bg ? 'BCD'[i] : '')).filter(Boolean);
  if (letters.length === 0) return '';
  const rule = v!.rule === 'rotate' ? 'dealt out in turn' : v!.rule === 'corner' ? 'by name-stamp corner' : 'A for all';
  return ` + worksheet${letters.length === 1 ? '' : 's'} ${letters.join(', ')} (${rule})`;
}
