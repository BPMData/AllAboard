import React, { useState, useRef, useEffect, useMemo } from 'react';
import { ChatMessage, User, CanvasElement, BannedUserRecord } from '../types';
import {
  Send,
  MessageSquare,
  Users,
  Shield,
  Eraser,
  Check,
  Edit2,
  PlusCircle,
  Copy,
  KeyRound,
  X,
  Trash2,
  UserX,
  Lock,
  RotateCcw,
  PanelLeftClose,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';
import {
  MIN_CHAT_WIDTH,
  clampChatWidth,
  getMaxChatWidth,
} from '../lib/chatSidebar';

interface ChatProps {
  roomId: string;
  hasTeacherPin: boolean;
  messages: ChatMessage[];
  users: User[];
  elements: CanvasElement[];
  onSendMessage: (text: string) => void;
  userId: string;
  userName: string;
  userColor: string;
  isTeacher: boolean;
  isNameLocked?: boolean;
  bannedUsers?: BannedUserRecord[];
  onAuthenticateTeacher: (pin: string) => Promise<{ ok: boolean; error?: string; mode?: string }>;
  onStepDownTeacher: () => void;
  onCreateNewRoom: () => void;
  onSwitchRoom: (newRoomId: string) => void;
  onUpdateName: (newName: string) => void;
  onClearUserDrawings: (targetUserId: string) => void;
  onTeacherRenameUser?: (targetUserId: string, newName: string) => void;
  onTeacherDeleteMessage?: (messageId: string) => void;
  onTeacherKickUser?: (targetUserId: string, mode: 'kick' | 'ban', targetName?: string) => void;
  onTeacherUnbanUser?: (targetUserId: string) => void;
  width: number;
  onWidthChange: (nextWidth: number) => void;
  onResetWidth: () => void;
  onHideChat: () => void;
}

const USER_COLORS = [
  '#dc2626', '#ea580c', '#d97706', '#059669', '#0891b2',
  '#2563eb', '#4f46e5', '#7c3aed', '#c026d3', '#db2777'
];

export function getUserColor(userId: string) {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length];
}

