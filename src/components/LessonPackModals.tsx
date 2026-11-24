import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, BookOpen, Download, Eye, EyeOff, FolderOpen, HardDrive, X } from 'lucide-react';
import type { BreakoutRoundMeta, RoomBackground } from '../types';
import { cn } from '../lib/utils';
import {
  LESSON_FILE_ACCEPT,
  lessonAssetUrls,
  lessonFileName,
  parseLessonText,
  rewriteAssetUrls,
  hasStudentPicks,
  roundNameFromTitle,
  type LessonPack,
  type LessonRequestEvent,
  type MainInkChoice,
} from '../lib/lessonPack';
import { embedAssets } from '../lib/roomSnapshot';
import { variantsNote, type RoundVariants } from '../lib/roundVariants';
import { normalizeRoomCode, sanitizeRoomCodeDraft } from '../lib/roomCode';
import { MIN_TEACHER_PIN_LENGTH } from '../lib/teacherPin';
import {
  GoogleError,
  downloadDriveFile,
  friendlyGoogleError,
  getAccessToken,
  getLastDriveFolder,
  pickDriveFile,
  pickDriveFolder,
  saveJsonToDrive,
  LESSON_MIME,
  type DriveFolder,
} from '../lib/googleDrive';

export type LessonRequest = (event: LessonRequestEvent, payload: unknown, timeoutMs?: number) => Promise<any>;

