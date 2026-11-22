import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { History, RefreshCw, X } from 'lucide-react';
import {
  checkRoomHistoryStatus,
  clearRoomHistory,
  formatRoomAge,
  formatRoomStatusLabel,
  loadRoomHistory,
  removeRoomHistoryEntry,
  sortAndFilterRoomHistory,
  type RoomHistoryEntry,
  type RoomLiveStatus,
  type RoomStatusInfo,
} from '../lib/roomHistory';

interface RoomHistoryDropdownProps {
  theme: 'dark' | 'light';
  align?: 'left' | 'right';
  currentRoomId?: string;
  disabled?: boolean;
  historyVersion?: number;
  hintText?: string;
  onSelectRoom: (code: string) => void;
}

const DOT_CLASS: Record<RoomLiveStatus, string> = {
  live: 'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.22)]',
  saved: 'bg-amber-500',
  checking: 'bg-brand-500 animate-pulse',
  unknown: 'bg-slate-400',
  expired: 'bg-slate-400/70',
};

/**
 * Dropdown listing recent rooms visited on this browser with live/saved/expired status checks.
 */
export default function RoomHistoryDropdown({
  theme,
  align = 'right',
  currentRoomId,
  disabled = false,
  historyVersion = 0,
  hintText = 'Click a room to select its code.',
  onSelectRoom,
}: RoomHistoryDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [liveOnly, setLiveOnly] = useState(false);
  const [entries, setEntries] = useState<RoomHistoryEntry[]>(() => loadRoomHistory());
  const [statuses, setStatuses] = useState<Record<string, RoomStatusInfo | undefined>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const checkSeqRef = useRef(0);

  const refreshStatuses = useCallback((items: RoomHistoryEntry[]) => {
    const seq = ++checkSeqRef.current;
    if (items.length === 0) {
      setStatuses({});
      return;
    }
    setStatuses({});
    items.forEach((entry) => {
      void checkRoomHistoryStatus(entry.code).then((info) => {
        if (seq !== checkSeqRef.current) return;
        setStatuses((prev) => ({ ...prev, [entry.code]: info }));
      });
    });
  }, []);

  useEffect(() => {
    setEntries(loadRoomHistory());
  }, [historyVersion]);

  useEffect(() => {
    if (disabled) setIsOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  const toggleOpen = () => {
    if (disabled) return;
    if (isOpen) {
      setIsOpen(false);
      return;
    }
    const fresh = loadRoomHistory();
    setEntries(fresh);
    setIsOpen(true);
    refreshStatuses(fresh);
  };

  const displayedEntries = useMemo(
    () => sortAndFilterRoomHistory(entries, statuses, liveOnly),
    [entries, statuses, liveOnly]
  );

  const isDark = theme === 'dark';

  const triggerClasses = isDark
    ? `flex items-center gap-1 px-2 py-1 rounded-[2px] border font-medium whitespace-nowrap cursor-pointer disabled:opacity-50 transition-colors ${
        isOpen
          ? 'bg-brand-500/20 border-brand-500/60 text-brand-300'
          : 'oh-btn-dark text-slate-200 hover:text-white'
      }`
    : `flex items-center gap-1 px-2 py-0.5 rounded-[2px] border text-[11px] font-medium whitespace-nowrap cursor-pointer disabled:opacity-50 transition-colors ${
        isOpen
          ? 'oh-btn-active text-brand-900'
          : 'oh-btn text-slate-700 hover:text-slate-900'
      }`;

  const menuClasses = isDark
    ? 'bg-slate-900 border-2 border-[#243044] text-slate-100'
    : 'bg-white border-2 border-[#CBD5E1] text-slate-900';

  const mutedText = isDark ? 'text-slate-400' : 'text-slate-500';
  const subtleBtn = isDark
    ? 'px-1.5 py-0.5 rounded-[2px] border oh-btn-dark text-slate-200 hover:text-white transition-colors cursor-pointer'
    : 'px-1.5 py-0.5 rounded-[2px] border oh-btn text-slate-700 hover:text-slate-900 transition-colors cursor-pointer';

  const getRowClasses = (status: RoomLiveStatus) => {
    if (status === 'live') {
      return isDark
        ? 'border-emerald-500/45 bg-emerald-500/12 hover:bg-emerald-500/20'
        : 'border-emerald-500/45 bg-emerald-50/80 hover:bg-emerald-100/70';
    }
    if (status === 'saved') {
      return isDark
        ? 'border-amber-500/35 bg-amber-500/8 hover:bg-amber-500/15'
        : 'border-amber-400/50 bg-amber-50/60 hover:bg-amber-100/60';
    }
    if (status === 'expired') {
      return isDark
        ? 'border-slate-700/60 bg-slate-800/40 opacity-55 hover:opacity-80'
        : 'border-slate-200 bg-slate-50/70 opacity-60 hover:opacity-85';
    }
    return isDark
      ? 'border-slate-700/80 bg-slate-800/60 hover:bg-slate-800'
      : 'border-slate-200 bg-slate-50 hover:bg-slate-100';
  };

  const getStatusTextClasses = (status: RoomLiveStatus) => {
    if (status === 'live') return isDark ? 'text-emerald-300' : 'text-emerald-700';
    if (status === 'saved') return isDark ? 'text-amber-300' : 'text-amber-700';
    return mutedText;
  };

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        disabled={disabled}
        aria-expanded={isOpen}
        aria-haspopup="true"
        onClick={toggleOpen}
        className={triggerClasses}
        title="View recent rooms visited on this browser"
      >
        <History size={12} />
        <span>History</span>
      </button>

      {isOpen && (
        <div
          role="region"
          aria-label="Recent room history"
          className={`absolute top-[calc(100%+6px)] ${
            align === 'left' ? 'left-0' : 'right-0'
          } z-50 w-80 max-w-[calc(100vw-2rem)] rounded-[3px] p-2.5 flex flex-col gap-2 text-left ${menuClasses}`}
        >
          <div className="flex items-center justify-between gap-2 text-xs">
            <strong className="font-semibold">Recent rooms</strong>
            <div className="flex items-center gap-2">
              <label className="inline-flex items-center gap-1 text-[11px] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={liveOnly}
                  onChange={(e) => setLiveOnly(e.target.checked)}
                  className="rounded border-slate-400 accent-brand-500 cursor-pointer"
                />
                <span>Live only</span>
              </label>
              {entries.length > 0 && (
                <>
                  <button
                    type="button"
                    className={subtleBtn}
                    aria-label="Refresh room status"
                    title="Refresh room status"
                    onClick={() => refreshStatuses(entries)}
                  >
                    <RefreshCw size={11} />
                  </button>
                  <button
                    type="button"
                    className={`${subtleBtn} text-[11px]`}
                    onClick={() => {
                      clearRoomHistory();
                      setEntries([]);
                      setStatuses({});
                    }}
                  >
                    Clear
                  </button>
                </>
              )}
            </div>
          </div>

          <p className={`text-[11px] leading-snug ${mutedText}`}>{hintText}</p>

          {entries.length === 0 ? (
            <div className={`py-3 px-2 text-center text-xs ${mutedText}`}>
              No rooms visited on this browser yet.
            </div>
          ) : displayedEntries.length === 0 ? (
            <div className={`py-3 px-2 text-center text-xs ${mutedText}`}>
              No live rooms right now. Uncheck Live only to see saved or expired rooms.
            </div>
          ) : (
            <ul className="max-h-60 overflow-y-auto flex flex-col gap-1 pr-0.5">
              {displayedEntries.map((entry) => {
                const info = statuses[entry.code];
                const st: RoomLiveStatus = info?.status ?? 'checking';
                const isCurrent = currentRoomId === entry.code;
                return (
                  <li key={entry.code} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setIsOpen(false);
                        onSelectRoom(entry.code);
                      }}
                      className={`flex-1 min-w-0 flex items-center gap-2 px-2.5 py-1.5 rounded-[2px] border text-left text-xs transition-colors cursor-pointer ${getRowClasses(
                        st
                      )}`}
                    >
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${DOT_CLASS[st]}`}
                        aria-hidden="true"
                      />
                      <span className="font-mono font-semibold truncate">{entry.code}</span>
                      {isCurrent && (
                        <span
                          className={`text-[10px] px-1 py-0.2 rounded font-medium shrink-0 ${
                            isDark ? 'bg-slate-700 text-slate-200' : 'bg-slate-200 text-slate-700'
                          }`}
                        >
                          Current
                        </span>
                      )}
                      <span className={`text-[11px] whitespace-nowrap shrink-0 ${mutedText}`}>
                        {formatRoomAge(entry.lastUsedAt)}
                      </span>
                      <span
                        className={`ml-auto text-[11px] font-semibold whitespace-nowrap shrink-0 ${getStatusTextClasses(
                          st
                        )}`}
                      >
                        {formatRoomStatusLabel(info)}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${entry.code} from history`}
                      title={`Remove ${entry.code} from history`}
                      onClick={() => {
                        const updated = removeRoomHistoryEntry(entry.code);
                        setEntries(updated);
                      }}
                      className={`p-1 rounded transition-colors cursor-pointer shrink-0 ${
                        isDark
                          ? 'text-slate-500 hover:text-slate-200 hover:bg-slate-800'
                          : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      <X size={12} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
