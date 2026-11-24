import React, { useMemo, useState } from 'react';
import type { BreakoutRoundMeta, CanvasElement, RoomBackground, SubBoardData, User } from '../types';
import {
  MAX_PDF_PAGES,
  buildWorksheetBackground,
  getPdfPageCount,
  isPdfFile,
  processWorksheetFile,
} from '../lib/worksheetLoader';
import { quadrantsByUser, type Quadrant } from '../lib/stampQuadrants';

const LETTERS = ['A', 'B', 'C', 'D'] as const;
type Letter = (typeof LETTERS)[number];
type Mode = 'same' | 'rotate' | 'corner';
type CornerKey = Quadrant | 'none';

const WORKSHEET_ACCEPT = '.png,.jpg,.jpeg,.webp,.pdf,image/png,image/jpeg,image/webp,application/pdf';
const CORNER_GLYPH: Record<Quadrant, string> = { tl: '↖', tr: '↗', bl: '↙', br: '↘' };
const CORNER_LABEL: Record<CornerKey, string> = {
  tl: '↖ Top-left',
  tr: '↗ Top-right',
  bl: '↙ Bottom-left',
  br: '↘ Bottom-right',
  none: 'No stamp',
};

interface Variant {
  letter: Letter;
  bg: RoomBackground | null;
  rendering: boolean;
  note?: string;
  error?: string;
}

export type SendWorksheetResult = { ok: boolean; updated?: number; skipped?: string[]; error?: string };

interface SendWorksheetModalProps {
  round: BreakoutRoundMeta;
  boards: SubBoardData[];
  mainElements: CanvasElement[];
  mainBackground: RoomBackground | null;
  onSend: (boardIds: string[], bg: RoomBackground | null, roundTemplateFor?: string) => Promise<SendWorksheetResult>;
  onClose: () => void;
}