/** Gmail and many school mail systems refuse attachments over about this size. */
const EMAIL_LIMIT_BYTES = 25 * 1024 * 1024;

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `about ${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `about ${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function driveError(err: any, fallback: string): string {
  return err instanceof GoogleError ? friendlyGoogleError(err.code) : err?.message || fallback;
}

function ModalShell({
  title,
  subtitle,
  onClose,
  footer,
  children,
  testId,
}: {
  title: string;
  subtitle?: React.ReactNode;
  onClose: () => void;
  footer: React.ReactNode;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4 select-text">
      <div
        role="dialog"
        aria-label={title}
        data-testid={testId}
        className="bg-white border-2 border-[#CBD5E1] rounded-[3px] w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden"
      >
        <div className="oh-panel-header flex items-start justify-between gap-4 px-5 py-3.5 border-b border-[#CBD5E1]">
          <div>
            <h3 className="font-display text-lg font-bold text-slate-900">{title}</h3>
            {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
          </div>
          <button
            type="button"
            aria-label={`Close ${title.toLowerCase()}`}
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-700 rounded-[2px] border border-transparent hover:border-[#CBD5E1] cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto text-xs text-slate-700">{children}</div>
        <div className="oh-panel-header flex flex-wrap items-center justify-end gap-2 px-5 py-3 border-t border-[#CBD5E1]">
          {footer}
        </div>
      </div>
    </div>
  );
}

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" className="p-3 rounded-[3px] bg-red-50 border border-red-200 flex items-start gap-2 text-xs text-red-800">
      <AlertCircle size={15} className="text-red-600 shrink-0 mt-0.5" />
      <div>{children}</div>
    </div>
  );
}

const btn = 'px-3 py-1.5 rounded-[2px] border oh-btn text-xs font-medium text-slate-700 transition-colors cursor-pointer disabled:opacity-50';
const btnPrimary =
  'flex items-center gap-1.5 px-4 py-1.5 rounded-[2px] border oh-btn-primary text-xs font-semibold text-white disabled:opacity-50 transition-colors cursor-pointer';

// ---------------------------------------------------------------- Save

interface SaveLessonModalProps {
  roomId: string;
  userName: string;
  rounds: BreakoutRoundMeta[];
  roundTemplates: Record<string, RoomBackground | null>;
  /** Worksheet variants B–D per round, to list them and to offer saving per-student picks. */
  roundVariants?: Record<string, RoundVariants>;
  mainBackground: RoomBackground | null;
  driveConfigured: boolean;
  onRequest: LessonRequest;
  onClose: () => void;
}

type BuildState =
  | { status: 'building' }
  | { status: 'ready'; json: string; fileName: string; size: number }
  | { status: 'error'; error: string };

export function SaveLessonModal({
  roomId,
  userName,
  rounds,
  roundTemplates,
  roundVariants = {},
  mainBackground,
  driveConfigured,
  onRequest,
  onClose,
}: SaveLessonModalProps) {
  const [includeStudentPicks, setIncludeStudentPicks] = useState(false);
  const anyStudentPicks = hasStudentPicks(roundVariants);
  const [title, setTitle] = useState(roomId);
  const [includeAuthor, setIncludeAuthor] = useState(true);
  const [mainInk, setMainInk] = useState<MainInkChoice>('teacher');
  // D4: launched rounds go in too, ticked by default.
  const [selected, setSelected] = useState<Set<string>>(() => new Set(rounds.map((r) => r.id)));
  const [inkCounts, setInkCounts] = useState<{ teacher: number; all: number } | null>(null);
  const [build, setBuild] = useState<BuildState>({ status: 'building' });
  const [retry, setRetry] = useState(0);
  const [folder, setFolder] = useState<DriveFolder>(() => getLastDriveFolder());
  const [driveBusy, setDriveBusy] = useState(false);
  const [driveMessage, setDriveMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const assetCache = useRef<Record<string, string>>({});
  const selectedKey = Array.from(selected).sort().join(',');

  // Rebuild the file whenever a choice changes. Images already downloaded are kept in assetCache.
  useEffect(() => {
    let cancelled = false;
    setBuild({ status: 'building' });
    const timer = setTimeout(async () => {
      const res = await onRequest('teacher:export-lesson', {
        title,
        exportedBy: includeAuthor ? userName : undefined,
        mainInk,
        roundIds: selectedKey ? selectedKey.split(',') : [],
        includeStudentPicks,
      });
      if (cancelled) return;
      if (!res?.ok) {
        setBuild({ status: 'error', error: res?.error || 'Could not build the lesson.' });
        return;
      }
      if (res.inkCounts) setInkCounts(res.inkCounts);
      const lesson = res.lesson as LessonPack;
      const urls = lessonAssetUrls(lesson);
      const toFetch = urls.filter((u) => !assetCache.current[u]);
      const { assets, failed } = await embedAssets(toFetch);
      if (cancelled) return;
      Object.assign(assetCache.current, assets);
      if (failed.length > 0) {
        setBuild({
          status: 'error',
          error: `${failed.length} worksheet image${failed.length === 1 ? '' : 's'} couldn't be downloaded, so the file would be incomplete. Check your connection and try again.`,
        });
        return;
      }
      lesson.assets = Object.fromEntries(urls.map((u) => [u, assetCache.current[u]]));
      const json = JSON.stringify(lesson);
      setBuild({ status: 'ready', json, fileName: lessonFileName(lesson.title), size: json.length });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [title, includeAuthor, userName, mainInk, selectedKey, includeStudentPicks, onRequest, retry]);

  const toggleRound = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const download = () => {
    if (build.status !== 'ready') return;
    const url = URL.createObjectURL(new Blob([build.json], { type: 'application/json' }));
    const link = document.createElement('a');
    link.download = build.fileName;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const saveToDrive = async () => {
    if (build.status !== 'ready') return;
    setDriveBusy(true);
    setDriveMessage(null);
    try {
      await getAccessToken(); // first, inside the click, so the sign-in popup isn't blocked
      // Kept apart from this room's own Drive save, so saving a lesson never replaces the room file.
      const saved = await saveJsonToDrive(`lesson:${roomId}`, build.fileName, folder, build.json, LESSON_MIME);
      setDriveMessage({ text: `Saved ${saved.fileName} to ${saved.folder.name}.`, isError: false });
    } catch (err) {
      setDriveMessage({ text: driveError(err, 'Could not save to Google Drive.'), isError: true });
    } finally {
      setDriveBusy(false);
    }
  };

  const changeFolder = async () => {
    setDriveMessage(null);
    try {
      const picked = await pickDriveFolder(folder);
      if (picked) setFolder(picked);
    } catch (err) {
      setDriveMessage({ text: driveError(err, 'Could not open Google Drive.'), isError: true });
    }
  };

  const inkOption = (value: MainInkChoice, label: string, count?: number) => (
    <label className="flex items-center gap-2 cursor-pointer">
      <input type="radio" name="lesson-main-ink" checked={mainInk === value} onChange={() => setMainInk(value)} />
      <span>
        {label}
        {count !== undefined ? ` (${count})` : ''}
      </span>
    </label>
  );

  return (
    <ModalShell
      testId="save-lesson-modal"
      title="Save lesson"
      subtitle="A .allaboard file you can load into a fresh room later, or share with another teacher."
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={btn}>
            Close
          </button>
          {driveConfigured && (
            <button
              type="button"
              disabled={build.status !== 'ready' || driveBusy}
              onClick={saveToDrive}
              className={cn(btn, 'flex items-center gap-1.5')}
            >
              <HardDrive size={13} className="text-emerald-600" />
              {driveBusy ? 'Saving…' : 'Save to Drive'}
            </button>
          )}
          <button type="button" disabled={build.status !== 'ready'} onClick={download} className={btnPrimary}>
            <Download size={13} />
            Download
          </button>
        </>
      }
    >
      <div className="space-y-1">
        <label htmlFor="lesson-title" className="block font-semibold text-slate-800">
          Lesson title
        </label>
        <input
          id="lesson-title"
          value={title}
          maxLength={80}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full border border-[#CBD5E1] rounded-[2px] px-2 py-1 text-sm"
        />
        <label className="flex items-center gap-2 cursor-pointer pt-1">
          <input type="checkbox" checked={includeAuthor} onChange={(e) => setIncludeAuthor(e.target.checked)} />
          <span>Include my name ({userName || 'Teacher'}) as the author</span>
        </label>
      </div>

      <div className="space-y-1">
        <div className="font-semibold text-slate-800">Main board</div>
        <div>Worksheet: {mainBackground?.fileName || 'none'}</div>
        <div className="space-y-1 pt-1">
          {inkOption('teacher', 'Teacher ink only', inkCounts?.teacher)}
          {inkOption('all', 'All ink except name stamps', inkCounts?.all)}
          {inkOption('none', 'No ink')}
        </div>
        <p className="text-slate-500">
          Ink by a co-teacher who hasn't been in this room since the server last restarted counts as student ink.
        </p>
      </div>

      <div className="space-y-1">
        <div className="font-semibold text-slate-800">Breakout rounds</div>
        {rounds.length === 0 ? (
          <div className="text-slate-500">No rounds yet. Rounds you save for later in Breakouts go here.</div>
        ) : (
          rounds.map((r) => (
            <label key={r.id} className="flex items-start gap-2 cursor-pointer">
              <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleRound(r.id)} className="mt-0.5" />
              <span>
                {roundNameFromTitle(r.title) || `Round ${r.number}`} · {r.mode === 'groups' ? 'Groups' : 'Individual'} ·{' '}
                {roundTemplates[r.id]?.fileName || 'blank'}
                {variantsNote(roundVariants[r.id])}
                {r.prepared ? ' (prepared)' : ' (already run; saved without student work)'}
              </span>
            </label>
          ))
        )}
      </div>

      {anyStudentPicks && (
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={includeStudentPicks}
            onChange={(e) => setIncludeStudentPicks(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            Also save the worksheets you picked for specific students (saves those students' names). They apply when a
            student with the same name joins.
          </span>
        </label>
      )}
      <p className="p-2.5 rounded-[3px] bg-slate-50 border border-[#CBD5E1]">
        Never saved: student boards, chat, {includeStudentPicks ? 'other ' : ''}student names, groups' members, your PIN.
      </p>

      <div aria-live="polite" className="space-y-1">
        {build.status === 'building' && <div className="text-slate-500">Preparing the file…</div>}
        {build.status === 'ready' && (
          <div data-testid="lesson-size">
            File: <span className="font-mono">{build.fileName}</span>, {formatSize(build.size)}.
            {build.size > EMAIL_LIMIT_BYTES && ' That is too big to email; save it to Drive to share it.'}
          </div>
        )}
        {build.status === 'error' && (
          <ErrorBox>
            {build.error}{' '}
            <button type="button" onClick={() => setRetry((n) => n + 1)} className="underline font-semibold cursor-pointer">
              Try again
            </button>
          </ErrorBox>
        )}
        {driveConfigured && (
          <div className="flex items-center gap-2 text-slate-500">
            <span>Drive folder: {folder.name}</span>
            <button type="button" onClick={changeFolder} className="underline cursor-pointer">
              Change
            </button>
          </div>
        )}
        {driveMessage && (
          <div className={driveMessage.isError ? 'text-red-600 font-medium' : 'text-emerald-700'}>{driveMessage.text}</div>
        )}
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------- Load

interface LoadLessonModalProps {
  roomId: string;
  isRoundLive: boolean;
  driveConfigured: boolean;
  onRequest: LessonRequest;
  generateUnusedRoomCode: () => Promise<string>;
  getSavedTeacherPin: () => string;
  onOpenNewRoom: (roomId: string, pin: string) => void;
  onSaveRoomFirst: () => void;
  /** Called after a load into this room, with the lesson that was loaded. */
  onLoadedHere: (lesson: LessonPack) => void;
  onClose: () => void;
}

function describeSettings(lesson: LessonPack): string[] {
  const s = lesson.settings;
  const lines: string[] = [];
  if (s.autoIndividual) {
    const ws = s.autoIndividualTemplateLabel || s.autoIndividualBackground?.fileName || 'blank';
    lines.push(`Students start on their own boards: ${ws}`);
  }
  if (typeof s.timerDurationMs === 'number') {
    const min = Math.round(s.timerDurationMs / 60000);
    lines.push(`Timer: ${min} min${s.timerAutoLock ? ', locks the board when it ends' : ''}`);
  }
  if (s.oneNameStamp) lines.push('One name stamp per student');
  if (s.hideStudentCursors) lines.push("Students can't see each other's cursors");
  if (s.allowSelfSelect) lines.push('Students may pick their own breakout board');
  if (s.chatScope === 'board') lines.push('Breakout chat stays on each board');
  return lines;
}

export function LoadLessonModal({
  roomId,
  isRoundLive,
  driveConfigured,
  onRequest,
  generateUnusedRoomCode,
  getSavedTeacherPin,
  onOpenNewRoom,
  onSaveRoomFirst,
  onLoadedHere,
  onClose,
}: LoadLessonModalProps) {
  const [fileName, setFileName] = useState('');
  const [lesson, setLesson] = useState<LessonPack | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [target, setTarget] = useState<'new' | 'current'>('new');
  const [newRoomId, setNewRoomId] = useState('');
  const [pin, setPin] = useState(() => getSavedTeacherPin());
  const [showPin, setShowPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [driveOpening, setDriveOpening] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void generateUnusedRoomCode().then((code) => {
      if (!cancelled) setNewRoomId((prev) => prev || code);
    });
    return () => {
      cancelled = true;
    };
  }, [generateUnusedRoomCode]);

  useEffect(() => {
    if (isRoundLive && target === 'current') setTarget('new');
  }, [isRoundLive, target]);

  const openText = (name: string, text: string) => {
    const parsed = parseLessonText(name, text);
    setFileName(name);
    setLesson(parsed.lesson);
    setParseError(parsed.error);
    setLoadError(null);
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => openText(file.name, String(reader.result || ''));
    reader.onerror = () => setParseError(`Couldn't read "${file.name}".`);
    reader.readAsText(file);
  };

  const openFromDrive = async () => {
    setParseError(null);
    setDriveOpening(true);
    try {
      const doc = await pickDriveFile('lesson'); // signs in first, inside the click
      if (!doc) return;
      const file = await downloadDriveFile(doc);
      openText(doc.name, await file.text());
    } catch (err) {
      setParseError(driveError(err, 'Could not open the lesson from Drive.'));
    } finally {
      setDriveOpening(false);
    }
  };

  const imageBytes = useMemo(
    () => (lesson ? Object.values(lesson.assets).reduce((sum, d) => sum + Math.round(d.length * 0.75), 0) : 0),
    [lesson]
  );
  const mainInkCount = lesson?.main.elements.length ?? 0;
  const cleanRoomId = normalizeRoomCode(newRoomId);
  const pinOk = pin.trim().length >= MIN_TEACHER_PIN_LENGTH;
  const canLoad =
    Boolean(lesson) && !busy && (target === 'current' ? !isRoundLive : Boolean(newRoomId.trim()) && pinOk);

  const load = async () => {
    if (!lesson || !canLoad) return;
    setBusy(true);
    setLoadError(null);
    try {
      // 1. Images first, one per message, so a pack of any size stays under the socket limit.
      const urls = lessonAssetUrls(lesson);
      setProgress('Checking worksheet images…');
      const missing: string[] = [];
      for (let i = 0; i < urls.length; i += 1000) {
        const res = await onRequest('teacher:has-assets', { urls: urls.slice(i, i + 1000) });
        if (!res?.ok) throw new Error(res?.error || 'Could not check the worksheet images.');
        missing.push(...res.missing);
      }
      const notInFile = missing.filter((u) => !lesson.assets[u]);
      if (notInFile.length > 0) {
        throw new Error(
          `This file is missing ${notInFile.length} worksheet image${notInFile.length === 1 ? '' : 's'}. Save the lesson again and use the new file.`
        );
      }
      const remap: Record<string, string> = {};
      for (let i = 0; i < missing.length; i++) {
        setProgress(`Uploading worksheet images ${i + 1}/${missing.length}…`);
        const res = await onRequest('teacher:upload-asset', { dataUrl: lesson.assets[missing[i]] });
        if (!res?.ok) throw new Error(res?.error || 'An image could not be uploaded.');
        if (res.url !== missing[i]) remap[missing[i]] = res.url; // the file was edited by hand
      }
      // 2. Then the small lesson, without its images.
      const ready = Object.keys(remap).length > 0 ? rewriteAssetUrls(lesson, remap) : lesson;
      const { assets: _assets, ...withoutAssets } = ready;
      setProgress('Setting up the lesson…');
      const res = await onRequest('teacher:load-lesson', {
        lesson: withoutAssets,
        target,
        ...(target === 'new' ? { newRoomId: cleanRoomId, pin: pin.trim() } : {}),
      });
      if (!res?.ok) throw new Error(res?.error || 'The lesson could not be loaded.');
      if (target === 'new') {
        onOpenNewRoom(res.roomId, pin.trim());
      } else {
        onLoadedHere(ready);
      }
      onClose();
    } catch (err: any) {
      setLoadError(err?.message || 'The lesson could not be loaded.');
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  return (
    <ModalShell
      testId="load-lesson-modal"
      title="Load lesson"
      subtitle="Sets up a saved .allaboard lesson. Nobody moves until you launch a round."
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={btn}>
            Cancel
          </button>
          <button type="button" disabled={!canLoad} onClick={load} className={btnPrimary}>
            <BookOpen size={13} />
            {busy ? 'Loading…' : target === 'new' ? 'Load into new room' : 'Load into this room'}
          </button>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept={LESSON_FILE_ACCEPT}
          aria-label="Lesson file"
          className="hidden"
          onChange={onFile}
        />
        <button type="button" onClick={() => fileInputRef.current?.click()} className={cn(btn, 'flex items-center gap-1.5')}>
          <FolderOpen size={13} />
          Choose file…
        </button>
        {driveConfigured && (
          <button type="button" disabled={driveOpening} onClick={openFromDrive} className={cn(btn, 'flex items-center gap-1.5')}>
            <HardDrive size={13} className="text-emerald-600" />
            {driveOpening ? 'Opening…' : 'Open from Drive'}
          </button>
        )}
        {fileName && <span className="font-mono text-slate-500 truncate max-w-[14rem]">{fileName}</span>}
      </div>

      {parseError && <ErrorBox>{parseError}</ErrorBox>}

      {lesson && (
        <div data-testid="lesson-preview" className="p-3 rounded-[3px] bg-slate-50 border border-[#CBD5E1] space-y-1.5">
          <div className="font-display font-semibold text-sm text-slate-900">{lesson.title}</div>
          {(lesson.exportedBy || lesson.exportedAt > 0) && (
            <div className="text-slate-500">
              {lesson.exportedBy ? `By ${lesson.exportedBy}` : ''}
              {lesson.exportedBy && lesson.exportedAt > 0 ? ', ' : ''}
              {lesson.exportedAt > 0 ? new Date(lesson.exportedAt).toLocaleDateString() : ''}
            </div>
          )}
          <div>
            Main board: {lesson.main.background?.fileName || 'no worksheet'}
            {mainInkCount > 0 ? `, ${mainInkCount} ink mark${mainInkCount === 1 ? '' : 's'}` : ''}
          </div>
          {lesson.rounds.length > 0 ? (
            <ol className="list-decimal pl-5 space-y-0.5">
              {lesson.rounds.map((r) => (
                <li key={r.key}>
                  {r.title || (r.mode === 'groups' ? 'Groups' : 'Individual')} ·{' '}
                  {r.mode === 'groups' ? `${r.groups?.length ?? 0} groups` : 'Individual'} · {r.worksheet?.fileName || 'blank'}
                  {r.ink?.length ? ` + teacher ink (${r.ink.length})` : ''}
                  {variantsNote(r.variants)}
                </li>
              ))}
            </ol>
          ) : (
            <div>No breakout rounds.</div>
          )}
          {describeSettings(lesson).map((line) => (
            <div key={line}>{line}</div>
          ))}
          {imageBytes > 0 && <div className="text-slate-500">Images: {formatSize(imageBytes)}</div>}
        </div>
      )}

      {lesson && (
        <div className="space-y-2">
          <div className="font-semibold text-slate-800">Load into</div>
          <label className="flex items-start gap-2 cursor-pointer">
            <input type="radio" name="lesson-target" checked={target === 'new'} onChange={() => setTarget('new')} className="mt-0.5" />
            <span>A new room</span>
          </label>
          {target === 'new' && (
            <div className="pl-6 grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
              <label htmlFor="lesson-room-code">Room code</label>
              <input
                id="lesson-room-code"
                value={newRoomId}
                onChange={(e) => setNewRoomId(sanitizeRoomCodeDraft(e.target.value))}
                className="border border-[#CBD5E1] rounded-[2px] px-2 py-1 font-mono"
              />
              <label htmlFor="lesson-room-pin">Teacher PIN</label>
              <div className="flex items-center gap-1">
                <input
                  id="lesson-room-pin"
                  type={showPin ? 'text' : 'password'}
                  value={pin}
                  autoComplete="off"
                  onChange={(e) => setPin(e.target.value)}
                  className="border border-[#CBD5E1] rounded-[2px] px-2 py-1 flex-1 min-w-0"
                />
                <button
                  type="button"
                  aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
                  onClick={() => setShowPin((v) => !v)}
                  className="p-1 text-slate-500 cursor-pointer"
                >
                  {showPin ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              {!pinOk && (
                <span className="col-span-2 text-slate-500">
                  The PIN needs at least {MIN_TEACHER_PIN_LENGTH} characters.
                </span>
              )}
            </div>
          )}
          <label className={cn('flex items-start gap-2', isRoundLive ? 'opacity-60' : 'cursor-pointer')}>
            <input
              type="radio"
              name="lesson-target"
              disabled={isRoundLive}
              checked={target === 'current'}
              onChange={() => setTarget('current')}
              className="mt-0.5"
            />
            <span>
              This room (#{roomId})
              {isRoundLive && <span className="block text-slate-500">Bring everyone to Main first.</span>}
            </span>
          </label>
          {target === 'current' && (
            <div className="pl-6 text-amber-800">
              The main board's ink and worksheet will be replaced. Prepared rounds will be replaced.{' '}
              <button type="button" onClick={onSaveRoomFirst} className="underline font-semibold cursor-pointer">
                Save class work first
              </button>
            </div>
          )}
        </div>
      )}

      <div aria-live="polite">
        {progress && <div className="text-slate-500">{progress}</div>}
        {loadError && (
          <ErrorBox>
            {loadError}{' '}
            <button type="button" onClick={load} className="underline font-semibold cursor-pointer">
              Retry
            </button>
          </ErrorBox>
        )}
      </div>
    </ModalShell>
  );
}
