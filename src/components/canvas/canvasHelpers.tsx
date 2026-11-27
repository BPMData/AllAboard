import {
  Circle as CircleIcon,
  Diamond,
  Grid,
  Square,
  Star,
  Triangle
} from 'lucide-react';
import React from 'react';
import type { ElementGroup } from '../../lib/elementGroups';
import {
  TEXT_SIZE_PRESETS
} from '../../lib/inkCore';
import type { RoundVariants } from '../../lib/roundVariants';
import { DEFAULT_PAGE_GAP } from '../../lib/worksheetLayout';
import {
  CanvasElement,
  GridMode,
  HollowShapeKind,
  RoomBackground,
  StudentStatus
} from '../../types';


export type HistoryAction =
  | { kind: 'add'; items: CanvasElement[] }
  | { kind: 'remove'; items: CanvasElement[] }
  | { kind: 'update'; before: CanvasElement[]; after: CanvasElement[]; bringToFront?: boolean }
  | { kind: 'replace'; removed: CanvasElement[]; added: CanvasElement[] }
  /** Order-keeping edits (the eraser): `forward` redoes, `backward` undoes. */
  | { kind: 'groups'; forward: ElementGroup<CanvasElement>[]; backward: ElementGroup<CanvasElement>[] };

export const MIN_SCALE = 0.1;

export const MAX_SCALE = 5.0;

export const PAGE_GAP = DEFAULT_PAGE_GAP;

export const PALM_ERASER_SCREEN_PX = 56;

export function readLocalNum(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
  } catch {
    return fallback;
  }
}

export function readLocalColor(key: string, fallback: string): string {
  try {
    const raw = localStorage.getItem(key);
    return raw && /^#[0-9a-f]{6}$/i.test(raw) ? raw : fallback;
  } catch {
    return fallback;
  }
}

export function saveLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage errors
  }
}

export const HOLLOW_SHAPE_OPTIONS: Array<{
  kind: HollowShapeKind;
  label: string;
  dx: number;
  dy: number;
}> = [
    { kind: 'circle', label: 'Circle', dx: -62, dy: 26 },
    { kind: 'square', label: 'Square', dx: -35, dy: 50 },
    { kind: 'triangle', label: 'Triangle', dx: 0, dy: 60 },
    { kind: 'diamond', label: 'Diamond', dx: 35, dy: 50 },
    { kind: 'star', label: 'Star', dx: 62, dy: 26 },
  ];

export const STATUS_RADIAL_OPTIONS: Array<{
  status: StudentStatus;
  label: string;
  pillClass: string;
  dx: number;
  dy: number;
}> = [
    { status: 'need-help', label: 'Need Help', pillClass: 'bg-amber-100 text-amber-900 border-amber-400', dx: 40, dy: 30 },
    { status: 'got-it', label: 'Got It', pillClass: 'bg-emerald-100 text-emerald-900 border-emerald-400', dx: 100, dy: 64 },
    { status: 'done', label: 'Done', pillClass: 'bg-purple-100 text-purple-900 border-purple-400', dx: 158, dy: 60 },
    { status: 'none', label: 'Clear', pillClass: 'bg-slate-800 text-slate-100 border-slate-500', dx: 214, dy: 28 },
  ];

export const TEXT_SIZE_DROPDOWN_PRESETS = [
  ...TEXT_SIZE_PRESETS,
  { label: 'XXL', size: 72, title: 'Extra-extra-large text (72px)' },
] as const;

