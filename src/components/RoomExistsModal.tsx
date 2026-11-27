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
    Boolean(onSwitchToCustomRoom) && Boolean(normalizedCustom) && normalizedCustom !== availability.roomId;

  const handleCustomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmitCustom || isBusy || !onSwitchToCustomRoom) return;
    onSwitchToCustomRoom(normalizedCustom);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4"
      onClick={() => {
        if (!isBusy) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="room-exists-title"
        onClick={(e) => e.stopPropagation()}
        className="bg-white border-2 border-[#CBD5E1] rounded-[3px] w-full max-w-md overflow-hidden text-slate-800 select-text"
      >
        <div className="oh-panel-header flex items-start justify-between gap-3 px-5 py-3.5 border-b border-[#CBD5E1]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-[3px] bg-amber-100 border border-amber-200 text-amber-700 flex items-center justify-center shrink-0">
              <AlertTriangle size={18} />
            </div>
            <div>
              <h2 id="room-exists-title" className="font-display font-bold text-base text-slate-900">
                Room Already Exists
              </h2>
              <p className="text-xs text-slate-500">
                Room <span className="font-mono font-semibold text-slate-800">#{availability.roomId}</span> is already
                in use
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={isBusy}
            onClick={onCancel}
            className="p-1 text-slate-400 hover:text-slate-700 rounded-[2px] border border-transparent hover:border-[#CBD5E1] transition-colors cursor-pointer disabled:opacity-40"
            aria-label="Cancel room change"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {details.length > 0 && (
            <ul className="px-3.5 py-2.5 rounded-[3px] bg-amber-50/80 border border-amber-200/80 space-y-1 text-xs text-amber-950">
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
              className="p-3 rounded-[3px] bg-slate-50 border border-[#CBD5E1] space-y-1.5"
            >
              <label htmlFor="modal-custom-room-input" className="block text-[11px] font-medium text-slate-600">
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
                  className="flex-1 min-w-0 px-2.5 py-1.5 bg-white border border-[#CBD5E1] rounded-[2px] font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-brand-500"
                />
                <button
                  type="submit"
                  disabled={!canSubmitCustom || isBusy}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-[2px] border oh-btn-primary text-xs font-semibold text-white transition-colors cursor-pointer disabled:opacity-40 shrink-0"
                  title="Use this custom room code"
                >
                  <Check size={13} />
                  <span>Use Code</span>
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={onCreateFreshRoom}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-[2px] border oh-btn text-xs font-medium text-slate-800 transition-colors cursor-pointer disabled:opacity-40 shrink-0"
                  title="Generate a random unused room code"
                >
                  <Shuffle size={12} />
                  <span>Random</span>
                </button>
              </div>
            </form>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2 pt-3 border-t border-slate-200">
            <button
              type="button"
              disabled={isBusy}
              onClick={onCancel}
              className="px-3.5 py-1.5 rounded-[2px] border oh-btn text-xs font-medium text-slate-700 transition-colors cursor-pointer disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={onJoinAnyway}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-[2px] border oh-btn text-xs font-semibold text-slate-800 transition-colors cursor-pointer disabled:opacity-40"
            >
              <LogIn size={13} />
              <span>Join Anyway</span>
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={onCreateFreshRoom}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-[2px] border oh-btn-primary text-xs font-semibold text-white transition-colors cursor-pointer disabled:opacity-40"
            >
              <PlusCircle size={13} />
              <span>Create Fresh Room</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
