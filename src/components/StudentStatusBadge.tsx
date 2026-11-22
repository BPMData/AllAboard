import React from 'react';
import type { StudentStatus } from '../types';

export const STATUS_OPTIONS = {
  'need-help': { label: 'Need Help', className: 'bg-amber-100 text-amber-800 border-amber-300' },
  'got-it': { label: 'Got It', className: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
  done: { label: 'Done', className: 'bg-purple-100 text-purple-800 border-purple-300' },
} as const;

export function StudentStatusBadge({ status, name, onClear }: { status?: StudentStatus; name: string; onClear?: () => void }) {
  if (!status || status === 'none') return null;
  const option = STATUS_OPTIONS[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-[2px] border px-2 py-0.5 text-[11px] font-medium ${option.className}`}>
      {option.label}
      {onClear && <button type="button" aria-label={`Clear ${name}'s status`} onClick={(e) => { e.stopPropagation(); onClear(); }} className="font-bold cursor-pointer">×</button>}
    </span>
  );
}