export function readLocalHollowShape(key: string, fallback: HollowShapeKind): HollowShapeKind {
  try {
    const raw = localStorage.getItem(key);
    if (
      raw === 'circle' ||
      raw === 'square' ||
      raw === 'triangle' ||
      raw === 'diamond' ||
      raw === 'star'
    ) {
      return raw;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export function HollowShapeIcon({ kind, size = 17 }: { kind: HollowShapeKind; size?: number }) {
  if (kind === 'square') return <Square size={size} />;
  if (kind === 'triangle') return <Triangle size={size} />;
  if (kind === 'diamond') return <Diamond size={size} />;
  if (kind === 'star') return <Star size={size} />;
  return <CircleIcon size={size} />;
}

export const GRID_MODE_OPTIONS: Array<{
  mode: GridMode;
  label: string;
  dx: number;
  dy: number;
}> = [
    { mode: 'blank', label: 'Blank', dx: -54, dy: -26 },
    { mode: 'dots', label: 'Dot Grid', dx: -20, dy: -54 },
    { mode: 'graph', label: 'Graph Paper (90°)', dx: 20, dy: -54 },
    { mode: 'isometric', label: 'Isometric (3D)', dx: 54, dy: -26 },
  ];

export function readLocalGridMode(key: string, fallback: GridMode): GridMode {
  try {
    const raw = localStorage.getItem(key);
    if (raw === 'blank' || raw === 'dots' || raw === 'graph' || raw === 'isometric') {
      return raw;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export function GridModeIcon({ mode, size = 15 }: { mode: GridMode; size?: number }) {
  if (mode === 'blank') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2" strokeDasharray="2.5 2" />
      </svg>
    );
  }
  if (mode === 'dots') {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
        <circle cx="3.5" cy="3.5" r="1.3" />
        <circle cx="8" cy="3.5" r="1.3" />
        <circle cx="12.5" cy="3.5" r="1.3" />
        <circle cx="3.5" cy="8" r="1.3" />
        <circle cx="8" cy="8" r="1.3" />
        <circle cx="12.5" cy="8" r="1.3" />
        <circle cx="3.5" cy="12.5" r="1.3" />
        <circle cx="8" cy="12.5" r="1.3" />
        <circle cx="12.5" cy="12.5" r="1.3" />
      </svg>
    );
  }
  if (mode === 'graph') {
    return <Grid size={size} />;
  }
  // Isometric 3D lattice icon
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.75L13.75 5V11L8 14.25L2.25 11V5L8 1.75Z" />
      <path d="M2.25 5L8 8.25L13.75 5" />
      <path d="M8 8.25V14.25" />
    </svg>
  );
}

export function getCanvasGridStyle(
  gridMode: GridMode,
  gridSpacing: number,
  stagePos: { x: number; y: number }
): React.CSSProperties {
  if (gridMode === 'blank') {
    return { backgroundColor: '#ffffff' };
  }
  if (gridMode === 'dots') {
    return {
      backgroundColor: '#ffffff',
      backgroundImage: `radial-gradient(#cbd5e1 1.25px, transparent 1.25px)`,
      backgroundSize: `${gridSpacing}px ${gridSpacing}px`,
      backgroundPosition: `${stagePos.x}px ${stagePos.y}px`,
    };
  }
  if (gridMode === 'graph') {
    return {
      backgroundColor: '#ffffff',
      backgroundImage: `linear-gradient(to right, #e2e8f0 1px, transparent 1px), linear-gradient(to bottom, #e2e8f0 1px, transparent 1px)`,
      backgroundSize: `${gridSpacing}px ${gridSpacing}px`,
      backgroundPosition: `${stagePos.x}px ${stagePos.y}px`,
    };
  }
  // Isometric 3D lattice (vertical lines + ±30° isometric axes meeting at every vertex)
  const isoH = Math.max(24, gridSpacing);
  const isoW = Math.round(isoH * Math.sqrt(3) * 100) / 100;
  const halfW = Math.round((isoW / 2) * 100) / 100;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${isoW}" height="${isoH}" viewBox="0 0 ${isoW} ${isoH}"><path d="M 0 0 L ${isoW} ${isoH} M 0 ${isoH} L ${isoW} 0 M 0 0 L 0 ${isoH} M ${halfW} 0 L ${halfW} ${isoH}" stroke="#dbe4f0" stroke-width="1" fill="none"/></svg>`;
  return {
    backgroundColor: '#ffffff',
    backgroundImage: `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`,
    backgroundSize: `${isoW}px ${isoH}px`,
    backgroundPosition: `${stagePos.x}px ${stagePos.y}px`,
  };
}

export const EMPTY_ROUND_TEMPLATES: Record<string, RoomBackground | null> = {};

export const EMPTY_TEMPLATE_INK: Record<string, CanvasElement[]> = {};

export const EMPTY_ROUND_VARIANTS: Record<string, RoundVariants> = {};

export const formatTimerMs = (ms: number): string => {
  const totalSecs = Math.max(0, Math.ceil(ms / 1000));
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

export const parseCustomTimeSeconds = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.includes(':')) {
    const parts = trimmed.split(':').map((p) => Number(p.trim()));
    if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
    if (parts.length === 2) {
      return Math.round(parts[0] * 60 + parts[1]);
    }
    if (parts.length === 3) {
      return Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2]);
    }
    return null;
  }
  const mins = Number(trimmed);
  if (!Number.isFinite(mins) || mins <= 0) return null;
  return Math.round(mins * 60);
};
