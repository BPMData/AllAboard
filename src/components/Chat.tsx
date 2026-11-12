import React, { useState, useRef, useEffect, useMemo } from 'react';
import { ChatMessage, User, CanvasElement } from '../types';
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
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';

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
  onAuthenticateTeacher: (pin: string) => Promise<{ ok: boolean; error?: string; mode?: string }>;
  onStepDownTeacher: () => void;
  onCreateNewRoom: () => void;
  onSwitchRoom: (newRoomId: string) => void;
  onUpdateName: (newName: string) => void;
  onClearUserDrawings: (targetUserId: string) => void;
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
  onAuthenticateTeacher,
  onStepDownTeacher,
  onCreateNewRoom,
  onSwitchRoom,
  onUpdateName,
  onClearUserDrawings,
}: ChatProps) {
  const [activeTab, setActiveTab] = useState<'chat' | 'roster'>('chat');
  const [inputText, setInputText] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(userName);
  const [confirmEraseUserId, setConfirmEraseUserId] = useState<string | null>(null);

  // Room & Teacher PIN Popover states
  const [showPinPrompt, setShowPinPrompt] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [isSubmittingPin, setIsSubmittingPin] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [isEditingRoom, setIsEditingRoom] = useState(false);
  const [roomDraft, setRoomDraft] = useState(roomId);

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setNameDraft(userName);
  }, [userName]);

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
      { userId: string; name: string; color: string; isTeacher: boolean; isOnline: boolean }
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
    if (nameDraft.trim()) {
      onUpdateName(nameDraft.trim());
      setIsEditingName(false);
    }
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
    <aside className="flex flex-col h-full bg-slate-50 border-r border-slate-200 w-80 shrink-0 select-text">
      {/* Top Studio Header, Room Switcher & PIN-Protected Teacher Control */}
      <div className="p-3.5 border-b border-slate-200 bg-white space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="font-display font-bold text-base tracking-tight text-slate-900 whitespace-nowrap shrink-0">
            AllAboard
          </span>

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
        </div>

        {/* Room Code Bar + Instant "New Room" Escape Hatch */}
        <div className="flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-50 border border-slate-200/80 text-xs">
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
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-slate-400">Room:</span>
                <button
                  type="button"
                  onClick={() => setIsEditingRoom(true)}
                  className="font-mono font-semibold text-slate-800 hover:text-blue-600 truncate max-w-[95px] cursor-pointer"
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
                      className="flex flex-col items-start"
                    >
                      <div className="flex items-center gap-1.5 mb-1 px-0.5 text-xs">
                        <span
                          className="w-2 h-2 rounded-xs shrink-0"
                          style={{ backgroundColor: resolvedColor }}
                          aria-hidden="true"
                        />
                        <span
                          className="font-display font-semibold text-xs truncate max-w-[165px]"
                          style={{ color: resolvedColor }}
                        >
                          {msg.userName}
                        </span>
                        {msg.isTeacher && (
                          <span className="text-[11px] text-amber-700 font-medium">
                            · Teacher
                          </span>
                        )}
                        {isMe && (
                          <span className="text-[11px] text-slate-400">
                            · You
                          </span>
                        )}
                        <span className="text-[11px] text-slate-400 font-mono tabular-nums ml-auto">
                          {new Date(msg.timestamp).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
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
            <span>Board Items</span>
          </div>

          {fullParticipantList.map((participant) => {
            const count = strokeCountsByUser[participant.userId] || 0;
            const isMe = participant.userId === userId;
            const isConfirming = confirmEraseUserId === participant.userId;

            return (
              <div
                key={participant.userId}
                className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-white border border-slate-200/80"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="w-2.5 h-2.5 rounded-xs shrink-0"
                      style={{ backgroundColor: participant.color }}
                    />
                    <span className="font-medium text-sm text-slate-900 truncate">
                      {participant.name}
                    </span>
                  </div>
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

                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-mono tabular-nums text-xs text-slate-600">
                    {count} {count === 1 ? 'item' : 'items'}
                  </span>

                  {(isTeacher || isMe) && count > 0 && (
                    isConfirming ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            onClearUserDrawings(participant.userId);
                            setConfirmEraseUserId(null);
                          }}
                          className="px-2 py-1 text-xs font-medium bg-red-600 text-white rounded hover:bg-red-700 transition-colors whitespace-nowrap cursor-pointer"
                        >
                          Confirm
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
                        onClick={() => setConfirmEraseUserId(participant.userId)}
                        className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors cursor-pointer"
                        title={`Erase all drawings by ${participant.name}`}
                      >
                        <Eraser size={14} />
                      </button>
                    )
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Persistent Student Identity Footer */}
      <div className="p-3 bg-slate-100/80 border-t border-slate-200 text-xs">
        {isEditingName ? (
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
            <button
              type="button"
              onClick={() => setIsEditingName(true)}
              className="flex items-center gap-1 text-slate-500 hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              title="Change display name"
            >
              <Edit2 size={12} />
              <span>Rename</span>
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
