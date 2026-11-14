import React, { useEffect, useState } from 'react';
import { RoomAvailability } from '../types';
import { AlertTriangle, PlusCircle, LogIn, X, Shuffle, Check } from 'lucide-react';
import { normalizeRoomCode, sanitizeRoomCodeDraft } from '../lib/roomCode';

interface RoomExistsModalProps {
  availability: RoomAvailability;
  isJoiningAsTeacher?: boolean;
  isBusy?: boolean;
  onJoinAnyway: () => void;
  onCreateFreshRoom: () => void;
  onSwitchToCustomRoom?: (customRoomId: string) => void;
  onCancel: () => void;
}

export default function RoomExistsModal({
  availability,
  isJoiningAsTeacher = false,
  isBusy = false,
  onJoinAnyway,
  onCreateFreshRoom,
  onSwitchToCustomRoom,
  onCancel,
}: RoomExistsModalProps) {
  const [customDraft, setCustomDraft] = useState('');

  useEffect(() => {
    setCustomDraft('');
  }, [availability.roomId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isBusy) {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isBusy, onCancel]);

  const details: string[] = [];
  if (availability.activeUserCount > 0) {
    details.push(
      `${availability.activeUserCount} ${availability.activeUserCount === 1 ? 'person' : 'people'} currently online`
    );
  }
  if (availability.hasTeacherPin) {
    details.push('Teacher PIN already set');
  }
  if (availability.hasContent) {
    details.push('Saved board work or chat history');
  }

  const trimmedCustom = customDraft.replace(/^-|-$/g, '').trim();
  const normalizedCustom = trimmedCustom ? normalizeRoomCode(trimmedCustom) : '';
  const canSubmitCustom =
    Boolean(onSwitchToCustomRoom) &&
    Boolean(normalizedCustom) &&
    normalizedCustom !== availability.roomId;

  const handleCustomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmitCustom || isBusy || !onSwitchToCustomRoom) return;
    onSwitchToCustomRoom(normalizedCustom);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4"
      onClick={() => {
        if (!isBusy) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="room-exists-title"
        onClick={(e) => e.stopPropagation()}
        className="bg-white border border-slate-200 rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4 text-slate-800 select-text"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
              <AlertTriangle size={20} />
            </div>
            <div>
              <h2
                id="room-exists-title"
                className="font-display font-bold text-base text-slate-900"
              >
                Room Already Exists
              </h2>
              <p className="text-xs text-slate-500">
                Room <span className="font-mono font-semibold text-slate-800">#{availability.roomId}</span> is already in use
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={isBusy}
            onClick={onCancel}
            className="p-1 text-slate-400 hover:text-slate-700 rounded-md transition-colors cursor-pointer disabled:opacity-40"
            aria-label="Cancel room change"
          >
            <X size={16} />
          </button>
        </div>

        {details.length > 0 && (
          <ul className="px-3.5 py-2.5 rounded-xl bg-amber-50/80 border border-amber-200/80 space-y-1 text-xs text-amber-950">
            {details.map((item) => (
              <li key={item} className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden="true" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        )}

        <p className="text-xs text-slate-600 leading-relaxed">
          {isJoiningAsTeacher && availability.hasTeacherPin
            ? 'If your Teacher PIN does not match this room’s existing PIN, you will join as a student instead. Want to join anyway or start a fresh room?'
            : 'Joining will enter this existing classroom (as a student unless you have its Teacher PIN). Do you want to join anyway or create a fresh room?'}
        </p>

        {onSwitchToCustomRoom && (
          <form
            onSubmit={handleCustomSubmit}
            className="p-3 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1.5"
          >
            <label
              htmlFor="modal-custom-room-input"
              className="block text-[11px] font-medium text-slate-600"
            >
              Pick another room code or generate a random one:
            </label>
            <div className="flex items-center gap-1.5">
              <input
                id="modal-custom-room-input"
                type="text"
                value={customDraft}
                disabled={isBusy}
                onChange={(e) => setCustomDraft(sanitizeRoomCodeDraft(e.target.value))}
                onBlur={() => {
                  if (trimmedCustom) setCustomDraft(normalizedCustom);
                }}
                placeholder="custom-room-code"
                maxLength={24}
                className="flex-1 min-w-0 px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-500"
              />
              <button
                type="submit"
                disabled={!canSubmitCustom || isBusy}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors cursor-pointer disabled:opacity-40 shrink-0"
                title="Use this custom room code"
              >
                <Check size={13} />
                <span>Use Code</span>
              </button>
              <button
                type="button"
                disabled={isBusy}
                onClick={onCreateFreshRoom}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-200/80 hover:bg-slate-300 text-slate-800 transition-colors cursor-pointer disabled:opacity-40 shrink-0"
                title="Generate a random unused room code"
              >
                <Shuffle size={12} />
                <span>Random</span>
              </button>
            </div>
          </form>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-slate-100">
          <button
            type="button"
            disabled={isBusy}
            onClick={onCancel}
            className="px-3.5 py-2 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isBusy}
            onClick={onJoinAnyway}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-800 transition-colors cursor-pointer disabled:opacity-40"
          >
            <LogIn size={13} />
            <span>Join Anyway</span>
          </button>
          <button
            type="button"
            disabled={isBusy}
            onClick={onCreateFreshRoom}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors cursor-pointer disabled:opacity-40"
          >
            <PlusCircle size={13} />
            <span>Create Fresh Room</span>
          </button>
        </div>
      </div>
    </div>
  );
}
