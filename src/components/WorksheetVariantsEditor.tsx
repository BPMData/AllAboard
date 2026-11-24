import React, { useState } from 'react';
import type { RoomBackground } from '../types';
import { WORKSHEET_FILE_ACCEPT, loadWorksheetFromFile } from '../lib/worksheetLoader';
import {
  CORNER_KEYS,
  DEFAULT_CORNER_MAP,
  VARIANT_LETTERS,
  type CornerKey,
  type RoundVariants,
  type VariantRule,
} from '../lib/roundVariants';

/** What the prepared-round form edits. `slots` = how many of B, C, D are shown (some may have no file yet). */
export interface VariantsDraft {
  extra: (RoomBackground | null)[];
  slots: number;
  rule: VariantRule;
  cornerMap: Record<CornerKey, number>;
  lateJoiners: 'rule' | 'a';
}

export function emptyVariantsDraft(): VariantsDraft {
  return { extra: [null, null, null], slots: 0, rule: 'same', cornerMap: { ...DEFAULT_CORNER_MAP }, lateJoiners: 'rule' };
}

export function draftFromVariants(v: RoundVariants | null | undefined): VariantsDraft {
  if (!v) return emptyVariantsDraft();
  const last = v.extra.reduce((acc, bg, i) => (bg ? i + 1 : acc), 0);
  return { extra: [...v.extra], slots: last, rule: v.rule, cornerMap: { ...v.cornerMap }, lateJoiners: v.lateJoiners };
}

/** Letters shown without a file: saving is blocked until they get one or are removed. */
export function missingVariantLetters(d: VariantsDraft): string[] {
  return d.extra.slice(0, d.slots).map((bg, i) => (bg ? '' : VARIANT_LETTERS[i + 1])).filter(Boolean);
}

export function draftHasVariants(d: VariantsDraft): boolean {
  return d.extra.slice(0, d.slots).some(Boolean);
}

const CORNER_LABEL: Record<CornerKey, string> = {
  tl: '↖ Top-left',
  tr: '↗ Top-right',
  bl: '↙ Bottom-left',
  br: '↘ Bottom-right',
  none: 'No stamp',
};

interface Props {
  value: VariantsDraft;
  onChange: (next: VariantsDraft) => void;
  /** Name of worksheet A (the round's own worksheet chosen above). */
  worksheetAName: string;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}

