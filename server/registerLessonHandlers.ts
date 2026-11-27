import { sniffMime } from '../backupMirror.ts';
import { isValidAssetHash } from '../roomStore.ts';
import {
  MAX_PIN_LENGTH,
  MIN_PIN_LENGTH,
  hashPin
} from '../socketGuards.ts';
import {
  getRounds,
  migrateLegacyBreakout,
  normalizeBreakoutConfig,
  uniqueStrings
} from '../src/lib/breakoutRounds.ts';
import { cleanImportedTemplateInk, deserializeSubBoards, getRoomSettingsPayload, normalizeRoomId, serializeSubBoards } from './roomSerialization.ts';
import type { RoomState, ServerUserRecord } from './types.ts';

import type { ServerContext, TypedSocket } from './types.ts';
export function registerLessonHandlers(socket: TypedSocket, ctx: ServerContext) {
  const { io, rooms, socketMeta, store, cleanImportedRoundTemplates, cleanImportedRoundVariants, internRoomAssets, scheduleSaveToDisk, syncBoardChannels, teacherChannel, teacherTemplatesPayload, buildLessonForRoom, teacherIdsOf, checkIncomingLesson, applyLessonToRoom, noteChange, boardAudience, broadcastRoomSettings, broadcastBreakoutSync, findRoom, getOrCreateRoom } = ctx;
  const teacherCaller = (): { room: RoomState; record: ServerUserRecord } | null => { const meta = socketMeta.get(socket.id); const room = meta && rooms.get(meta.roomId); const record = meta && room?.usersByUserId.get(meta.userId); return room && record?.isTeacher ? { room, record } : null; };
  const NOT_TEACHER = 'Only a verified Teacher can do that.';
  socket.on(
    'teacher:import-room',
    (
      {
        elements: importedElements,
        messages: importedMessages,
        background: importedBg,
        subBoards: importedSubBoards,
        breakoutConfig: importedBreakoutConfig,
        mode,
        assets: importedAssets,
        roundTemplates: importedRoundTemplates,
        roundTemplateInk: importedTemplateInk,
        roundVariants: importedRoundVariants,
      },
      callback
    ) => {
      const meta = socketMeta.get(socket.id);
      if (!meta) {
        callback?.({ ok: false, error: 'Not in a room.' });
        return;
      }
      const room = rooms.get(meta.roomId);
      if (!room) {
        callback?.({ ok: false, error: 'Room not found.' });
        return;
      }

      const callerRecord = room.usersByUserId.get(meta.userId);
      if (!callerRecord?.isTeacher) {
        callback?.({ ok: false, error: 'Only a verified Teacher can import room snapshots.' });
        return;
      }

      if (importedAssets && typeof importedAssets === 'object') {
        for (const dataUrl of Object.values(importedAssets)) {
          if (typeof dataUrl === 'string') store.internDataUrl(dataUrl);
        }
      }

      const validElements = Array.isArray(importedElements) ? importedElements : [];
      const validMessages = Array.isArray(importedMessages) ? importedMessages : [];

      if (mode === 'merge') {
        const existingElIds = new Set(room.elements.map((e) => e.id));
        for (const el of validElements) {
          if (el && el.id && !existingElIds.has(el.id)) {
            room.elements.push(el);
            existingElIds.add(el.id);
          }
        }
        const existingMsgIds = new Set(room.messages.map((m) => m.id));
        for (const msg of validMessages) {
          if (msg && msg.id && !existingMsgIds.has(msg.id)) {
            room.messages.push(msg);
            existingMsgIds.add(msg.id);
          }
        }
        room.messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        if (room.messages.length > 500) {
          room.messages = room.messages.slice(-500);
        }
        if (!room.background && importedBg) {
          room.background = importedBg;
        }
        if (importedSubBoards) {
          const parsedSubs = deserializeSubBoards(importedSubBoards);
          const importedCfg = normalizeBreakoutConfig(importedBreakoutConfig);
          migrateLegacyBreakout(parsedSubs, importedCfg);
          for (const [k, v] of parsedSubs.entries()) {
            if (!room.subBoards.has(k)) room.subBoards.set(k, v);
          }
          const knownRoundIds = new Set(getRounds(room.breakoutConfig).map((r) => r.id));
          const mergedRounds = getRounds(room.breakoutConfig);
          const importedTemplates = cleanImportedRoundTemplates(importedRoundTemplates, importedCfg);
          const importedInk = cleanImportedTemplateInk(importedTemplateInk, importedCfg);
          const importedVariants = cleanImportedRoundVariants(importedRoundVariants, importedCfg);
          for (const r of getRounds(importedCfg)) {
            if (knownRoundIds.has(r.id)) continue;
            mergedRounds.push(r);
            if (Object.prototype.hasOwnProperty.call(importedTemplates, r.id)) {
              room.roundTemplates[r.id] = importedTemplates[r.id];
            }
            if (importedInk[r.id]) room.roundTemplateInk[r.id] = importedInk[r.id];
            if (importedVariants[r.id]) room.roundVariants[r.id] = importedVariants[r.id];
          }
          room.breakoutConfig.rounds = mergedRounds;
        }
      } else if (mode === 'readonly') {
        room.elements = validElements;
        room.messages = validMessages.slice(-500);
        if (importedBg !== undefined) room.background = importedBg || null;
        if (importedSubBoards !== undefined) {
          room.subBoards = deserializeSubBoards(importedSubBoards);
          room.roundTemplates = {};
          room.roundTemplateInk = {};
          room.roundVariants = {};
        }
        if (importedBreakoutConfig) {
          room.breakoutConfig = normalizeBreakoutConfig(importedBreakoutConfig);
        }
        if (importedRoundTemplates && typeof importedRoundTemplates === 'object') {
          room.roundTemplates = cleanImportedRoundTemplates(importedRoundTemplates, room.breakoutConfig);
        }
        if (importedTemplateInk && typeof importedTemplateInk === 'object') {
          room.roundTemplateInk = cleanImportedTemplateInk(importedTemplateInk, room.breakoutConfig);
        }
        if (importedRoundVariants && typeof importedRoundVariants === 'object') {
          room.roundVariants = cleanImportedRoundVariants(importedRoundVariants, room.breakoutConfig);
        }
        room.isCanvasLocked = true;
      } else {
        room.elements = validElements;
        room.messages = validMessages.slice(-500);
        if (importedBg !== undefined) room.background = importedBg || null;
        if (importedSubBoards !== undefined) {
          room.subBoards = deserializeSubBoards(importedSubBoards);
          room.roundTemplates = {};
          room.roundTemplateInk = {};
          room.roundVariants = {};
        }
        if (importedBreakoutConfig) {
          room.breakoutConfig = normalizeBreakoutConfig(importedBreakoutConfig);
        }
        if (importedRoundTemplates && typeof importedRoundTemplates === 'object') {
          room.roundTemplates = cleanImportedRoundTemplates(importedRoundTemplates, room.breakoutConfig);
        }
        if (importedTemplateInk && typeof importedTemplateInk === 'object') {
          room.roundTemplateInk = cleanImportedTemplateInk(importedTemplateInk, room.breakoutConfig);
        }
        if (importedRoundVariants && typeof importedRoundVariants === 'object') {
          room.roundVariants = cleanImportedRoundVariants(importedRoundVariants, room.breakoutConfig);
        }
        room.isCanvasLocked = false;
      }

      migrateLegacyBreakout(room.subBoards, room.breakoutConfig);
      internRoomAssets(room);

      room.lastActiveAt = Date.now();
      scheduleSaveToDisk(room, true);

      io.to(room.id).emit('room-restored', {
        elements: room.elements,
        messages: room.messages,
        background: room.background,
        subBoards: serializeSubBoards(room.subBoards),
        roomSettings: getRoomSettingsPayload(room),
      });
      syncBoardChannels(room, false); // room-restored carried everything
      io.to(teacherChannel(room.id)).emit('round-templates-sync', teacherTemplatesPayload(room));

      callback?.({
        ok: true,
        elementsCount: room.elements.length,
        messagesCount: room.messages.length,
      });
    }
  );

  socket.on('teacher:export-lesson', (payload, callback) => {
    const caller = teacherCaller();
    if (!caller) return callback?.({ ok: false, error: NOT_TEACHER });
    const opts = payload && typeof payload === 'object' ? payload : {};
    const lesson = buildLessonForRoom(caller.room, caller.record, opts);
    const teacherIds = teacherIdsOf(caller.room, caller.record.userId);
    const notStamp = (el: any) => !(el.tool === 'stamp' && el.stamp === 'username');
    callback?.({
      ok: true,
      lesson,
      inkCounts: {
        teacher: caller.room.elements.filter((el) => notStamp(el) && teacherIds.has(el.userId)).length,
        all: caller.room.elements.filter(notStamp).length,
      },
    });
  });

  socket.on('teacher:has-assets', (payload, callback) => {
    if (!teacherCaller()) return callback?.({ ok: false, error: NOT_TEACHER });
    const urls = Array.isArray(payload?.urls) ? payload.urls : null;
    if (!urls || urls.length > 1000) return callback?.({ ok: false, error: 'Send up to 1,000 image links.' });
    const missing: string[] = [];
    for (const url of uniqueStrings(urls)) {
      const m = /^\/api\/assets\/([a-f0-9]{64})$/.exec(url);
      if (!m || !isValidAssetHash(m[1]) || !store.getAsset(m[1])) missing.push(url);
    }
    callback?.({ ok: true, missing });
  });

  socket.on('teacher:upload-asset', (payload, callback) => {
    if (!teacherCaller()) return callback?.({ ok: false, error: NOT_TEACHER });
    const dataUrl = typeof payload?.dataUrl === 'string' ? payload.dataUrl : '';
    const m = /^data:(image\/(?:png|jpeg|webp));base64,/.exec(dataUrl);
    if (!m) return callback?.({ ok: false, error: 'Only PNG, JPEG and WebP images can be uploaded.' });
    const bytes = Buffer.from(dataUrl.slice(m[0].length), 'base64');
    if (bytes.length === 0 || sniffMime(bytes) !== m[1]) {
      return callback?.({ ok: false, error: "That image's contents don't match its type." });
    }
    // No room references it yet; gcAssets' grace period covers the gap until load-lesson arrives.
    callback?.({ ok: true, url: store.internDataUrl(dataUrl) });
  });

  socket.on('teacher:load-lesson', async (payload, callback) => {
    const caller = teacherCaller();
    if (!caller) return callback?.({ ok: false, error: NOT_TEACHER });
    const checked = checkIncomingLesson(payload?.lesson);
    if (!checked.ok) return callback?.({ ok: false, error: checked.error });
    const author = { userId: caller.record.userId, name: caller.record.name };

    if (payload?.target === 'current') {
      const room = caller.room;
      if (room.breakoutConfig.mode !== 'main') {
        return callback?.({ ok: false, error: 'Bring everyone to Main first, then load the lesson.' });
      }
      const rounds = applyLessonToRoom(room, checked.lesson, author);
      room.lastActiveAt = Date.now();
      scheduleSaveToDisk(room, true);
      // Like spotlight-board, not room-restored (which would send every board to everyone).
      io.to(room.id).emit('background-sync', { boardId: 'main', background: room.background });
      io.to(room.id).emit('board-replaced', { boardId: 'main' });
      noteChange(room, 'main', { full: true });
      io.to(boardAudience(room.id, 'main')).emit('state-sync', { boardId: 'main', elements: room.elements });
      broadcastRoomSettings(room);
      broadcastBreakoutSync(room);
      return callback?.({ ok: true, roomId: room.id, rounds: rounds.length });
    }

    const rawId = typeof payload?.newRoomId === 'string' ? payload.newRoomId.trim() : '';
    const newRoomId = normalizeRoomId(rawId);
    if (!rawId || newRoomId.length > 64) return callback?.({ ok: false, error: 'Enter a room code for the new room.' });
    if (findRoom(newRoomId)) return callback?.({ ok: false, error: 'That room code is taken.' });
    const pin = typeof payload?.pin === 'string' ? payload.pin.trim() : '';
    if (pin.length < MIN_PIN_LENGTH || pin.length > MAX_PIN_LENGTH) {
      return callback?.({ ok: false, error: `The Teacher PIN must be ${MIN_PIN_LENGTH} to ${MAX_PIN_LENGTH} characters.` });
    }
    const pinHash = await hashPin(pin);
    if (findRoom(newRoomId)) return callback?.({ ok: false, error: 'That room code is taken.' });
    const room = getOrCreateRoom(newRoomId);
    room.teacherPinHash = pinHash;
    const rounds = applyLessonToRoom(room, checked.lesson, author);
    room.lastActiveAt = Date.now();
    scheduleSaveToDisk(room, true);
    callback?.({ ok: true, roomId: room.id, rounds: rounds.length });
  });
}
