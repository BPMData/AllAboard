import express from 'express';
import { GcsBackend } from './backupMirror.ts';
import { WriterLease } from './server/writerLease.ts';
import { createServer } from 'http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import path from 'path';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { RoomStore } from './roomStore.ts';
import { createBoardChannels } from './server/boardChannels.ts';
import { createBreakoutHelpers } from './server/breakoutHelpers.ts';
import { registerHttpRoutes } from './server/httpRoutes.ts';
import { createLessonPackHelpers } from './server/lessonPackHelpers.ts';
import { registerBreakoutHandlers } from './server/breakoutHandlers.ts';
import { registerDrawingHandlers } from './server/drawingHandlers.ts';
import { registerLessonPackHandlers } from './server/lessonPackHandlers.ts';
import { registerModerationHandlers } from './server/moderationHandlers.ts';
import { createRoomPersistence, isProductionRuntime, openBackupMirror } from './server/roomPersistence.ts';
import {
  HOUSEKEEPING_INTERVAL_MS,
  PIN_FAILURES_PER_WINDOW,
  PIN_FAILURE_WINDOW_MS,
  createRoomSerialization,
} from './server/roomSerialization.ts';
import type { RoomState, StartServerOptions } from './server/types.ts';
import { MAX_BOARD_ELEMENTS, createFailureLimiter, createSocketLimiter } from './socketGuards.ts';
import { OVERVIEW_SYNC_MS } from './src/lib/boardDigest.ts';
import { CURSOR_EMIT_MS } from './src/lib/drawThrottle.ts';
import type { ClientToServerEvents, ServerToClientEvents } from './src/lib/socketContract.ts';
import { distRouter } from './staticAssets.ts';
export type { StartServerOptions } from './server/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function startServer(options: StartServerOptions = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(process.cwd(), '.data');
  const legacyStoreFile = path.join(dataDir, 'rooms-store.json');
  const store = new RoomStore(path.join(dataDir, 'allaboard.db'));
  const backup = await openBackupMirror(store, options);
  const serialization = createRoomSerialization(store);
  const { cloneBackground, cleanRoundVariants } = serialization;
  const portToBind =
    options.port !== undefined ? options.port : process.env.PORT === '0' ? 0 : Number(process.env.PORT) || 3000;
  const hostToBind = options.host || '0.0.0.0';

  let closing = false;
  let lease: WriterLease | undefined;
  const writable = () => !closing && (!lease || lease.writable());
  const app = express();
  const httpServer = createServer(app);
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    allowRequest: (_req, done) => {
      if (lease && !lease.writable()) lease.request();
      done(null, writable());
    },
    cors: {
      origin: '*',
    },
    maxHttpBufferSize: 3e7, // 30 MB for PDF worksheets, subBoards, and JSON snapshots
  });

  const rooms: Map<string, RoomState> = new Map();
  /**
   * `channel` = the board channel this socket gets live drawing traffic from (see placeSocket).
   * `viewBoardId` = the board a teacher says they're looking at (`teacher:view-board`); ignored for students.
   */
  /**
   * `channel` = the board channel this socket gets live drawing traffic from (see placeSocket).
   * `viewBoardId` = the board a teacher says they're looking at (`teacher:view-board`); ignored for students.
   */
  const socketMeta: Map<
    string,
    { roomId: string; userId: string; channel?: string; viewBoardId?: string; inTeachers?: boolean }
  > = new Map();

  const persistence = createRoomPersistence({ store, backup, rooms, legacyStoreFile });
  const {
    migrateLegacyJsonStore,
    restoreFromBackup,
    runHousekeeping,
    getRoomAvailability,
    scheduleSaveToDisk,
    flushRoomsToDisk,
    flushRoomsToDiskAsync,
    cancelPendingSave,
  } = persistence;
  registerHttpRoutes(app, {
    store,
    backup,
    options,
    getRoomAvailability,
    writerState: () => {
      if (lease && !lease.writable()) lease.request();
      return lease?.state() ?? 'active';
    },
  });

  async function restore() {
    migrateLegacyJsonStore();
    await restoreFromBackup();
  }
  const housekeepingInterval = setInterval(() => {
    if (writable()) runHousekeeping();
  }, HOUSEKEEPING_INTERVAL_MS);
  housekeepingInterval.unref();

  // ---------- Board channels ----------
  // Live traffic (ink deltas, state-sync, cursors) goes only to sockets viewing that board: students on their
  // assigned board, teachers on the board they picked. Teachers get every *other* board as a `boards-digest` every
  // OVERVIEW_SYNC_MS (just the changed elements), which is plenty for the live grid / moderation and far cheaper.
  // Room-wide events (roster, settings, chat, backgrounds, breakout-sync) still go to room.id.
  // A socket that changes board is sent a fresh copy of it (placeSocket), since it wasn't listening before.

  const channels = createBoardChannels({ io, rooms, socketMeta, scheduleSaveToDisk });
  const { noteChange, flushDigests, flushCursors, broadcastRoomSettings } = channels;
  const digestInterval = setInterval(flushDigests, options.overviewSyncMs ?? OVERVIEW_SYNC_MS);
  digestInterval.unref();

  // ---------- Cursor batching ----------
  // Relaying every cursor-move to every viewer costs N senders x N viewers messages, which was most of a busy
  // board's traffic. Instead keep each user's latest position per board channel and send each channel one
  // `cursors-batch` every CURSOR_EMIT_MS. A batch with several movers includes the sender (clients skip their own userId); a lone mover's isn't echoed back.

  const cursorInterval = setInterval(flushCursors, CURSOR_EMIT_MS);
  cursorInterval.unref();

  // ---------- Load log ----------
  // One line a minute while anyone is connected, so Cloud Run logs show headroom: sockets are in-flight requests
  // against --concurrency, and event-loop lag is what students feel as ink delay.
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  let peakSockets = 0;
  function logLoad() {
    const sockets = io.of('/').sockets.size;
    peakSockets = Math.max(peakSockets, sockets);
    if (peakSockets > 0) {
      let busiestRoom = 0;
      for (const room of rooms.values())
        busiestRoom = Math.max(busiestRoom, io.sockets.adapter.rooms.get(room.id)?.size ?? 0);
      console.log(
        '[load]',
        JSON.stringify({
          rooms: rooms.size,
          sockets,
          peakSockets,
          busiestRoom,
          lagP99Ms: Math.round(loopDelay.percentile(99) / 1e6),
          lagMaxMs: Math.round(loopDelay.max / 1e6),
          rateLimited: rateLimitedEvents,
          rssMb: Math.round(process.memoryUsage().rss / 1048576),
        })
      );
    }
    peakSockets = sockets;
    rateLimitedEvents = 0;
    pinFailures.prune();
    loopDelay.reset();
  }
  const peakTracker = setInterval(() => {
    peakSockets = Math.max(peakSockets, io.of('/').sockets.size);
  }, 5_000);
  peakTracker.unref();
  const loadLogInterval = setInterval(logLoad, 60_000);
  loadLogInterval.unref();

  // 1-second check for running classroom countdown timers
  const timerTickInterval = setInterval(() => {
    if (!writable()) return;
    const now = Date.now();
    for (const room of rooms.values()) {
      if (room.timer?.isRunning && room.timer.endsAt !== null && now >= room.timer.endsAt) {
        room.timer.isRunning = false;
        room.timer.remainingMs = 0;
        room.timer.endsAt = null;
        if (room.timer.autoLockOnExpire) {
          room.isCanvasLocked = true;
        }
        room.lastActiveAt = now;
        broadcastRoomSettings(room);
        scheduleSaveToDisk(room);
      }
    }
  }, 1000);
  timerTickInterval.unref();

  const breakout = createBreakoutHelpers({ io, cloneBackground, cleanRoundVariants, noteChange });
  const { setRoundVariants, teacherIdsOf, getRoundTemplate, createGroupBoards } = breakout;
  const lesson = createLessonPackHelpers({
    store,
    cloneBackground,
    setRoundVariants,
    createGroupBoards,
    teacherIdsOf,
    getRoundTemplate,
  });

  /** Wrong Teacher PINs per room (across all sockets: a school shares one IP, and sockets are free to open). */
  const pinFailures = createFailureLimiter(PIN_FAILURES_PER_WINDOW, PIN_FAILURE_WINDOW_MS);
  const ctx = {
    io,
    store,
    backup,
    rooms,
    socketMeta,
    pinFailures,
    ...serialization,
    ...persistence,
    ...channels,
    ...breakout,
    ...lesson,
  };
  let rateLimitedEvents = 0;

  const handlers = new Set<Promise<unknown>>();
  io.on('connection', (socket) => {
    // Every handler for this socket runs in arrival order, one at a time, even when one awaits (PIN hashing).
    // Errors are logged, never thrown: with one instance, an uncaught throw takes every room down.
    let queue: Promise<unknown> = Promise.resolve();
    const rawOn = socket.on.bind(socket) as (event: string, handler: (...args: any[]) => unknown) => unknown;
    (socket as any).on = (event: string, handler: (...args: any[]) => unknown) =>
      rawOn(event, (...args: any[]) => {
        if (event !== 'disconnect' && !writable()) return;
        handlers.delete(queue);
        queue = queue
          .then(() => handler(...args))
          .catch((err) => console.error(`[socket] ${event} handler failed:`, err));
        handlers.add(queue);
        const queued = queue;
        void queued.finally(() => handlers.delete(queued));
      });

    // Per-socket allowances (socketGuards.ts). Over the limit, the event is dropped, not the connection.
    const limiter = createSocketLimiter();
    let warnedRateLimit = false;
    socket.use((packet, next) => {
      const event = String(packet[0]);
      if (limiter.allow(event)) return next();
      rateLimitedEvents++;
      const ack = packet[packet.length - 1];
      if (typeof ack === 'function') ack({ ok: false, error: 'Too many requests. Slow down and try again.' });
      if (!warnedRateLimit) {
        warnedRateLimit = true;
        const meta = socketMeta.get(socket.id);
        console.warn('[ratelimit]', JSON.stringify({ event, roomId: meta?.roomId, userId: meta?.userId }));
      }
    });
    /** Board at MAX_BOARD_ELEMENTS: resync the sender (drops its optimistic copy) and say why, once per board. */
    const warnedFullBoards = new Set<string>();
    function boardFull(boardId: string, elements: any[]) {
      socket.emit('state-sync', { boardId, elements });
      if (warnedFullBoards.has(boardId)) return;
      warnedFullBoards.add(boardId);
      socket.emit('board-full', { boardId, max: MAX_BOARD_ELEMENTS });
    }
    registerModerationHandlers(socket, ctx);
    registerBreakoutHandlers(socket, ctx);
    registerLessonPackHandlers(socket, ctx);
    registerDrawingHandlers(socket, ctx, boardFull);
  });

  let draining: Promise<void> | undefined;
  if (backup?.backend instanceof GcsBackend && (options.releaseSequence !== undefined || process.env.K_SERVICE)) {
    lease = new WriterLease(
      backup.backend,
      options.releaseSequence ?? (Number(process.env.RELEASE_SEQUENCE) || 0),
      restore,
      drain
    );
    await lease.start();
  } else await restore();

  if (!options.skipVite && !isProductionRuntime()) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (!options.skipVite) {
    app.use(distRouter(path.join(process.cwd(), 'dist')));
  }

  await new Promise<void>((resolve) => {
    httpServer.listen(portToBind, hostToBind, () => {
      const addr = httpServer.address();
      const listeningPort = typeof addr === 'object' && addr ? addr.port : portToBind;
      if (!options.skipVite) {
        console.log(`Server running on http://localhost:${listeningPort}`);
      }
      resolve();
    });
  });

  const addr = httpServer.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : portToBind;

  function drain() {
    closing = true;
    return (draining ??= (async () => {
      clearInterval(housekeepingInterval);
      clearInterval(timerTickInterval);
      clearInterval(digestInterval);
      clearInterval(cursorInterval);
      clearInterval(loadLogInterval);
      clearInterval(peakTracker);
      loopDelay.disable();
      // Closing transports makes browsers reconnect. A server namespace disconnect suppresses automatic retry.
      for (const socket of io.sockets.sockets.values()) socket.conn.close();
      await Promise.all(handlers);
      cancelPendingSave();
      flushRoomsToDisk();
      await backup?.stop();
    })());
  }
  let shutdown: Promise<void> | undefined;
  function close() {
    closing = true;
    return (shutdown ??= (async () => {
      try {
        if (lease) await lease.stop();
        else await drain();
      } finally {
        await io.close();
        store.close();
        process.off('SIGTERM', onSignal);
        process.off('SIGINT', onSignal);
      }
    })());
  }
  function onSignal() {
    if (shutdown) return;
    const deadline = setTimeout(() => {
      console.error('Shutdown deadline reached before the final backup completed.');
      process.exit(1);
    }, 8000);
    deadline.unref();
    void close().then(
      () => process.exit(0),
      (err) => {
        console.error('Shutdown failed:', err);
        process.exit(1);
      }
    );
  }
  if (!options.skipVite) {
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
  }

  return {
    app,
    store,
    backup,
    httpServer,
    io,
    port: actualPort,
    flushRoomsToDisk,
    flushRoomsToDiskAsync,
    close,
  };
}

const isMainModule = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMainModule) {
  void startServer();
}
