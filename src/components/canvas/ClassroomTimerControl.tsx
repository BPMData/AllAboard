import { Pause, Play, RotateCcw, Timer } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import type { ClassroomTimerState, TimerControlPayload } from '../../types';
import { formatTimerMs, parseCustomTimeSeconds } from './canvasHelpers';

/** True when the timer is running or paused with time left (what the countdown shows, without ticking). */
export function timerHasTime(timer: ClassroomTimerState | undefined): boolean {
  return Boolean(timer?.isRunning) || Math.max(0, timer?.remainingMs || 0) > 0;
}

/**
 * Milliseconds left on the classroom timer, re-computed every 250 ms while it runs. Only the component that calls this
 * re-renders on each tick.
 */
export function useTimerRemainingMs(timer: ClassroomTimerState | undefined): number {
  const [displayRemainingMs, setDisplayRemainingMs] = useState<number>(0);

  useEffect(() => {
    const updateRemaining = () => {
      if (!timer) {
        setDisplayRemainingMs(0);
        return;
      }
      if (timer.isRunning && timer.endsAt !== null) {
        setDisplayRemainingMs(Math.max(0, timer.endsAt - Date.now()));
      } else {
        setDisplayRemainingMs(Math.max(0, timer.remainingMs || 0));
      }
    };
    updateRemaining();
    if (timer?.isRunning && timer?.endsAt !== null) {
      const interval = setInterval(updateRemaining, 250);
      return () => clearInterval(interval);
    }
  }, [timer]);

  return displayRemainingMs;
}

interface ClassroomTimerControlProps {
  timer: ClassroomTimerState | undefined;
  onTeacherTimerControl: (payload: TimerControlPayload) => void;
}

