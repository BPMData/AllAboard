export type StampKind = 'check' | 'question' | 'star' | 'thumbsup' | 'heart' | 'username';

export type ToolType =
  | 'pan'
  | 'move-bg'
  | 'solid'
  | 'hollow'
  | 'spray'
  | 'highlighter'
  | 'eraser'
  | 'rect'
  | 'circle'
  | 'line'
  | 'text'
  | 'stamp';

export interface Point {
  x: number;
  y: number;
}

export interface CanvasElement {
  id: string;
  boardId?: string;
  userId: string;
  userName: string;
  tool: Exclude<ToolType, 'pan' | 'move-bg'>;
  color: string;
  strokeWidth: number;
  points?: number[]; // Used for freehand strokes (solid, hollow, spray, highlighter, eraser) and line
  x?: number;        // Used for rect, circle, text, stamp
  y?: number;        // Used for rect, circle, text, stamp
  width?: number;    // Used for rect, circle, text bounding box
  height?: number;   // Used for rect, circle, text bounding box
  text?: string;     // Used for text elements
  fontSize?: number; // Used for text elements (OverBoard note font size)
  isCover?: boolean; // Used for opaque Highlighter Cover bars (OverBoard answer-hiding cover mode)
  hlStrength?: number; // Used for Highlighter strength % (10..100)
  stamp?: StampKind; // Used for stamp elements
  timestamp?: number;
}

export interface BackgroundPage {
  dataUrl: string;
  width: number;
  height: number;
}

export interface RoomBackground {
  id: string;
  fileName: string;
  pages: BackgroundPage[];
  x: number;
  y: number;
  scale: number;
  layout: 'row' | 'stack';
  opacity: number;
}

export interface ChatMessage {
  id: string;
  boardId?: string;
  userId: string;
  userName: string;
  userColor?: string;
  isTeacher?: boolean;
  text: string;
  timestamp: number;
}

export interface User {
  userId: string;
  name: string;
  color: string;
  isTeacher: boolean;
  onlineCount?: number;
}

export type BreakoutMode = 'main' | 'individual' | 'groups';

export interface SubBoardData {
  id: string;
  title: string;
  assignedUserIds: string[];
  elements: CanvasElement[];
  background: RoomBackground | null;
  messages: ChatMessage[];
}

export interface BreakoutConfig {
  mode: BreakoutMode;
  allowSelfSelect: boolean;
  chatScope: 'unified' | 'board';
}

export interface RoomSettings {
  roomId: string;
  isCanvasLocked: boolean;
  hasTeacherPin: boolean;
  lastSavedAt?: number;
  breakoutConfig?: BreakoutConfig;
}

export interface RemoteCursor {
  userId: string;
  userName: string;
  color: string;
  boardId?: string;
  x: number;
  y: number;
  tool: ToolType;
  isDrawing: boolean;
  updatedAt: number;
}

export type ImportRestoreMode = 'replace' | 'readonly' | 'merge';

export interface RoomSnapshot {
  version: 1;
  roomId: string;
  exportedAt: number;
  exportedBy: string;
  elements: CanvasElement[];
  messages: ChatMessage[];
  background?: RoomBackground | null;
  subBoards?: Record<string, SubBoardData>;
  breakoutConfig?: BreakoutConfig;
}