/** Teacher modal: send up to four worksheet variants (A–D) to selected boards of one breakout round. */
export function SendWorksheetModal({ round, boards, mainElements, mainBackground, onSend, onClose }: SendWorksheetModalProps) {
  const sortedBoards = useMemo(
    () => [...boards].sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true })),
    [boards]
  );
  const [variants, setVariants] = useState<Variant[]>([{ letter: 'A', bg: null, rendering: false }]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(boards.map((b) => b.id)));
  const [chosenMode, setChosenMode] = useState<Mode | null>(null);
  const [overrides, setOverrides] = useState<Record<string, Letter>>({});
  const [cornerMap, setCornerMap] = useState<Record<CornerKey, Letter>>({ tl: 'A', tr: 'B', bl: 'C', br: 'D', none: 'A' });
  const [lateJoiners, setLateJoiners] = useState(true);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

  const letters = variants.map((v) => v.letter);
  const variantFor = (l: Letter) => variants.find((v) => v.letter === l);
  const mode: Mode = chosenMode ?? (letters.length >= 2 ? 'rotate' : 'same');

  // Corner mode: only for individual rounds, and only when Main has a worksheet with name stamps on it.
  const quadrants = useMemo(() => {
    const userIds = boards.map((b) => b.assignedUserIds[0]).filter((u): u is string => Boolean(u));
    return quadrantsByUser(mainElements, mainBackground, userIds);
  }, [boards, mainElements, mainBackground]);
  const cornerDisabledReason =
    round.mode !== 'individual' || boards.some((b) => b.kind === 'group')
      ? 'Coming later: individual rounds only'
      : !mainBackground?.pages?.length
        ? 'The main board has no worksheet'
        : !mainElements.some((el) => el.tool === 'stamp' && el.stamp === 'username')
          ? 'Nobody has stamped their name on the main board'
          : '';
  const effectiveMode: Mode = mode === 'corner' && cornerDisabledReason ? 'same' : mode;

  const quadrantOf = (b: SubBoardData): Quadrant | null => quadrants[b.assignedUserIds[0]] ?? null;
  const selectedBoards = sortedBoards.filter((b) => selected.has(b.id));
  const assignment = new Map<string, Letter>();
  selectedBoards.forEach((b, i) => {
    const auto: Letter =
      effectiveMode === 'rotate'
        ? letters[i % letters.length]
        : effectiveMode === 'corner'
          ? cornerMap[quadrantOf(b) ?? 'none']
          : 'A';
    const o = overrides[b.id];
    assignment.set(b.id, o && letters.includes(o) ? o : auto);
  });

  const usedLetters = LETTERS.filter((l) => [...assignment.values()].includes(l));
  const missingLetters = usedLetters.filter((l) => !variantFor(l)?.bg);
  const rendering = variants.some((v) => v.rendering);
  const sending = Boolean(progress);
  const withWork = selectedBoards.filter((b) => b.elements.length > 0).length;
  const sendDisabled =
    sending || rendering || selectedBoards.length === 0 || missingLetters.length > 0 || (lateJoiners && !variantFor('A')?.bg);

  let cornerSummary = '';
  if (effectiveMode === 'corner') {
    const counts: Record<string, number> = {};
    let noStamp = 0;
    for (const b of selectedBoards) {
      if (!overrides[b.id] && !quadrantOf(b)) noStamp++;
      else counts[assignment.get(b.id)!] = (counts[assignment.get(b.id)!] || 0) + 1;
    }
    const parts = LETTERS.filter((l) => counts[l]).map((l) => `${counts[l]} → ${l}`);
    if (noStamp) parts.push(`${noStamp} → no stamp (${cornerMap.none})`);
    cornerSummary = parts.join(', ');
  }

  const updateVariant = (letter: Letter, patch: Partial<Variant>) =>
    setVariants((prev) => prev.map((v) => (v.letter === letter ? { ...v, ...patch } : v)));

  const pickFile = async (letter: Letter, file: File) => {
    updateVariant(letter, { rendering: true, error: undefined, note: undefined, bg: null });
    try {
      let range: { first: number; last: number } | undefined;
      if (isPdfFile(file)) {
        const total = await getPdfPageCount(file);
        if (total > MAX_PDF_PAGES) range = { first: 1, last: MAX_PDF_PAGES };
      }
      const pages = await processWorksheetFile(file, range);
      const bg = buildWorksheetBackground(pages, range ? `${file.name} (pp. ${range.first}–${range.last})` : file.name);
      updateVariant(letter, { rendering: false, bg, note: range ? `using pages 1–${MAX_PDF_PAGES}` : undefined });
    } catch (err: any) {
      updateVariant(letter, { rendering: false, error: err?.message || 'Could not read this file.' });
    }
  };

  const send = async () => {
    setError('');
    const plan = LETTERS.map((l) => ({
      letter: l,
      ids: selectedBoards.filter((b) => assignment.get(b.id) === l).map((b) => b.id),
      template: l === 'A' && lateJoiners,
    })).filter((p) => p.ids.length > 0 || p.template);
    let skipped = 0;
    // One emit per variant, one after another, so large worksheets never share a packet.
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i];
      setProgress(`Sending ${p.letter} (${i + 1}/${plan.length})…`);
      const res = await onSend(p.ids, variantFor(p.letter)!.bg, p.template ? round.id : undefined);
      if (!res.ok) {
        setProgress('');
        setError(res.error || `Could not send worksheet ${p.letter}.`);
        return;
      }
      skipped += res.skipped?.length || 0;
    }
    setProgress('');
    if (skipped) {
      setError(`Sent, but ${skipped} board${skipped === 1 ? ' was' : 's were'} not found (the round may have changed).`);
      return;
    }
    onClose();
  };

  const letterSelect = (value: Letter, onChange: (l: Letter) => void, options: readonly Letter[], label: string) => (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as Letter)}
      className="bg-slate-50 border border-[#CBD5E1] rounded-[2px] px-1.5 py-0.5 text-xs text-slate-800 cursor-pointer"
    >
      {options.map((l) => (
        <option key={l} value={l}>
          {l}{variantFor(l) ? '' : ' (no file)'}
        </option>
      ))}
    </select>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4" role="dialog" aria-modal="true" aria-labelledby="send-worksheet-title">
      <div className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-[3px] border-2 border-[#CBD5E1] bg-white overflow-hidden">
        <div className="oh-panel-header px-5 py-3 border-b border-[#CBD5E1]">
          <h3 id="send-worksheet-title" className="font-bold text-slate-900">Send worksheet to {round.title}</h3>
        </div>
        <div className="p-5 space-y-5 overflow-y-auto text-sm text-slate-800">
          <section className="space-y-2">
            <h4 className="font-semibold">Worksheets</h4>
            {variants.map((v) => (
              <div key={v.letter} className="flex flex-wrap items-center gap-2">
                <span className="w-6 font-bold">{v.letter}</span>
                <input
                  type="file"
                  accept={WORKSHEET_ACCEPT}
                  aria-label={`Worksheet ${v.letter}`}
                  disabled={sending}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void pickFile(v.letter, f);
                  }}
                  className="text-xs"
                />
                <span className="text-xs text-slate-500">
                  {v.rendering
                    ? 'Rendering…'
                    : v.bg
                      ? `${v.bg.fileName} · ${v.bg.pages.length} page${v.bg.pages.length === 1 ? '' : 's'}${v.note ? ` (${v.note})` : ''}`
                      : 'No file yet'}
                </span>
                {v.error && <span role="alert" className="text-xs text-red-700">{v.error}</span>}
                {v.letter !== 'A' && (
                  <button
                    type="button"
                    disabled={sending}
                    onClick={() => setVariants((prev) => prev.filter((x) => x.letter !== v.letter))}
                    className="ml-auto px-2 py-0.5 text-xs rounded-[2px] border oh-btn text-slate-700 cursor-pointer"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
            {variants.length < 4 && (
              <button
                type="button"
                disabled={sending}
                onClick={() => {
                  const next = LETTERS.find((l) => !letters.includes(l));
                  if (next) setVariants((prev) => [...prev, { letter: next, bg: null, rendering: false }].sort((a, b) => a.letter.localeCompare(b.letter)));
                }}
                className="px-2 py-1 text-xs rounded-[2px] border oh-btn text-slate-700 cursor-pointer"
              >
                Add variant
              </button>
            )}
          </section>

          <section className="space-y-1">
            <h4 className="font-semibold">Who gets which</h4>
            <label className="flex gap-2">
              <input type="radio" name="sw-mode" checked={effectiveMode === 'same'} onChange={() => setChosenMode('same')} />
              Same worksheet (A) for all selected
            </label>
            <label className="flex gap-2">
              <input type="radio" name="sw-mode" checked={effectiveMode === 'rotate'} onChange={() => setChosenMode('rotate')} />
              Deal out {letters.join(', ')} in turn (alphabetical by student)
            </label>
            <label className={`flex gap-2 ${cornerDisabledReason ? 'text-slate-400' : ''}`} title={cornerDisabledReason || undefined}>
              <input
                type="radio"
                name="sw-mode"
                disabled={Boolean(cornerDisabledReason)}
                checked={effectiveMode === 'corner'}
                onChange={() => setChosenMode('corner')}
              />
              By name-stamp corner on the main board
              {cornerDisabledReason && <span className="text-xs">({cornerDisabledReason})</span>}
            </label>
            {effectiveMode === 'corner' && (
              <div className="grid grid-cols-2 gap-2 max-w-xs mt-2 ml-6">
                {(['tl', 'tr', 'bl', 'br', 'none'] as CornerKey[]).map((k) => (
                  <label key={k} className="flex items-center justify-between gap-2 text-xs">
                    {CORNER_LABEL[k]} →
                    {letterSelect(cornerMap[k], (l) => setCornerMap((m) => ({ ...m, [k]: l })), LETTERS, `${CORNER_LABEL[k]} worksheet`)}
                  </label>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-3">
              <h4 className="font-semibold">Boards ({selectedBoards.length}/{boards.length})</h4>
              <button type="button" onClick={() => setSelected(new Set(boards.map((b) => b.id)))} className="text-xs text-brand-700 hover:underline cursor-pointer">Select all</button>
              <button type="button" onClick={() => setSelected(new Set())} className="text-xs text-brand-700 hover:underline cursor-pointer">Select none</button>
            </div>
            <table className="w-full text-xs">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-1 w-6"></th>
                  <th className="py-1">Board</th>
                  {effectiveMode === 'corner' && <th className="py-1">Corner</th>}
                  <th className="py-1">Worksheet</th>
                </tr>
              </thead>
              <tbody>
                {sortedBoards.map((b) => {
                  const on = selected.has(b.id);
                  const q = quadrantOf(b);
                  return (
                    <tr key={b.id} className="border-t border-slate-100">
                      <td className="py-1">
                        <input
                          type="checkbox"
                          aria-label={`Send to ${b.title}`}
                          checked={on}
                          onChange={(e) =>
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(b.id);
                              else next.delete(b.id);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td className="py-1">
                        <span className="font-medium">{b.title}</span>
                        {b.elements.length > 0 && (
                          <span className="ml-2 px-1 rounded-[2px] bg-amber-100 text-amber-800">has work</span>
                        )}
                        <span className="ml-2 text-slate-400">{b.background?.fileName || 'no worksheet'}</span>
                      </td>
                      {effectiveMode === 'corner' && <td className="py-1">{q ? CORNER_GLYPH[q] : 'none'}</td>}
                      <td className="py-1">
                        {on
                          ? letterSelect(assignment.get(b.id)!, (l) => setOverrides((o) => ({ ...o, [b.id]: l })), LETTERS.filter((l) => letters.includes(l) || l === assignment.get(b.id)), `Worksheet for ${b.title}`)
                          : <span className="text-slate-400">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <label className="flex gap-2">
            <input type="checkbox" checked={lateJoiners} onChange={(e) => setLateJoiners(e.target.checked)} />
            Late joiners get worksheet A
          </label>

          {withWork > 0 && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-[2px] p-2">
              {withWork} board{withWork === 1 ? ' already has' : 's already have'} student work. Their ink stays, but the worksheet underneath will change.
            </p>
          )}
          {missingLetters.length > 0 && (
            <p className="text-xs text-red-700">Add a file for worksheet {missingLetters.join(', ')} or change who gets it.</p>
          )}
          {cornerSummary && <p className="text-xs text-slate-600">{cornerSummary}</p>}
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-200">
          <button type="button" disabled={sending} onClick={onClose} className="px-3 py-1.5 text-sm rounded-[2px] border oh-btn text-slate-700 cursor-pointer">
            Cancel
          </button>
          <button
            type="button"
            disabled={sendDisabled}
            onClick={() => void send()}
            className="px-3 py-1.5 text-sm rounded-[2px] border oh-btn-primary text-white disabled:opacity-50 cursor-pointer"
          >
            {progress || 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