/** Teacher Classroom Countdown Timer button & popover. */
export function ClassroomTimerControl({ timer, onTeacherTimerControl }: ClassroomTimerControlProps) {
  const [showTimerMenu, setShowTimerMenu] = useState<boolean>(false);
  const [customTimeInput, setCustomTimeInput] = useState<string>('7:00');
  const timerMenuRef = useRef<HTMLDivElement>(null);
  const displayRemainingMs = useTimerRemainingMs(timer);

  useEffect(() => {
    if (!showTimerMenu) return;
    const onDocDown = (e: MouseEvent) => {
      if (timerMenuRef.current && !timerMenuRef.current.contains(e.target as Node)) {
        setShowTimerMenu(false);
      }
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [showTimerMenu]);

  return (
    <div ref={timerMenuRef} className="relative">
      <button
        type="button"
        onClick={() => setShowTimerMenu((prev) => !prev)}
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1 rounded-[2px] text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer border',
          timer?.isRunning
            ? displayRemainingMs <= 60000
              ? 'oh-btn-danger text-white animate-pulse'
              : 'oh-btn-dark text-amber-300'
            : displayRemainingMs > 0
              ? 'bg-amber-200 text-slate-900 border-amber-400'
              : 'oh-btn text-slate-800'
        )}
        title="Start, pause, or configure the synchronized classroom countdown timer"
      >
        <Timer size={13} className={timer?.isRunning ? 'text-amber-300' : 'text-amber-600'} />
        <span className="font-mono tabular-nums">
          {timer?.isRunning || displayRemainingMs > 0
            ? `${formatTimerMs(displayRemainingMs)}${!timer?.isRunning ? ' (Paused)' : ''}`
            : 'Timer'}
        </span>
      </button>

      {showTimerMenu && (
        <div className="absolute left-0 top-full mt-1.5 z-50 w-72 rounded-[3px] bg-white border-2 border-[#CBD5E1] overflow-hidden text-slate-800 select-text">
          <div className="oh-panel-header flex items-center justify-between px-3.5 py-2 border-b border-[#CBD5E1]">
            <span className="font-display font-bold text-xs text-slate-900">Classroom Countdown Timer</span>
            {(timer?.isRunning || displayRemainingMs > 0) && (
              <span className="font-mono tabular-nums text-xs font-bold text-brand-600">
                {formatTimerMs(displayRemainingMs)}
              </span>
            )}
          </div>

          <div className="p-3.5 space-y-3">
            {/* Default Preset Buttons: 5, 10, 20, 30 minutes */}
            <div>
              <span className="block text-[11px] font-medium text-slate-500 mb-1.5">Quick Start Presets:</span>
              <div className="grid grid-cols-4 gap-1.5">
                {[5, 10, 20, 30].map((mins) => (
                  <button
                    key={mins}
                    type="button"
                    onClick={() => {
                      onTeacherTimerControl({
                        action: 'start',
                        durationSeconds: mins * 60,
                      });
                      setShowTimerMenu(false);
                    }}
                    className="py-1.5 px-2 rounded-[2px] border oh-btn text-xs font-mono font-semibold text-slate-800 hover:text-brand-700 transition-colors cursor-pointer"
                  >
                    {mins}m
                  </button>
                ))}
              </div>
            </div>

            {/* Custom Exact Time Input */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const secs = parseCustomTimeSeconds(customTimeInput);
                if (secs && secs >= 5) {
                  onTeacherTimerControl({
                    action: 'start',
                    durationSeconds: secs,
                  });
                  setShowTimerMenu(false);
                }
              }}
              className="space-y-1"
            >
              <label className="block text-[11px] font-medium text-slate-500">
                Exact Time (e.g. <span className="font-mono">7:30</span> or minutes like{' '}
                <span className="font-mono">12</span>):
              </label>
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={customTimeInput}
                  onChange={(e) => setCustomTimeInput(e.target.value)}
                  placeholder="e.g. 7:30 or 15"
                  className="flex-1 px-2.5 py-1.5 text-xs font-mono border border-[#CBD5E1] rounded-[2px] focus:outline-none focus:border-brand-600"
                />
                <button
                  type="submit"
                  disabled={!parseCustomTimeSeconds(customTimeInput)}
                  className="px-3 py-1.5 rounded-[2px] border oh-btn-primary text-xs font-semibold text-white disabled:opacity-40 cursor-pointer whitespace-nowrap"
                >
                  Start
                </button>
              </div>
            </form>

            {/* Active Timer Controls (Pause/Resume, +1m, Stop) */}
            {(timer?.isRunning || displayRemainingMs > 0) && (
              <div className="flex items-center gap-1.5 pt-2 border-t border-slate-200">
                {timer?.isRunning ? (
                  <button
                    type="button"
                    onClick={() => onTeacherTimerControl({ action: 'pause' })}
                    className="flex-1 flex items-center justify-center gap-1 py-1.5 px-2 rounded-[2px] border border-amber-300 bg-amber-100 text-amber-900 hover:bg-amber-200 text-xs font-semibold cursor-pointer"
                  >
                    <Pause size={12} />
                    <span>Pause</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => onTeacherTimerControl({ action: 'resume' })}
                    className="flex-1 flex items-center justify-center gap-1 py-1.5 px-2 rounded-[2px] border oh-btn-emerald text-xs font-semibold text-white cursor-pointer"
                  >
                    <Play size={12} />
                    <span>Resume</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onTeacherTimerControl({ action: 'add-minute' })}
                  className="py-1.5 px-2.5 rounded-[2px] border oh-btn text-xs font-mono font-semibold text-slate-700 cursor-pointer"
                  title="Add 1 minute"
                >
                  +1m
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onTeacherTimerControl({ action: 'stop' });
                    setShowTimerMenu(false);
                  }}
                  className="flex items-center justify-center gap-1 py-1.5 px-2.5 rounded-[2px] border border-red-200 bg-red-50 text-red-600 hover:bg-red-100 text-xs font-semibold cursor-pointer"
                  title="Stop and clear timer"
                >
                  <RotateCcw size={12} />
                  <span>Stop</span>
                </button>
              </div>
            )}

            {/* Auto-Lock on Expire Option */}
            <label className="flex items-center gap-2 pt-2 border-t border-slate-200 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={Boolean(timer?.autoLockOnExpire)}
                onChange={(e) =>
                  onTeacherTimerControl({
                    action: 'set-autolock',
                    autoLockOnExpire: e.target.checked,
                  })
                }
                className="rounded-[2px] border-[#CBD5E1] text-brand-600 focus:ring-brand-500"
              />
              <span>Auto-lock board when time expires</span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

/** The countdown chip in the student status banner. */
export function StudentTimerBadge({ timer }: { timer: ClassroomTimerState | undefined }) {
  const displayRemainingMs = useTimerRemainingMs(timer);
  if (!(timer?.isRunning || displayRemainingMs > 0)) return null;
  return (
    <span
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-0.5 rounded-[2px] border font-mono tabular-nums font-bold text-xs',
        timer?.isRunning
          ? displayRemainingMs <= 60000
            ? 'bg-red-600 border-red-700 text-white animate-pulse'
            : 'bg-slate-900 border-[#243044] text-amber-300'
          : 'bg-amber-200 border-amber-400 text-slate-900'
      )}
    >
      <Timer size={12} />
      <span>
        {formatTimerMs(displayRemainingMs)}
        {!timer?.isRunning ? ' (Paused)' : ''}
      </span>
    </span>
  );
}