/** "Different worksheets for different students": worksheets B–D for an individual round, and who gets which. */
export function WorksheetVariantsEditor({ value, onChange, worksheetAName, disabled, onBusyChange }: Props) {
  const [rendering, setRendering] = useState<number | null>(null);
  const [error, setError] = useState('');
  const shown = value.extra.slice(0, value.slots);
  const letters = ['A', ...shown.map((_bg, i) => VARIANT_LETTERS[i + 1])];
  const set = (patch: Partial<VariantsDraft>) => onChange({ ...value, ...patch });

  const pick = async (i: number, file: File) => {
    setError('');
    setRendering(i);
    onBusyChange?.(true);
    try {
      const { background } = await loadWorksheetFromFile(file);
      const extra = [...value.extra];
      extra[i] = background;
      set({ extra });
    } catch (err: any) {
      setError(err?.message || 'Could not read this file.');
    } finally {
      setRendering(null);
      onBusyChange?.(false);
    }
  };

  const remove = (i: number) => {
    // Later letters move up so there are never gaps (C becomes B).
    const extra = [...value.extra.slice(0, i), ...value.extra.slice(i + 1), null];
    set({ extra, slots: value.slots - 1 });
  };

  const letterSelect = (current: number, onPick: (i: number) => void, label: string) => (
    <select
      aria-label={label}
      value={current < letters.length ? current : 0}
      disabled={disabled}
      onChange={(e) => onPick(Number(e.target.value))}
      className="bg-white border border-[#CBD5E1] rounded-[2px] px-1.5 py-0.5 text-xs text-slate-800 cursor-pointer"
    >
      {letters.map((l, i) => (
        <option key={l} value={i}>
          {l}
        </option>
      ))}
    </select>
  );

  return (
    <div className="p-3 rounded-[3px] bg-slate-50 border border-[#CBD5E1] space-y-2 text-xs" data-testid="variants-editor">
      <div>
        <div className="font-semibold text-slate-800">Different worksheets for different students (optional)</div>
        <p className="text-[11px] text-slate-500">Up to four versions, A to D. Each student gets one when you launch.</p>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-5 font-bold">A</span>
        <span className="text-slate-600">{worksheetAName}</span>
      </div>
      {shown.map((bg, i) => {
        const letter = VARIANT_LETTERS[i + 1];
        return (
          <div key={letter} className="flex flex-wrap items-center gap-2">
            <span className="w-5 font-bold">{letter}</span>
            <label className="px-2 py-1 rounded-[2px] border oh-btn text-slate-700 cursor-pointer">
              <input
                type="file"
                className="sr-only"
                aria-label={`Worksheet ${letter}`}
                accept={WORKSHEET_FILE_ACCEPT}
                disabled={disabled || rendering !== null}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void pick(i, f);
                }}
              />
              {rendering === i ? 'Rendering…' : bg ? 'Change file…' : 'Choose file…'}
            </label>
            <span className="text-slate-500 truncate max-w-[16rem]">
              {bg ? `${bg.fileName} · ${bg.pages.length} page${bg.pages.length === 1 ? '' : 's'}` : 'No file yet'}
            </span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => remove(i)}
              className="ml-auto px-2 py-0.5 rounded-[2px] border oh-btn text-slate-700 cursor-pointer"
            >
              Remove
            </button>
          </div>
        );
      })}
      {value.slots < 3 && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => set({ slots: value.slots + 1 })}
          className="px-2 py-1 rounded-[2px] border oh-btn text-slate-700 cursor-pointer"
        >
          Add worksheet {VARIANT_LETTERS[value.slots + 1]}
        </button>
      )}
      {error && <p role="alert" className="text-red-700">{error}</p>}

      {value.slots > 0 && (
        <div className="space-y-1 pt-1 border-t border-slate-200">
          <div className="font-semibold text-slate-700">Who gets which</div>
          <label className="flex gap-2">
            <input type="radio" name="pv-rule" checked={value.rule === 'same'} onChange={() => set({ rule: 'same' })} />
            Everyone gets A (pick students one by one later, in Send worksheet…)
          </label>
          <label className="flex gap-2">
            <input type="radio" name="pv-rule" checked={value.rule === 'rotate'} onChange={() => set({ rule: 'rotate' })} />
            Deal out {letters.join(', ')} in turn (alphabetical by student)
          </label>
          <label className="flex gap-2">
            <input type="radio" name="pv-rule" checked={value.rule === 'corner'} onChange={() => set({ rule: 'corner' })} />
            By where each student stamped their name on the main board (read when you launch)
          </label>
          {value.rule === 'corner' && (
            <div className="grid grid-cols-2 gap-2 max-w-xs ml-6">
              {CORNER_KEYS.map((k) => (
                <label key={k} className="flex items-center justify-between gap-2">
                  {CORNER_LABEL[k]} →
                  {letterSelect(value.cornerMap[k], (idx) => set({ cornerMap: { ...value.cornerMap, [k]: idx } }), `${CORNER_LABEL[k]} worksheet`)}
                </label>
              ))}
            </div>
          )}
          <label className="flex items-center gap-2 pt-1">
            Students who join late get
            <select
              aria-label="Late joiners get"
              value={value.lateJoiners}
              disabled={disabled}
              onChange={(e) => set({ lateJoiners: e.target.value === 'a' ? 'a' : 'rule' })}
              className="bg-white border border-[#CBD5E1] rounded-[2px] px-1.5 py-0.5 text-xs text-slate-800 cursor-pointer"
            >
              <option value="rule">their worksheet by the same rule</option>
              <option value="a">worksheet A</option>
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
