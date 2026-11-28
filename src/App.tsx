import { useEffect, useMemo, useRef, useState } from 'react';
import Canvas from './components/Canvas';
import Chat, { getUserColor } from './components/Chat';
import LobbyScreen from './components/LobbyScreen';
import ProblemReportModal from './components/ProblemReportModal';
import PurgeContributionsModal from './components/PurgeContributionsModal';
import RoomExistsModal from './components/RoomExistsModal';
import { useClassroomActions } from './hooks/useClassroomActions';
import { useDrawingActions } from './hooks/useDrawingActions';
import { useRoomSocket } from './hooks/useRoomSocket';
import { findStudentBoardId } from './lib/breakoutRounds';
import {
  CHAT_STORAGE_KEYS,
  DEFAULT_CHAT_WIDTH,
  clampChatWidth,
  readStoredChatHidden,
  readStoredChatWidth,
  storeChatHiddenChoice,
} from './lib/chatSidebar';
import {
  STORAGE_KEYS,
  getInitialRoomId,
  getOrCreatePersistentUserId,
  getOrCreatePersistentUserKey,
  hasInitialUrlRoomParam,
} from './lib/identity';
import { normalizeRoomCode } from './lib/roomCode';
import type { RoundVariants } from './lib/roundVariants';
import {
  BreakoutConfig,
  CanvasElement,
  ChatMessage,
  RemoteCursor,
  RoomAvailability,
  RoomBackground,
  RoomSettings,
  SubBoardData,
  User,
} from './types';

