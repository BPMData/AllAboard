import type { StampKind, StudentStampKind, TeacherStampKind } from '../types.ts';

export const STAMP_OPTIONS: Array<{ kind: StudentStampKind; symbol: string; label: string }> = [
  { kind: 'check', symbol: '✓', label: 'Got It (Check)' },
  { kind: 'question', symbol: '?', label: 'Confused (Question)' },
  { kind: 'star', symbol: '★', label: 'Star' },
  { kind: 'thumbsup', symbol: '👍', label: 'Thumbs Up' },
  { kind: 'heart', symbol: '♥', label: 'Heart' },
  { kind: 'username', symbol: 'ID', label: 'Stamp Your Username Badge' },
];

export const STUDENT_STAMP_SYMBOLS: Record<string, string> = {
  check: '✓',
  question: '?',
  star: '★',
  thumbsup: '👍',
  heart: '♥',
};

export interface TeacherStampOption {
  kind: TeacherStampKind;
  label: string;
  color: string;
  fill: string;
  rotationDeg: number;
}

export const TEACHER_STAMP_OPTIONS: readonly TeacherStampOption[] = [
  { kind: 'approved', label: 'APPROVED', color: '#15803d', fill: '#f0fdf4', rotationDeg: -8 },
  { kind: 'excellent', label: 'EXCELLENT', color: '#15803d', fill: '#f0fdf4', rotationDeg: -6 },
  { kind: 'needs-work', label: 'NEEDS WORK', color: '#b45309', fill: '#fffbeb', rotationDeg: -7 },
  { kind: 'redo', label: 'REDO', color: '#b45309', fill: '#fffbeb', rotationDeg: 6 },
  { kind: 'see-me', label: 'SEE ME', color: '#b45309', fill: '#fffbeb', rotationDeg: -5 },
  { kind: 'incomplete', label: 'INCOMPLETE', color: '#475569', fill: '#f8fafc', rotationDeg: 5 },
  { kind: 'late', label: 'LATE', color: '#475569', fill: '#f8fafc', rotationDeg: -5 },
  { kind: 'denied', label: 'DENIED', color: '#b91c1c', fill: '#fef2f2', rotationDeg: 7 },
  { kind: 'teacher-custom', label: 'CUSTOM', color: '#7c3aed', fill: '#faf5ff', rotationDeg: -6 },
];

const TEACHER_STAMP_MAP = new Map<string, TeacherStampOption>(
  TEACHER_STAMP_OPTIONS.map((opt) => [opt.kind, opt])
);

export function isTeacherStampKind(kind: unknown): kind is TeacherStampKind {
  return typeof kind === 'string' && TEACHER_STAMP_MAP.has(kind);
}

export interface TeacherStampAppearance {
  text: string;
  color: string;
  fill: string;
  rotationDeg: number;
}

export function getTeacherStampAppearance(
  kind: StampKind | string | undefined,
  customText?: string,
  elementColor?: string
): TeacherStampAppearance | null {
  if (!isTeacherStampKind(kind)) return null;
  const opt = TEACHER_STAMP_MAP.get(kind)!;
  if (kind === 'teacher-custom') {
    const normalizedText = (customText || 'FEEDBACK').trim().slice(0, 24).toUpperCase() || 'FEEDBACK';
    return {
      text: normalizedText,
      color: elementColor && elementColor !== '#ffffff' ? elementColor : opt.color,
      fill: '#ffffff',
      rotationDeg: opt.rotationDeg,
    };
  }
  return {
    text: opt.label,
    color: opt.color,
    fill: opt.fill,
    rotationDeg: opt.rotationDeg,
  };
}

export interface TeacherStampDimensions {
  width: number;
  height: number;
  fontSize: number;
  borderWidth: number;
  innerInset: number;
  cornerRadius: number;
}

export function getTeacherStampDimensions(text: string, strokeWidth = 6): TeacherStampDimensions {
  const fontSize = Math.max(15, Math.round(strokeWidth * 1.15 + 11));
  const padX = Math.round(fontSize * 0.9);
  const charAdvance = fontSize * 0.72 + 1.2;
  const width = Math.max(96, Math.round(text.length * charAdvance + padX * 2));
  const height = Math.round(fontSize * 2.05);
  const borderWidth = Math.max(2.5, Math.round(fontSize * 0.16 * 10) / 10);
  return {
    width,
    height,
    fontSize,
    borderWidth,
    innerInset: Math.max(3, Math.round(borderWidth + 1.5)),
    cornerRadius: Math.max(4, Math.round(fontSize * 0.3)),
  };
}
