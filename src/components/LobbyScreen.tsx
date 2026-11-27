import { Eye, EyeOff, KeyRound, LifeBuoy, LogIn, PlusCircle, Shuffle } from 'lucide-react';
import { motion } from 'motion/react';
import React from 'react';
import { sanitizeRoomCodeDraft } from '../lib/roomCode';
import type { RoomAvailability } from '../types';
import RoomExistsModal from './RoomExistsModal';
import RoomHistoryDropdown from './RoomHistoryDropdown';

interface LobbyScreenProps {
  effectiveRoomId: string;
  handleJoin: (e: React.FormEvent) => void;
  kickNotice: string | null;
  displayNameInputRef: React.RefObject<HTMLInputElement | null>;
  userName: string;
  setUserName: React.Dispatch<React.SetStateAction<string>>;
  isCheckingRoom: boolean;
  historyVersion: number;
  setKickNotice: React.Dispatch<React.SetStateAction<string | null>>;
  setHasEditedLobbyRoom: React.Dispatch<React.SetStateAction<boolean>>;
  setRoomId: React.Dispatch<React.SetStateAction<string>>;
  showTeacherSetupOnJoin: boolean;
  teacherPinInputRef: React.RefObject<HTMLInputElement | null>;
  roomCodeInputRef: React.RefObject<HTMLInputElement | null>;
  roomId: string;
  handleLobbyNewRoom: () => void;
  handleCreateNewRoom: () => void;
  setShowTeacherSetupOnJoin: React.Dispatch<React.SetStateAction<boolean>>;
  setInitialTeacherPin: React.Dispatch<React.SetStateAction<string>>;
  setShowInitialTeacherPin: React.Dispatch<React.SetStateAction<boolean>>;
  initialTeacherPin: string;
  showInitialTeacherPin: boolean;
  openProblemReport: () => void;
  pendingRoomPrompt: { availability: RoomAvailability; teacherPin?: string } | null;
  handleConfirmJoinAnyway: () => void;
  handleConfirmCreateFreshRoom: () => void;
  handleCustomRoomFromModal: (roomId: string) => void;
  handleCancelRoomPrompt: () => void;
  problemReportModal: React.ReactNode;
}

