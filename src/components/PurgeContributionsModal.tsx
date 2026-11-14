import React, { useEffect, useState } from 'react';
import { Trash2, AlertTriangle, X } from 'lucide-react';

interface PurgeContributionsModalProps {
  targetName: string;
  actionMode: 'kick' | 'ban';
  drawingCount: number;
  messageCount: number;
  isBusy?: boolean;
  onConfirmDelete: () => void;
  onCancel: () => void;
}

export default function PurgeContributionsModal({
  targetName,
  actionMode,
  drawingCount,
  messageCount,
  isBusy = false,
  onConfirmDelete,
  onCancel,
}: PurgeContributionsModalProps) {
  const [step, setStep] = useState<1 | 2>(1);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isBusy) {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isBusy, onCancel]);

  const countsSummary = [
    drawingCount > 0 ? `${drawingCount} ${drawingCount === 1 ? 'drawing/annotation' : 'drawings/annotations'}` : null,
    messageCount > 0 ? `${messageCount} ${messageCount === 1 ? 'chat message' : 'chat messages'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

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
        aria-labelledby="purge-contributions-title"
        onClick={(e) => e.stopPropagation()}
        className="bg-white border border-slate-200 rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4 text-slate-800 select-text"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div
              className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                step === 2 ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
              }`}
            >
              {step === 2 ? <Trash2 size={20} /> : <AlertTriangle size={20} />}
            </div>
            <div>
              <h2
                id="purge-contributions-title"
                className="font-display font-bold text-base text-slate-900"
              >
                {step === 1
                  ? `${actionMode === 'ban' ? 'Banned' : 'Kicked'} ${targetName}`
                  : 'Are you really sure?'}
              </h2>
              <p className="text-xs text-slate-500">
                {step === 1
                  ? 'Optional cleanup'
                  : `Permanently removing ${targetName}’s room contributions`}
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={isBusy}
            onClick={onCancel}
            className="p-1 text-slate-400 hover:text-slate-700 rounded-md transition-colors cursor-pointer disabled:opacity-40"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {step === 1 ? (
          <>
            <p className="text-sm font-medium text-slate-800 leading-snug">
              Delete all their contributions to the room (chat messages, drawings, annotations)?
            </p>
            {countsSummary && (
              <p className="px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-600">
                Found in this room: <span className="font-semibold text-slate-800">{countsSummary}</span>
              </p>
            )}
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                disabled={isBusy}
                onClick={onCancel}
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors cursor-pointer disabled:opacity-40"
              >
                No
              </button>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => setStep(2)}
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-700 text-white transition-colors cursor-pointer disabled:opacity-40"
              >
                Yes
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-slate-600 leading-relaxed">
              This will immediately and permanently delete all chat messages, drawings, and annotations by{' '}
              <span className="font-semibold text-slate-900">{targetName}</span> across the entire room
              (including breakout boards). This cannot be undone.
            </p>
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                disabled={isBusy}
                onClick={onCancel}
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors cursor-pointer disabled:opacity-40"
              >
                No
              </button>
              <button
                type="button"
                disabled={isBusy}
                onClick={onConfirmDelete}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-700 text-white transition-colors cursor-pointer disabled:opacity-40"
              >
                <Trash2 size={13} />
                <span>{isBusy ? 'Deleting...' : 'Yes'}</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