export default function App() {
  const [userId] = useState<string>(() => getOrCreatePersistentUserId());
  const [userKey] = useState<string>(() => getOrCreatePersistentUserKey());
  const [userColor] = useState<string>(() => getUserColor(getOrCreatePersistentUserId()));
  const [roomId, setRoomId] = useState<string>(() => getInitialRoomId());
  const [hadInitialUrlRoom] = useState<boolean>(() => hasInitialUrlRoomParam());
  const [hasEditedLobbyRoom, setHasEditedLobbyRoom] = useState<boolean>(false);
  const [pendingRoomPrompt, setPendingRoomPrompt] = useState<{
    source: 'lobby' | 'switch';
    availability: RoomAvailability;
    userName?: string;
    teacherPin?: string;
  } | null>(null);
  const [isCheckingRoom, setIsCheckingRoom] = useState<boolean>(false);
  const [pendingPurgePrompt, setPendingPurgePrompt] = useState<{
    targetUserId: string;
    targetName: string;
    mode: 'kick' | 'ban';
  } | null>(null);
  const [isPurgingContributions, setIsPurgingContributions] = useState<boolean>(false);

  const [userName, setUserName] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEYS.USER_NAME) || '';
    } catch {
      return '';
    }
  });

  const [isTeacher, setIsTeacher] = useState<boolean>(false);
  const [isNameLocked, setIsNameLocked] = useState<boolean>(false);
  const [kickNotice, setKickNotice] = useState<string | null>(null);
  const [showTeacherSetupOnJoin, setShowTeacherSetupOnJoin] = useState<boolean>(false);
  const [initialTeacherPin, setInitialTeacherPin] = useState<string>('');
  const [showInitialTeacherPin, setShowInitialTeacherPin] = useState<boolean>(false);
  const [historyVersion, setHistoryVersion] = useState<number>(0);

  const [isJoined, setIsJoined] = useState<boolean>(() => {
    try {
      if (!hasInitialUrlRoomParam()) return false;
      const savedName = localStorage.getItem(STORAGE_KEYS.USER_NAME);
      const savedJoined = localStorage.getItem(STORAGE_KEYS.IS_JOINED) === 'true';
      const sessionRoom = sessionStorage.getItem(STORAGE_KEYS.JOINED_ROOM_SESSION);
      return Boolean(savedName && savedName.trim() && savedJoined && sessionRoom === getInitialRoomId());
    } catch {
      return false;
    }
  });

  const userNameRef = useRef<string>(userName);
  const isJoinedRef = useRef<boolean>(isJoined);
  const roomCodeInputRef = useRef<HTMLInputElement | null>(null);
  const displayNameInputRef = useRef<HTMLInputElement | null>(null);
  const teacherPinInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    userNameRef.current = userName;
  }, [userName]);
  useEffect(() => {
    isJoinedRef.current = isJoined;
  }, [isJoined]);

  // Resizable & Collapsible Chat Sidebar State
  const [chatWidth, setChatWidth] = useState<number>(() => {
    try {
      return readStoredChatWidth(
        typeof window !== 'undefined' ? window.localStorage : null,
        typeof window !== 'undefined' ? window.innerWidth : undefined
      );
    } catch {
      return DEFAULT_CHAT_WIDTH;
    }
  });
  const [isChatHidden, setIsChatHidden] = useState<boolean>(() => {
    try {
      return typeof window !== 'undefined' ? readStoredChatHidden(window.localStorage, window.innerWidth) : false;
    } catch {
      return false;
    }
  });
  const [unreadChatCount, setUnreadChatCount] = useState<number>(0);

  const isChatHiddenRef = useRef<boolean>(isChatHidden);

  useEffect(() => {
    isChatHiddenRef.current = isChatHidden;
    if (!isChatHidden) {
      setUnreadChatCount(0);
    }
    // Not saved here: only a click on hide/show is saved (storeChatHiddenChoice), so the narrow-screen default
    // keeps applying until someone actually chooses.
  }, [isChatHidden]);

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_STORAGE_KEYS.WIDTH, String(chatWidth));
    } catch {
      // Ignore
    }
  }, [chatWidth]);

  useEffect(() => {
    const handleViewportResize = () => {
      setChatWidth((prev) => clampChatWidth(prev, window.innerWidth));
    };
    window.addEventListener('resize', handleViewportResize);
    return () => window.removeEventListener('resize', handleViewportResize);
  }, []);

  // Main Board State + Sub-Boards State
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [elements, setElements] = useState<CanvasElement[]>([]);
  const [background, setBackground] = useState<RoomBackground | null>(null);
  const [subBoards, setSubBoards] = useState<Record<string, SubBoardData>>({});
  /** Teacher-only: each round's starting worksheet (server `roundTemplates`). Empty for students. */
  const [roundTemplates, setRoundTemplates] = useState<Record<string, RoomBackground | null>>({});
  /** Teacher-only: ink each round copies onto its boards (server `roundTemplateInk`). Empty for students. */
  const [roundTemplateInk, setRoundTemplateInk] = useState<Record<string, CanvasElement[]>>({});
  /** Teacher-only: worksheet variants B–D and who gets which, per individual round (server `roundVariants`). */
  const [roundVariants, setRoundVariants] = useState<Record<string, RoundVariants>>({});
  const [teacherSelectedBoardId, setTeacherSelectedBoardId] = useState<string>('main');

  const [users, setUsers] = useState<User[]>([]);
  const [roomSettings, setRoomSettings] = useState<RoomSettings>({
    roomId: getInitialRoomId(),
    isCanvasLocked: false,
    hideStudentCursors: false,
    hasTeacherPin: false,
    breakoutConfig: {
      mode: 'main',
      rounds: [],
      allowSelfSelect: false,
      chatScope: 'unified',
    },
  });
  const [remoteCursors, setRemoteCursors] = useState<Record<string, RemoteCursor>>({});

  const breakoutConfig: BreakoutConfig = useMemo(
    () =>
      roomSettings.breakoutConfig || {
        mode: 'main',
        rounds: [],
        allowSelfSelect: false,
        chatScope: 'unified',
      },
    [roomSettings.breakoutConfig]
  );

  // Determine which boardId the current user should be viewing/drawing on
  const activeBoardId = useMemo(() => {
    if (isTeacher) {
      if (teacherSelectedBoardId !== 'main' && !subBoards[teacherSelectedBoardId]) {
        return 'main';
      }
      return teacherSelectedBoardId;
    }
    return findStudentBoardId(subBoards, breakoutConfig, userId);
  }, [isTeacher, teacherSelectedBoardId, breakoutConfig, subBoards, userId]);

  const activeBoardIdRef = useRef<string>(activeBoardId);
  const chatScopeRef = useRef<'unified' | 'board'>(breakoutConfig.chatScope || 'unified');
  useEffect(() => {
    activeBoardIdRef.current = activeBoardId;
  }, [activeBoardId]);
  useEffect(() => {
    chatScopeRef.current = breakoutConfig.chatScope || 'unified';
  }, [breakoutConfig.chatScope]);

  const activeBoardTitle = useMemo(() => {
    if (activeBoardId === 'main') return 'Main Class Board';
    return subBoards[activeBoardId]?.title || activeBoardId;
  }, [activeBoardId, subBoards]);

  const activeElements = useMemo(() => {
    if (activeBoardId === 'main') return elements;
    return subBoards[activeBoardId]?.elements || [];
  }, [activeBoardId, elements, subBoards]);

  const activeBackground = useMemo(() => {
    if (activeBoardId === 'main') return background;
    return subBoards[activeBoardId]?.background || null;
  }, [activeBoardId, background, subBoards]);

  const activeMessages = useMemo(() => {
    if (breakoutConfig.chatScope === 'board' && activeBoardId !== 'main') {
      return subBoards[activeBoardId]?.messages || [];
    }
    return messages;
  }, [breakoutConfig.chatScope, activeBoardId, subBoards, messages]);

  const effectiveRoomId = normalizeRoomCode(roomId);
  /**
   * The room the socket, the address bar and the tab title follow: the room you're in. In the lobby it holds still
   * while the Room Code box is typed in. Following the box made a new server connection, and (with the title) a
   * browser-history entry, for every letter typed.
   */
  const [liveRoomId, setLiveRoomId] = useState<string>(effectiveRoomId);
  useEffect(() => {
    if (isJoined) setLiveRoomId(effectiveRoomId);
  }, [isJoined, effectiveRoomId]);

  useEffect(() => {
    document.title = liveRoomId !== 'main' ? `#${liveRoomId} · AllAboard` : 'AllAboard';
    try {
      const url = new URL(window.location.href);
      if (liveRoomId === 'main') {
        url.searchParams.delete('room');
      } else {
        url.searchParams.set('room', liveRoomId);
      }
      if (url.toString() !== window.location.href) window.history.replaceState({}, '', url.toString());
    } catch {
      // Ignore
    }
  }, [liveRoomId]);

  const { socket, emitDrawing, enqueueOutgoingPoints } = useRoomSocket({
    userId,
    userKey,
    userColor,
    liveRoomId,
    roomId,
    isTeacher,
    activeBoardId,
    userNameRef,
    isJoinedRef,
    isChatHiddenRef,
    activeBoardIdRef,
    chatScopeRef,
    setElements,
    setSubBoards,
    setIsTeacher,
    setRoundTemplates,
    setRoundTemplateInk,
    setRoundVariants,
    setMessages,
    setBackground,
    setUnreadChatCount,
    setUsers,
    setRoomSettings,
    setIsNameLocked,
    setUserName,
    setHistoryVersion,
    setKickNotice,
    setIsJoined,
    setPendingPurgePrompt,
    setRemoteCursors,
  });
  const {
    handleAuthenticateTeacher,
    handleStepDownTeacher,
    problemReport,
    teacherActions,
    handleLeaveRoom,
    handleSwitchRoom,
    handleCreateNewRoom,
    handleJoin,
    handleLobbyNewRoom,
    handleCancelRoomPrompt,
    handleConfirmJoinAnyway,
    handleConfirmCreateFreshRoom,
    handleCustomRoomFromModal,
    handleUpdateName,
    handleTeacherRenameUser,
    handleTeacherDeleteMessage,
    handleTeacherKickUser,
    handleCancelPurgeContributions,
    handleConfirmPurgeContributions,
    purgeContributionCounts,
    handleTeacherUnbanUser,
    sendMessage,
    handleSetStatus,
    handleClearStatus,
  } = useClassroomActions({
    connection: { socket, emitDrawing },
    roomState: {
      activeBoardId,
      userId,
      roomId,
      effectiveRoomId,
      isJoined,
      isTeacher,
      breakoutConfig,
      subBoards,
      activeBackground,
      activeElements,
      users,
      roomSettings,
      isChatHidden,
      userName,
      liveRoomId,
      userKey,
      userColor,
      isNameLocked,
      elements,
      messages,
    },
    roomSetters: {
      setSubBoards,
      setIsTeacher,
      setTeacherSelectedBoardId,
      setBackground,
      setRemoteCursors,
      setIsNameLocked,
      setKickNotice,
      setPendingPurgePrompt,
      setIsPurgingContributions,
      setRoomId,
      setIsJoined,
      setUserName,
      setHasEditedLobbyRoom,
      setIsCheckingRoom,
      setPendingRoomPrompt,
    },
    lobby: {
      initialTeacherPin,
      hasEditedLobbyRoom,
      isCheckingRoom,
      pendingRoomPrompt,
      hadInitialUrlRoom,
      showTeacherSetupOnJoin,
      displayNameInputRef,
      isJoinedRef,
      pendingPurgePrompt,
      isPurgingContributions,
    },
  });
  const openProblemReport = problemReport.open;
  const problemReportModal = problemReport.isOpen ? (
    <ProblemReportModal
      getDiagnostics={problemReport.diagnostics}
      redact={problemReport.redact}
      onClose={problemReport.close}
    />
  ) : null;
  const { drawingActions, handleClearUserDrawings } = useDrawingActions({
    socket,
    activeBoardId,
    setSubBoards,
    emitDrawing,
    userId,
    setElements,
    enqueueOutgoingPoints,
  });

  if (!isJoined) {
    return (
      <LobbyScreen
        effectiveRoomId={effectiveRoomId}
        handleJoin={handleJoin}
        kickNotice={kickNotice}
        displayNameInputRef={displayNameInputRef}
        userName={userName}
        setUserName={setUserName}
        isCheckingRoom={isCheckingRoom}
        historyVersion={historyVersion}
        setKickNotice={setKickNotice}
        setHasEditedLobbyRoom={setHasEditedLobbyRoom}
        setRoomId={setRoomId}
        showTeacherSetupOnJoin={showTeacherSetupOnJoin}
        teacherPinInputRef={teacherPinInputRef}
        roomCodeInputRef={roomCodeInputRef}
        roomId={roomId}
        handleLobbyNewRoom={handleLobbyNewRoom}
        handleCreateNewRoom={handleCreateNewRoom}
        setShowTeacherSetupOnJoin={setShowTeacherSetupOnJoin}
        setInitialTeacherPin={setInitialTeacherPin}
        setShowInitialTeacherPin={setShowInitialTeacherPin}
        initialTeacherPin={initialTeacherPin}
        showInitialTeacherPin={showInitialTeacherPin}
        openProblemReport={openProblemReport}
        pendingRoomPrompt={pendingRoomPrompt}
        handleConfirmJoinAnyway={handleConfirmJoinAnyway}
        handleConfirmCreateFreshRoom={handleConfirmCreateFreshRoom}
        handleCustomRoomFromModal={handleCustomRoomFromModal}
        handleCancelRoomPrompt={handleCancelRoomPrompt}
        problemReportModal={problemReportModal}
      />
    );
  }

  return (
    <div className="flex h-screen bg-slate-100 overflow-hidden font-sans">
      {!isChatHidden && (
        <Chat
          roomId={roomId}
          historyVersion={historyVersion}
          hasTeacherPin={roomSettings.hasTeacherPin}
          messages={activeMessages}
          users={users}
          elements={activeElements}
          onSendMessage={sendMessage}
          userId={userId}
          userName={userName}
          userColor={userColor}
          isTeacher={isTeacher}
          isNameLocked={isNameLocked}
          bannedUsers={roomSettings.bannedUsers || []}
          onAuthenticateTeacher={handleAuthenticateTeacher}
          onStepDownTeacher={handleStepDownTeacher}
          onCreateNewRoom={handleCreateNewRoom}
          onSwitchRoom={handleSwitchRoom}
          onLeaveRoom={handleLeaveRoom}
          onUpdateName={handleUpdateName}
          onClearUserDrawings={handleClearUserDrawings}
          onTeacherRenameUser={handleTeacherRenameUser}
          onTeacherDeleteMessage={handleTeacherDeleteMessage}
          onTeacherKickUser={handleTeacherKickUser}
          onTeacherUnbanUser={handleTeacherUnbanUser}
          onTeacherClearStatus={handleClearStatus}
          onReportProblem={openProblemReport}
          width={chatWidth}
          onWidthChange={setChatWidth}
          onResetWidth={() =>
            setChatWidth(
              clampChatWidth(DEFAULT_CHAT_WIDTH, typeof window !== 'undefined' ? window.innerWidth : undefined)
            )
          }
          onHideChat={() => {
            setIsChatHidden(true);
            storeChatHiddenChoice(window.localStorage, true);
          }}
        />
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <Canvas
          roomId={roomId}
          viewer={{ userId, userName, userColor, isTeacher }}
          roomFlags={{
            isCanvasLocked: roomSettings.isCanvasLocked,
            hideStudentCursors: Boolean(roomSettings.hideStudentCursors),
            oneNameStamp: Boolean(roomSettings.oneNameStamp),
            hasTeacherPin: roomSettings.hasTeacherPin,
            timer: roomSettings.timer,
          }}
          activeBoard={{
            activeBoardId,
            activeBoardTitle,
            elements: activeElements,
            messages: activeMessages,
            background: activeBackground,
          }}
          mainBoard={{ fullMainElements: elements, fullMainMessages: messages, fullMainBackground: background }}
          rounds={{ subBoards, breakoutConfig, roundTemplates, roundTemplateInk, roundVariants }}
          chat={{
            isChatHidden,
            unreadChatCount,
            onShowChat: () => {
              setIsChatHidden(false);
              storeChatHiddenChoice(window.localStorage, false);
            },
          }}
          users={users}
          remoteCursors={remoteCursors}
          laserSocket={socket}
          onSetStatus={handleSetStatus}
          onReportProblem={openProblemReport}
          drawingActions={drawingActions}
          teacherActions={{ ...teacherActions, onSelectBoard: setTeacherSelectedBoardId }}
        />
      </div>

      {pendingRoomPrompt && (
        <RoomExistsModal
          availability={pendingRoomPrompt.availability}
          isJoiningAsTeacher={Boolean(pendingRoomPrompt.teacherPin && pendingRoomPrompt.teacherPin.length >= 3)}
          isBusy={isCheckingRoom}
          onJoinAnyway={handleConfirmJoinAnyway}
          onCreateFreshRoom={handleConfirmCreateFreshRoom}
          onSwitchToCustomRoom={handleCustomRoomFromModal}
          onCancel={handleCancelRoomPrompt}
        />
      )}

      {pendingPurgePrompt && (
        <PurgeContributionsModal
          targetName={pendingPurgePrompt.targetName}
          actionMode={pendingPurgePrompt.mode}
          drawingCount={purgeContributionCounts.drawingCount}
          messageCount={purgeContributionCounts.messageCount}
          isBusy={isPurgingContributions}
          onConfirmDelete={handleConfirmPurgeContributions}
          onCancel={handleCancelPurgeContributions}
        />
      )}

      {problemReportModal}
    </div>
  );
}