export default function Chat({
  roomId,
  hasTeacherPin,
  messages,
  users,
  elements,
  onSendMessage,
  userId,
  userName,
  userColor,
  isTeacher,
  isNameLocked = false,
  bannedUsers = [],
  onAuthenticateTeacher,
  onStepDownTeacher,
  onCreateNewRoom,
  onSwitchRoom,
  onUpdateName,
  onClearUserDrawings,
  onTeacherRenameUser,
  onTeacherDeleteMessage,
  onTeacherKickUser,
  onTeacherUnbanUser,
  width,
  onWidthChange,
  onResetWidth,
  onHideChat,
}: ChatProps) {
  const [activeTab, setActiveTab] = useState<'chat' | 'roster'>('chat');
  const [inputText, setInputText] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(userName);
  const [confirmEraseUserId, setConfirmEraseUserId] = useState<string | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  // Teacher Moderation States (Force Rename & Kick/Ban Confirmation)
  const [renamingUserId, setRenamingUserId] = useState<string | null>(null);
  const [teacherRenameDraft, setTeacherRenameDraft] = useState<string>('');
  const [confirmRemoveUserId, setConfirmRemoveUserId] = useState<string | null>(null);

  // Room & Teacher PIN Popover states
  const [showPinPrompt, setShowPinPrompt] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [isSubmittingPin, setIsSubmittingPin] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [isEditingRoom, setIsEditingRoom] = useState(false);
  const [roomDraft, setRoomDraft] = useState(roomId);

  const scrollRef = useRef<HTMLDivElement>(null);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(width);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
    };
  }, []);

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    resizeCleanupRef.current?.();
    dragStartXRef.current = e.clientX;
    dragStartWidthRef.current = width;
    setIsResizing(true);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - dragStartXRef.current;
      onWidthChange(clampChatWidth(dragStartWidthRef.current + delta, window.innerWidth));
    };

    const handlePointerUp = () => {
      setIsResizing(false);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      resizeCleanupRef.current = null;
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    resizeCleanupRef.current = handlePointerUp;
  };

  const handleResizeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    const viewportW = typeof window !== 'undefined' ? window.innerWidth : undefined;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onWidthChange(clampChatWidth(width - step, viewportW));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      onWidthChange(clampChatWidth(width + step, viewportW));
    } else if (e.key === 'Home') {
      e.preventDefault();
      onWidthChange(MIN_CHAT_WIDTH);
    } else if (e.key === 'End') {
      e.preventDefault();
      onWidthChange(getMaxChatWidth(viewportW));
    }
  };

  useEffect(() => {
    setNameDraft(userName);
  }, [userName]);

  useEffect(() => {
    if (isNameLocked && !isTeacher) {
      setIsEditingName(false);
    }
  }, [isNameLocked, isTeacher]);

  useEffect(() => {
    setRoomDraft(roomId);
  }, [roomId]);

  useEffect(() => {
    if (scrollRef.current && activeTab === 'chat') {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, activeTab]);

  const strokeCountsByUser = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const el of elements) {
      counts[el.userId] = (counts[el.userId] || 0) + 1;
    }
    return counts;
  }, [elements]);

  const fullParticipantList = useMemo(() => {
    const map = new Map<
      string,
      {
        userId: string;
        name: string;
        color: string;
        isTeacher: boolean;
        isNameLocked?: boolean;
        isOnline: boolean;
      }
    >();
    for (const u of users) {
      map.set(u.userId, { ...u, isOnline: true });
    }
    for (const el of elements) {
      if (!map.has(el.userId)) {
        map.set(el.userId, {
          userId: el.userId,
          name: el.userName || 'Student',
          color: getUserColor(el.userId),
          isTeacher: false,
          isOnline: false,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      if (a.userId === userId) return -1;
      if (b.userId === userId) return 1;
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [users, elements, userId]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputText.trim()) {
      onSendMessage(inputText);
      setInputText('');
    }
  };

  const handleSaveName = (e: React.FormEvent) => {
    e.preventDefault();
    if (isNameLocked && !isTeacher) {
      setIsEditingName(false);
      return;
    }
    if (nameDraft.trim()) {
      onUpdateName(nameDraft.trim());
      setIsEditingName(false);
    }
  };

  const handleTeacherRenameSubmit = (e: React.FormEvent, targetUserId: string) => {
    e.preventDefault();
    const cleaned = teacherRenameDraft.trim();
    if (cleaned && onTeacherRenameUser) {
      onTeacherRenameUser(targetUserId, cleaned);
    }
    setRenamingUserId(null);
    setTeacherRenameDraft('');
  };

  const handleCopyRoomLink = () => {
    const url = new URL(window.location.href);
    url.searchParams.set('room', roomId);
    navigator.clipboard.writeText(url.toString()).catch(() => {});
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const handleRoomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (roomDraft.trim()) {
      onSwitchRoom(roomDraft.trim());
      setIsEditingRoom(false);
    }
  };

  const handlePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pinInput.trim() || isSubmittingPin) return;
    setIsSubmittingPin(true);
    setPinError(null);
    const res = await onAuthenticateTeacher(pinInput.trim());
    setIsSubmittingPin(false);
    if (res.ok) {
      setShowPinPrompt(false);
      setPinInput('');
      setPinError(null);
    } else {
      setPinError(res.error || 'Invalid Teacher PIN.');
    }
  };

  return (
    <aside
      aria-label="Class chat sidebar"
      style={{ width: `${width}px` }}
      className="relative flex flex-col h-full bg-slate-50 border-r border-slate-200 shrink-0 select-text"
    >
      {/* Top Studio Header, Room Switcher & PIN-Protected Teacher Control */}
      <div className="p-3.5 border-b border-slate-200 bg-white space-y-2.5">
        <div className="flex items-center justify-between gap-1.5">
          <span className="font-display font-bold text-base tracking-tight text-slate-900 whitespace-nowrap shrink-0">
            AllAboard
          </span>

          <div className="flex items-center gap-1.5 min-w-0">
            {isTeacher ? (
              <button
                type="button"
                onClick={onStepDownTeacher}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                title="Click to exit Teacher Mode"
              >
                <Shield size={13} className="text-amber-600" />
                <span>Teacher Active</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setShowPinPrompt(!showPinPrompt);
                  setPinError(null);
                }}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer",
                  showPinPrompt
                    ? "bg-slate-900 text-white"
                    : "bg-slate-100 text-slate-600 hover:text-slate-900"
                )}
                title={
                  hasTeacherPin
                    ? "Enter room Teacher PIN to unlock moderation"
                    : "Set a Teacher PIN for this room"
                }
              >
                <KeyRound size={12} />
                <span>{hasTeacherPin ? 'Teacher PIN' : 'Claim Teacher'}</span>
              </button>
            )}

            <button
              type="button"
              onClick={onHideChat}
              className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors cursor-pointer shrink-0"
              title="Hide chat sidebar to focus on drawing"
              aria-label="Hide chat sidebar"
            >
              <PanelLeftClose size={15} />
            </button>
          </div>
        </div>

        {/* Room Code Bar + Instant "New Room" Escape Hatch */}
        <div className="flex flex-wrap items-center justify-between gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-50 border border-slate-200/80 text-xs">
          {isEditingRoom ? (
            <form onSubmit={handleRoomSubmit} className="flex items-center gap-1 flex-1">
              <input
                type="text"
                value={roomDraft}
                onChange={(e) => setRoomDraft(e.target.value)}
                placeholder="room-code"
                autoFocus
                maxLength={24}
                className="w-full px-2 py-0.5 bg-white border border-slate-300 rounded font-mono text-xs text-slate-900 focus:outline-none focus:border-blue-500"
              />
              <button
                type="submit"
                className="p-1 bg-blue-600 text-white rounded hover:bg-blue-700 cursor-pointer"
                title="Switch room"
              >
                <Check size={12} />
              </button>
              <button
                type="button"
                onClick={() => setIsEditingRoom(false)}
                className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X size={12} />
              </button>
            </form>
          ) : (
            <>
              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                <span className="text-slate-400 shrink-0">Room:</span>
                <button
                  type="button"
                  onClick={() => setIsEditingRoom(true)}
                  className="font-mono font-semibold text-slate-800 hover:text-blue-600 truncate cursor-pointer"
                  title="Click to enter a different room code"
                >
                  {roomId}
                </button>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={handleCopyRoomLink}
                  className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-200/60 rounded transition-colors cursor-pointer whitespace-nowrap"
                  title="Copy room invite link for students"
                >
                  <Copy size={11} />
                  <span>{copiedLink ? 'Copied!' : 'Copy Link'}</span>
                </button>
                <span className="text-slate-300" aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={onCreateNewRoom}
                  className="flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-medium text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded transition-colors cursor-pointer whitespace-nowrap"
                  title="Create a brand new room with an unclaimed Teacher PIN"
                >
                  <PlusCircle size={11} />
                  <span>New Room</span>
                </button>
              </div>
            </>
          )}
        </div>

        {/* Teacher PIN Claim / Verification Drawer */}
        {showPinPrompt && !isTeacher && (
          <div className="p-3 rounded-lg bg-slate-900 text-white space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="font-display font-semibold text-xs">
                {hasTeacherPin ? 'Unlock Teacher Mode' : 'Claim Teacher Mode (Set PIN)'}
              </span>
              <button
                type="button"
                onClick={() => {
                  setShowPinPrompt(false);
                  setPinError(null);
                }}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            <p className="text-[11px] text-slate-300 leading-relaxed">
              {hasTeacherPin
                ? 'A Teacher PIN is already set for this room. Enter the PIN below to unlock moderation.'
                : 'No teacher has claimed this room yet. Choose a 4+ character PIN so students cannot access teacher controls.'}
            </p>

            <form onSubmit={handlePinSubmit} className="flex items-center gap-1.5">
              <input
                type="password"
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value)}
                placeholder={hasTeacherPin ? 'Enter room PIN...' : 'Create 4+ digit PIN...'}
                autoFocus
                maxLength={16}
                className="flex-1 px-2.5 py-1.5 bg-slate-800 border border-slate-700 rounded text-xs text-white placeholder:text-slate-500 font-mono focus:outline-none focus:border-blue-500"
              />
              <button
                type="submit"
                disabled={pinInput.trim().length < 3 || isSubmittingPin}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-600 text-xs font-semibold rounded transition-colors whitespace-nowrap cursor-pointer"
              >
                {hasTeacherPin ? 'Unlock' : 'Set PIN'}
              </button>
            </form>

            {pinError && (
              <div className="space-y-2 pt-1 border-t border-slate-800">
                <p className="text-[11px] text-red-400 leading-snug">{pinError}</p>
                <button
                  type="button"
                  onClick={() => {
                    setShowPinPrompt(false);
                    setPinError(null);
                    onCreateNewRoom();
                  }}
                  className="w-full py-1.5 px-2.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold text-xs rounded flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                >
                  <PlusCircle size={13} />
                  <span>Create Fresh Room & Claim Teacher</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Interactive Filter Tabs */}
        <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg">
          <button
            type="button"
            onClick={() => setActiveTab('chat')}
            className={cn(
              "flex items-center justify-center gap-1.5 py-1.5 px-3 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer",
              activeTab === 'chat'
                ? "bg-white text-slate-900 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            )}
          >
            <MessageSquare size={14} />
            <span>Chat</span>
            <span className="font-mono tabular-nums text-[11px] text-slate-400">
              ({messages.length})
            </span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('roster')}
            className={cn(
              "flex items-center justify-center gap-1.5 py-1.5 px-3 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer",
              activeTab === 'roster'
                ? "bg-white text-slate-900 shadow-xs"
                : "text-slate-600 hover:text-slate-900"
            )}
          >
            <Users size={14} />
            <span>Class</span>
            <span className="font-mono tabular-nums text-[11px] text-slate-400">
              ({users.length})
            </span>
          </button>
        </div>
      </div>

      {/* Main Content Area: Chat Stream OR Live Roster */}
      {activeTab === 'chat' ? (
        <>
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto p-3.5 space-y-2.5 scroll-smooth"
          >
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center px-4 py-8 text-slate-400">
                <MessageSquare size={24} className="mb-2 text-slate-300" />
                <p className="text-xs font-medium text-slate-600">No messages in #{roomId} yet</p>
                <p className="text-xs text-slate-400 mt-0.5">
                  Share the room link or code with your students to begin!
                </p>
              </div>
            ) : (
              <AnimatePresence initial={false}>
                {messages.map((msg) => {
                  const resolvedColor = msg.userColor || getUserColor(msg.userId);
                  const isMe = msg.userId === userId;

                  return (
                    <motion.div
                      key={msg.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.14 }}
                      className="group flex flex-col items-start"
                    >
                      <div className="flex items-center gap-1.5 mb-1 px-0.5 text-xs w-full">
                        <span
                          className="w-2 h-2 rounded-xs shrink-0"
                          style={{ backgroundColor: resolvedColor }}
                          aria-hidden="true"
                        />
                        <span
                          className="font-display font-semibold text-xs truncate min-w-0"
                          style={{ color: resolvedColor }}
                        >
                          {msg.userName}
                        </span>
                        {msg.isTeacher && (
                          <span className="text-[11px] text-amber-700 font-medium shrink-0">
                            · Teacher
                          </span>
                        )}
                        {isMe && (
                          <span className="text-[11px] text-slate-400 shrink-0">
                            · You
                          </span>
                        )}
                        <span className="text-[11px] text-slate-400 font-mono tabular-nums ml-auto shrink-0">
                          {new Date(msg.timestamp).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                        {isTeacher && onTeacherDeleteMessage && (
                          <button
                            type="button"
                            onClick={() => onTeacherDeleteMessage(msg.id)}
                            className="p-0.5 text-slate-400 hover:text-red-600 rounded transition-colors cursor-pointer shrink-0"
                            title="Delete chat message"
                            aria-label={`Delete message from ${msg.userName}`}
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                      <div
                        className={cn(
                          "w-full px-3 py-2 rounded-lg text-sm leading-relaxed border break-words",
                          isMe
                            ? "bg-blue-50/70 border-blue-200/80 text-slate-900"
                            : "bg-white border-slate-200/90 text-slate-800"
                        )}
                      >
                        {msg.text}
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            )}
          </div>

          <form onSubmit={handleSubmit} className="p-3 bg-white border-t border-slate-200">
            <div className="relative flex items-center">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="Message the class..."
                className="w-full pl-3.5 pr-10 py-2 bg-slate-100 border border-transparent rounded-lg text-sm text-slate-900 placeholder:text-slate-400 focus:bg-white focus:border-blue-500 focus:outline-none transition-colors"
              />
              <button
                type="submit"
                disabled={!inputText.trim()}
                className="absolute right-1.5 p-1.5 text-blue-600 hover:bg-blue-50 rounded-md disabled:text-slate-300 disabled:hover:bg-transparent transition-colors cursor-pointer"
                title="Send message"
              >
                <Send size={16} />
              </button>
            </div>
          </form>
        </>
      ) : (
        <div className="flex-1 overflow-y-auto p-3.5 space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-500 pb-1 border-b border-slate-200/80">
            <span>Student / Role</span>
            <span>Actions / Items</span>
          </div>

          {fullParticipantList.map((participant) => {
            const count = strokeCountsByUser[participant.userId] || 0;
            const isMe = participant.userId === userId;
            const isConfirmingErase = confirmEraseUserId === participant.userId;
            const isRenamingThis = renamingUserId === participant.userId;
            const isConfirmingRemove = confirmRemoveUserId === participant.userId;

            return (
              <div
                key={participant.userId}
                className="flex flex-col gap-2 p-2.5 rounded-lg bg-white border border-slate-200/80"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    {isRenamingThis ? (
                      <form
                        onSubmit={(e) => handleTeacherRenameSubmit(e, participant.userId)}
                        className="flex items-center gap-1"
                      >
                        <input
                          type="text"
                          value={teacherRenameDraft}
                          onChange={(e) => setTeacherRenameDraft(e.target.value)}
                          placeholder="New name..."
                          autoFocus
                          maxLength={28}
                          className="w-full px-2 py-0.5 bg-slate-50 border border-slate-300 rounded text-xs text-slate-900 focus:outline-none focus:border-blue-500"
                        />
                        <button
                          type="submit"
                          className="p-1 bg-blue-600 text-white rounded hover:bg-blue-700 cursor-pointer shrink-0"
                          title="Save & lock student name"
                        >
                          <Check size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRenamingUserId(null);
                            setTeacherRenameDraft('');
                          }}
                          className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer shrink-0"
                          title="Cancel"
                        >
                          <X size={12} />
                        </button>
                      </form>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <span
                          className="w-2.5 h-2.5 rounded-xs shrink-0"
                          style={{ backgroundColor: participant.color }}
                        />
                        <span className="font-medium text-sm text-slate-900 truncate">
                          {participant.name}
                        </span>
                        {participant.isNameLocked && (
                          <span
                            className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-slate-100 text-[10px] text-slate-500 font-medium shrink-0"
                            title="Name locked by teacher"
                          >
                            <Lock size={9} />
                          </span>
                        )}
                      </div>
                    )}
                    <div className="flex items-center gap-1.5 text-[11px] text-slate-500 mt-0.5">
                      <span>{participant.isOnline ? 'Online' : 'Offline'}</span>
                      {participant.isTeacher && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-amber-700 font-medium">Teacher</span>
                        </>
                      )}
                      {isMe && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>You</span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <span className="font-mono tabular-nums text-xs text-slate-600 mr-1">
                      {count} {count === 1 ? 'item' : 'items'}
                    </span>

                    {isTeacher && !isRenamingThis && (
                      <button
                        type="button"
                        onClick={() => {
                          setRenamingUserId(participant.userId);
                          setTeacherRenameDraft(participant.name);
                          setConfirmRemoveUserId(null);
                          setConfirmEraseUserId(null);
                        }}
                        className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-colors cursor-pointer"
                        title={`Rename ${participant.name} (locks student from changing it back)`}
                      >
                        <Edit2 size={13} />
                      </button>
                    )}

                    {(isTeacher || isMe) && count > 0 && (
                      isConfirmingErase ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              onClearUserDrawings(participant.userId);
                              setConfirmEraseUserId(null);
                            }}
                            className="px-2 py-1 text-xs font-medium bg-red-600 text-white rounded hover:bg-red-700 transition-colors whitespace-nowrap cursor-pointer"
                          >
                            Erase
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmEraseUserId(null)}
                            className="px-1.5 py-1 text-xs text-slate-500 hover:text-slate-800 cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmEraseUserId(participant.userId);
                            setConfirmRemoveUserId(null);
                          }}
                          className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors cursor-pointer"
                          title={`Erase all drawings by ${participant.name}`}
                        >
                          <Eraser size={14} />
                        </button>
                      )
                    )}

                    {isTeacher && !isMe && (
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmRemoveUserId(
                            isConfirmingRemove ? null : participant.userId
                          );
                          setConfirmEraseUserId(null);
                          setRenamingUserId(null);
                        }}
                        className={cn(
                          "p-1.5 rounded-md transition-colors cursor-pointer",
                          isConfirmingRemove
                            ? "text-red-600 bg-red-50"
                            : "text-slate-400 hover:text-red-600 hover:bg-red-50"
                        )}
                        title={`Kick or Ban ${participant.name}`}
                      >
                        <UserX size={14} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Inline Kick / Ban Confirmation Warning */}
                {isTeacher && !isMe && isConfirmingRemove && (
                  <div className="p-2.5 rounded-lg bg-red-50/90 border border-red-200 text-xs space-y-2">
                    <p className="text-red-900 font-medium leading-snug">
                      Remove <span className="font-semibold">{participant.name}</span> from this classroom?
                      <span className="block text-[11px] text-red-700 font-normal mt-0.5">
                        Their existing drawings and chat messages will be kept unless you erase them.
                      </span>
                    </p>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          onTeacherKickUser?.(participant.userId, 'kick', participant.name);
                          setConfirmRemoveUserId(null);
                        }}
                        className="px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white font-semibold text-xs transition-colors cursor-pointer"
                        title="Boot student to the lobby (they can rejoin)"
                      >
                        Kick
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onTeacherKickUser?.(participant.userId, 'ban', participant.name);
                          setConfirmRemoveUserId(null);
                        }}
                        className="px-2.5 py-1 rounded bg-red-600 hover:bg-red-700 text-white font-semibold text-xs transition-colors cursor-pointer"
                        title="Boot student and block them from rejoining until unbanned"
                      >
                        Ban
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmRemoveUserId(null)}
                        className="ml-auto px-2 py-1 text-xs text-slate-600 hover:text-slate-900 cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Banned Students Management Section (Teacher Only) */}
          {isTeacher && bannedUsers.length > 0 && (
            <div className="pt-3 mt-3 border-t border-slate-200 space-y-2">
              <div className="flex items-center justify-between text-xs font-semibold text-red-700">
                <span>Banned Students ({bannedUsers.length})</span>
              </div>
              {bannedUsers.map((banned) => (
                <div
                  key={banned.userId}
                  className="flex items-center justify-between gap-2 p-2 rounded-lg bg-red-50/60 border border-red-200/80 text-xs"
                >
                  <div className="min-w-0">
                    <span className="font-medium text-slate-900 truncate block">
                      {banned.name}
                    </span>
                    <span className="text-[10px] text-red-600">Blocked from rejoining</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => onTeacherUnbanUser?.(banned.userId)}
                    className="flex items-center gap-1 px-2 py-1 rounded bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 font-medium text-xs cursor-pointer shrink-0"
                    title={`Unban ${banned.name}`}
                  >
                    <RotateCcw size={11} />
                    <span>Unban</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Persistent Student Identity Footer */}
      <div className="p-3 bg-slate-100/80 border-t border-slate-200 text-xs">
        {isEditingName && (!isNameLocked || isTeacher) ? (
          <form onSubmit={handleSaveName} className="flex items-center gap-1.5">
            <input
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              className="flex-1 px-2.5 py-1 bg-white border border-slate-300 rounded text-xs text-slate-900 focus:outline-none focus:border-blue-500"
              autoFocus
              maxLength={28}
            />
            <button
              type="submit"
              className="p-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 cursor-pointer"
              title="Save name"
            >
              <Check size={13} />
            </button>
          </form>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="w-2.5 h-2.5 rounded-xs shrink-0"
                style={{ backgroundColor: userColor }}
              />
              <span className="font-medium text-slate-800 truncate">{userName}</span>
              <span className="text-slate-400">·</span>
              <span className="font-mono tabular-nums text-slate-500">
                {strokeCountsByUser[userId] || 0} drawn
              </span>
            </div>
            {isNameLocked && !isTeacher ? (
              <span
                className="flex items-center gap-1 text-[11px] text-slate-400 whitespace-nowrap shrink-0"
                title="Your display name was set by the teacher and cannot be changed"
              >
                <Lock size={11} />
                <span>Name Locked</span>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setIsEditingName(true)}
                className="flex items-center gap-1 text-slate-500 hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                title="Change display name"
              >
                <Edit2 size={12} />
                <span>Rename</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Right-Edge Drag & Keyboard Resize Handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat sidebar"
        aria-valuemin={MIN_CHAT_WIDTH}
        aria-valuemax={getMaxChatWidth(typeof window !== 'undefined' ? window.innerWidth : undefined)}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={handleResizePointerDown}
        onDoubleClick={onResetWidth}
        onKeyDown={handleResizeKeyDown}
        title="Drag to resize chat sidebar (double-click to reset)"
        className={cn(
          "group absolute top-0 right-0 bottom-0 w-2 translate-x-1/2 z-30 cursor-col-resize flex items-center justify-center touch-none focus:outline-none",
          isResizing && "z-40"
        )}
      >
        <div
          className={cn(
            "w-0.5 h-full transition-colors",
            isResizing
              ? "bg-blue-600"
              : "bg-transparent group-hover:bg-blue-400 group-focus-visible:bg-blue-500"
          )}
        />
        <div
          aria-hidden="true"
          className={cn(
            "absolute top-1/2 -translate-y-1/2 w-1 h-8 rounded-full transition-all",
            isResizing
              ? "bg-blue-600 opacity-100 scale-y-110"
              : "bg-slate-400/80 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
          )}
        />
      </div>
    </aside>
  );
}