export default function LobbyScreen({
  effectiveRoomId,
  handleJoin,
  kickNotice,
  displayNameInputRef,
  userName,
  setUserName,
  isCheckingRoom,
  historyVersion,
  setKickNotice,
  setHasEditedLobbyRoom,
  setRoomId,
  showTeacherSetupOnJoin,
  teacherPinInputRef,
  roomCodeInputRef,
  roomId,
  handleLobbyNewRoom,
  handleCreateNewRoom,
  setShowTeacherSetupOnJoin,
  setInitialTeacherPin,
  setShowInitialTeacherPin,
  initialTeacherPin,
  showInitialTeacherPin,
  openProblemReport,
  pendingRoomPrompt,
  handleConfirmJoinAnyway,
  handleConfirmCreateFreshRoom,
  handleCustomRoomFromModal,
  handleCancelRoomPrompt,
  problemReportModal
}: LobbyScreenProps) {
  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{
        backgroundColor: '#f8fafc',
        backgroundImage: 'radial-gradient(#cbd5e1 1.25px, transparent 1.25px)',
        backgroundSize: '28px 28px',
      }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.14 }}
        className="bg-white border-2 border-[#CBD5E1] rounded-[3px] w-full max-w-md"
      >
        <div className="oh-panel-header px-5 py-3 border-b border-[#CBD5E1] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <img
              src="/assets/aistudio/favicon_68cc1684.svg"
              alt="AllAboard"
              referrerPolicy="no-referrer"
              className="w-6 h-6 rounded-[2px] border border-[#CBD5E1] shrink-0 object-contain"
            />
            <h1 className="font-display text-base font-bold tracking-tight text-slate-900 truncate">
              AllAboard
            </h1>
          </div>
          <span className="px-2 py-0.5 rounded-[2px] bg-brand-50 border border-brand-200 font-mono text-xs font-semibold text-brand-800 truncate max-w-[12rem]">
            #{effectiveRoomId}
          </span>
        </div>

        <form onSubmit={handleJoin} autoComplete="off">
          <div className="p-5 space-y-4">
            {kickNotice && (
              <div className="p-3 rounded-[3px] bg-red-50 border border-red-200 text-xs text-red-800 leading-relaxed">
                {kickNotice}
              </div>
            )}

            <div>
              <label
                htmlFor="display-name-input"
                className="block text-xs font-semibold text-slate-700 mb-1.5"
              >
                Your Display Name
              </label>
              <input
                ref={displayNameInputRef}
                id="display-name-input"
                type="text"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                placeholder="e.g. Alex"
                autoFocus
                maxLength={28}
                className="w-full px-3 py-2 bg-white border border-[#CBD5E1] rounded-[2px] text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none transition-colors"
              />
            </div>

            <div>
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <label
                  htmlFor="lobby-room-code-input"
                  className="text-xs font-semibold text-slate-700"
                >
                  Room Code
                </label>
                <RoomHistoryDropdown
                  theme="light"
                  align="right"
                  disabled={isCheckingRoom}
                  historyVersion={historyVersion}
                  hintText="Click a room to fill its code, then join."
                  onSelectRoom={(code) => {
                    setKickNotice(null);
                    setHasEditedLobbyRoom(true);
                    setRoomId(code);
                    if (showTeacherSetupOnJoin) {
                      teacherPinInputRef.current?.focus();
                    } else if (!userName.trim()) {
                      displayNameInputRef.current?.focus();
                    }
                  }}
                />
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  ref={roomCodeInputRef}
                  id="lobby-room-code-input"
                  aria-label="Room Code"
                  type="text"
                  value={roomId}
                  placeholder="main"
                  onChange={(e) => {
                    setKickNotice(null);
                    setHasEditedLobbyRoom(true);
                    setRoomId(sanitizeRoomCodeDraft(e.target.value));
                  }}
                  onBlur={() => {
                    setRoomId((prev) => prev.replace(/^-|-$/g, ''));
                  }}
                  maxLength={24}
                  className="flex-1 min-w-0 px-3 py-1.5 bg-white border border-[#CBD5E1] rounded-[2px] font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-brand-600"
                />
                <button
                  type="button"
                  disabled={isCheckingRoom}
                  onClick={handleLobbyNewRoom}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-[2px] border oh-btn text-brand-700 text-xs font-medium whitespace-nowrap cursor-pointer disabled:opacity-50 transition-colors shrink-0"
                  title="Make a new room with the code you typed (a random one if the box is empty) and go in"
                >
                  <PlusCircle size={13} />
                  <span>New Room</span>
                </button>
                <button
                  type="button"
                  disabled={isCheckingRoom}
                  onClick={handleCreateNewRoom}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-[2px] border oh-btn text-slate-700 text-xs font-medium whitespace-nowrap cursor-pointer disabled:opacity-50 transition-colors shrink-0"
                  title="Fill the box with a random unused room code"
                >
                  <Shuffle size={12} />
                  <span>Random</span>
                </button>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-200">
              {showTeacherSetupOnJoin ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label
                      htmlFor="teacher-pin-input"
                      className="text-xs font-semibold text-amber-800 flex items-center gap-1.5"
                    >
                      <KeyRound size={13} className="text-amber-600" />
                      <span>Set or Enter Room Teacher PIN</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setShowTeacherSetupOnJoin(false);
                        setInitialTeacherPin('');
                        setShowInitialTeacherPin(false);
                      }}
                      className="text-[11px] text-slate-500 hover:text-slate-800 cursor-pointer"
                    >
                      Cancel
                    </button>
                  </div>
                  <div className="relative">
                    <input
                      ref={teacherPinInputRef}
                      id="teacher-pin-input"
                      type="text"
                      value={initialTeacherPin}
                      onChange={(e) => setInitialTeacherPin(e.target.value)}
                      placeholder="Choose a 4+ digit PIN (e.g. 4829)"
                      maxLength={16}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      data-lpignore="true"
                      data-1p-ignore="true"
                      className={`w-full pl-3 pr-9 py-1.5 bg-slate-50 border border-[#CBD5E1] rounded-[2px] text-xs text-slate-900 font-mono placeholder:text-slate-400 focus:bg-white focus:outline-none focus:border-amber-500${showInitialTeacherPin ? '' : ' pin-masked'
                        }`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowInitialTeacherPin((v) => !v)}
                      aria-label={showInitialTeacherPin ? 'Hide Teacher PIN' : 'Show Teacher PIN'}
                      title={showInitialTeacherPin ? 'Hide PIN' : 'Show PIN'}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
                    >
                      {showInitialTeacherPin ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-500 leading-snug">
                    The first person to set a PIN in a room locks Teacher Mode so students cannot click it.
                  </p>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowTeacherSetupOnJoin(true)}
                  className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <KeyRound size={12} />
                  <span>Instructor? Set or enter a room Teacher PIN</span>
                </button>
              )}
            </div>
          </div>

          <div className="oh-panel-header px-5 py-3 border-t border-[#CBD5E1]">
            <button
              type="submit"
              disabled={!userName.trim() || isCheckingRoom}
              className={`w-full py-2 px-4 text-sm font-semibold rounded-[2px] border transition-colors flex items-center justify-center gap-2 ${!userName.trim() || isCheckingRoom
                  ? 'bg-slate-100 border-[#CBD5E1] text-slate-400 cursor-not-allowed'
                  : 'oh-btn-primary text-white cursor-pointer'
                }`}
            >
              <LogIn size={16} />
              <span>{isCheckingRoom ? 'Checking Room...' : 'Join Classroom'}</span>
            </button>
          </div>
        </form>
      </motion.div>

      <button
        type="button"
        onClick={openProblemReport}
        className="fixed bottom-3 right-3 flex items-center gap-1.5 px-2.5 py-1.5 rounded-[2px] border oh-btn bg-white text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
      >
        <LifeBuoy size={13} />
        <span>Something not working?</span>
      </button>

      {pendingRoomPrompt && (
        <RoomExistsModal
          availability={pendingRoomPrompt.availability}
          isJoiningAsTeacher={Boolean(
            pendingRoomPrompt.teacherPin && pendingRoomPrompt.teacherPin.length >= 3
          )}
          isBusy={isCheckingRoom}
          onJoinAnyway={handleConfirmJoinAnyway}
          onCreateFreshRoom={handleConfirmCreateFreshRoom}
          onSwitchToCustomRoom={handleCustomRoomFromModal}
          onCancel={handleCancelRoomPrompt}
        />
      )}

      {problemReportModal}
    </div>
  );
}
